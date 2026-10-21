import type { AgentIdentity, DeliveryTarget, WorkflowChatPostRequest } from '@foreman-code/contracts'
import type { UseQueryResult } from '@tanstack/react-query'
import { Button, Select } from '../../shared/ui/nocturne'
import { deliveryAction, type DeliveryPresentation } from '../conversations/delivery/deliveryAction'
import { sameDeliveryTarget } from './draft'
import { recipientProblem } from './recipientProblem'
import { agentLabel } from './mentions'

export type RecipientTargetOption = {
  target: DeliveryTarget
  label: string
  presentation: DeliveryPresentation
  deliveryTargetState?: 'existing' | 'not_created'
}
export type WorkflowTargetResolver = (agent: AgentIdentity, input: {
  signal: AbortSignal
  recovery?: 'outside_run' | 'historical_follow_up'
  sourceTarget?: DeliveryTarget
}) => Promise<RecipientTargetOption[]>
type Delivery = WorkflowChatPostRequest['deliveries'][number]

export function RecipientTargetPicker({ agent, selection, result, onSelect, onIntent, onRemove }: {
  agent: AgentIdentity
  selection?: Delivery
  result: UseQueryResult<RecipientTargetOption[]>
  onSelect(option: RecipientTargetOption): void
  onIntent(intent: Delivery['intent']): void
  onRemove(): void
}) {
  const options = result.data ?? []
  const selected = selection ? options.findIndex(item => sameDeliveryTarget(item.target, selection.target)) : -1
  const option = options[selected]
  const problem = recipientProblem(selection, result)
  return <fieldset className="workflow-chat-recipient">
    <legend>{agentLabel(agent)}</legend>
    <Select label={`Target for ${agent.displayName}`} value={selected < 0 ? '' : String(selected)}
      options={[{ value: '', label: 'Choose a target', disabled: true }, ...options.map((item, index) => ({
        value: String(index), label: `${item.label}${item.deliveryTargetState === 'not_created' ? ' · New conversation on send' : ''}`,
      }))]} disabled={result.isPending}
      onChange={event => { const item = options[Number(event.target.value)]; if (item) onSelect(item) }} />
    {selection ? <Select label={`Delivery for ${agent.displayName}`} value={selection.intent}
      options={[
        { value: 'auto', label: option ? `Automatic · ${deliveryAction(option.presentation, 'auto').label}` : 'Automatic' },
        { value: 'next_turn', label: 'Queue next' }, { value: 'steer', label: 'Steer now' },
        { value: 'interrupt_and_send', label: 'Interrupt and send' },
      ]} onChange={event => {
        const intent = event.target.value
        if (intent === 'auto' || intent === 'next_turn' || intent === 'steer' || intent === 'interrupt_and_send') onIntent(intent)
      }} /> : null}
    {problem ? <p role="status">{problem}</p> : null}
    {result.isError ? <Button size="sm" onClick={() => void result.refetch()}>Retry targets</Button> : null}
    {selection && option && selection.expectedNativeTurnId !== option.presentation.nativeTurnId
      ? <Button size="sm" onClick={() => onSelect(option)}>Refresh target</Button> : null}
    <Button size="sm" onClick={onRemove}>Remove recipient</Button>
  </fieldset>
}
