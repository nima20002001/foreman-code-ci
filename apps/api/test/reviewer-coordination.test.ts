import assert from 'node:assert/strict'

import type pg from 'pg'
import { test } from 'vitest'
import type { ReviewJob } from '@foreman-code/contracts'

import { PostgresInteractionCoordinationRepository } from '../src/modules/interactions/coordination.js'

const now = new Date().toISOString()
const job: ReviewJob = { id: 'review', interactionId: 'interaction', reviewerAgentId: 'reviewer', attempt: 1,
  state: 'uncertain', provider: 'codex', nativeSessionId: 'native', correlationId: 'original', createdAt: now, updatedAt: now }

function database(respond: (sql: string, values: unknown[]) => { rows: unknown[]; rowCount: number }) {
  const calls: { sql: string; values: unknown[] }[] = []
  let released = false
  const query = async (sql: string, values: unknown[] = []) => { calls.push({ sql, values }); return respond(sql, values) }
  const pool = { query, connect: async () => ({ query, release: () => { released = true } }) } as unknown as pg.Pool
  return { calls, repository: new PostgresInteractionCoordinationRepository(pool), released: () => released }
}

test('queue selection and claiming both include every recoverable state and check actual expiry', async () => {
  const f = database((sql) => sql.includes('select record from review_jobs') ? { rows: [{ record: job }], rowCount: 1 } : { rows: [], rowCount: 1 })
  await f.repository.nextReviewJob('reviewer')
  const claimed = await f.repository.claimReviewJob('review', 'worker', 'new-token', new Date(Date.now() + 60_000).toISOString())
  assert.equal(claimed.state, 'uncertain')
  assert.equal(claimed.correlationId, 'original')
  for (const { sql } of f.calls.filter((call) => call.sql.includes('select record from review_jobs'))) {
    for (const state of ['pending', 'leased', 'submitted', 'acknowledged', 'uncertain', 'blocked_busy', 'blocked_disconnected']) {
      assert.ok(sql.includes(`'${state}'`), state)
    }
    assert.match(sql, /leaseExpiresAt.*clock_timestamp\(\)/s)
    assert.match(sql, /retryAfter.*clock_timestamp\(\)/s)
  }
  assert.equal(f.released(), true)
})

for (const method of ['assertLaneLease', 'assertReviewJobLease', 'renewLane', 'renewReviewJob'] as const) {
  test(`${method} rejects unconfirmed ownership and preserves database failures`, async () => {
    let unavailable = false
    const timeout = new Error('Query read timeout')
    const f = database(() => {
      if (unavailable) throw timeout
      return { rows: [], rowCount: 0 }
    })
    const confirm = () => {
      if (method === 'renewLane' || method === 'renewReviewJob') {
        return f.repository[method]('id', 'old-token', 30_000)
      }
      return f.repository[method]('id', 'old-token')
    }
    await assert.rejects(confirm(), {
      code: method.includes('Lane') ? 'SESSION_LANE_LEASE_LOST' : 'REVIEW_JOB_LEASE_LOST',
    })
    unavailable = true
    await assert.rejects(confirm(), error => error === timeout)
  })
}

test('claiming a native lane records actual busy ownership, not an advisory idle row', async () => {
  const f = database(() => ({ rows: [], rowCount: 0 }))
  const future = new Date(Date.now() + 60_000).toISOString()
  await assert.rejects(f.repository.claimLane('lane', 0, 'worker', 'token', future, 'correlation'), { code: 'SESSION_LANE_BUSY' })
  assert.match(f.calls[0]!.sql, /observedStatus.*busy/s)
  assert.match(f.calls[0]!.sql, /revision=\$2/)
  assert.match(f.calls[0]!.sql, /\$5::timestamptz > clock_timestamp/)
})

test('review state changes fence both job and lane again at the final database write', async () => {
  const owned = { ...job, leaseToken: 'token', leaseOwner: 'worker', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }
  const f = database((sql) => ({ rows: sql.startsWith('select record') ? [{ record: owned, revision: '2', lease_fence: '1', lease_active: true }] : [], rowCount: 1 }))
  await f.repository.transitionReviewJob(job.id, 'token', 'acknowledged', { writerFence: { id: 'lane', token: 'lane-token' } })
  const update = f.calls.find(({ sql }) => sql.startsWith('update review_jobs'))!
  assert.match(update.sql, /lease_token=\$5 and lease_fence=\$6/)
  assert.match(update.sql, /exists.*native_session_lanes.*record->>'leaseToken'=\$8/s)
  assert.equal(update.sql.match(/> clock_timestamp\(\)/g)?.length, 2)
  assert.deepEqual(update.values.slice(3), ['2', 'token', '1', 'lane', 'lane-token'])
})

test('expired job transition rolls back and never overwrites a successor', async () => {
  const f = database(() => ({ rows: [], rowCount: 0 }))
  await assert.rejects(f.repository.transitionReviewJob(job.id, 'old', 'completed'), { code: 'REVIEW_JOB_LEASE_LOST' })
  assert.ok(!f.calls.some(({ sql }) => sql.startsWith('update')))
  assert.ok(f.calls.some(({ sql }) => sql === 'rollback'))
  assert.equal(f.released(), true)
})

test('releasing an expired lane cannot clear a successor lease', async () => {
  const f = database(() => ({ rows: [], rowCount: 0 }))
  await assert.rejects(f.repository.releaseLane('lane', 'old', { observedStatus: 'idle' }), { code: 'SESSION_LANE_LEASE_LOST' })
  assert.ok(!f.calls.some(({ sql }) => sql.startsWith('update')))
  assert.match(f.calls.find(({ sql }) => sql.startsWith('select'))!.sql, /leaseExpiresAt.*> clock_timestamp/s)
})


test('durable acknowledgement refuses native turn identity replacement', async () => {
  const owned = { ...job, providerTurnOrMessageId: 'original', leaseToken: 'token',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }
  const f = database((sql) => ({ rows: sql.startsWith('select record') ? [{ record: owned, revision: '2', lease_fence: '1', lease_active: true }] : [], rowCount: 1 }))
  await assert.rejects(f.repository.transitionReviewJob(job.id, 'token', 'acknowledged', { providerTurnOrMessageId: 'replacement' }),
    { code: 'REVIEW_JOB_IDENTITY_CONFLICT' })
  assert.ok(!f.calls.some(({ sql }) => sql.startsWith('update')))
})
