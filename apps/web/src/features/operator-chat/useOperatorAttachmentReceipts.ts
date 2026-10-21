import { useCallback, useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ChatDeliveryReceipt, OperatorConversationState, SendOperatorMessageRequest } from '@foreman-code/contracts'
import type { MessageAttachmentRef } from '@foreman-code/contracts/files'
import { ApiError, sendOperatorMessage } from '../../shared/api/client'
import { chatStoragePrefix, identityEpoch } from '../../shared/api/protectedChatStorage'
import { sessionGeneration, sessionIsSwitching, SessionChangedError } from '../../shared/api/sessionBoundary'
import { containsAttachmentRefs, messageAttachmentRefs, sameAttachmentRefs, type ChatAttachmentAttempt } from '../conversations/chatAttachmentAttempt'
import { readPendingOperatorMessage } from './operatorOutbox'
import { confirmedOperatorDelivery } from './operatorDeliveryReceipt'

interface Attempt {
  id: string
  command: SendOperatorMessageRequest
  attachment: ChatAttachmentAttempt
  generation: number
  epoch: string
}
function current(attempt: Attempt) {
  return !sessionIsSwitching() && attempt.generation === sessionGeneration() && attempt.epoch === identityEpoch()
}
function matches(attempt: Attempt, state: OperatorConversationState) {
  const { id, command, attachment } = attempt
  const message = state.messages.find((entry) => entry.role === 'user' && entry.requestId === command.requestId)
  return state.conversation.id === id && message?.conversationId === id
    && message.content.trim() === command.content.trim()
    && containsAttachmentRefs(messageAttachmentRefs(message), command.attachments)
    && sameAttachmentRefs(attachment.attachments, command.attachments)
    && !(state.turnState === 'uncertain' && (!state.activeRequestId || state.activeRequestId === command.requestId))
}

/** Local snapshot capabilities are not receipts. Cross-tab removal only triggers a receipt read. */
export function useOperatorAttachmentReceipts() {
  const client = useQueryClient()
  const attempts = useRef(new Map<string, Attempt>())
  const confirm = useCallback((requestId: string, state: OperatorConversationState | undefined) => {
    const attempt = attempts.current.get(requestId)
    if (!state || !attempt || !current(attempt) || !matches(attempt, state)) return
    attempt.attachment.acknowledge?.()
    attempts.current.delete(requestId)
  }, [])
  const confirmDelivery = useCallback((requestId: string, receipt: ChatDeliveryReceipt) => {
    const attempt = attempts.current.get(requestId)
    if (!attempt || !current(attempt) || ['failed', 'unknown'].includes(receipt.state)
      || receipt.commandId !== requestId || receipt.target.kind !== 'operator_conversation'
      || receipt.target.conversationId !== attempt.id || !sameAttachmentRefs(attempt.attachment.attachments, attempt.command.attachments)) return
    attempt.attachment.acknowledge?.(); attempts.current.delete(requestId)
  }, [])
  const remember = useCallback((id: string, command: SendOperatorMessageRequest, attachment: ChatAttachmentAttempt) => {
    if (!attachment.attachments.length || attempts.current.has(command.requestId)) return
    attempts.current.set(command.requestId, { id, command, attachment, generation: sessionGeneration(), epoch: identityEpoch() })
  }, [])
  const forget = useCallback((requestId: string) => { attempts.current.delete(requestId) }, [])
  const blocksSend = useCallback((id: string, pins: readonly MessageAttachmentRef[]) =>
    [...attempts.current.values()].some((attempt) => attempt.id === id && current(attempt)
      && attempt.attachment.attachments.some((sent) => pins.some((pin) =>
        pin.fileId === sent.fileId && pin.revisionId === sent.revisionId))), [])
  const reconcile = useCallback(() => {
    for (const attempt of attempts.current.values()) {
      if (!current(attempt)) continue
      const pending = readPendingOperatorMessage(attempt.id)
      if (pending.error || pending.command?.requestId === attempt.command.requestId) continue
      // Receipt-only recovery never reserves, admits, or clears a newer outbox command.
      // Query owns/deduplicates the read, including simultaneous storage/focus events.
      void client.fetchQuery({
        queryKey: ['operator-chat', 'attachment-receipt', attempt.generation, attempt.epoch, attempt.id, attempt.command.requestId],
        retry: false, staleTime: 0, gcTime: 0,
        queryFn: async ({ signal }) => {
          if (!current(attempt)) throw new SessionChangedError()
          const result = await sendOperatorMessage(attempt.id, { ...attempt.command, recovery: 'receipt' }, { signal })
          if (!current(attempt)) throw new SessionChangedError()
          const receipt = confirmedOperatorDelivery(attempt.id, attempt.command.requestId, 'receipt' in result ? result.receipt : undefined)
          if (!receipt && (!result.state || !matches(attempt, result.state))) throw new ApiError({
            code: 'INVALID_RESPONSE', message: 'The file message receipt was not confirmed.',
          })
          return { state: result.state, receipt }
        },
      }).then(result => result.receipt ? confirmDelivery(attempt.command.requestId, result.receipt)
        : confirm(attempt.command.requestId, result.state)).catch(error => { console.warn('Could not confirm the attachment message receipt.', error) })
    }
  }, [client, confirm, confirmDelivery])
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(chatStoragePrefix)) reconcile()
    }
    window.addEventListener('storage', changed)
    window.addEventListener('focus', reconcile)
    return () => {
      window.removeEventListener('storage', changed)
      window.removeEventListener('focus', reconcile)
    }
  }, [reconcile])
  return { remember, confirm, confirmDelivery, forget, blocksSend, reconcile }
}
