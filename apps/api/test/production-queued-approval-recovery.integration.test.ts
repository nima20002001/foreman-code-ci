import { describe, expect, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { productionFixtures, response, checkpointCut, expireAbandonedClaims, recover } from './helpers/approvalCheckpointProduction.js'
import { rejectableDeferred } from './helpers/deferred.js'

describe.skipIf(!postgresEnabled)('approval checkpoint recovery during queued resume races', () => {
  const fixture = productionFixtures()

  it.each(['revoked_authority', 'closed_execution', 'lease_expiry', 'stop'] as const)(
    '%s while the service resume is queued cannot commit a checkpoint or repeat delivery', async (race: 'lease_expiry' | 'stop' | 'revoked_authority' | 'closed_execution') => {
      const f = await fixture(), waiting = rejectableDeferred(), release = rejectableDeferred(), queued = rejectableDeferred()
      const update = f.runs.updateState.bind(f.runs), resume = f.engine.resumeInteraction.bind(f.engine)
      let gated = false
      const stateSpy = vi.spyOn(f.runs, 'updateState').mockImplementation(async (...args) => {
        const result = await update(...args)
        if (!gated && args[1].executionState === 'waiting') {
          gated = true; waiting.resolve(); await release.promise
        }
        return result
      })
      const resumeSpy = vi.spyOn(f.engine, 'resumeInteraction').mockImplementation((...args) => {
        queued.resolve()
        return resume(...args) // Actual queueResume waits behind the start task.
      })
      const starting = f.engine.start(f.f.run.id)
      const startResult = starting.catch((error: unknown) => error)
      let responseResult: Promise<unknown> | undefined
      try {
        await Promise.race([waiting.promise, starting])
        const [interaction] = await f.pending(), cut = await checkpointCut(f)
        responseResult = f.service.respond({ kind: 'user', principal: f.principal }, response(interaction!)).catch((error: unknown) => error)
        await Promise.race([queued.promise, responseResult])
        expect((await f.db.pool.query('select state from interaction_graph_resumes where interaction_id=$1', [interaction!.id])).rows[0])
          .toEqual({ state: 'resuming' })
        if (race === 'lease_expiry') await expireAbandonedClaims(f)
        if (race === 'stop') await f.stop()
        if (race === 'revoked_authority') await f.db.pool.query('update management_principals set revoked_at=clock_timestamp() where id=$1', [f.authorizationPrincipalId])
        if (race === 'closed_execution') await f.db.pool.query('update harness_executions set worker_credentials_closed_at=clock_timestamp() where id=$1', [interaction!.executionId])
        release.resolve()
        await startResult; await responseResult
        expect(await f.receipts()).toEqual([])
        expect((await f.saver.getTuple(cut.config))?.pendingWrites).toEqual(cut.pendingWrites)
        expect(f.provider.counts.responses).toBe(1)
        if (race === 'lease_expiry') {
          await recover(f)
          expect(await f.receipts()).toHaveLength(1)
          expect(f.provider.counts.responses).toBe(1)
        }
      } finally {
        release.resolve()
        await startResult; await responseResult
        stateSpy.mockRestore(); resumeSpy.mockRestore()
      }
    }, 60000)
})
