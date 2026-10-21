import { expect, it, vi } from 'vitest'
import { attemptCleanup } from './cleanup.js'

it('lets remote closure finish beyond the local cleanup deadline within its bounded budget', async () => {
  vi.useFakeTimers()
  const failures: Error[] = []
  try {
    const result = attemptCleanup(failures, 'remote closure', async signal => {
      await new Promise<void>(resolve => { setTimeout(resolve, 6_000) })
      signal.throwIfAborted()
      return 'closed'
    }, { timeoutMs: 120_000 })
    await vi.advanceTimersByTimeAsync(6_001)
    expect(await result).toBe('closed')
    expect(failures).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})

it('still cancels remote closure at the supplied deadline', async () => {
  vi.useFakeTimers()
  const failures: Error[] = []
  let signal: AbortSignal | undefined
  try {
    const result = attemptCleanup(failures, 'remote closure', async current => {
      signal = current
      return new Promise<never>((_resolve, reject) => {
        current.addEventListener('abort', () => reject(current.reason), { once: true })
      })
    }, { timeoutMs: 120_000 })
    await vi.advanceTimersByTimeAsync(120_001)
    expect(await result).toBeUndefined()
    expect(signal?.aborted).toBe(true)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.cause).toMatchObject({ message: 'Execution cleanup timed out.' })
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
