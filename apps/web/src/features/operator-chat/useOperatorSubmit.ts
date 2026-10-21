import { useRef, type Dispatch, type SetStateAction } from 'react'
import type { OperatorConversationState, SessionMode } from '@foreman-code/contracts'
import { useConversationDraftStore } from '../conversations'
import { prepareChatAttachments } from '../conversations/chatAttachmentAttempt'
import { identityEpoch } from '../../shared/api/protectedChatStorage'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { useOperatorChatStore } from './operatorChatStore'
import { reserveOperatorMessage, type readPendingOperatorMessage } from './operatorOutbox'
import type { useOperatorAttachmentReceipts } from './useOperatorAttachmentReceipts'
import type { useOperatorChatAttachments } from './useOperatorChatAttachments'
import type { useOperatorSendMutation } from './useOperatorSendMutation'
import type { useOperatorSettings } from './useOperatorSettings'
import { currentSession, type PreparationError, type RefreshOutbox } from './operatorChatShared'

export function useOperatorSubmit({ selectedId, setupReady, settingsReady, archived, active, accessDenied, pending, attachmentReceiptPending,
  send, attachments, attachmentReceipts, pendingHandoff, setPreparationError, setPreparingId, refreshOutbox, messageSettings,
  conversation, preferences, createConversation }: {
  selectedId: string | undefined
  setupReady: boolean
  settingsReady: boolean
  archived: boolean
  active: boolean
  accessDenied: boolean
  pending: ReturnType<typeof readPendingOperatorMessage>
  attachmentReceiptPending: boolean
  send: ReturnType<typeof useOperatorSendMutation>
  attachments: ReturnType<typeof useOperatorChatAttachments>['attachments']
  attachmentReceipts: ReturnType<typeof useOperatorAttachmentReceipts>
  pendingHandoff: boolean
  setPreparationError: Dispatch<SetStateAction<PreparationError>>
  setPreparingId: Dispatch<SetStateAction<string | undefined>>
  refreshOutbox: RefreshOutbox
  messageSettings: ReturnType<typeof useOperatorSettings>['settings']
  conversation: OperatorConversationState | undefined
  preferences: ReturnType<typeof useOperatorSettings>
  createConversation: () => Promise<void>
}) {
  const reservations = useRef(new Set<string>())
  return async (content: string, sessionMode?: SessionMode) => {
    if (content.trim() === '/new') {
      await createConversation()
      return
    }
    if (!setupReady || !settingsReady || !selectedId || archived || active || accessDenied || pending.command || pending.error || attachmentReceiptPending
      || reservations.current.has(selectedId) || (send.isPending && send.variables?.id === selectedId)) return
    if ((useConversationDraftStore.getState().drafts[selectedId] ?? '').trim() !== content.trim()) return
    const attachmentAttempt = prepareChatAttachments(attachments)
    if (!attachmentAttempt || (!content.trim() && !attachmentAttempt.attachments.length)
      || attachmentReceipts.blocksSend(selectedId, attachmentAttempt.attachments)) return
    if (attachmentAttempt.attachments.length && pendingHandoff) {
      setPreparationError({ id: selectedId, message: 'Start the new chat before attaching files.' })
      return
    }
    const id = selectedId
    const generation = sessionGeneration()
    const epoch = identityEpoch()
    const navigationGeneration = useOperatorChatStore.getState().navigationGeneration
    reservations.current.add(id); setPreparingId(id)
    try {
      const command = await reserveOperatorMessage(id, content, window.location.pathname + window.location.search, messageSettings,
        conversation?.revision,
        { configurationVersionId: conversation?.conversation.operatorConfigurationVersionId,
          defaultsRevision: preferences.query.data?.revision, ...(sessionMode ? { sessionMode } : {}) }, attachmentAttempt.attachments)
      if (!currentSession(generation) || epoch !== identityEpoch()) return
      attachmentReceipts.remember(id, command, attachmentAttempt)
      setPreparationError(undefined)
      send.mutate({ id, command, generation, epoch, navigationGeneration })
    } catch (error) {
      if (currentSession(generation) && epoch === identityEpoch()) setPreparationError({ id,
        message: error instanceof Error ? error.message : 'Message preparation failed.' })
    } finally {
      reservations.current.delete(id)
      setPreparingId((current) => current === id ? undefined : current)
      refreshOutbox((value) => value + 1)
    }
  }
}
