import { afterEach, expect, it, vi } from 'vitest'
import { readUntil } from './observableCondition.js'

afterEach(() => vi.useRealTimers())

it('bounds reconciliation reads when their own writes publish change notifications', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  let ready = false
  let changed!: () => void
  const read = vi.fn(async () => {
    if (!ready) setTimeout(changed, 25)
    return ready
  })
  const options = {
    timeoutMs: 3_000,
    description: 'reserved remote review decision',
    minimumReadIntervalMs: 1_000,
    subscribe: (notify: () => void) => {
      changed = notify
      return () => undefined
    },
  }
  const result = readUntil(read, Boolean, options)
  await vi.advanceTimersByTimeAsync(999)
  expect(read).toHaveBeenCalledTimes(1)
  ready = true
  await vi.advanceTimersByTimeAsync(1)
  await expect(result).resolves.toBe(true)
  expect(read).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

it('bounds polling traffic while awaiting native fixture progress', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  let ready = false
  const read = vi.fn(async () => ready)
  const result = readUntil(read, Boolean, { timeoutMs: 1_000, description: 'native fixture readiness' })
  await vi.advanceTimersByTimeAsync(100)
  expect(read.mock.calls.length).toBeLessThanOrEqual(5)
  ready = true
  await vi.advanceTimersByTimeAsync(25)
  await expect(result).resolves.toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps the deadline when a polling interval would extend past it', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const result = readUntil(async () => false, Boolean, { timeoutMs: 10, description: 'unavailable fixture' })
  const rejected = expect(result).rejects.toThrow('Timed out waiting for unavailable fixture.')
  await vi.advanceTimersByTimeAsync(10)
  await rejected
  expect(vi.getTimerCount()).toBe(0)
})

it('observes subscribed changes without waiting for a polling interval', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  let changed!: () => void
  let ready = false
  const unsubscribe = vi.fn()
  const read = vi.fn(async () => ready)
  const result = readUntil(read, Boolean, { timeoutMs: 1_000, description: 'published fixture',
    subscribe: notify => { changed = notify; return unsubscribe },
  })
  await vi.advanceTimersByTimeAsync(0)
  ready = true
  changed()
  await expect(result).resolves.toBe(true)
  expect(read).toHaveBeenCalledTimes(2)
  expect(unsubscribe).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

it.each([
  { interval: {}, pollingMs: 25 },
  { interval: { minimumReadIntervalMs: 1_000 }, pollingMs: 1_000 },
])('rechecks subscribed conditions without a commit notification after $pollingMs ms', async ({ interval, pollingMs }) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  let ready = false
  const unsubscribe = vi.fn()
  const read = vi.fn(async () => ready)
  const result = readUntil(read, Boolean, {
    timeoutMs: 2_000, description: 'native retry readiness', subscribe: () => unsubscribe,
    ...interval,
  })
  await vi.advanceTimersByTimeAsync(0)
  ready = true
  await vi.advanceTimersByTimeAsync(pollingMs - 1)
  expect(read).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(read).toHaveBeenCalledTimes(2)
  await expect(result).resolves.toBe(true)
  expect(unsubscribe).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps waiting while the observed value progresses past the stall deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const started = performance.now()
  const read = vi.fn(async () => Math.floor((performance.now() - started) / 50))
  const result = readUntil(read, step => step >= 6, {
    timeoutMs: 100, description: 'progressing Run', progress: step => step,
  })
  const resolved = expect(result).resolves.toBe(6)
  await vi.advanceTimersByTimeAsync(400)
  await resolved
  expect(vi.getTimerCount()).toBe(0)
})

it('times out once the observed value stops progressing', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const started = performance.now()
  const read = vi.fn(async () => Math.min(2, Math.floor((performance.now() - started) / 50)))
  let settled = false
  const result = readUntil(read, step => step >= 6, {
    timeoutMs: 100, description: 'stalled Run', progress: step => step,
  }).finally(() => { settled = true })
  const rejected = expect(result).rejects.toThrow('Timed out waiting for stalled Run. No progress for 100 ms; last progress: 2')
  await vi.advanceTimersByTimeAsync(150)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(100)
  await rejected
  expect(vi.getTimerCount()).toBe(0)
})

it('observes subscribed external progress before a short deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const started = performance.now()
  let ready = false
  let completedAfter: number | undefined
  const unsubscribe = vi.fn()
  const read = vi.fn(async () => ready)
  setTimeout(() => { ready = true }, 10)
  const result = readUntil(read, Boolean, {
    timeoutMs: 100,
    description: 'external fixture progress',
    subscribe: () => unsubscribe,
  }).then(value => {
    completedAfter = performance.now() - started
    return value
  })
  await vi.advanceTimersByTimeAsync(100)
  await expect(result).resolves.toBe(true)
  expect(completedAfter).toBe(25)
  expect(read).toHaveBeenCalledTimes(2)
  expect(unsubscribe).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})
