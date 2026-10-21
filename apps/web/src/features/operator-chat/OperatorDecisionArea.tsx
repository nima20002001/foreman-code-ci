import type { OperatorConversationState } from '@foreman-code/contracts'
import { Alert, Button } from '../../shared/ui/nocturne'
import { identityEpoch } from '../../shared/api/protectedChatStorage'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { discardDefinitivelyRejectedOperatorMessage, type readPendingOperatorMessage } from './operatorOutbox'
import { useOperatorChatStore } from './operatorChatStore'
import type { PreparationError, RefreshOutbox } from './operatorChatShared'
import type { useOperatorAttachmentReceipts } from './useOperatorAttachmentReceipts'
import type { useOperatorConversationMutations } from './useOperatorConversationMutations'
import type { useOperatorSendMutation } from './useOperatorSendMutation'
import type { Dispatch, SetStateAction } from 'react'

/** Pending approval status, failures and the pending-message recovery actions. */
export function OperatorDecisionArea({ conversation, selectedId, requestId, retired, pending, sendError, send, respond, cancel,
  attachmentReceipts, setPreparationError, refreshOutbox }: {
  conversation: OperatorConversationState
  selectedId: string | undefined
  requestId: string | null | undefined
  retired: boolean
  pending: ReturnType<typeof readPendingOperatorMessage>
  sendError: string | undefined
  send: ReturnType<typeof useOperatorSendMutation>
  respond: ReturnType<typeof useOperatorConversationMutations>['respond']
  cancel: ReturnType<typeof useOperatorConversationMutations>['cancel']
  attachmentReceipts: ReturnType<typeof useOperatorAttachmentReceipts>
  setPreparationError: Dispatch<SetStateAction<PreparationError>>
  refreshOutbox: RefreshOutbox
}) {
  const respondVariables = respond.variables
  const cancelVariables = cancel.variables
  if (!(conversation.pendingInteraction || conversation.error || pending.error || pending.command || sendError
    || (respondVariables?.id === selectedId && respond.error) || (cancelVariables?.id === selectedId && cancel.error))) return null
  return <div className="operator-chat-decision-area">
    {conversation.pendingInteraction && !conversation.responseAvailability?.available ? <p role="status">{conversation.responseAvailability?.message ?? 'Refresh this conversation to check reply availability.'}</p> : null}
    {conversation.pendingInteraction && conversation.responseDelivery !== 'offered' ? <Alert tone="warning" title="Response delivery is being reconciled" /> : null}
    <div className="operator-chat-feedback">
      {conversation.error ? <Alert live tone="danger" title="Operator turn failed">{conversation.error}</Alert> : null}
      {respondVariables && respondVariables.id === selectedId && respondVariables.input.requestId === requestId && respond.error instanceof Error ? <Alert live tone="danger" title="Approval response failed">{respond.error.message}</Alert> : null}
      {cancelVariables && cancelVariables.id === selectedId && cancelVariables.requestId === requestId && cancel.error instanceof Error ? <Alert live tone="danger" title="Cancellation failed">{cancel.error.message}</Alert> : null}
      {pending.error ? <Alert live tone="danger" title="Pending message unavailable">{pending.error}</Alert> : null}
      {sendError ? <Alert live tone="danger" title="Message could not be sent">{sendError}</Alert> : null}
    </div>
    {!retired && pending.command ? <Button disabled={send.isPending && send.variables?.id === selectedId} loading={send.isPending && send.variables?.id === selectedId} onClick={() => {
      setPreparationError(undefined)
      send.mutate({ id: conversation.conversation.id, command: pending.command!, generation: sessionGeneration(), epoch: identityEpoch(), recoverFirst: true, navigationGeneration: useOperatorChatStore.getState().navigationGeneration })
    }}>Retry pending message</Button> : null}
    {!retired && pending.command && pending.definitiveFailure ? <Button variant="ghost" disabled={pending.inFlight || (send.isPending && send.variables?.id === selectedId)} onClick={() => {
      void discardDefinitivelyRejectedOperatorMessage(conversation.conversation.id, pending.command!.requestId).then((discarded) => {
        if (discarded) { attachmentReceipts.forget(pending.command!.requestId); send.reset(); setPreparationError(undefined); refreshOutbox((value) => value + 1) }
      }).catch((error: unknown) => setPreparationError({ id: conversation.conversation.id,
        message: error instanceof Error ? error.message : 'The saved attempt could not be cleared.' }))
    }}>Clear rejected attempt and keep draft</Button> : null}
  </div>
}
