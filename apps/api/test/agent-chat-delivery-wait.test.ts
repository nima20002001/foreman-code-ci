import type { AgentChatTurn } from '@foreman-code/contracts/agent-chat'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentChatEvents } from '../src/modules/conversations/agentChat.js'
import { waitForDelivery } from './helpers/agentChatDelivery.js'
import { rejectableDeferred } from './helpers/deferred.js'

afterEach(() => { vi.useRealTimers() })

function turn(delivery: AgentChatTurn['delivery']): AgentChatTurn {
  return {
    requestId: 'first', sequence: '1', intent: 'next_turn', delivery, messageId: 'message-first',
    createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z',
  }
}

it('waits for committed delivery without polling during native startup or streamed text', async () => {
  vi.useFakeTimers()
  const events = new AgentChatEvents()
  let delivery: AgentChatTurn['delivery'] = 'submitting'
  const repository = { turn: vi.fn(async () => turn(delivery)), get: async () => undefined }
  const pending = waitForDelivery({ events }, repository, 'chat', 'first', 'completed')
  await vi.advanceTimersByTimeAsync(29_000)
  for (let index = 0; index < 100; index += 1) {
    events.publish('chat', 'delta', { requestId: 'first', text: 'partial' })
    events.publish('chat', 'state', { requestId: 'other', delivery: 'accepted' })
  }
  expect(repository.turn).toHaveBeenCalledTimes(1)
  delivery = 'completed'
  events.publish('chat', 'state', { requestId: 'first', delivery })
  await pending
  expect(repository.turn).toHaveBeenCalledTimes(2)
  events.publish('chat', 'state', { requestId: 'first', delivery })
  expect(repository.turn).toHaveBeenCalledTimes(2)
})

it('does not lose a completion published while its first snapshot is being read', async () => {
  const snapshot = rejectableDeferred<AgentChatTurn>()
  const events = new AgentChatEvents()
  const repository = { turn: vi.fn(async () => turn('completed')), get: async () => undefined }
  repository.turn.mockImplementationOnce(() => snapshot.promise)
  const pending = waitForDelivery({ events }, repository, 'chat', 'first', 'completed')
  events.publish('chat', 'turn', { requestId: 'first', delivery: 'accepted' })
  events.publish('chat', 'state', { requestId: 'first', delivery: 'completed' })
  expect(repository.turn).toHaveBeenCalledTimes(1)
  snapshot.resolve(turn('submitting'))
  await pending
  expect(repository.turn).toHaveBeenCalledTimes(2)
})

it('reads an already completed turn even when its notification preceded subscription', async () => {
  const events = new AgentChatEvents()
  events.publish('chat', 'state', { requestId: 'first', delivery: 'completed' })
  const repository = { turn: async () => turn('completed'), get: async () => undefined }
  await waitForDelivery({ events }, repository, 'chat', 'first', 'completed')
})

it('rejects a different persisted terminal outcome', async () => {
  const repository = { turn: async () => turn('failed'), get: async () => undefined }
  await expect(waitForDelivery({ events: new AgentChatEvents() }, repository, 'chat', 'first', 'completed'))
    .rejects.toThrow('Expected completed for first')
})

it('keeps the original thirty-second deadline when startup never completes', async () => {
  vi.useFakeTimers()
  const repository = { turn: async () => turn('submitting'), get: async () => undefined }
  const pending = waitForDelivery({ events: new AgentChatEvents() }, repository, 'chat', 'first', 'completed')
  const rejected = expect(pending).rejects.toThrow('No persisted completed result for first')
  await vi.advanceTimersByTimeAsync(30_000)
  await rejected
})

it('honors a shorter delivery deadline without polling', async () => {
  vi.useFakeTimers()
  const repository = { turn: vi.fn(async () => turn('submitting')), get: async () => undefined }
  const pending = waitForDelivery({ events: new AgentChatEvents() }, repository,
    'chat', 'first', 'completed', { timeoutMs: 1_000 })
  const rejected = expect(pending).rejects.toThrow('No persisted completed result for first')
  await vi.advanceTimersByTimeAsync(999)
  expect(repository.turn).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  await rejected
})
