import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'

import type { NativeHarnessEvent, NativeSessionLane, NativeSessionReference, ReviewJob } from '@foreman-code/contracts'

import type { PostgresInteractionCoordinationRepository, WriterFence } from '../src/modules/interactions/coordination.js'
import type { ReviewerNativeRuntime } from '../src/modules/interactions/reviewerRuntime.js'
import type { ReviewNativeCapture, ReviewOriginalNativeSource } from '../src/modules/interactions/reviewNativeCapture.js'
import { normalizeNativeProducerEvent } from '../src/modules/run-graph/nativeProducerNormalization.js'

export const reviewSession: NativeSessionReference = { harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'review-session' }
export function reviewJob(): ReviewJob {
  const now = new Date().toISOString()
  return { id: 'review-job', interactionId: 'interaction', reviewerAgentId: 'reviewer', attempt: 1,
    provider: 'codex', nativeSessionId: reviewSession.nativeSessionId, correlationId: 'review-correlation',
    providerTurnOrMessageId: 'review-turn', state: 'acknowledged', submittedAt: now, acknowledgedAt: now, createdAt: now, updatedAt: now }
}

/** In-memory port fake; PostgreSQL predicate/fencing behavior has separate repository-boundary coverage. */
export function reviewCoordination(initial = reviewJob()) {
  let job = structuredClone(initial)
  let lane: NativeSessionLane = { id: 'lane', harness: initial.provider, nativeSessionId: initial.nativeSessionId,
    ownerAgentId: 'reviewer', observedStatus: 'busy', correlationId: initial.correlationId,
    currentTurnOrMessageId: initial.providerTurnOrMessageId, connectionGeneration: 0, observedAt: new Date().toISOString(), revision: 0 }
  const transitions: ReviewJob[] = []
  // Test-only capture/consumer seam, not a substitute for the PostgreSQL
  // original-source proof service. Keep exact job, session and writer identity.
  const captures = new WeakMap<ReviewNativeCapture, {
    token: string; writer: WriterFence; source: ReviewOriginalNativeSource; jobId: string
  }>()
  const captureReviewNative: ReviewerNativeRuntime['captureReviewNative'] = (executionId, session, assigned, lease, source) => {
    lease.guard.signal.throwIfAborted()
    assert.equal(executionId, 'execution')
    assert.equal(assigned.id, job.id)
    assert.ok(assigned.leaseToken)
    assert.equal(assigned.leaseToken, job.leaseToken)
    assert.equal(session.harness, job.provider)
    assert.equal(session.nativeSessionId, job.nativeSessionId)
    assert.equal(lease.fence.id, lane.id)
    assert.equal(lease.fence.token, lane.leaseToken)
    assert.equal(lease.previous.connectionGeneration, lane.connectionGeneration)
    const capture = Object.freeze({ executionId })
    captures.set(capture, { token: assigned.leaseToken, writer: structuredClone(lease.fence),
      source: structuredClone(source), jobId: assigned.id })
    return capture
  }
  const original = (capture: ReviewNativeCapture | undefined, assigned: ReviewJob, writer: WriterFence | undefined) => {
    const stored = capture && captures.get(capture)
    assert.ok(stored, 'Original scheduler capture is required')
    assert.equal(stored.jobId, assigned.id)
    assert.equal(stored.token, assigned.leaseToken)
    assert.equal(stored.token, job.leaseToken)
    assert.deepEqual(stored.writer, writer)
    assert.equal(stored.writer.token, lane.leaseToken)
    return stored.source
  }
  const value = {
    async assertReviewConnection() {},
    async reviewRunStopped() { return false },
    async getLane() { return structuredClone(lane) },
    async nextReviewJob() { return job.cleanup?.completedAt ? undefined : structuredClone(job) },
    async claimReviewJob(_id: string, owner: string, token: string, expires: string) {
      job = { ...job, attempt: job.attempt + 1, leaseToken: token, leaseOwner: owner, leaseExpiresAt: expires }
      return structuredClone(job)
    },
    async getReviewJobContext() { return { executionId: 'execution', workingDirectory: '/tmp/reviewer', providerVersion: reviewSession.providerVersion } },
    async assertReviewJobLease(_id: string, token: string) { assert.equal(token, job.leaseToken) },
    async renewReviewJob() { return new Date(Date.now() + 60_000).toISOString() },
    async isReviewPending() { return true },
    async appendReviewNativeHistory(assigned: ReviewJob, events: readonly NativeHarnessEvent[],
      options: Parameters<PostgresInteractionCoordinationRepository['appendReviewNativeHistory']>[2]) {
      if (!options?.nativeCapture) throw new Error('Original review history capture required.')
      for (const event of events) await value.appendReviewNativeEvent(assigned, event, options)
    },
    async appendReviewNativeEvent(assigned: ReviewJob, event: NativeHarnessEvent,
      options: { writer?: WriterFence; nativeCapture?: ReviewNativeCapture }) {
      const source = original(options.nativeCapture, assigned, options.writer)
      const events = source.type === 'history' ? source.history.events : source.type === 'event' ? [source.event] : []
      assert.ok(events.some((candidate) => isDeepStrictEqual(event,
        normalizeNativeProducerEvent({ ...candidate, executionId: 'execution' }).event)),
      'Projected review event must retain its original event/history capture')
    },
    async transitionReviewJob(_id: string, token: string, state: ReviewJob['state'], fields: {
      error?: ReviewJob['error']; providerTurnOrMessageId?: string; cleanup?: ReviewJob['cleanup']; releaseLease?: boolean; writerFence?: WriterFence
      nativeCapture?: ReviewNativeCapture
    } = {}) {
      assert.equal(token, job.leaseToken)
      const { releaseLease, writerFence, nativeCapture, ...patch } = fields
      if (state === 'submitted') assert.equal(original(nativeCapture, job, writerFence).type, 'entry')
      if (writerFence) assert.equal(writerFence.token, lane.leaseToken)
      job = { ...job, ...patch, state }
      if (releaseLease ?? ['failed', 'completed', 'uncertain'].includes(state)) {
        delete job.leaseToken; delete job.leaseOwner; delete job.leaseExpiresAt
      }
      transitions.push(structuredClone(job))
      return structuredClone(job)
    },
    async ensureLane() { return structuredClone(lane) },
    async claimLane(_id: string, revision: number, owner: string, token: string, expires: string, correlation: string) {
      assert.equal(revision, lane.revision)
      lane = { ...lane, leaseOwner: owner, leaseToken: token, leaseExpiresAt: expires,
        correlationId: correlation, revision: revision + 1 }
      return structuredClone(lane)
    },
    async assertLaneLease(_id: string, token: string) { assert.equal(token, lane.leaseToken) },
    async renewLane() { return new Date(Date.now() + 60_000).toISOString() },
    async releaseLane(_id: string, token: string, fields: { observedStatus: NativeSessionLane['observedStatus']; currentTurnOrMessageId?: string }) {
      assert.equal(token, lane.leaseToken)
      lane = { ...lane, ...fields }
      if (fields.observedStatus === 'idle' && !fields.currentTurnOrMessageId) delete lane.correlationId
      delete lane.leaseToken; delete lane.leaseOwner; delete lane.leaseExpiresAt
      return structuredClone(lane)
    },
    async bindLaneTurn(_fence: WriterFence, correlation: string) { lane.correlationId = correlation; delete lane.currentTurnOrMessageId },
    async acknowledgeLaneTurn(fence: WriterFence, correlation: string, providerId: string) {
      assert.equal(fence.token, lane.leaseToken)
      assert.equal(correlation, lane.correlationId)
      assert.ok(!lane.currentTurnOrMessageId || lane.currentTurnOrMessageId === providerId)
      lane.currentTurnOrMessageId = providerId
    },
  }
  return { repository: value as unknown as PostgresInteractionCoordinationRepository, captureReviewNative,
    transitions, get job() { return structuredClone(job) }, get lane() { return structuredClone(lane) },
    successor() { lane = { ...lane, correlationId: 'successor-correlation', currentTurnOrMessageId: 'successor-turn', observedStatus: 'busy' } },
  }
}
