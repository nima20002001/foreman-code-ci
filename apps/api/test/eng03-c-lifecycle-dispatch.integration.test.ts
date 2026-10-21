import { describe, expect, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { lifecycleFixtures } from './helpers/workflowLifecycleFixtures.js'
import { rejectableDeferred } from './helpers/deferred.js'

// Provider transport is deterministic; admission, capture, checkpointing and lifecycle writers remain real.
describe.skipIf(!postgresEnabled)('native workflow lifecycle: dispatch', () => {
  const fixture = lifecycleFixtures()

  it('deduplicates Start and reconciliation while native dispatch is active', async () => {
    const f = await fixture(), entered = rejectableDeferred(), release = rejectableDeferred()
    const original = f.provider.createSession.bind(f.provider)
    vi.spyOn(f.provider, 'createSession').mockImplementationOnce(async (...args) => {
      entered.resolve(); await release.promise; return original(...args)
    })
    const task = f.engine.start(f.f.run.id)
    try {
      await entered.promise
      expect(f.engine.start(f.f.run.id)).toBe(task)
      await f.engine.reconcile()
      release.resolve(); await task
      expect(f.provider.counts).toMatchObject({ sessions: 3, starts: 3 })
      expect(new Set(f.provider.startedNodes).size).toBe(3)
    } finally { release.resolve(); await task.catch(() => undefined) }
  }, 60000)
})
