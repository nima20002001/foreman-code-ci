import { describe, expect, it } from 'vitest'
import { reviewHeartbeatFixtures } from './helpers/reviewHeartbeat.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

const { fixture, graph } = reviewHeartbeatFixtures()

describe.skipIf(!postgresEnabled)('production review heartbeat: row-lock', { timeout: 60000 }, () => {
  it('rechecks expiry after waiting behind an independent row writer', async () => {
    const f = await fixture(), before = await graph(f), locker = await f.pool.connect()
    let observed: Promise<{ renewed: boolean; code?: string }> | undefined
    try {
      await locker.query('begin')
      const pid = (await locker.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      await locker.query('select id from review_jobs where id=$1 for update', [f.job.id])
      // The renewal statement first sees the still-live committed version, then
      // blocks on this row. Committing the expired replacement must defeat it.
      await locker.query(`update review_jobs set record=jsonb_set(record,'{leaseExpiresAt}',
        '"2000-01-01T00:00:00.000Z"'::jsonb) where id=$1`, [f.job.id])
      observed = f.repository.coordination.renewReviewJob(f.job.id, f.job.leaseToken!, 60000)
        .then(() => ({ renewed: true }), (error: { code?: string }) => ({ renewed: false, ...(error.code ? { code: error.code } : {}) }))
      const deadline = Date.now() + 3000
      for (;;) {
        const row = (await f.pool.query<{ waiting: boolean }>(`select exists(select 1 from pg_stat_activity
          where $1=any(pg_blocking_pids(pid)) and query like 'update review_jobs%') as waiting`, [pid])).rows[0]!
        if (row.waiting) break
        if (Date.now() >= deadline) throw new Error('Renewal did not reach the independent row lock')
      }
      await locker.query('commit')
      expect(await observed).toEqual({ renewed: false, code: 'REVIEW_JOB_LEASE_LOST' })
      expect(await graph(f)).toEqual(before)
    } finally {
      await locker.query('rollback')
      locker.release()
      await observed
    }
  }, 60000)
})
