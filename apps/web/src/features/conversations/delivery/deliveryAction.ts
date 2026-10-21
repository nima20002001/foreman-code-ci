import type { ChatDeliveryIntent, EngineChatReadback } from '@foreman-code/contracts'

export type DeliveryPresentation = Pick<EngineChatReadback, 'state' | 'capabilities'> & {
  nativeTurnId?: string
  hasAttachments?: boolean
  changesMode?: boolean
  unavailableReason?: string
}

export function deliveryAction(presentation: DeliveryPresentation, intent: ChatDeliveryIntent) {
  const { state, capabilities, hasAttachments, changesMode, unavailableReason } = presentation
  const active = state === 'active'
  const queue = active || state === 'queued' || state === 'starting'
  const steerReason = !active ? 'No active turn is selected.'
    : capabilities.steer !== 'native_expected_turn' ? 'Live steering is unavailable for this target.'
      : !presentation.nativeTurnId ? 'Waiting for the active turn identity.'
        : hasAttachments ? 'Files need a new turn.'
          : changesMode ? 'Changing mode needs a new turn.' : undefined
  const applied = intent === 'auto' ? active && !steerReason ? 'steer' : 'next_turn' : intent
  const reason = unavailableReason ?? (state === 'settling' ? 'Wait for this turn to stop.'
    : applied === 'steer' ? steerReason
      : applied === 'interrupt_and_send' && (!active || !capabilities.interruptAndSend)
        ? 'Interrupt and send is unavailable for this target.'
        : applied === 'next_turn' && !capabilities.queue ? 'Ordinary delivery is unavailable for this target.' : undefined)
  const label = applied === 'steer' ? 'Steer now'
    : applied === 'interrupt_and_send' ? 'Interrupt and send' : queue ? 'Queue next' : 'Send'
  return { applied, label, reason }
}

