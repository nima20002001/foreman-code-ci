import { expect, it } from 'vitest'
import { chatStatus } from './chatStatus'
import { operatorTurnStatus } from '../operator-chat/operatorChatStatus'
import { operatorState } from '../operator-chat/pr17-test-fixtures'

it.each([
  ['interrupting', 'Stop requested—execution not yet confirmed stopped.'],
  ['uncertain', 'Delivery uncertain—may still be running.'],
  ['waiting_approval', 'Waiting for approval'],
  ['creating', 'Creating the native session'],
  ['active', 'Agent is working'],
  ['idle', 'Ready for a follow-up'],
] as const)('preserves %s execution facts separately from command and connection state', (phase, label) => {
  const status = chatStatus({ phase, delivery: 'Canceled', connection: 'reconnecting', hasConversation: true,
    actionUnavailable: 'Read only', error: 'Native turn not confirmed' })
  expect(status.execution).toBe(label)
  expect(status.delivery).toBe('Canceled')
  expect(status.connection).toContain('Connecting to activity updates')
  expect(status.actionUnavailable).toBe('Read only')
  expect(status.error).toBe('Native turn not confirmed')
  expect(status.execution).not.toBe('Stopped')
})

it.each(['canceling', 'uncertain'] as const)('uses the same %s explanation in Operator chat', phase => {
  const state = operatorState({ turnState: phase })
  const label = operatorTurnStatus(state, 'reconnecting')
  expect(label).toContain(phase === 'canceling'
    ? 'Stop requested—execution not yet confirmed stopped.' : 'Delivery uncertain—may still be running.')
  expect(label).toContain('Connecting to activity updates')
})

it('reports browser offline and live-stream loss without changing an idle execution', () => {
  const offline = chatStatus({ phase: 'idle', connection: 'offline', hasConversation: true })
  const unavailable = chatStatus({ phase: 'idle', connection: 'unavailable', hasConversation: true })
  expect(offline.execution).toBe('Ready for a follow-up')
  expect(offline.connection).toContain('Offline · draft kept')
  expect(unavailable.execution).toBe('Ready for a follow-up')
  expect(unavailable.connection).toContain('Waiting for activity updates.')
})


it('keeps a fresh polling snapshot quiet while the stream reconnects', () => {
  const status = chatStatus({ phase: 'active', connection: 'reconnecting', hasConversation: true, snapshotFresh: true })
  expect(status.connection).toBeUndefined()
  expect(status.execution).toBe('Agent is working')
  const offline = chatStatus({ phase: 'active', connection: 'offline', hasConversation: true, snapshotFresh: true })
  expect(offline.connection).toContain('Offline')
})
