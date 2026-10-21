import type { CompactionState } from '@foreman-code/contracts'
import { expect, it, vi } from 'vitest'
import { compactionFixture } from './__tests__/compaction.js'
import { deferred } from './__tests__/sessionManager.js'

const phases = ['initial-progress', 'dispatch', 'offer', 'post-offer-progress'] as const
const endings = ['abort', 'eof'] as const

it.each(phases.flatMap(phase => endings.map(ending => ({ phase, ending }))))(
  'owns completion rejection during held $phase persistence on $ending', async ({ phase, ending }) => {
    const f = await compactionFixture()
    const entered = deferred<void>()
    const release = deferred<void>()
    const unhandled = vi.fn()
    const abort = new AbortController()
    process.on('unhandledRejection', unhandled)
    let progressCalls = 0
    let saved: CompactionState | undefined
    const open = f.runner.open
    f.runner.open = async input => {
      const sdk = await open(input)
      const offer = sdk.offer
      sdk.offer = async (message, signal) => {
        const result = await offer(message, signal)
        if (phase === 'offer') {
          entered.resolve()
          await release.promise
        }
        return result
      }
      return sdk
    }
    try {
      const session = await f.attach()
      const compact = f.manager.compactSession!(session, {
        requestId: 'compact-request', clientCorrelationId: 'compact-request',
        onProgress: async state => {
          saved = state
          progressCalls++
          if (phase === 'initial-progress' && progressCalls === 1
            || phase === 'post-offer-progress' && progressCalls === 2) {
            entered.resolve()
            await release.promise
          }
        },
        onDispatch: async () => {
          if (phase === 'dispatch') {
            entered.resolve()
            await release.promise
          }
        },
      }, abort.signal).then(() => undefined, (error: unknown) => error)
      await entered.promise
      if (ending === 'abort') abort.abort(new Error('Control cancelled'))
      else f.frames.close()
      await new Promise<void>(resolve => setImmediate(resolve))
      await new Promise<void>(resolve => setImmediate(resolve))
      const earlyRejections = unhandled.mock.calls.length
      release.resolve()
      const error = await compact
      expect(error).toBeInstanceOf(Error)
      if (phase === 'initial-progress' || phase === 'dispatch') {
        expect(error).toMatchObject({ deliveryState: 'not-delivered', certainty: 'definite' })
      } else {
        expect(await f.manager.reconcileCompaction!(session, { ...saved!, status: 'uncertain' }))
          .toMatchObject({ status: 'uncertain' })
      }
      expect(earlyRejections).toBe(0)
      expect(f.offers).toHaveBeenCalledTimes(phase === 'offer' || phase === 'post-offer-progress' ? 1 : 0)
    } finally {
      release.resolve()
      await f.dispose()
      process.off('unhandledRejection', unhandled)
    }
  },
)
