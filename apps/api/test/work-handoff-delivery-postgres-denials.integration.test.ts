import assert from 'node:assert/strict'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { WorkHandoffResultSchema, type WorkHandoffResult } from '@foreman-code/contracts/wave25'
import { describe, expect, it } from 'vitest'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { RepeatRunRepository } from '../src/modules/runs/repeatPostgres.js'
import { repeatId } from '../src/modules/runs/repeatResolution.js'
import { createWorkLimitNotice } from '../src/modules/runs/workHandoffNotice.js'
import { nim2691TaskDatabase as taskDatabase } from './helpers/nim2691Database.js'
import {
  acceptedReview, acquireOwner, acceptPreparedResult, boundaryNoticeDeliverable, databaseJsonBytes, pendingRequester,
} from './work-handoff-delivery-postgres.test-support.js'

const postgresDescribe = describe.skipIf(process.env.NIM2691_POSTGRES !== '1')
postgresDescribe('handoff delivery denials', () => {
  it.each([
    { restart: false, payload: 'text' }, { restart: true, payload: 'text' },
    { restart: false, payload: 'numeric' }, { restart: true, payload: 'numeric' },
  ] as const)('delivers a boundary-sized $payload exhausted-route denial notice (restart=$restart)',
    async ({ restart, payload }) => {
    await taskDatabase(async (pool) => {
      await applyApplicationMigrations(pool)
      const t = await acceptedReview(pool, { routing: { kind: 'return', requestId: 'review-request', outcome: 'accepted' },
        data: { latestDeliverable: { revision: 1 }, remainingFindings: [] } })
      const output: WorkHandoffResult = { routing: { kind: 'request', outcome: 'review' },
        data: { latestDeliverable: '', remainingFindings: [] } }
      const next = await pendingRequester(pool, t, output)
      const requestId = repeatId('work-request', t.run.id, next.execution.id, t.request.relationshipId)
      const denialId = repeatId('work-denial', requestId)
      const notice = createWorkLimitNotice({ scope: t.fixture.scope, version: t.version, now: t.fixture.createdAt }, {
        cause: { kind: 'limit_denial', denialId }, requesterActivationId: next.activationId,
        requesterNodeId: t.request.requesterNodeId, continuationActivationId: repeatId('work-activation', denialId),
        relationshipId: t.request.relationshipId, destinationNodeId: t.request.destinationNodeId,
        used: 1, maximum: 1, latestDeliverable: '', remainingFindings: [],
      }, [])
      output.data.latestDeliverable = await boundaryNoticeDeliverable(pool, notice, payload)
      const candidate = HarnessExecutionSchema.parse({ ...next.execution, result: { outcome: 'succeeded', output } })
      let owner = await acquireOwner(pool, t.run.id)
      try {
        await owner.oneShotConnection().transaction((sql) => acceptPreparedResult(sql, t, next.activationId, candidate, output))
        if (restart) {
          await owner.release()
          owner = await acquireOwner(pool, t.run.id)
        }
        const store = new RepeatRunRepository(owner, t.host, t.version)
        const denied = await store.admitWorkRequest(candidate.id)
        assert.equal(denied.kind, 'limit_reached')
        expect(denied.notice.latestDeliverable).toEqual(output.data.latestDeliverable)
        expect(denied.notice.cause).toEqual({ kind: 'limit_denial', denialId })
        expect(await databaseJsonBytes(pool, { ...denied.notice,
          delivery: 'delivered', acknowledgementId: 'a'.repeat(200) })).toBe(65536)
        expect((await store.admitWorkRequest(candidate.id)).replayed).toBe(true)
        expect((await pool.query('select 1 from run_work_denials where run_id=$1', [t.run.id])).rowCount).toBe(1)
        expect((await pool.query('select 1 from run_work_notices where run_id=$1', [t.run.id])).rowCount).toBe(1)
      } finally { await owner.release() }
    })
  }, 120000)

  it.each(['text', 'numeric'] as const)(
    'rejects an oversized %s denial notice before acceptance and after recovery', async (payload) => {
    await taskDatabase(async (pool) => {
      await applyApplicationMigrations(pool)
      const t = await acceptedReview(pool, { routing: { kind: 'return', requestId: 'review-request', outcome: 'accepted' },
        data: { latestDeliverable: { revision: 1 }, remainingFindings: [] } })
      const latestDeliverable = payload === 'numeric' ? Array<number>(1000).fill(1e100) : 'x'.repeat(65000)
      const output: WorkHandoffResult = { routing: { kind: 'request', outcome: 'review' },
        data: { latestDeliverable, remainingFindings: [] } }
      WorkHandoffResultSchema.parse(output)
      const next = await pendingRequester(pool, t, output)
      let owner = await acquireOwner(pool, t.run.id)
      try {
        for (const recover of [false, true]) {
          if (recover) {
            await owner.release()
            owner = await acquireOwner(pool, t.run.id)
          }
          await expect(owner.oneShotConnection().transaction((sql) =>
            acceptPreparedResult(sql, t, next.activationId, next.execution, output)))
            .rejects.toMatchObject({ code: 'WORK_HANDOFF_DELIVERY_TOO_LARGE' })
        }
        expect((await pool.query('select accepted from harness_executions where id=$1', [next.execution.id])).rows[0]?.accepted)
          .toBe(false)
        expect((await pool.query('select 1 from run_work_results where execution_id=$1', [next.execution.id])).rowCount).toBe(0)
        expect((await pool.query('select 1 from run_work_denials where run_id=$1', [t.run.id])).rowCount).toBe(0)
      } finally { await owner.release() }
    })
  }, 120000)
})
