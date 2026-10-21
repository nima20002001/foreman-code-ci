import type { HarnessExecution, HarnessNativeEvent, NativeSessionReference } from '@foreman-code/contracts'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { REMOTE_NATIVE_SOURCE_LIMIT } from '@foreman-code/contracts/remote-workflow-physical'
import type { NativeHistory } from '../harnesses/port.js'
import { DomainError } from '../errors.js'
import type { RunOwnership } from '../runs/ownership.js'
import type { RepeatNativeEvidence } from '../runs/repeatNativeRepository.js'
import type { SessionWriteLease, SingleWriterSessionManager } from './sessionWriter.js'

/** This channel is private production composition, not an HTTP/MCP input. A
 * serialized descriptor is useful provenance but is never a capability. Only
 * the coordinator receives capture(); the repository receives read(). Channels
 * made by tests/other compositions cannot authorize this repository. */
export type WorkflowOriginalNativeSource =
  | { type: 'session_created'; session: NativeSessionReference }
  | { type: 'boundary' }
  | { type: 'event'; event: HarnessNativeEvent }
  | { type: 'history'; history: NativeHistory }

export interface WorkflowNativeCaptureInput {
  owner: RunOwnership
  execution: HarnessExecution
  session: NativeSessionReference
  manager: SingleWriterSessionManager
  lease?: SessionWriteLease
  lifetimeGeneration: number
  closureGeneration: string | null
  source: WorkflowOriginalNativeSource
  kind: 'live' | 'recovery'
  /** Checks the coordinator's original Map entry, manager, session, generation
   * and controller. Must be synchronous: a G1 verifier cannot query a second
   * connection while holding native-lane locks. */
  assertCurrent(): void
}
export interface WorkflowNativeCapture {
  readonly owner: RunOwnership
  readonly execution: HarnessExecution
  readonly session: NativeSessionReference
  readonly source: WorkflowOriginalNativeSource
  readonly observedAt: string
  readonly kind: 'live' | 'recovery'
  readonly lifetimeGeneration: number
  readonly closureGeneration: string | null
  readonly lane: null | {
    id: string; token: string; connectionGeneration: number; providerId: string | null
  }
  assertCurrent(): void
}
export interface WorkflowNativeCapturePort {
  capture(input: WorkflowNativeCaptureInput): RepeatNativeEvidence
}
export interface WorkflowNativeVerificationPort {
  read(evidence: RepeatNativeEvidence): WorkflowNativeCapture
}
const issued = new WeakMap<object, string>()
function invalid(): never {
  throw new DomainError('NATIVE_SOURCE_NOT_CAPTURED', 'Native evidence must originate in the current coordinator lifetime.', 409)
}
function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) freezeTree(child)
  }
  return value
}
function freezeJson<T>(value: T, maxBytes = 4 * 1024 * 1024): T {
  return freezeTree(JSON.parse(canonicalGraphJson(value, maxBytes)) as T)
}

/** Preserve the opaque, deeply frozen capture while callers cross asynchronous
 * boundaries. structuredClone/JSON of it is deliberately not trusted. */
export function retainWorkflowNativeCapture(input: RepeatNativeEvidence): RepeatNativeEvidence {
  if (!input || !issued.has(input)) return invalid()
  return input
}

export function createWorkflowNativeCaptureChannel(): {
  capture: WorkflowNativeCapturePort; verify: WorkflowNativeVerificationPort
} {
  const captures = new WeakMap<object, WorkflowNativeCapture>()
  return {
    capture: Object.freeze({ capture(input: WorkflowNativeCaptureInput): RepeatNativeEvidence {
      input.owner.assertOwned()
      input.assertCurrent()
      if (input.execution.runId !== input.owner.runId || !Number.isSafeInteger(input.lifetimeGeneration)
        || input.lifetimeGeneration < (input.source.type === 'boundary' ? 0 : 1) || input.session.harness !== input.manager.harness
        || input.execution.nativeSessionId !== undefined
          && input.execution.nativeSessionId !== input.session.nativeSessionId
        || input.closureGeneration !== null && !/^[1-9][0-9]*$/.test(input.closureGeneration)) return invalid()
      const owner = input.owner, manager = input.manager, lease = input.lease
      const session = freezeJson(input.session), execution = freezeJson(input.execution)
      const source = freezeJson(input.source, REMOTE_NATIVE_SOURCE_LIMIT)
      const assertCoordinator = input.assertCurrent
      const lane = lease ? Object.freeze({ id: lease.fence.id, token: lease.fence.token,
        connectionGeneration: lease.previous.connectionGeneration, providerId: lease.providerId ?? null }) : null
      const check = () => {
        owner.assertOwned(); assertCoordinator()
        if (owner.runId !== execution.runId) return invalid()
        if (lease) {
          manager.assertCapturedLease(session, lease)
          if (lease.fence.id !== lane!.id || lease.fence.token !== lane!.token
            || lease.previous.connectionGeneration !== lane!.connectionGeneration
            || (lease.providerId ?? null) !== lane!.providerId) return invalid()
        }
      }
      check()
      if ((source.type === 'history' || source.type === 'event') && !lane) return invalid()
      if (source.type === 'event' && source.event.executionId !== execution.id) return invalid()
      if (source.type === 'session_created' && canonicalGraphJson(source.session) !== canonicalGraphJson(session)) return invalid()
      const observedAt = new Date().toISOString()
      const descriptor = freezeJson({ observedAt, source, executionId: execution.id, session,
        lifetimeGeneration: input.lifetimeGeneration, closureGeneration: input.closureGeneration, lane },
      REMOTE_NATIVE_SOURCE_LIMIT)
      const result: RepeatNativeEvidence = Object.freeze({ kind: input.kind, session, evidence: descriptor })
      captures.set(result, Object.freeze({ owner, execution, session, source, observedAt, kind: input.kind,
        lifetimeGeneration: input.lifetimeGeneration, closureGeneration: input.closureGeneration, lane,
        assertCurrent: check }))
      issued.set(result, observedAt)
      return result
    } }),
    verify: Object.freeze({ read(evidence: RepeatNativeEvidence): WorkflowNativeCapture {
      const capture = captures.get(evidence)
      if (!capture) return invalid()
      capture.assertCurrent()
      return capture
    } }),
  }
}

export function capturedWorkflowNativeTime(evidence: RepeatNativeEvidence): string {
  const at = issued.get(evidence)
  if (!at) return invalid()
  return at
}
