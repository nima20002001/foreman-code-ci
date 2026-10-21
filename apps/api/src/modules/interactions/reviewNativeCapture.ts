import type { HarnessExecution, NativeHarnessEvent, NativeSessionReference, PendingNativeInteraction, ReviewJob } from '@foreman-code/contracts'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { REMOTE_NATIVE_SOURCE_LIMIT } from '@foreman-code/contracts/remote-workflow-physical'
import type { NativeHistory } from '../harnesses/port.js'
import { DomainError } from '../errors.js'
import type { SessionWriteLease, SingleWriterSessionManager } from './sessionWriter.js'
import type { RunOwnership } from '../runs/ownership.js'
import type { ReviewNativeCapture } from './coordination.js'

/** Private companion to the existing reviewer writer, not an HTTP/MCP proof
 * schema. Entry is command intent only. Event/history retain the original source
 * before public normalization; pending is the captured manager's pending read. */
export type ReviewOriginalNativeSource =
  | { type: 'entry' }
  | { type: 'event'; event: NativeHarnessEvent; pending: PendingNativeInteraction | null }
  | { type: 'history'; history: NativeHistory }
export type { ReviewNativeCapture }
export interface ReviewNativeCaptureInput {
  execution: HarnessExecution
  session: NativeSessionReference
  job: ReviewJob
  manager: SingleWriterSessionManager
  lease: SessionWriteLease
  lifetimeGeneration: number
  closureGeneration: string
  source: ReviewOriginalNativeSource
  assertCurrent(): void
  owner?: RunOwnership
}
export interface CapturedReviewNativeSource {
  owner?: RunOwnership
  execution: HarnessExecution
  session: NativeSessionReference
  job: ReviewJob
  lifetimeGeneration: number
  closureGeneration: string
  lane: { id: string; token: string; connectionGeneration: number; providerId: string | null }
  source: ReviewOriginalNativeSource
  observedAt: string
  assertCurrent(): void
}
export interface ReviewNativeCapturePort { capture(input: ReviewNativeCaptureInput): ReviewNativeCapture }
export interface ReviewNativeVerificationPort { read(value: ReviewNativeCapture): CapturedReviewNativeSource }
function invalid(): never {
  throw new DomainError('REVIEW_ORIGINAL_SOURCE_REQUIRED', 'The exact original reviewer manager and writer lifetime must produce this evidence.', 409)
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child) }
  return value
}
function immutable<T>(value: T, maxBytes = 4 * 1024 * 1024): T {
  return freeze(JSON.parse(canonicalGraphJson(value, maxBytes)) as T)
}
export function createReviewNativeCaptureChannel(): { capture: ReviewNativeCapturePort; verify: ReviewNativeVerificationPort } {
  const values = new WeakMap<object, CapturedReviewNativeSource>()
  return {
    capture: Object.freeze({ capture(input: ReviewNativeCaptureInput): ReviewNativeCapture {
      input.assertCurrent()
      if (!input.job.leaseToken || !Number.isSafeInteger(input.lifetimeGeneration) || input.lifetimeGeneration < 1
        || !/^[1-9][0-9]*$/.test(input.closureGeneration)
        || input.execution.agentId !== input.job.reviewerAgentId
        || input.execution.nativeSessionId !== input.session.nativeSessionId
        || input.job.nativeSessionId !== input.session.nativeSessionId || input.job.provider !== input.session.harness
        || input.manager.harness !== input.session.harness) return invalid()
      const execution = immutable(input.execution), session = immutable(input.session), job = immutable(input.job)
      const source = immutable(input.source, REMOTE_NATIVE_SOURCE_LIMIT)
      const manager = input.manager, lease = input.lease, assertCoordinator = input.assertCurrent
      const lane = immutable({ id: lease.fence.id, token: lease.fence.token,
        connectionGeneration: lease.previous.connectionGeneration, providerId: lease.providerId ?? null })
      const check = () => {
        assertCoordinator(); manager.assertCapturedLease(session, lease)
        if (lease.fence.id !== lane.id || lease.fence.token !== lane.token
          || lease.previous.connectionGeneration !== lane.connectionGeneration
          || (lease.providerId ?? null) !== lane.providerId) return invalid()
      }
      check()
      const value = Object.freeze({ executionId: execution.id })
      values.set(value, Object.freeze({ execution, session, job, lane, source,
        ...(input.owner ? { owner: input.owner } : {}),
        lifetimeGeneration: input.lifetimeGeneration, closureGeneration: input.closureGeneration,
        observedAt: new Date().toISOString(), assertCurrent: check }))
      return value
    } }),
    verify: Object.freeze({ read(value: ReviewNativeCapture): CapturedReviewNativeSource {
      const captured = value && values.get(value)
      if (!captured) return invalid()
      captured.assertCurrent()
      return captured
    } }),
  }
}
