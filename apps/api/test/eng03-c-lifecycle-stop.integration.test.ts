import { describe, expect, it, vi } from 'vitest'
import { readCurrentExecutions, postgresEnabled } from './helpers/wave25Agent3.js'
import { lifecycleFixtures } from './helpers/workflowLifecycleFixtures.js'
import { graphParity } from './helpers/wave25R1GraphParity.js'
import { rejectableDeferred } from './helpers/deferred.js'

// Provider transport is deterministic; admission, capture, checkpointing and lifecycle writers remain real.
describe.skipIf(!postgresEnabled)('native workflow lifecycle: stop', () => {
  const fixture = lifecycleFixtures()

  it('acknowledges Stop when the queued launch loses the durable Stop race', async () => {
    const f = await fixture(), entered = rejectableDeferred(), release = rejectableDeferred()
    const update = f.runs.updateState.bind(f.runs)
    vi.spyOn(f.runs, 'updateState').mockImplementationOnce(async (...args) => {
      entered.resolve(); await release.promise; return update(...args)
    })
    const started = f.engine.start(f.f.run.id).then(() => undefined, (error: unknown) => error)
    try {
      await entered.promise
      await f.stop()
      release.resolve()
      expect(await started).toBeUndefined()
      await f.engine.cancel(f.f.run.id)
      expect((await f.runs.get(f.f.run.id))?.outcome).toBe('canceled')
      expect(await f.runs.hasPendingCleanup(f.f.run.id)).toBe(false)
      expect(await readCurrentExecutions(f.runs, f.f.run.id)).toHaveLength(0)
      expect(f.provider.counts.starts).toBe(0)
    } finally { release.resolve(); await started }
  }, 60000)

  it('stops both waiting branches and leaves another queued Run intact', async () => {
    const f = await fixture(), other = await fixture()
    const { compare } = await graphParity(f.db.pool, f.f.scope)
    await f.engine.start(f.f.run.id)
    expect(await f.pending()).toHaveLength(2)
    expect(f.provider.counts.starts).toBe(3)
    await compare(); await f.stop(); await f.engine.cancel(f.f.run.id)
    expect((await compare()).state.run.outcome).toBe('canceled')
    expect(await f.runs.hasPendingCleanup(f.f.run.id)).toBe(false)
    expect((await other.runs.get(other.f.run.id))?.executionState).toBe('queued')
    expect(other.provider.counts.starts).toBe(0)
    expect(f.provider.counts.starts).toBe(3)
  }, 60000)
})
