import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { pendingReviewCleanup, publicReviewStopError, reviewNeedsStop, reviewPreflightIdentity } from '../src/modules/interactions/reviewPolicy.js'

const done = { nativeState: 'terminal' as const, credentialState: 'revoked' as const,
  interruptState: 'not_sent' as const, completedAt: '2026-09-20T00:00:00.000Z' }

describe('review lifecycle policy', () => {
  it('keeps an unresolved correlation and provider identity together', () => {
    assert.deepEqual(reviewPreflightIdentity({ correlationId: 'review-A', currentTurnOrMessageId: 'native-A' }, 'execution:entry'),
      { correlationId: 'review-A', nativeTurnId: 'native-A' })
  })
  it('never attaches an idle lane’s retained provider ID under the workflow correlation', () => {
    assert.deepEqual(reviewPreflightIdentity({ currentTurnOrMessageId: 'native-A' }, 'execution:entry'), { correlationId: 'execution:entry' })
  })
  it('keeps unresolved correlation even before the provider ID is known', () => {
    assert.deepEqual(reviewPreflightIdentity({ correlationId: 'review-A' }, 'execution:entry'), { correlationId: 'review-A' })
  })
  it('uses the workflow identity only when there is no saved pair', () => {
    assert.deepEqual(reviewPreflightIdentity(undefined, 'execution:entry'), { correlationId: 'execution:entry' })
  })
  it('records obligations, never fake closure, for an unknown failure', () => {
    assert.deepEqual(pendingReviewCleanup(), { nativeState: 'pending', credentialState: 'pending', interruptState: 'not_sent' })
    assert.notEqual(pendingReviewCleanup(), pendingReviewCleanup())
  })
  for (const executionState of ['queued', 'running', 'waiting', 'interrupted', 'completed'] as const) {
    it(`retains a Stop owner for incomplete cleanup in a ${executionState} Run`, () => {
      assert.equal(reviewNeedsStop({ state: 'failed', cleanup: pendingReviewCleanup() }, { executionState }), true)
    })
  }
  it('also recovers old failures with no cleanup record', () => {
    assert.equal(reviewNeedsStop({ state: 'failed' }, { executionState: 'waiting' }), true)
  })
  it('stops a still-active Run after a terminal business failure and completed cleanup', () => {
    assert.equal(reviewNeedsStop({ state: 'failed', cleanup: done, error: { code: 'REVIEW_NO_DECISION', message: 'failure' } }, { executionState: 'waiting' }), true)
  })
  it('does not repeatedly stop a terminal Run after cleanup finished', () => {
    assert.equal(reviewNeedsStop({ state: 'failed', cleanup: done }, { executionState: 'completed' }), false)
  })
  for (const code of ['REVIEW_NO_LONGER_PENDING', 'REVIEW_RUN_STOPPED']) {
    it(`does not cancel active unrelated work for a settled ${code} job`, () => {
      assert.equal(reviewNeedsStop({ state: 'failed', cleanup: done, error: { code, message: 'obsolete' } }, { executionState: 'running' }), false)
    })
  }
  it('never converts a recoverable transport state into a business Stop', () => {
    assert.equal(reviewNeedsStop({ state: 'uncertain' }, { executionState: 'running' }), false)
    assert.equal(reviewNeedsStop({ state: 'completed' }, { executionState: 'running' }), false)
  })
  it('allows only fixed error codes and public wording into a Run stop cause', () => {
    const publicError = publicReviewStopError('REVIEW_SUBMISSION_REJECTED')
    assert.equal(publicError.code, 'REVIEW_SUBMISSION_REJECTED')
    assert.equal(publicReviewStopError('opm_secret /private/path').code, 'REVIEW_FAILED')
    assert.equal(publicReviewStopError('__proto__').code, 'REVIEW_FAILED')
    assert.equal(publicReviewStopError(undefined).message.includes('undefined'), false)
  })
})
