import pg from 'pg'
import { WorkReturnSchema, type WorkHandoffResult } from '@foreman-code/contracts/wave25'
import { describe, expect, it } from 'vitest'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { RepeatRunRepository } from '../src/modules/runs/repeatPostgres.js'
import { repeatDigest } from '../src/modules/runs/repeatResolution.js'
import { nim2691TaskDatabase as taskDatabase } from './helpers/nim2691Database.js'
import { acceptedReview, acquireOwner } from './work-handoff-delivery-postgres.test-support.js'

const postgresDescribe = describe.skipIf(process.env.NIM2691_POSTGRES !== '1')
postgresDescribe('handoff delivery accepted review', () => {
  it.each([false, true])('waits for a closing caller after accepted-review recovery (work failed: %s)', async failed => {
    let caller: pg.Client | undefined
    let closing = Promise.resolve()
    let closed = false
    let closeError: unknown
    const failure = new Error('Delivery verification failed')
    try {
      const work = taskDatabase(async (pool, _directory, connectionString) => {
        await applyApplicationMigrations(pool)
        const t = await acceptedReview(pool, {
          routing: { kind: 'return', requestId: 'review-request', outcome: 'accepted' },
          data: { latestDeliverable: { revision: 1 }, remainingFindings: [] },
        })
        let owner = await acquireOwner(pool, t.run.id)
        await owner.release()
        owner = await acquireOwner(pool, t.run.id)
        try {
          const store = new RepeatRunRepository(owner, t.host, t.version)
          expect((await store.returnWork('review-execution')).value).toMatchObject({
            requestId: 'review-request', outcome: 'accepted', latestDeliverable: { revision: 1 },
          })
        } finally { await owner.release() }
        caller = new pg.Client({ connectionString })
        await caller.connect()
        await caller.query('select 1')
        const connected = caller
        // Close the independent caller when teardown removes an owned pool connection.
        closing = new Promise<void>((resolve) => {
          pool.once('remove', () => {
            void connected.end().then(
              () => {
                closed = true
                resolve()
              },
              error => {
                closeError = error
                resolve()
              },
            )
          })
        })
        if (failed) throw failure
        return 'delivery verified'
      })
      if (failed) await expect(work).rejects.toBe(failure)
      else await expect(work).resolves.toBe('delivery verified')
      expect(closed).toBe(true)
      expect(closeError).toBeUndefined()
    } finally {
      await closing
      await caller?.end()
    }
  }, 30_000)

  it.each([false, true])('preserves accepted review findings without a revision activation (restart=%s)', async (restart) => {
    await taskDatabase(async (pool) => {
      await applyApplicationMigrations(pool)
      const output: WorkHandoffResult = { routing: { kind: 'return', requestId: 'review-request', outcome: 'accepted' },
        data: { latestDeliverable: { revision: 1 }, remainingFindings: [{ id: 'remaining-finding' }] } }
      const t = await acceptedReview(pool, output)
      let owner = await acquireOwner(pool, t.run.id)
      try {
        if (restart) {
          await owner.release()
          owner = await acquireOwner(pool, t.run.id)
        }
        const store = new RepeatRunRepository(owner, t.host, t.version)
        const returned = await store.returnWork('review-execution')
        expect(returned.value).toMatchObject({ requestId: 'review-request', outcome: 'accepted',
          latestDeliverable: output.data.latestDeliverable, remainingFindings: output.data.remainingFindings })
        expect(returned.value.continuationActivationId).toBeUndefined()
        expect((await store.returnWork('review-execution')).replayed).toBe(true)
        expect((await pool.query('select record from run_work_returns where run_id=$1', [t.run.id])).rows
          .map((row) => WorkReturnSchema.parse(row.record))).toEqual([returned.value])
        expect((await pool.query('select execution_id,result_digest from run_work_unresolved where run_id=$1',
          [t.run.id])).rows).toEqual([{ execution_id: 'review-execution',
          result_digest: repeatDigest(t.executions[1]!.result) }])
        expect((await pool.query('select activation_id from run_work_activations where run_id=$1', [t.run.id])).rowCount).toBe(2)
        expect((await pool.query('select used from run_work_connection_usage where run_id=$1', [t.run.id])).rows[0]?.used).toBe(1)
      } finally { await owner.release() }
    })
  }, 120000)
})
