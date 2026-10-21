import assert from 'node:assert/strict'

import { ReviewCleanupSchema, type ReviewJob } from '@foreman-code/contracts'
import type pg from 'pg'
import { describe, it } from 'vitest'

import { PostgresInteractionCoordinationRepository } from '../src/modules/interactions/coordination.js'
import { reviewJob } from './pr17-agent2-fixtures.js'

function failed(): ReviewJob {
  return { ...reviewJob(), state: 'failed', leaseOwner: 'owner', leaseToken: 'token',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    error: { code: 'ORIGINAL_FAILURE', message: 'Keep the original business failure.' },
    cleanup: { nativeState: 'pending', credentialState: 'pending', credentialPrincipalId: 'original-principal', interruptState: 'acknowledged' } }
}
function database(job = failed()) {
  const calls: { sql: string; values: unknown[] }[] = []
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values })
    if (sql.startsWith('select record')) return { rows: [{ record: job, revision: '2', lease_fence: '1', lease_active: true }], rowCount: 1 }
    if (sql.startsWith('select l.id')) return { rows: [{ id: 'lane' }], rowCount: 1 }
    return { rows: [], rowCount: 1 }
  }
  const pool = { query, connect: async () => ({ query, release: () => {} }) } as unknown as pg.Pool
  return { repository: new PostgresInteractionCoordinationRepository(pool), calls }
}

describe('PR17 #2: durable cleanup queue and fencing', () => {
  it('selects failed incomplete cleanup and preserves failure on claim without changing queue fairness', async () => {
    const f = database()
    await f.repository.nextReviewJob('reviewer')
    await f.repository.reviewJobAgents()
    const claimed = await f.repository.claimReviewJob('review-job', 'recovery', 'new-token', new Date(Date.now() + 60_000).toISOString())
    assert.equal(claimed.state, 'failed')
    assert.deepEqual(claimed.error, failed().error)
    assert.deepEqual(claimed.cleanup, failed().cleanup)
    const selections = f.calls.filter(({ sql }) => sql.includes('from review_jobs') && !sql.startsWith('update'))
    assert.equal(selections.length, 3)
    for (const { sql } of selections) {
      assert.match(sql, /state\s*=\s*'failed'/)
      assert.match(sql, /cleanup.*completedAt.*is null/s)
      assert.match(sql, /leaseExpiresAt.*clock_timestamp/s)
    }
    assert.match(selections[0]!.sql, /order by updated_at,id/)
  })

  it('journals failed cleanup without releasing its lease before side effects', async () => {
    const f = database()
    const next = await f.repository.transitionReviewJob('review-job', 'token', 'failed', {
      cleanup: failed().cleanup, releaseLease: false, error: { code: 'NEW_ERROR', message: 'Do not overwrite.' },
      writerFence: { id: 'lane', token: 'writer' },
    })
    assert.equal(next.leaseToken, 'token')
    assert.deepEqual(next.error, failed().error)
    const update = f.calls.find(({ sql }) => sql.startsWith('update review_jobs'))!
    assert.match(update.sql, /lease_token=\$5 and lease_fence=\$6/)
    assert.match(update.sql, /native_session_lanes.*leaseToken.*\$8/s)
    assert.equal(update.sql.match(/> clock_timestamp\(\)/g)?.length, 2)
  })

  it('never revives a failed cleanup job or substitutes a successor credential', async () => {
    const f = database()
    await assert.rejects(f.repository.transitionReviewJob('review-job', 'token', 'submitted'))
    await assert.rejects(f.repository.transitionReviewJob('review-job', 'token', 'failed', {
      cleanup: { ...failed().cleanup!, credentialPrincipalId: 'successor-principal' },
    }))
    await assert.rejects(f.repository.transitionReviewJob('review-job', 'token', 'failed', {
      cleanup: { ...failed().cleanup!, nativeState: 'not_started' },
    }))
    await assert.rejects(f.repository.transitionReviewJob('review-job', 'token', 'failed', {
      cleanup: { ...failed().cleanup!, interruptState: 'submitted' },
    }))
    assert.equal(f.calls.some(({ sql }) => sql.startsWith('update review_jobs')), false)
  })

  it('blocks binding new work into a lane with pending failure cleanup', async () => {
    const f = database()
    await assert.rejects(f.repository.bindLaneTurn({ id: 'lane', token: 'writer' }, 'new-turn'), { code: 'SESSION_LANE_BUSY' })
    assert.match(f.calls[0]!.sql, /nativeSessionId.*native_session_id/s)
    assert.match(f.calls[0]!.sql, /cleanup.*completedAt.*is null/s)
    assert.equal(f.calls.some(({ sql }) => sql.startsWith('update')), false)
  })

  it('rejects premature completedAt even when an interrupt was acknowledged', () => {
    const pending = { ...failed().cleanup!, completedAt: new Date().toISOString() }
    assert.equal(ReviewCleanupSchema.safeParse(pending).success, false)
    assert.equal(ReviewCleanupSchema.safeParse({ ...pending, nativeState: 'terminal' }).success, false)
    assert.equal(ReviewCleanupSchema.safeParse({ ...pending, nativeState: 'terminal', credentialState: 'revoked' }).success, true)
  })
})
