import type { Dispatch, SetStateAction } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { OperatorConversationState, SendOperatorMessageRequest } from '@foreman-code/contracts'
import { useConversationDraftStore } from '../conversations'
import { containsAttachmentRefs, messageAttachmentRefs } from '../conversations/chatAttachmentAttempt'
import { ApiError, sendOperatorMessage } from '../../shared/api/client'
import { identityEpoch } from '../../shared/api/protectedChatStorage'
import { SessionChangedError } from '../../shared/api/sessionBoundary'
import { useOperatorChatStore } from './operatorChatStore'
import { acknowledgeOperatorMessage, assertOperatorMessageReserved, beginOperatorMessageAttempt,
  recordOperatorMessageFailure } from './operatorOutbox'
import type { useOperatorAttachmentReceipts } from './useOperatorAttachmentReceipts'
import { currentSession, type PreparationError, type RefreshOutbox } from './operatorChatShared'

export function useOperatorSendMutation({ acceptState, invalidate, attachmentReceipts, setPreparationError, setHandoffNotice, refreshOutbox }: {
  acceptState: (id: string, state: OperatorConversationState) => void
  invalidate: (id: string) => Promise<void>
  attachmentReceipts: ReturnType<typeof useOperatorAttachmentReceipts>
  setPreparationError: Dispatch<SetStateAction<PreparationError>>
  setHandoffNotice: Dispatch<SetStateAction<{ id: string; epoch: string } | undefined>>
  refreshOutbox: RefreshOutbox
}) {
  const select = useOperatorChatStore((state) => state.select)
  const clearDraft = useConversationDraftStore((state) => state.clearDraft)
  return useMutation({
    mutationFn: async (input: { id: string; command: SendOperatorMessageRequest; generation: number; epoch: string; navigationGeneration: number; recoverFirst?: boolean; attemptId?: string }) => {
      const { id, command, generation, epoch } = input
      if (!currentSession(generation) || epoch !== identityEpoch()) throw new SessionChangedError()
      // Persist the in-flight attempt across tabs before crossing the HTTP boundary.
      input.attemptId = await beginOperatorMessageAttempt(id, command)
      refreshOutbox((value) => value + 1)
      if (!currentSession(generation) || epoch !== identityEpoch()) throw new SessionChangedError()
      assertOperatorMessageReserved(id, command)
      const confirmed = (result: Awaited<ReturnType<typeof sendOperatorMessage>>) => {
        if (command.attachments?.length) {
          const message = result.state.messages.find((entry) => entry.role === 'user' && entry.requestId === command.requestId)
          if (result.state.conversation.id !== id || !message || message.conversationId !== id
            || message.content.trim() !== command.content.trim() || !containsAttachmentRefs(messageAttachmentRefs(message), command.attachments)) {
            throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The file message receipt was not confirmed. Retry the pending message.' })
          }
          if (result.state.turnState === 'uncertain' && (!result.state.activeRequestId || result.state.activeRequestId === command.requestId)) {
            throw new ApiError({ code: 'OPERATOR_DELIVERY_UNCONFIRMED', message: 'Delivery is unknown. Your draft is kept.' }, 409)
          }
        }
        return result
      }
      if (input.recoverFirst) {
        try { return confirmed(await sendOperatorMessage(id, { ...command, recovery: 'receipt' })) }
        catch (error) {
          if (!ApiError.is(error) || error.code !== 'OPERATOR_RECEIPT_NOT_FOUND') throw error
          // A read-only miss is not an abandonment receipt. Reuse the original
          // command identity if new admission is still needed.
          if (!currentSession(generation) || epoch !== identityEpoch()) throw new SessionChangedError({ cause: error })
          assertOperatorMessageReserved(id, command)
        }
      }
      try {
        return confirmed(await sendOperatorMessage(id, command))
      } catch (error) {
        if (!ApiError.is(error) || error.code !== 'REQUEST_TIMEOUT') throw error
        if (!currentSession(generation) || epoch !== identityEpoch()) throw new SessionChangedError({ cause: error })
        assertOperatorMessageReserved(id, command)
        return confirmed(await sendOperatorMessage(id, { ...command, recovery: 'receipt' }))
      }
    },
    onSuccess: async (result, input) => {
      if (!currentSession(input.generation) || input.epoch !== identityEpoch()) return
      const targetId = result.state.conversation.id
      // Acceptance, not winning the cross-tab outbox deletion, consumes the snapshot.
      attachmentReceipts.confirm(input.command.requestId, result.state)
      let acknowledged = false
      try {
        acknowledged = await acknowledgeOperatorMessage(input.id, input.command.requestId)
        if (!currentSession(input.generation) || input.epoch !== identityEpoch()) return
        if (acknowledged) {
          clearDraft(input.id, input.command.content)
        }
      } catch (error) {
        if (!currentSession(input.generation) || input.epoch !== identityEpoch()) return
        setPreparationError({ id: input.id, message: error instanceof Error ? error.message : 'The message receipt could not be saved.' })
      }
      refreshOutbox((value) => value + 1)
      acceptState(targetId, result.state)
      if (targetId !== input.id && acknowledged) {
        const navigation = useOperatorChatStore.getState()
        if (navigation.selectedConversationId === input.id && navigation.navigationGeneration === input.navigationGeneration) select(targetId)
        else setHandoffNotice({ id: targetId, epoch: input.epoch })
      }
      await invalidate(targetId)
    },
    onError: async (error, input) => {
      if (!currentSession(input.generation) || input.epoch !== identityEpoch()) return
      try { await recordOperatorMessageFailure(input.id, input.command.requestId,
        error instanceof Error ? error.message : 'Message delivery failed.', ApiError.is(error)
          && ['INVALID_REQUEST', 'CONVERSATION_REVISION_CONFLICT', 'HARNESS_PROFILE_SELECTION_CONFLICT', 'MESSAGE_ATTACHMENT_NOT_FOUND',
            'MESSAGE_ATTACHMENT_NOT_READY', 'MESSAGE_ATTACHMENT_UNAVAILABLE', 'MESSAGE_ATTACHMENT_CONVERSATION_REQUIRED'].includes(error.code), input.attemptId) } catch { /* ignore: The current error remains visible. */ }
      if (currentSession(input.generation) && input.epoch === identityEpoch()) refreshOutbox((value) => value + 1)
    },
    // A later 4xx cannot prove an earlier lost delivery was not accepted.
    // Keep the same durable request identity until a successful receipt is read.
  })
}
