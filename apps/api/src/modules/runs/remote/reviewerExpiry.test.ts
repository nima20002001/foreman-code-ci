import { expect, it, vi } from 'vitest'
import { deferred } from '../../../../test/helpers/deferred.js'
import { MainClock } from '../../devices/workerClock.js'
import { runningInstalledFixture } from './__tests__/installedWorkflowHost.js'

it('keeps a reviewer renewed while an older expiry authorization request fails', async () => {
  const mainTime = Date.now()
  let elapsed = 0
  const clock = new MainClock(() => elapsed)
  clock.observe(mainTime)
  const entered = deferred()
  const release = deferred()
  let delayNextAuthorization = false
  const f = await runningInstalledFixture('generation', {
    retainReviewer: true,
    mainNow: () => clock.now(),
    authorizeReviewer: async () => {
      if (!delayNextAuthorization) return
      delayNextAuthorization = false
      entered.resolve()
      await release.promise
      throw new Error('Delayed reviewer authorization failed')
    },
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    f.finish('succeeded')
    await f.retained
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1))
    delayNextAuthorization = true
    elapsed = 50_000
    await vi.advanceTimersByTimeAsync(10_000)
    await entered.promise
    elapsed = 55_000
    const expiresAt = new Date(mainTime + 115_000).toISOString()
    expect((await f.call('status')).payload).toMatchObject({
      receipt: { retainedReviewer: { expiresAt }, stopFence: false },
    })
    elapsed = 65_000
    release.resolve()
    await vi.waitFor(async () => {
      const status = await f.journal.status(f.intent.operationId)
      expect(vi.getTimerCount() === 1 || status.status === 'known' && status.receipt.stopFence).toBe(true)
    })
    expect(await f.journal.status(f.intent.operationId)).toMatchObject({
      receipt: { retainedReviewer: { expiresAt }, stopFence: false, phase: 'running' },
    })
    expect(f.cancel).not.toHaveBeenCalled()
    elapsed = 115_000
    f.disconnect()
    await vi.advanceTimersByTimeAsync(10_000)
    await f.settled
    expect(await f.journal.status(f.intent.operationId)).toMatchObject({
      receipt: { stopFence: true, terminal: { kind: 'cancelled' } },
    })
    expect(f.cancel).toHaveBeenCalledOnce()
  } finally {
    release.resolve()
    vi.useRealTimers()
    f.reconnect(f.context.binding)
    f.cleanup()
    await f.stop()
    await f.host.close()
  }
})
