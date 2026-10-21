import { afterEach, expect, it, vi } from 'vitest'
import { readUntil } from './helpers/observableCondition.js'

afterEach(() => vi.useRealTimers())

it('waits for committed native changes without repeatedly requesting reconciliation', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  let ready = false
  const read = vi.fn(async () => ready)
  const listeners = new Set<() => void>()
  const pending = readUntil(read, value => value, {
    timeoutMs: 2000,
    description: 'committed native interaction',
    minimumReadIntervalMs: 1_000,
    subscribe: changed => {
      listeners.add(changed)
      return () => { listeners.delete(changed) }
    },
  })
  await vi.advanceTimersByTimeAsync(100)
  expect(read).toHaveBeenCalledTimes(1)
  ready = true
  for (const changed of listeners) changed()
  await vi.advanceTimersByTimeAsync(899)
  expect(read).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  await expect(pending).resolves.toBe(true)
  expect(read).toHaveBeenCalledTimes(2)
  expect(listeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('rechecks native progress without a commit notification at the polling deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  let ready = false
  const read = vi.fn(async () => ready)
  const pending = readUntil(read, value => value, {
    timeoutMs: 2000,
    description: 'external native progress',
    minimumReadIntervalMs: 1_000,
    subscribe: () => () => {},
  })
  await vi.advanceTimersByTimeAsync(100)
  expect(read).toHaveBeenCalledTimes(1)
  ready = true
  await vi.advanceTimersByTimeAsync(899)
  expect(read).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  await expect(pending).resolves.toBe(true)
  expect(read).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})
