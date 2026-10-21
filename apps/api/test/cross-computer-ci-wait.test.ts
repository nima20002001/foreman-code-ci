import { afterEach, expect, it, vi } from 'vitest'
import { waitForCi } from './helpers/crossComputerCiWait.js'

afterEach(() => vi.useRealTimers())

it.each(['readiness', 'activity', 'publication'])('waits for delayed %s with one deadline', async label => {
  vi.useFakeTimers()
  const read = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true)
  const pending = waitForCi(label, read, Boolean, { deadline: Date.now() + 100, intervalMs: 10 })
  await vi.runAllTimersAsync()
  await expect(pending).resolves.toBe(true)
  expect(read).toHaveBeenCalledTimes(3)
})

it('stops at its deadline and does not retry unexpected errors', async () => {
  vi.useFakeTimers()
  const read = vi.fn().mockResolvedValue(false)
  const pending = expect(waitForCi('activity', read, Boolean, {
    deadline: Date.now() + 25, intervalMs: 10,
  })).rejects.toThrow('activity')
  await vi.runAllTimersAsync()
  await pending
  expect(read).toHaveBeenCalledTimes(4)
  await expect(waitForCi('publication', async () => { throw new Error('denied') }, Boolean, {
    deadline: Date.now() + 100,
  })).rejects.toThrow('denied')
})
