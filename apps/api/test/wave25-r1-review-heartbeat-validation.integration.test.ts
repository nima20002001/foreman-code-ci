import { describe, expect, it } from 'vitest'
import { reviewHeartbeatFixtures } from './helpers/reviewHeartbeat.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

const { fixture, graph } = reviewHeartbeatFixtures()

describe.skipIf(!postgresEnabled)('production review heartbeat: validation', { timeout: 60000 }, () => {
  it.concurrent('does not renew an expired lease or overwrite a successor token', async ({ onTestFinished }) => {
    const f = await fixture(onTestFinished)
    await f.pool.query(`update review_jobs set record=jsonb_set(record,'{leaseExpiresAt}','"2000-01-01T00:00:00.000Z"'::jsonb)
      where id=$1`, [f.job.id])
    const expired = await graph(f)
    await expect(f.repository.coordination.renewReviewJob(f.job.id, f.job.leaseToken!, 60000))
      .rejects.toMatchObject({ code: 'REVIEW_JOB_LEASE_LOST' })
    expect(await graph(f)).toEqual(expired)
    await f.repository.coordination.claimReviewJob(f.job.id, 'successor-owner', 'successor-token', new Date(Date.now() + 60000).toISOString())
    const successor = await graph(f)
    await expect(f.repository.coordination.renewReviewJob(f.job.id, f.job.leaseToken!, 60000))
      .rejects.toMatchObject({ code: 'REVIEW_JOB_LEASE_LOST' })
    expect(await graph(f)).toEqual(successor)
    expect((await f.pool.query('select lease_token from review_jobs where id=$1', [f.job.id])).rows[0].lease_token).toBe('successor-token')
  })

  it.concurrent('rejects invalid durations without changing lease or public state', async ({ onTestFinished }) => {
    const f = await fixture(onTestFinished)
    const before = await graph(f)
    const stored = (await f.pool.query('select record,revision::text,lease_fence::text from review_jobs where id=$1', [f.job.id])).rows
    for (const duration of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2147483648]) {
      await expect(f.repository.coordination.renewReviewJob(f.job.id, f.job.leaseToken!, duration))
        .rejects.toMatchObject({ code: 'LEASE_EXPIRY_INVALID' })
    }
    expect((await f.pool.query('select record,revision::text,lease_fence::text from review_jobs where id=$1', [f.job.id])).rows).toEqual(stored)
    expect(await graph(f)).toEqual(before)
  })
})
