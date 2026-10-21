import type { ExecutionResult } from '@foreman-code/contracts'
import type { WorkflowControlDisposition } from '../collaboration/workflowControlTypes.js'
import { DomainError } from '../errors.js'

/** A logical control failure never rewrites the provider's immutable result. */
export function workflowControlFailure(control: WorkflowControlDisposition): ExecutionResult | undefined {
  if (control.kind === 'stopping') return { outcome: 'failed', error: { code: 'WORKFLOW_TURN_STOPPED',
    message: 'The current work was stopped without a queued continuation.', retryable: false } }
  if (control.kind !== 'superseded' || !['failed','canceled'].includes(control.continuation.state)) return undefined
  return { outcome: control.continuation.state === 'canceled' ? 'canceled' : 'failed', error: {
    code: control.continuation.errorCode ?? 'CONTROL_CONTINUATION_CLOSED',
    message: 'The reserved continuation could not continue this work.', retryable: false } }
}

export class ControlAdmissionFailure extends Error {
  constructor(readonly errorCode: string, cause: unknown) {
    super('The reserved control successor failed admission.', { cause })
  }
}

/** Unknown I/O/settlement remains pending. Only an explicit final refusal can
 * close a reservation that was already made before the native interrupt. */
export function finalControlAdmissionRefusal(error: unknown): boolean {
  return error instanceof DomainError && error.status < 500 && [
    'WORKFLOW_EXECUTION_BUDGET_EXHAUSTED', 'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED',
    'ACCESS_DENIED', 'AUTH_REVOKED', 'HARNESS_RETIRED', 'HARNESS_PROFILE_UNAVAILABLE',
    'HARNESS_CONFIGURATION_MISMATCH', 'WORKFLOW_NODE_NOT_FOUND', 'WORKFLOW_AGENT_NOT_FOUND',
    'WORKER_EXECUTION_IDENTITY_INVALID', 'WORKFLOW_AGENT_CONFIGURATION_MISSING',
  ].includes(error.code)
}
