import { expect, it } from 'vitest'
import { agentChatFixtures } from '@foreman-code/contracts/agent-chat'

it('loads the delivery client and validates conversation readbacks without removing engine lineage checks', async () => {
  const { deliveryReadSchema } = await import('./client')
  const target = { kind: 'agent_conversation', conversationId: 'conversation', agent: agentChatFixtures.empty.context }
  const state = { target, state: agentChatFixtures.empty, receipts: [],
    delivery: { state: 'idle', capabilities: { steer: 'unavailable', queue: true, interruptAndSend: false } } }
  expect(deliveryReadSchema.parse(state)).toEqual(state)
  expect(deliveryReadSchema.safeParse({ ...state, delivery: { ...state.delivery, state: 'invalid' } }).success).toBe(false)
})
