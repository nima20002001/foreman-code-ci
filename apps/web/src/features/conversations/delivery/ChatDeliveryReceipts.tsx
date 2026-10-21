import type { ChatDeliveryReceipt } from '@foreman-code/contracts'
import { deliveryTargetLabel } from './deliveryTargetLabel'
import { Button } from '../../../shared/ui/nocturne'

const intentLabels: Record<ChatDeliveryReceipt['requestedIntent'], string> = {
  auto: 'Automatic', steer: 'Steer now', next_turn: 'Next turn', interrupt_and_send: 'Interrupt and send',
}
const stateLabels: Record<ChatDeliveryReceipt['state'], string> = {
  queued: 'Queued', submitting: 'Sending', accepted: 'Delivered', completed: 'Completed',
  failed: 'Failed', canceled: 'Canceled', unknown: 'Delivery unconfirmed',
}

export function ChatDeliveryReceipts({ receipts, onCancel, onRefresh, onOpenPost, onOpenContinuation, onRecover, controlsReason }: {
  receipts: readonly ChatDeliveryReceipt[]
  onCancel?: (receipt: ChatDeliveryReceipt) => void
  onRefresh?: () => void
  onOpenPost?: (postId: string) => void
  onOpenContinuation?: (receipt: ChatDeliveryReceipt) => void
  onRecover?: (receipt: ChatDeliveryReceipt, choice: 'outside_run' | 'historical_follow_up') => void
  controlsReason?: string
}) {
  if (!receipts.length) return null
  return <ul className="chat-delivery-receipts" aria-label="Delivery receipts">
    {receipts.map(receipt => <li key={receipt.id}>
      <p><strong>{receipt.errorCode === 'TARGET_SETTLED' ? 'Not sent — selected turn ended' : stateLabels[receipt.state]}</strong>
        {' · '}{deliveryTargetLabel(receipt.target)}</p>
      <p>Requested: {intentLabels[receipt.requestedIntent]} · Applied: {intentLabels[receipt.appliedIntent]}</p>
      {receipt.consultationId ? <p>Reply {receipt.consultationId} · Delegated work continues independently.</p> : null}
      {receipt.errorCode && receipt.errorCode !== 'TARGET_SETTLED' ? <p>{receipt.errorCode}</p> : null}
      {receipt.continuationId && !receipt.continuationExecution ? <p>Changing direction · Waiting for the continuing execution.</p> : null}
      {receipt.continuationExecution ? <p>Continuing task · A new execution is available.
        {onOpenContinuation ? <Button size="sm" onClick={() => onOpenContinuation(receipt)}>Open continuation</Button> : null}</p> : null}
      <div className="n-actions">
        {receipt.state === 'queued' && onCancel ? <Button size="sm" disabled={!!controlsReason} title={controlsReason} onClick={() => onCancel(receipt)}>Cancel queued message</Button> : null}
        {receipt.state === 'unknown' && onRefresh ? <Button size="sm" onClick={onRefresh}>Check status</Button> : null}
        {receipt.replyPostId && onOpenPost ? <Button size="sm" onClick={() => onOpenPost(receipt.replyPostId!)}>Show reply</Button> : null}
        {receipt.errorCode === 'TARGET_SETTLED' && onRecover ? <>
          <Button size="sm" onClick={() => onRecover(receipt, 'outside_run')}>Send outside run</Button>
          {receipt.target.kind === 'workflow_execution' ? <Button size="sm"
            onClick={() => onRecover(receipt, 'historical_follow_up')}>Follow up on this run</Button> : null}
        </> : null}
      </div>
    </li>)}
  </ul>
}
