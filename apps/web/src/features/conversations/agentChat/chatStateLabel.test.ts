import { expect, it } from 'vitest'
import { agentChatFixtures } from '@foreman-code/contracts/agent-chat'
import { agentChatStateLabel } from './chatStateLabel'

it.each([
  ['Starting', 'Starting'],
  ['Queued', 'Starting'],
  ['Running', 'Working'],
  ['Waiting', 'Working'],
  ['Looping · loop 3', 'Looping · loop 3'],
  ['Completed', 'Completed'],
  ['Failed', 'Failed'],
])('shows %s from the selected Run before an execution transcript arrives', (runLabel, expected) => {
  const state = structuredClone(agentChatFixtures.empty)
  state.context.runId = 'selected-run'
  state.availability = { canSend: false, reason: 'run_active' }
  expect(agentChatStateLabel(state, runLabel)).toBe(expected)
})

it('does not claim an uncertain submission is idle', () => {
  const state = structuredClone(agentChatFixtures.unknownDelivery)
  state.activeTurn = null
  state.sessionState = 'uncertain'
  expect(agentChatStateLabel(state)).toBe('Working')
})
