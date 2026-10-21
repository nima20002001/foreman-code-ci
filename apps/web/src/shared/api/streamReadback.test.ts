import { afterEach, expect, it, vi } from 'vitest'
import { createStreamReadback } from './streamReadback'
afterEach(() => vi.useRealTimers())
it('coalesces bursts and reads again when a commit arrives during GET', async () => {
  vi.useFakeTimers()
  let finish!: () => void
  const read = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
  const owner = createStreamReadback(read)
  owner.request(); owner.request(); await vi.advanceTimersByTimeAsync(100)
  expect(read).toHaveBeenCalledOnce()
  owner.request(); finish(); await vi.advanceTimersByTimeAsync(100)
  expect(read).toHaveBeenCalledTimes(2)
  owner.dispose(); finish(); await vi.runAllTimersAsync()
  expect(read).toHaveBeenCalledTimes(2)
})
it('disposal prevents pending and late callbacks from issuing another read', async () => {
  vi.useFakeTimers()
  const read = vi.fn(async () => {})
  const owner = createStreamReadback(read)
  owner.request(); owner.dispose(); owner.request(); await vi.runAllTimersAsync()
  expect(read).not.toHaveBeenCalled()
})
