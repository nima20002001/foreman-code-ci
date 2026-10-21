import { Check, CircleAlert, LoaderCircle, Minus } from 'lucide-react'
import type { AgentChatTurn } from '@foreman-code/contracts/agent-chat'
import { Tooltip } from '../../../shared/ui/nocturne'
import { deliveryLabels, intentLabels } from './model'

export function ChatDeliveryState({ delivery, turn, initialDelivery }: {
  delivery: AgentChatTurn['delivery']; turn?: AgentChatTurn; initialDelivery?: AgentChatTurn['delivery']
}) {
  const sending = delivery === 'queued' || delivery === 'submitting'
  const failed = delivery === 'failed' || delivery === 'unknown'
  let glyph = <Check size={12} aria-hidden="true" />
  if (sending) glyph = <LoaderCircle size={12} aria-hidden="true" />
  if (failed) glyph = <CircleAlert size={12} aria-hidden="true" />
  if (delivery === 'canceled') glyph = <Minus size={12} aria-hidden="true" />
  const details = [deliveryLabels[delivery],
    initialDelivery && initialDelivery !== delivery ? `Initial acknowledgement: ${deliveryLabels[initialDelivery]}` : '', turn ? intentLabels[turn.intent] : '', turn?.error?.message,
    delivery === 'accepted' ? 'Provider acknowledged delivery; consumption is not yet confirmed.' : '',
    delivery === 'unknown' ? 'The original may have been accepted. Sending again can repeat work.' : '',
  ].filter(Boolean).join(' · ')
  return <Tooltip content={details}>
    <span className="agent-chat-delivery" data-delivery={delivery} tabIndex={0}
      aria-label={deliveryLabels[delivery]}>{glyph}</span>
  </Tooltip>
}
