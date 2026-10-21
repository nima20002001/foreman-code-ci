import { setTimeout as delay } from 'node:timers/promises'
import type { ExecutionResult, HarnessExecution } from '@foreman-code/contracts'
import { SourceCapacityErrorDetailsSchema } from '@foreman-code/contracts'
import {
  failureClass, isDatabasePoolTimeout, isDatabaseTimeout, isTransientDatabaseOrSocketError, type FailureClass,
} from '@foreman-code/contracts/failure'
import { ZodError } from 'zod'
import { DomainError } from '../errors.js'
import { componentLogger } from '../diagnostics/logger.js'
import { isTransientExecutionCode } from '../../shared/executionFailureCodes.js'
export { isTransientExecutionCode } from '../../shared/executionFailureCodes.js'

/** Agent failure attempts per work activation, including the first. At-least-once: an Agent
 * turn may run again after an infrastructure failure; only results are deduped. */
export const EXECUTION_MAX_ATTEMPTS = 3
export const EXECUTION_INFRASTRUCTURE_RETRY_WINDOW_MS = 10 * 60_000
/** Wait before attempt 2, 3, ... (the last value repeats). */
export const EXECUTION_RETRY_BACKOFF_MS: readonly number[] = [10_000, 30_000, 60_000]

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const result = (error as { result?: ExecutionResult }).result
  if (result?.outcome === 'failed' && result.error?.code) return result.error.code
  return 'code' in error && error.code !== undefined ? String(error.code) : undefined
}

/** Pending settlement retains the checkpoint and original native lifetime for reconciliation. */
export function repeatSettlementPending(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && ['APPROVAL_SETTLEMENT_PENDING', 'REPEAT_BOUNDARY_PENDING', 'REPEAT_CLEANUP_PENDING',
      'WORK_ACTIVATIONS_UNRESOLVED', 'WORK_REQUEST_UNRESOLVED', 'WORK_DENIAL_CONTINUATION_UNRESOLVED',
    ].includes(String(error.code))
}

/** Shared classification. Transient: database timeouts and connection loss,
 * device/transport loss, MCP not ready, uncertain start or dispatch, interrupted
 * attempts, Worker restart and the credential failures they cause, and runtime
 * errors with no code on their whole cause chain. Everything else (an Agent's failed
 * result, an invalid output contract, Stop, budget exhaustion, revoked access) is a
 * real failure. An explicit class on the cause chain wins over these code rules. */
export function executionFailureClass(error: unknown): FailureClass {
  let coded = false
  return failureClass(error, link => {
    if (link instanceof ZodError) return 'permanent'
    if (link instanceof AggregateError) {
      const classes = link.errors.map(error => executionFailureClass(error))
      if (classes.includes('permanent')) return 'permanent'
      return classes.length && classes.every(value => value === 'cancelled') ? 'cancelled' : 'transient'
    }
    if (repeatSettlementPending(link)) return 'transient'
    if (isDatabaseTimeout(link) || isDatabasePoolTimeout(link)) return 'transient'
    const code = errorCode(link)
    if (code === undefined) return undefined
    coded = true
    return isTransientExecutionCode(code) ? 'transient' : undefined
  }, last => {
    if (isTransientDatabaseOrSocketError(last)) return 'transient'
    return !coded && last instanceof Error ? 'transient' : 'permanent'
  })
}

export function isTransientExecutionError(error: unknown): boolean {
  return executionFailureClass(error) === 'transient'
}

/** The recorded cause of one abandoned attempt; retryable marks it for a fresh attempt. */
export function transientExecutionFailure(error: unknown, fallbackCode = 'EXECUTION_START_INTERRUPTED'): ExecutionResult {
  const code = errorCode(error)
  const message = error instanceof Error && error.message ? error.message.slice(0, 2_000)
    : 'The attempt stopped before it produced an accepted result.'
  const details = error instanceof DomainError && error.code === 'SOURCE_CAPACITY' && error.details
    ? SourceCapacityErrorDetailsSchema.parse(error.details) : undefined
  return { outcome: 'failed', error: { code: code ?? fallbackCode, message, retryable: true,
    ...(details ? { details } : {}) } }
}

export function isTransientExecutionResult(result: ExecutionResult | undefined): boolean {
  return result?.outcome === 'failed' && result.error?.retryable === true
}

/** Delay before starting the attempt after `failedAttempt`. */
export function executionRetryDelayMs(failedAttempt: number): number {
  const configured = process.env.FOREMAN_EXECUTION_RETRY_BACKOFF_MS?.split(',').map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0)
  const backoff = configured?.length ? configured : EXECUTION_RETRY_BACKOFF_MS
  return backoff[Math.min(Math.max(failedAttempt, 1), backoff.length) - 1]!
}

/** Recorded infrastructure abandonment is separate from an Agent's retryable failed result. */
export function hasExecutionRetryBudget(failed: HarnessExecution, attempts: readonly {
  execution: HarnessExecution; infrastructureFailure: boolean
}[], now = Date.now()): boolean {
  const infrastructure = attempts.filter(attempt => attempt.infrastructureFailure)
  if (!infrastructure.some(attempt => attempt.execution.id === failed.id)) {
    return attempts.length - infrastructure.length < EXECUTION_MAX_ATTEMPTS
  }
  const firstFailureAt = infrastructure.reduce((earliest, attempt) =>
    Math.min(earliest, Date.parse(attempt.execution.finishedAt ?? '')), Infinity)
  const nextStartAt = now + executionRetryDelayMs(failed.attempt)
  return nextStartAt < firstFailureAt + EXECUTION_INFRASTRUCTURE_RETRY_WINDOW_MS
}

/** Back off before a queued retry starts. A replayed retry that already started does not wait again. */
export async function waitBeforeRetry(failed: HarnessExecution, next: HarnessExecution, signal: AbortSignal): Promise<void> {
  if (next.state !== 'queued' || next.startedAt) return
  const waitMs = executionRetryDelayMs(failed.attempt)
  componentLogger('engine').warn({ runId: failed.runId, workflowNodeId: failed.workflowNodeId,
    executionId: failed.id, nextExecutionId: next.id, attempt: next.attempt, waitMs,
    code: failed.result?.outcome === 'failed' ? failed.result.error?.code : undefined }, 'Retrying work in a fresh attempt')
  await delay(waitMs, undefined, { signal })
}
