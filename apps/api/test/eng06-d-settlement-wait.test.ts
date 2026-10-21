import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForEng06Settlement, type Eng06SettlementProgress } from './helpers/eng06DSettlement.js'

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }))
afterEach(() => vi.useRealTimers())
const running = (): Eng06SettlementProgress => ({ state: 'running', cleanupPending: false,
  executions: [{ id: 'execution-1', state: 'running', accepted: false }] })

// Pure test-wait logic. No fake Run result, native receipt or retry admission.
describe('ENG06-D bounded settlement wait', () => {
  it('uses the configured polling interval without waiting for the default pause', async () => {
    const task = waitForEng06Settlement(async () => ({ ...running(),
      state: performance.now() >= 50 ? 'completed' : 'running' }), { pollIntervalMs: 50 })
    let done = false
    void task.then(() => { done = true })
    await vi.advanceTimersByTimeAsync(49)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(task).resolves.toBeUndefined()
    expect(performance.now()).toBe(50)
  })

  it('requires completed AND cleanup settled, not just a terminal state', async () => {
    const task = waitForEng06Settlement(async () => ({ ...running(), state: 'completed',
      cleanupPending: performance.now() < 1000 }))
    let done = false
    void task.then(() => { done = true })
    await vi.advanceTimersByTimeAsync(500)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    await expect(task).resolves.toBeUndefined()
  })

  it('allows genuine execution progress past the old whole-Run 20s deadline', async () => {
    const task = waitForEng06Settlement(async () => {
      const stage = Math.floor(performance.now() / 12000)
      return { state: stage >= 3 ? 'completed' : 'running', cleanupPending: false,
        executions: [{ id: 'execution-1', state: stage === 0 ? 'starting' : stage === 1 ? 'running' : 'completed',
          accepted: stage >= 2 }] }
    })
    await vi.advanceTimersByTimeAsync(36000)
    await expect(task).resolves.toBeUndefined()
  })

  it('fails a stuck Run after 20s even when every probe returns fresh objects', async () => {
    const task = waitForEng06Settlement(async () => running())
    const rejected = expect(task).rejects.toThrow('ENG06_SETTLEMENT_STALLED')
    await vi.advanceTimersByTimeAsync(20000)
    await rejected
    expect(performance.now()).toBe(20000)
  })

  it('does not mistake row ordering for durable progress', async () => {
    let reverse = false
    const task = waitForEng06Settlement(async () => {
      const rows = [running().executions[0]!, { id: 'execution-2', state: 'queued', accepted: false }]
      reverse = !reverse
      return { ...running(), executions: reverse ? rows.reverse() : rows }
    })
    const rejected = expect(task).rejects.toThrow('ENG06_SETTLEMENT_STALLED')
    await vi.advanceTimersByTimeAsync(20000)
    await rejected
  })

  it('cannot wait forever even if the observed work keeps changing', async () => {
    const task = waitForEng06Settlement(async () => ({ ...running(), executions: [
      { id: `execution-${Math.floor(performance.now() / 10000)}`, state: 'running', accepted: false },
    ] }))
    const rejected = expect(task).rejects.toThrow('ENG06_SETTLEMENT_DEADLINE')
    await vi.advanceTimersByTimeAsync(120000)
    await rejected
    expect(performance.now()).toBe(120000)
  })

  it('propagates a database/probe failure rather than masking it as a timeout', async () => {
    const error = new Error('original database failure')
    const probe = vi.fn(async () => { throw error })
    await expect(waitForEng06Settlement(probe)).rejects.toBe(error)
    expect(probe).toHaveBeenCalledTimes(1)
  })
})
