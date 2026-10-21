import type { ChatDeliveryIntent } from '@foreman-code/contracts'
import { deliveryAction, type DeliveryPresentation } from './deliveryAction'
import { Button, Select } from '../../../shared/ui/nocturne'

/** Selecting an intent never submits. The primary button and composer Enter share one action. */
export function ChatDeliveryActions({ presentation, intent, onIntentChange, onSubmit, pending, empty, reason,
  onStop, stopReason, onCancelQueued, queueCount = 0, controlsReason }: {
  presentation: DeliveryPresentation
  intent: ChatDeliveryIntent
  onIntentChange(intent: ChatDeliveryIntent): void
  onSubmit(): void
  pending?: boolean
  empty?: boolean
  reason?: string
  onStop?: () => void
  stopReason?: string
  onCancelQueued?: () => void
  queueCount?: number
  controlsReason?: string
}) {
  const action = deliveryAction(presentation, intent)
  const disabledReason = reason ?? action.reason
  const options: Array<{ value: ChatDeliveryIntent; label: string }> = [
    { value: 'auto', label: 'Automatic' }, { value: 'next_turn', label: 'Queue next' },
    { value: 'steer', label: 'Steer now' }, { value: 'interrupt_and_send', label: 'Interrupt and send' },
  ]
  return <div className="chat-delivery-actions">
    <div className="n-actions" role="group" aria-label="Message delivery">
      <Select label="Delivery action" value={intent} options={options} disabled={pending}
        onChange={event => {
          const selected = options.find(option => option.value === event.target.value)
          if (selected) onIntentChange(selected.value)
        }} />
      <Button type="button" variant="primary" aria-label={action.label === 'Send' ? 'Send message' : undefined} loading={pending} disabled={pending || empty || !!disabledReason}
        onClick={onSubmit}>{action.label}</Button>
      {onStop ? <Button type="button" disabled={pending || !!stopReason || !!controlsReason} onClick={onStop}>Stop active turn</Button> : null}
      {onCancelQueued && queueCount > 0 ? <Button type="button" disabled={pending || !!controlsReason}
        onClick={onCancelQueued}>Cancel queued messages ({queueCount})</Button> : null}
    </div>
    {disabledReason ? <p role="status">{disabledReason}</p> : null}
    {intent === 'interrupt_and_send' ? <p>Stops this turn, then sends your message. Work already done stays.</p> : null}
    {stopReason ? <p>{stopReason}</p> : null}
    {controlsReason && controlsReason !== disabledReason ? <p role="status">{controlsReason}</p> : null}
  </div>
}
