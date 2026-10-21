import { useRef, useState, type ReactNode, type RefObject } from 'react'
import { parseSessionCommand, type ChatDeliveryIntent, type DeliveryTarget, type SessionMode } from '@foreman-code/contracts'
import type { AgentChatState } from '@foreman-code/contracts/agent-chat'
import type { ConversationAttachments } from '../../attachments'
import { Button } from '../../../shared/ui/nocturne'
import type { ComposerSessionControls } from '../sessionControls/useSessionControls'
import { useConversationDraftStore } from '../conversationDraftStore'
import { prepareChatAttachments, type ChatAttachmentAttempt } from '../chatAttachmentAttempt'
import { ChatDeliveryActions } from '../delivery/ChatDeliveryActions'
import { deliveryAction } from '../delivery/deliveryAction'
import { ChatDeliveryReceipts } from '../delivery/ChatDeliveryReceipts'
import { RetainedDeliveryInputs, type DirectRecovery } from '../delivery/RetainedDeliveryInputs'
import { useChatDelivery } from '../delivery/useChatDelivery'
import { useDeliveryDraftPin } from '../delivery/useDeliveryDraftPin'
import { AgentChatComposer } from './AgentChatComposer'

export function CanonicalAgentComposer({ state, name, draftKey, inputRef, attachments, sessionControls,
  attachmentControl, actions, writeReason, onSessionCommand, refresh, target, onDenied, onRecover }: {
  state: AgentChatState; name: string; draftKey: string
  inputRef: RefObject<HTMLTextAreaElement | null>; attachments: ConversationAttachments
  sessionControls: ComposerSessionControls; attachmentControl?: ReactNode; actions?: ReactNode
  writeReason?: string; onSessionCommand(content: string, mode?: SessionMode): void; refresh(): void
  target?: DeliveryTarget; onDenied(error: Error): void
  onRecover?(recovery: DirectRecovery): void
}) {
  const draft = useConversationDraftStore(store => store.drafts[draftKey] ?? '')
  const [intent, setIntent] = useState<ChatDeliveryIntent>('auto')
  const attempted = useRef<{ content: string; version: number; files: ChatAttachmentAttempt } | undefined>(undefined)
  const delivery = useChatDelivery(target, !writeReason, `${state.sessionState}:${state.activeTurn?.requestId ?? ''}`, (_receipt, request) => {
    if (attempted.current?.content === request.content) {
      useConversationDraftStore.getState().clearExactDraft(draftKey, request.content, attempted.current.version)
      attempted.current.files.acknowledge?.()
    }
    refresh()
  }, { onDenied })
  const pin = useDeliveryDraftPin(draftKey, target, delivery.presentation.nativeTurnId, !!draft || attachments.hasAttachments)
  const command = parseSessionCommand(draft)
  const mode = command.kind === 'plan-task' ? 'plan' : sessionControls.state?.desiredMode
  const presentation = { ...delivery.presentation, hasAttachments: attachments.hasAttachments,
    changesMode: !!mode && sessionControls.state?.appliedMode !== mode }
  const controlsReason = !delivery.online ? 'You are offline. Controls are unavailable.' : undefined
  const reason = writeReason ?? (command.kind === 'invalid' ? command.message : delivery.pendingControl ? 'Confirm the original Stop or queue control before sending.' : pin.stale ? 'The selected target changed. Refresh the target to send this draft.' : !target ? 'No available target. Refresh this conversation.' : !delivery.online ? 'You are offline. Your draft is kept.' : undefined)
  const action = deliveryAction(presentation, intent)
  const submit = (content = draft, selectedMode = mode) => {
    const parsed = parseSessionCommand(content)
    if (parsed.kind === 'new' || parsed.kind === 'compact' || parsed.kind === 'mode') { onSessionCommand(content, selectedMode); return }
    if (reason || action.reason || delivery.busy || delivery.pending) return
    const files = prepareChatAttachments(attachments)
    if (!files || !content.trim() && !files.attachments.length) return
    attempted.current = { content, files, version: useConversationDraftStore.getState().versions[draftKey] ?? 0 }
    delivery.submit({ content, intent, ...(selectedMode ? { sessionMode: selectedMode } : {}),
      ...(intent !== 'next_turn' && pin.pin?.nativeTurnId ? { expectedNativeTurnId: pin.pin.nativeTurnId } : {}),
      ...(files.attachments.length ? { attachments: [...files.attachments] } : {}) })
  }
  const receipts = delivery.state?.receipts ?? []
  return <>
    {pin.stale ? <Button onClick={pin.refresh}>Refresh target</Button> : null}
    {delivery.feedback ? <p role="alert">{delivery.feedback}</p> : null}
    {delivery.pendingControl ? <p role="status">Control is not confirmed. <Button disabled={delivery.busy || !delivery.online}
      onClick={delivery.retryControl}>Retry original control</Button></p> : null}
    {delivery.pending ? <p role="status">Delivery is not confirmed. <Button onClick={() => void delivery.reconcile()}>Check status</Button>
      <Button onClick={() => void delivery.reconcile(true)}>Retry original message</Button></p> : null}
    <ChatDeliveryReceipts receipts={receipts} controlsReason={controlsReason} onCancel={delivery.pendingControl ? undefined : receipt => delivery.cancel(receipt.id)} onRefresh={delivery.refresh} />
    {target && !delivery.denied ? <RetainedDeliveryInputs target={target} receipts={receipts} onDenied={delivery.revoke}
      representedCommandIds={[...state.messages.filter(message => message.role === 'user').flatMap(message => message.requestId ? [message.requestId] : []),
        ...state.turns.map(turn => turn.requestId)]}
      controlsReason={controlsReason} onRecover={onRecover} onRefresh={delivery.refresh}
      onCancel={delivery.pendingControl ? undefined : receipt => delivery.cancel(receipt.id)} /> : null}
    <AgentChatComposer name={name} draftKey={draftKey} inputRef={inputRef} disabled={false}
      reason={reason ?? action.reason} controlReason={writeReason} pending={delivery.busy || !!delivery.pending}
      controlPending={sessionControls.mutation.isPending} hasAttachments={attachments.hasAttachments}
      attachmentControl={attachmentControl} actions={actions} canStop={false} onStop={delivery.stop} onSubmit={submit}
      deliveryActions={<ChatDeliveryActions presentation={presentation} intent={intent} onIntentChange={setIntent}
        controlsReason={controlsReason}
        pending={delivery.busy || !!delivery.pending} empty={!draft.trim() && !attachments.hasAttachments || attachments.hasBlockingAttachments}
        reason={reason} onSubmit={() => submit()} onStop={!delivery.pendingControl && presentation.state === 'active' ? delivery.stop : undefined}
        onCancelQueued={delivery.pendingControl ? undefined : delivery.cancelAll} queueCount={receipts.filter(receipt => receipt.state === 'queued').length} />} />
  </>
}
