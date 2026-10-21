import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { cleanupDeliveryFixtures, within } from './helpers/cleanupDelivery.js'
import { rejectableDeferred } from './helpers/deferred.js'

describe.skipIf(!postgresEnabled)('PostgreSQL approval delivery races', () => {
  const { fixture } = cleanupDeliveryFixtures()

  it('Stop commits independently while the actual provider response remains unresolved', async () => {
    const f = await fixture(), entered = rejectableDeferred(), release = rejectableDeferred()
    f.provider.beforeRespond = async () => { entered.resolve(); await release.promise }
    const operation = f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(f.interaction))
    const observed = operation.then((value) => ({ value }), (error: unknown) => ({ error }))
    try {
      await within(entered.promise)
      await within(f.stop())
      expect(await f.runs.hasRequestedStop(f.f.run.id)).toBe(true)
      release.resolve(); await observed
      expect(await f.receipts()).toEqual([])
      const row = (await f.db.pool.query('select state from interaction_graph_resumes where interaction_id=$1', [f.interaction.id])).rows[0]
      expect(row?.state).not.toBe('resumed')
    } finally { release.resolve(); await observed; await f.engine.cancel(f.f.run.id) }
  }, 60000)

  it('a changed native generation cannot consume the old provider response', async () => {
    const f = await fixture(), entered = rejectableDeferred(), release = rejectableDeferred()
    f.provider.beforeRespond = async () => { entered.resolve(); await release.promise }
    const operation = f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(f.interaction))
    const observed = operation.then(() => undefined, (error: unknown) => error)
    try {
      await within(entered.promise)
      const lane = await f.repository.coordination.getLane(f.interaction.harness, f.interaction.nativeSessionId)
      if (!lane?.leaseToken) throw new Error('Expected the response to own a native writer lease')
      await f.repository.coordination.releaseLane(lane.id, lane.leaseToken, {
        observedStatus: 'uncertain',
        connectionGeneration: lane.connectionGeneration + 1,
        ...(lane.currentTurnOrMessageId ? { currentTurnOrMessageId: lane.currentTurnOrMessageId } : {}),
      })
      release.resolve(); await observed
      expect(await f.receipts()).toEqual([])
      expect((await f.runs.get(f.f.run.id))?.outcome).not.toBe('succeeded')
      expect(f.provider.counts.responses).toBe(1)
      await expect(f.engine.shutdown()).resolves.toBeUndefined()
    } finally { release.resolve(); await observed }
  }, 60000)
})
