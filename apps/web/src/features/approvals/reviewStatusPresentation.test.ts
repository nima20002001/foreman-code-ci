import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import type { ReviewStatus } from '@foreman-code/contracts'
import { reviewStatusPresentation } from './reviewStatusPresentation'
const now = Date.parse('2026-09-20T12:00:00.000Z')
const pending = { status: 'pending' as const, deliveryState: 'not_started' as const }
const blocked: ReviewStatus = { state: 'blocked_disconnected', attempt: 1,
  error: { code: 'REVIEW_SESSION_DISCONNECTED', message: 'The reviewer session is unavailable.' },
  retryAfter: new Date(now + 10000).toISOString(), updatedAt: new Date(now).toISOString() }

describe('review failure and retry presentation', () => {
  it('shows both the error and a scheduled retry', () => {
    const view = reviewStatusPresentation(blocked, pending, now)
    assert.equal(view.errorMessage, blocked.error!.message)
    assert.ok(view.retryMessage)
    assert.match(view.retryMessage, /Retry scheduled/)
    assert.equal(view.retryScheduled, true)
  })
  it('marks a retry due without claiming it has actually started', () => {
    const view = reviewStatusPresentation(blocked, pending, now + 10001)
    assert.equal(view.errorMessage, blocked.error!.message)
    assert.ok(view.retryMessage)
    assert.match(view.retryMessage, /Retry is due; waiting for the next backend check/)
    assert.equal(view.title, 'Orchestrator connection unavailable')
  })
  it('preserves a terminal failure in canceled history after reload', () => {
    const view = reviewStatusPresentation({ ...blocked, state: 'failed', cleanupPending: false },
      { status: 'canceled', deliveryState: 'not_started' }, now)
    assert.equal(view.visible, true)
    assert.equal(view.failed, true)
    assert.equal(view.errorMessage, blocked.error!.message)
    assert.ok(view.retryMessage)
    assert.match(view.retryMessage, /No automatic review retry.*Cleanup finished/)
  })
  it('keeps unknown cleanup visible instead of reporting successful closure', () => {
    const view = reviewStatusPresentation({ ...blocked, state: 'failed', cleanupPending: true }, pending, now)
    assert.ok(view.retryMessage)
    assert.match(view.retryMessage, /cleanup is still pending; use Stop/)
    assert.equal(view.retryScheduled, false)
  })
  it('distinguishes a delivered Worker decision from unresolved native review', () => {
    const view = reviewStatusPresentation({ ...blocked, state: 'uncertain', retryAfter: undefined },
      { status: 'delivered', deliveryState: 'delivered' }, now)
    assert.equal(view.visible, true)
    assert.match(view.title, /native review settlement/)
    assert.ok(view.retryMessage)
    assert.match(view.retryMessage, /decision will not be resent/)
  })
  it('does not announce a retry for a canceled request', () => {
    const view = reviewStatusPresentation(blocked, { status: 'canceled', deliveryState: 'not_started' }, now)
    assert.equal(view.retryScheduled, false)
    assert.ok(view.retryMessage)
    assert.match(view.retryMessage, /No automatic review retry/)
  })
  it('does not leave a completed delivered review alert on the page', () => {
    assert.equal(reviewStatusPresentation({ ...blocked, state: 'completed' },
      { status: 'delivered', deliveryState: 'delivered' }, now).visible, false)
  })
  it('treats invalid retry time as unavailable rather than rendering Invalid Date', () => {
    const view = reviewStatusPresentation({ ...blocked, retryAfter: 'invalid' }, pending, now)
    assert.equal(view.retryScheduled, false)
    assert.equal(view.retryMessage, undefined)
  })
})

it('does not repeat a pending review title as an explanation', () => {
  const view = reviewStatusPresentation({ state: 'submitted', attempt: 1, updatedAt: new Date(now).toISOString() }, pending, now)
  assert.equal(view.title, 'Orchestrator reviewing')
  assert.equal(view.visible, true)
  assert.equal(view.retryMessage, undefined)
})
