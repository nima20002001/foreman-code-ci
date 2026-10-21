import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { RunStopCauseSchema } from './runStopCause.js'
import { ReviewStatusSchema } from './index.js'

const cause = { kind: 'review_failure', interactionId: 'interaction-A', reviewJobId: 'job-A',
  error: { code: 'REVIEW_NO_DECISION', message: 'The Orchestrator did not decide this request.' }, recordedAt: '2026-09-20T12:00:00.000Z' }
describe('review failure public contracts', () => {
  it('retains the exact job and interaction identities for reloaded Run history', () => {
    assert.deepEqual(RunStopCauseSchema.parse(cause), cause)
  })
  it('rejects secret-bearing environment and arbitrary native arguments', () => {
    assert.equal(RunStopCauseSchema.safeParse({ ...cause, environment: { token: 'not-public' } }).success, false)
    assert.equal(RunStopCauseSchema.safeParse({ ...cause, error: { ...cause.error, arguments: { command: 'not-public' } } }).success, false)
  })
  it('exposes a cleanup status without leaking the captured credential principal', () => {
    const status = { state: 'failed', attempt: 1, updatedAt: cause.recordedAt, error: cause.error, cleanupPending: true, reviewJobId: 'job-A' }
    assert.deepEqual(ReviewStatusSchema.parse(status), status)
    assert.equal(ReviewStatusSchema.safeParse({ ...status, credentialPrincipalId: 'internal-owner' }).success, false)
  })
})
