import { useRef, useState, type ReactNode } from 'react'
import { parseSessionCommand, type ChatDeliveryIntent, type OperatorConversationState } from '@foreman-code/contracts'
import { Button } from '../../shared/ui/nocturne'
import type { useFileDrop } from '../../shared/ui/useFileDrop'
import type { ConversationAttachments } from '../attachments'
import { useConversationDraftStore } from '../conversations/conversationDraftStore'
import { prepareChatAttachments, type ChatAttachmentAttempt } from '../conversations/chatAttachmentAttempt'
import type { ComposerSessionControls } from '../conversations/sessionControls/useSessionControls'
import { ChatDeliveryActions } from '../conversations/delivery/ChatDeliveryActions'
import { deliveryAction } from '../conversations/delivery/deliveryAction'
import { ChatDeliveryReceipts } from '../conversations/delivery/ChatDeliveryReceipts'
import { RetainedDeliveryInputs } from '../conversations/delivery/RetainedDeliveryInputs'
import { useChatDelivery } from '../conversations/delivery/useChatDelivery'
import { useDeliveryDraftPin } from '../conversations/delivery/useDeliveryDraftPin'
import { OperatorComposer } from './OperatorComposer'

/** Canonical Operator composer used by the shared rail; legacy API clients retain their defaults. */
export function CanonicalOperatorComposer({ conversation, attachments, sessionControls, context, attachmentControl,
  fileDropProps, reason: unavailable, onNewChat, onDenied, refresh }: {
  conversation: OperatorConversationState; attachments: ConversationAttachments; sessionControls: ComposerSessionControls
  context?: ReactNode; attachmentControl?: ReactNode; fileDropProps?: ReturnType<typeof useFileDrop>['dropTargetProps']
  reason?: string; onNewChat(): void; onDenied(error: Error): void; refresh(): void
}) {
  const id = conversation.conversation.id, draft = useConversationDraftStore(store => store.drafts[id] ?? '')
  const [intent, setIntent] = useState<ChatDeliveryIntent>('auto')
  const attempt = useRef<{ content: string; version: number; files: ChatAttachmentAttempt } | undefined>(undefined)
  const target = { kind: 'operator_conversation' as const, conversationId: id }
  const delivery = useChatDelivery(target, true, `${conversation.turnState}:${conversation.activeRequestId ?? ''}`, (_receipt, request) => {
    if (attempt.current?.content === request.content) {
      useConversationDraftStore.getState().clearExactDraft(id, request.content, attempt.current.version)
      attempt.current.files.acknowledge?.()
    }
    refresh()
  }, { onDenied })
  const pin = useDeliveryDraftPin(id, target, delivery.presentation.nativeTurnId, !!draft || attachments.hasAttachments)
  const parsed = parseSessionCommand(draft), mode = parsed.kind === 'plan-task' ? 'plan' : sessionControls.state?.desiredMode
  const presentation = { ...delivery.presentation, hasAttachments: attachments.hasAttachments,
    changesMode: !!mode && sessionControls.state?.appliedMode !== mode }
  const reason = unavailable ?? (delivery.pendingControl ? 'Confirm the original Stop or queue control before sending.' : !delivery.online ? 'You are offline. Your draft is kept.' : pin.stale ? 'The selected turn changed. Refresh the target to send this draft.' : undefined)
  const action = deliveryAction(presentation, intent), receipts = delivery.state?.receipts ?? []
  const controlsReason = !delivery.online ? 'You are offline. Controls are unavailable.' : undefined
  return <>
    {pin.stale ? <Button onClick={pin.refresh}>Refresh target</Button> : null}
    {delivery.feedback ? <p role="alert">{delivery.feedback}</p> : null}
    {delivery.pendingControl ? <p role="status">Control is not confirmed. <Button disabled={delivery.busy || !delivery.online}
      onClick={delivery.retryControl}>Retry original control</Button></p> : null}
    {delivery.pending ? <p role="status">Delivery is not confirmed. <Button onClick={() => void delivery.reconcile()}>Check status</Button>
      <Button onClick={() => void delivery.reconcile(true)}>Retry original message</Button></p> : null}
    <ChatDeliveryReceipts receipts={receipts} controlsReason={controlsReason} onCancel={delivery.pendingControl ? undefined : receipt => delivery.cancel(receipt.id)} onRefresh={delivery.refresh} />
    {!delivery.denied ? <RetainedDeliveryInputs target={target} receipts={receipts} onDenied={delivery.revoke}
      representedCommandIds={conversation.messages.filter(message => message.role === 'user').flatMap(message => message.requestId ? [message.requestId] : [])} controlsReason={controlsReason}
      onRefresh={delivery.refresh} onCancel={delivery.pendingControl ? undefined : receipt => delivery.cancel(receipt.id)} /> : null}
    <OperatorComposer conversationId={id} sessionControls={sessionControls} context={context} attachmentControl={attachmentControl}
      fileDropProps={fileDropProps} hasAttachments={attachments.hasAttachments} onNewChat={onNewChat}
      sendDisabled={!!reason || !!action.reason || attachments.hasBlockingAttachments || !!delivery.pending}
      isSending={delivery.busy} onSubmit={(content, selectedMode = mode) => {
        if (reason || action.reason || delivery.busy || delivery.pending) return
        const files = prepareChatAttachments(attachments)
        if (!files || !content.trim() && !files.attachments.length) return
        attempt.current = { content, files, version: useConversationDraftStore.getState().versions[id] ?? 0 }
        delivery.submit({ content, intent, ...(selectedMode ? { sessionMode: selectedMode } : {}),
          ...(intent !== 'next_turn' && pin.pin?.nativeTurnId ? { expectedNativeTurnId: pin.pin.nativeTurnId } : {}),
          ...(files.attachments.length ? { attachments: [...files.attachments] } : {}) })
      }} deliveryActions={submit => <ChatDeliveryActions presentation={presentation} intent={intent} onIntentChange={setIntent}
        controlsReason={controlsReason}
        pending={delivery.busy || !!delivery.pending} empty={!draft.trim() && !attachments.hasAttachments || attachments.hasBlockingAttachments}
        reason={reason} onSubmit={submit} onStop={!delivery.pendingControl && presentation.state === 'active' ? delivery.stop : undefined}
        onCancelQueued={delivery.pendingControl ? undefined : delivery.cancelAll} queueCount={receipts.filter(receipt => receipt.state === 'queued').length} />} />
  </>
}
