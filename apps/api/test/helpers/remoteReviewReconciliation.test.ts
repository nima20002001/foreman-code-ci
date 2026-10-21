import { afterEach, expect, it, vi } from 'vitest'
import { remoteReviewReconciliation } from './remoteReviewReconciliation.js'

afterEach(() => vi.useRealTimers())

it('bounds reconciliation writes when commit notifications repeatedly wake a native review waiter', async () => {
  vi.useFakeTimers({ toFake: ['performance'] })
  const writes: number[] = []
  const reconcile = remoteReviewReconciliation(async () => { writes.push(performance.now()) })

  await reconcile()
  for (let notification = 0; notification < 100; notification++) await reconcile()
  expect(writes).toHaveLength(1)

  vi.advanceTimersByTime(1_000)
  await reconcile()
  expect(writes).toHaveLength(2)
})

it('shares unfinished reconciliation and retries a failed pass without waiting', async () => {
  let fail!: (error: Error) => void
  const failure = new Error('Fixture reconciliation failed')
  const pending = new Promise<void>((_resolve, reject) => { fail = reject })
  const pass = vi.fn<() => Promise<void>>()
    .mockReturnValueOnce(pending)
    .mockResolvedValue(undefined)
  const reconcile = remoteReviewReconciliation(pass)
  const first = reconcile()
  const second = reconcile()
  const firstRejected = expect(first).rejects.toBe(failure)
  const secondRejected = expect(second).rejects.toBe(failure)
  fail(failure)
  await Promise.all([firstRejected, secondRejected])
  expect(pass).toHaveBeenCalledTimes(1)

  await expect(reconcile()).resolves.toBeUndefined()
  expect(pass).toHaveBeenCalledTimes(2)
})
