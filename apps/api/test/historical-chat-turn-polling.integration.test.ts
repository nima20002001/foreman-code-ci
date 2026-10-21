import { expect, it, vi } from 'vitest'
import { AgentChatStateSchema, agentChatFixtures } from '@foreman-code/contracts/agent-chat'
import { waitForHistoricalChatTurn } from './helpers/historicalChatPlacement.js'

it.each(['failed', 'canceled'] as const)('reports a %s historical chat turn on its first read', async delivery => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const state = structuredClone(agentChatFixtures.failed)
  state.turns[0]!.delivery = delivery
  const read = vi.fn(async () => state)
  const result = waitForHistoricalChatTurn(read, 'request-1', 'Worker chat fork completion')
    .catch(error => error as Error)
  try {
    await vi.advanceTimersByTimeAsync(90_001)
    expect(await result).toMatchObject({ message: expect.stringContaining(`${delivery}: NATIVE_TURN_FAILED`) })
    expect(read).toHaveBeenCalledTimes(1)
  } finally { vi.useRealTimers() }
})

it.each([30_001, 60_001])('waits for a historical native chat turn that completes after %i milliseconds', async delayMs => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const state = structuredClone(agentChatFixtures.active)
  const read = vi.fn(async () => state)
  let settled = false
  const result = waitForHistoricalChatTurn(read, 'request-1', 'Worker chat fork completion')
    .then(completed => { settled = true; return completed })
    .catch(error => error as Error)
  try {
    await vi.advanceTimersByTimeAsync(delayMs)
    expect(settled).toBe(false)
    const pendingReads = read.mock.calls.length
    state.turns[0]!.delivery = 'completed'
    await vi.advanceTimersToNextTimerAsync()
    expect(settled).toBe(true)
    expect(await result).toMatchObject({ turns: [expect.objectContaining({ delivery: 'completed' })] })
    expect(read).toHaveBeenCalledTimes(pendingReads + 1)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    await vi.advanceTimersByTimeAsync(90_001)
    await result
    vi.useRealTimers()
  }
})

it('bounds a pending native chat turn to ninety seconds', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  let settled = false
  const result = waitForHistoricalChatTurn(async () => agentChatFixtures.active, 'request-1', 'Worker chat fork completion')
    .catch(error => { settled = true; return error as Error })
  try {
    await vi.advanceTimersByTimeAsync(89_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(settled).toBe(true)
    expect(await result).toMatchObject({ message: 'Timed out waiting for Worker chat fork completion.' })
  } finally {
    await vi.advanceTimersByTimeAsync(90_001)
    await result
    vi.useRealTimers()
  }
})

it('reports a historical chat read error without polling again', async () => {
  const read = vi.fn(async () => { throw new Error('Chat read denied') })
  await expect(waitForHistoricalChatTurn(read, 'request-1', 'Worker chat fork completion')).rejects.toThrow('Chat read denied')
  expect(read).toHaveBeenCalledTimes(1)
})

it.each(['error', 'unavailable'] as const)('reports a %s historical chat session on its first read', async sessionState => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const state = AgentChatStateSchema.parse(agentChatFixtures.active)
  state.sessionState = sessionState
  state.availability = { canSend: false, reason: 'harness_unavailable', message: 'Native chat was rejected.' }
  expect(AgentChatStateSchema.parse(state).sessionState).toBe(sessionState)
  const read = vi.fn(async () => state)
  const result = waitForHistoricalChatTurn(read, 'request-1', 'Worker chat fork completion')
    .catch(error => error as Error)
  try {
    await vi.advanceTimersByTimeAsync(90_001)
    expect(await result).toMatchObject({ message: expect.stringContaining(`${sessionState}: harness_unavailable`) })
    expect(read).toHaveBeenCalledTimes(1)
  } finally {
    vi.useRealTimers()
  }
})
