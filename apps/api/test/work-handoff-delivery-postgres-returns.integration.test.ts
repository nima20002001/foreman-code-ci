import assert from 'node:assert/strict'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { WorkNoticeSchema, WorkHandoffResultSchema, type WorkHandoffResult } from '@foreman-code/contracts/wave25'
import { describe, expect, it } from 'vitest'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { RepeatRunRepository } from '../src/modules/runs/repeatPostgres.js'
import { createWorkLimitNotice } from '../src/modules/runs/workHandoffNotice.js'
import { nim2691TaskDatabase as taskDatabase } from './helpers/nim2691Database.js'
import {
  acceptedReview, acquireOwner, acceptPreparedResult, boundaryNoticeDeliverable, databaseJsonBytes, returnPreview, text,
} from './work-handoff-delivery-postgres.test-support.js'

const postgresDescribe = describe.skipIf(process.env.NIM2691_POSTGRES !== '1')
postgresDescribe('handoff delivery returns', () => {
  it.each([
    { restart: false, payload: 'text' }, { restart: true, payload: 'text' },
    { restart: false, payload: 'numeric' }, { restart: true, payload: 'numeric' },
  ] as const)('delivers a boundary-sized $payload return and last-handoff notice (restart=$restart)',
    async ({ restart, payload }) => {
    await taskDatabase(async (pool) => {
      await applyApplicationMigrations(pool)
      const output: WorkHandoffResult = { routing: { kind: 'return', requestId: 'review-request', outcome: 'needs_changes' },
        data: { latestDeliverable: '', remainingFindings: [{ id: 'needs-revision' }] } }
      const t = await acceptedReview(pool, output, { reviewAccepted: false })
      const returned = returnPreview(t, output)
      const preview = createWorkLimitNotice({ scope: t.fixture.scope, version: t.version, now: t.fixture.createdAt }, {
        cause: { kind: 'last_return', returnId: returned.returnId },
        requesterActivationId: t.request.requesterActivationId, requesterNodeId: t.request.requesterNodeId,
        continuationActivationId: returned.continuationActivationId!, relationshipId: t.request.relationshipId,
        destinationNodeId: t.request.destinationNodeId, used: 1, maximum: 1,
        latestDeliverable: '', remainingFindings: output.data.remainingFindings,
      }, [])
      output.data.latestDeliverable = await boundaryNoticeDeliverable(pool, preview, payload)
      const candidate = HarnessExecutionSchema.parse({ ...t.executions[1], result: { outcome: 'succeeded', output } })
      WorkHandoffResultSchema.parse(output)
      let owner = await acquireOwner(pool, t.run.id)
      try {
        await owner.oneShotConnection().transaction((sql) =>
          acceptPreparedResult(sql, t, t.request.destinationActivationId, candidate, output))
        if (restart) {
          await owner.release()
          owner = await acquireOwner(pool, t.run.id)
        }
        const store = new RepeatRunRepository(owner, t.host, t.version)
        const delivered = await store.returnWork(candidate.id)
        expect(delivered.value.latestDeliverable).toEqual(output.data.latestDeliverable)
        const notices = (await pool.query('select record from run_work_notices where run_id=$1', [t.run.id])).rows
        expect(notices).toHaveLength(1)
        const notice = WorkNoticeSchema.parse(notices[0]!.record)
        expect(notice.latestDeliverable).toEqual(output.data.latestDeliverable)
        expect(notice.remainingFindings).toEqual(output.data.remainingFindings)
        expect(notice.cause).toEqual({ kind: 'last_return', returnId: delivered.value.returnId })
        expect(await databaseJsonBytes(pool, { ...notice,
          delivery: 'delivered', acknowledgementId: 'a'.repeat(200) })).toBe(65536)
        expect((await store.returnWork(candidate.id)).replayed).toBe(true)
        expect((await pool.query('select record from run_work_notices where run_id=$1', [t.run.id])).rowCount).toBe(1)
        expect((await pool.query('select return_id from run_work_returns where run_id=$1', [t.run.id])).rowCount).toBe(1)
      } finally { await owner.release() }
    })
  }, 120000)

  it.each([
    { outcome: 'accepted', payload: 'text' }, { outcome: 'needs_changes', payload: 'text' },
    { outcome: 'accepted', payload: 'numeric' }, { outcome: 'needs_changes', payload: 'numeric' },
  ] as const)(
    'rejects $payload $outcome delivery overflow before acceptance and after recovery',
    async ({ outcome, payload }) => {
      await taskDatabase(async (pool) => {
        await applyApplicationMigrations(pool)
        const latestDeliverable = payload === 'numeric' ? Array<number>(1000).fill(1e100) : 'x'.repeat(65000)
        const output: WorkHandoffResult = { routing: { kind: 'return', requestId: 'review-request', outcome },
          data: { latestDeliverable, remainingFindings: [] } }
        WorkHandoffResultSchema.parse(output)
        const t = await acceptedReview(pool, output, { reviewAccepted: false })
        if (payload === 'numeric' && outcome === 'needs_changes') {
          const returned = returnPreview(t, output)
          const notice = createWorkLimitNotice({ scope: t.fixture.scope, version: t.version, now: t.fixture.createdAt }, {
            cause: { kind: 'last_return', returnId: returned.returnId },
            requesterActivationId: t.request.requesterActivationId, requesterNodeId: t.request.requesterNodeId,
            continuationActivationId: returned.continuationActivationId!, relationshipId: t.request.relationshipId,
            destinationNodeId: t.request.destinationNodeId, used: 1, maximum: 1,
            latestDeliverable: '', remainingFindings: [],
          }, [])
          const boundary = await boundaryNoticeDeliverable(pool, notice, payload)
          assert.ok(typeof boundary === 'object')
          output.data.latestDeliverable = { ...boundary, text: boundary.text + 'x' }
          expect(await databaseJsonBytes(pool, returnPreview(t, output))).toBeLessThanOrEqual(65536)
          expect(await databaseJsonBytes(pool, { ...notice, latestDeliverable: output.data.latestDeliverable,
            delivery: 'delivered', acknowledgementId: 'a'.repeat(200) })).toBe(65537)
        }
        const execution = HarnessExecutionSchema.parse({ ...t.executions[1], result: { outcome: 'succeeded', output } })
        expect(Buffer.byteLength(text(execution.result), 'utf8')).toBeLessThanOrEqual(65536)
        let owner = await acquireOwner(pool, t.run.id)
        try {
          for (const recover of [false, true]) {
            if (recover) {
              await owner.release()
              owner = await acquireOwner(pool, t.run.id)
            }
            await expect(owner.oneShotConnection().transaction((sql) =>
              acceptPreparedResult(sql, t, t.request.destinationActivationId, execution, output)))
              .rejects.toMatchObject({ code: 'WORK_HANDOFF_DELIVERY_TOO_LARGE' })
          }
          expect((await pool.query('select accepted from harness_executions where id=$1', [execution.id])).rows[0]?.accepted)
            .toBe(false)
          expect((await pool.query('select 1 from run_work_results where execution_id=$1', [execution.id])).rowCount).toBe(0)
          expect((await pool.query('select 1 from run_work_returns where run_id=$1', [t.run.id])).rowCount).toBe(0)
          expect((await pool.query('select 1 from run_work_notices where run_id=$1', [t.run.id])).rowCount).toBe(0)
        } finally { await owner.release() }
      })
    }, 120000,
  )
})
