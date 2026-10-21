import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import type { ReviewJob } from '@foreman-code/contracts'
import { assertSameRepeatExecution, assertSameReviewJob, reviewPhysicallySettled } from '../src/modules/interactions/repeatObservation.js'
import { repeatReviewerOccurrence } from '../src/modules/interactions/repeatReviewer.js'
import { native2Fixture } from './eng04-native2-fixtures.js'

function reviewFixture() {
  const f = native2Fixture(); f.installResident(true)
  const job: ReviewJob = { id: 'review-job-occurrence-1', interactionId: 'interaction-requester-occurrence-1',
    reviewerAgentId: f.get().agentId, attempt: 1, state: 'completed', provider: 'codex', nativeSessionId: f.session.nativeSessionId,
    correlationId: 'review-correlation-occurrence-1', providerTurnOrMessageId: 'turn-native2-exact',
    createdAt: f.at, updatedAt: f.at }
  f.interactions.coordination.findReviewJob = async () => job
  return { ...f, job }
}

test('NATIVE-2 review finishes its captured lifetime while the Run is still running', async () => {
  const f = reviewFixture()
  const finish = f.coordinator.captureReviewFinalizer(f.get().id, f.session, f.job)!
  await finish(f.job)
  assert.equal(f.run.executionState, 'running')
  assert.ok(f.calls.includes(`close:${f.session.nativeSessionId}`))
  assert.ok(f.calls.includes('revoke:principal-native2-captured'))
  assert.ok(!f.calls.some((call) => call.startsWith('revoke-execution:') || call === 'unqualified-finalize'))
})

test('NATIVE-2 old callback cannot close a later review on the same resident execution', async () => {
  const f = reviewFixture()
  const old = f.coordinator.captureReviewFinalizer(f.get().id, f.session, f.job)!
  f.coordinator.captureReviewFinalizer(f.get().id, f.session, { ...f.job, id: 'review-later', correlationId: 'review-later-correlation' })
  await assert.rejects(old(f.job), { code: 'REVIEW_JOB_IDENTITY_CONFLICT' })
  assert.ok(!f.calls.some((call) => call.startsWith('close:') || call.startsWith('revoke:')))
})

test('NATIVE-2 a different review attempt or provider turn cannot use a captured finalizer', async () => {
  const f = reviewFixture()
  const finish = f.coordinator.captureReviewFinalizer(f.get().id, f.session, f.job)!
  await assert.rejects(finish({ ...f.job, attempt: 2 }), { code: 'REVIEW_JOB_IDENTITY_CONFLICT' })
  await assert.rejects(finish({ ...f.job, providerTurnOrMessageId: 'turn-other-occurrence' }), { code: 'REVIEW_JOB_IDENTITY_CONFLICT' })
  assert.ok(!f.calls.some((call) => call.startsWith('close:')))
})

test('NATIVE-2 reviewer generation replacement invalidates the captured callback', async () => {
  const f = reviewFixture()
  const finish = f.coordinator.captureReviewFinalizer(f.get().id, f.session, f.job)!
  f.resident.generation++
  await assert.rejects(finish(f.job), { code: 'REVIEW_JOB_IDENTITY_CONFLICT' })
  assert.ok(!f.calls.some((call) => call.startsWith('close:')))
})

test('NATIVE-2 captured finalizer yields to a cleanup that is tearing down its lifetime', async () => {
  const f = reviewFixture()
  const finish = f.coordinator.captureReviewFinalizer(f.get().id, f.session, f.job)!
  f.resident.controller.abort()
  await finish(f.job)
  assert.ok(!f.calls.some((call) => call.startsWith('close:') || call.startsWith('revoke:')))
})

test('NATIVE-2 captured finalizer yields to a cleanup that already closed its lifetime', async () => {
  const f = reviewFixture()
  const finish = f.coordinator.captureReviewFinalizer(f.get().id, f.session, f.job)!
  f.internals.ownedSessions.delete(f.get().id)
  await finish(f.job)
  await finish({ ...f.job, state: 'acknowledged' })
  assert.ok(!f.calls.some((call) => call.startsWith('close:') || call.startsWith('revoke:')))
})

test('NATIVE-2 native review acknowledgement alone cannot close the lifetime', async () => {
  const f = reviewFixture()
  const finish = f.coordinator.captureReviewFinalizer(f.get().id, f.session, f.job)!
  await finish({ ...f.job, state: 'acknowledged' })
  assert.ok(!f.calls.some((call) => call.startsWith('close:')))
})

test('NATIVE-2 sibling review obligation retains the captured session without revocation', async () => {
  const f = reviewFixture()
  f.interactions.coordination.hasUnsettledReview = async () => true
  await f.coordinator.captureReviewFinalizer(f.get().id, f.session, f.job)!(f.job)
  assert.ok(!f.calls.some((call) => call.startsWith('close:') || call.startsWith('revoke:')))
})

