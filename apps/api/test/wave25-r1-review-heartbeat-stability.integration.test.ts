import { describe, expect, it } from 'vitest'
import { reviewHeartbeatFixtures } from './helpers/reviewHeartbeat.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

const { fixture, graph } = reviewHeartbeatFixtures()

describe.skipIf(!postgresEnabled)('production review heartbeat: stability', { timeout: 60000 }, () => {
  it('keeps the full snapshot, public review revision and graph head unchanged', async () => {
    const f = await fixture(), before = await graph(f)
    const stored = (await f.pool.query('select revision::text,lease_fence::text from review_jobs where id=$1', [f.job.id])).rows[0]
    const expiry = await f.repository.coordination.renewReviewJob(f.job.id, f.job.leaseToken!, 60000)
    expect(Date.parse(expiry)).toBeGreaterThan(Date.now())
    expect(await graph(f)).toEqual(before)
    expect((await f.pool.query('select revision::text,lease_fence::text from review_jobs where id=$1', [f.job.id])).rows[0]).toEqual(stored)
    // The existing record/column synchronization trigger remains in force.
    expect((await f.pool.query(`select lease_expires_at=(record->>'leaseExpiresAt')::timestamptz as aligned
      from review_jobs where id=$1`, [f.job.id])).rows[0].aligned).toBe(true)
  })

  it('does not shorten a live lease when a shorter heartbeat arrives later', async () => {
    const f = await fixture()
    const longer = await f.repository.coordination.renewReviewJob(f.job.id, f.job.leaseToken!, 120000)
    const before = await graph(f)
    const shorter = await f.repository.coordination.renewReviewJob(f.job.id, f.job.leaseToken!, 1)
    expect(Date.parse(shorter)).toBeGreaterThanOrEqual(Date.parse(longer))
    expect(await graph(f)).toEqual(before)
  })
})