test('NATIVE-2 wrong durable reviewer execution context fails before physical closure', async () => {
  const f = reviewFixture()
  f.interactions.coordination.getReviewJobContext = async () => ({ executionId: 'reviewer-other-occurrence',
    workingDirectory: f.get().workingDirectory!, providerVersion: f.session.providerVersion })
  await assert.rejects(f.coordinator.captureReviewFinalizer(f.get().id, f.session, f.job)!(f.job),
    { code: 'REVIEW_JOB_IDENTITY_CONFLICT' })
  assert.ok(!f.calls.some((call) => call.startsWith('close:')))
})

test('NATIVE-2 settled negative reviewer cleanup closes without response or positive ack', async () => {
  const f = reviewFixture()
  f.job.state = 'failed'
  f.job.cleanup = { nativeState: 'terminal', credentialState: 'revoked', interruptState: 'not_sent', completedAt: f.at }
  await f.coordinator.captureReviewFinalizer(f.get().id, f.session, f.job)!(f.job)
  assert.ok(f.calls.includes('closure:41'))
  assert.ok(!f.calls.some((call) => /respond|startTurn|unqualified-finalize/.test(call)))
})

test('NATIVE-2 execution-ID-only finishReview is not a v3 occurrence barrier', async () => {
  const f = reviewFixture()
  assert.equal('finishReview' in f.coordinator, false)
  assert.ok(!f.calls.some((call) => call.startsWith('close:')))
})

test('NATIVE-2 reviewer selection keys an in-block reviewer to the same occurrence', () => {
  const f = native2Fixture()
  assert.equal(repeatReviewerOccurrence(f.fixture.version, f.fixture.ref, 'work'), f.fixture.occurrence.identity.occurrenceId)
  assert.equal(repeatReviewerOccurrence(f.fixture.version, f.fixture.ref, 'done'), null)
  assert.throws(() => repeatReviewerOccurrence(f.fixture.version, { nodeId: 'done', occurrence: null }, 'work'),
    { code: 'REPEAT_REVIEW_SCOPE_UNSUPPORTED' })
})

test('NATIVE-2 immutable execution/input and review identity conflicts fail closed', () => {
  const f = reviewFixture()
  for (const change of [{ id: 'other' }, { runId: 'other' }, { attempt: 2 }, { input: { otherOccurrence: true } },
    { nativeSessionId: 'other-session' }, { result: { outcome: 'failed' as const } }]) {
    assert.throws(() => assertSameRepeatExecution(f.get(), { ...f.get(), ...change }), { code: 'REPEAT_EXECUTION_INPUT_CONFLICT' })
  }
  assert.throws(() => assertSameReviewJob(f.job, { ...f.job, interactionId: 'other' }), { code: 'REVIEW_JOB_IDENTITY_CONFLICT' })
  assert.equal(reviewPhysicallySettled({ ...f.job, providerTurnOrMessageId: undefined }), false)
  assert.equal(reviewPhysicallySettled({ ...f.job, state: 'uncertain' }), false)
})

test('NATIVE-2 missing physical review proof cannot close or revoke the captured lifetime', async () => {
  const f = reviewFixture()
  f.interactions.coordination.assertReviewPhysicalSettlement = async () => {
    throw Object.assign(new Error('Original terminal proof missing'), { code: 'REPEAT_CLEANUP_PENDING' })
  }
  await assert.rejects(f.coordinator.captureReviewFinalizer(f.get().id, f.session, f.job)!(f.job),
    { code: 'REPEAT_CLEANUP_PENDING' })
  assert.ok(!f.calls.some((call) => /close:|revoke:/.test(call)))
})

test('restart drains a captured reviewer finalizer before detaching its native lifetime', async () => {
  const f = reviewFixture()
  const order: string[] = []
  let entered!: () => void
  let release!: () => void
  const reading = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const readRun = f.runs.get
  f.runs.get = async () => {
    entered()
    await held
    return readRun()
  }
  Object.assign(f.manager, {
    retainsReviewerSession: true,
    closeForRestart: async () => { order.push('detach') },
  })
  Object.assign(f.closures, { recordDetached: async () => { order.push('detached') } })
  const finish = f.coordinator.captureReviewFinalizer(f.get().id, f.session, f.job)!
  const finalizing = finish(f.job).then(() => { order.push('finalized') })
  // Model the dispatcher's public drain boundary with the running real finalizer.
  const shutdown = vi.spyOn(f.coordinator.reviewers, 'shutdown').mockImplementation(() => finalizing)
  await reading
  const closing = f.coordinator.closeForRestart()
  try {
    assert.deepEqual(order, [])
    release()
    await closing
    await finalizing
    assert.deepEqual(order, ['finalized', 'detach', 'detached'])
    assert.ok(!f.calls.some(call => call.startsWith('revoke:')))
  } finally {
    release()
    await Promise.allSettled([closing, finalizing])
    shutdown.mockRestore()
    await f.connection.close()
  }
})
