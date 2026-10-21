import { isDeepStrictEqual } from 'node:util'
import type { HarnessExecution, NativeSessionReference, ReviewJob } from '@foreman-code/contracts'
import type { WorkflowNativeEntryPermit } from '../runs/workflowNativeEntry.js'
import type { RepeatRunRepository } from '../runs/repeatPostgres.js'
import { DomainError } from '../errors.js'

/** Owner-scoped NATIVE-1 adapter. No optional one-shot fallbacks are permitted.
 * readExecution validates the occurrence/slot/input receipt in the owner transaction.
 * exactSession validates the persisted provider version, native ID and command
 * evidence; it must not reconstruct a reference from capabilities or a latest row. */
export interface RepeatNativeObservationStore extends Pick<RepeatRunRepository,
  'readExecution' | 'settleNativeExecution'> {
  assertExecutionAdmission(executionId: string): Promise<void>
  assertNativeBoundary(executionId: string): Promise<void>
  exactSession(executionId: string): Promise<NativeSessionReference>
  /** Synchronous, one-use permission from a positively acknowledged launch COMMIT.
   * A returned candidate, an admission receipt or possible submission is not one. */
  authorizeNativeSubmission(executionId: string): Promise<void>
  consumeLaunch(executionId: string): boolean
}

/** The launch implementation belongs to the existing owner repository, not here. */
export interface RepeatNativeLaunchStore extends RepeatNativeObservationStore,
  Pick<RepeatRunRepository, 'readWorkExecutionContext'> {
  beginNativeEntry(executionId: string): Promise<WorkflowNativeEntryPermit>
  claimLaunch(executionId: string, paths: { workingDirectory: string; runtimeDirectory: string }): Promise<HarnessExecution | undefined>
  recoverSession(executionId: string): Promise<HarnessExecution>
}

/** A stale checkpoint may observe monotonic progress, never a different attempt,
 * occurrence input, configuration, accepted location or captured native session. */
export function assertSameRepeatExecution(expected: HarnessExecution, actual: HarnessExecution): void {
  const identity = (value: HarnessExecution) => ({ id: value.id, runId: value.runId,
    workflowNodeId: value.workflowNodeId, agentId: value.agentId,
    agentConfigurationVersionId: value.agentConfigurationVersionId, attempt: value.attempt, input: value.input })
  if (!isDeepStrictEqual(identity(expected), identity(actual))) throw new DomainError(
    'REPEAT_EXECUTION_INPUT_CONFLICT', 'Native observation cannot change its admitted execution or frozen input.', 409)
  for (const field of ['workingDirectory', 'runtimeDirectory', 'nativeSessionId'] as const) {
    if (expected[field] !== undefined && expected[field] !== actual[field]) throw new DomainError(
      'REPEAT_EXECUTION_INPUT_CONFLICT', 'Native observation cannot replace an accepted location or session.', 409)
  }
  if (expected.systemPrompt !== undefined && !isDeepStrictEqual(expected.systemPrompt, actual.systemPrompt)) {
    throw new DomainError('REPEAT_EXECUTION_INPUT_CONFLICT',
      'Native observation cannot replace the session system prompt.', 409)
  }
  if (expected.sessionContinuation !== undefined
    && !isDeepStrictEqual(expected.sessionContinuation, actual.sessionContinuation)) {
    throw new DomainError('REPEAT_EXECUTION_INPUT_CONFLICT', 'Native continuation cannot change its saved source.', 409)
  }
  if (expected.state === 'completed' && (actual.state !== 'completed'
    || !isDeepStrictEqual(expected.result, actual.result) || expected.finishedAt !== actual.finishedAt)) {
    throw new DomainError('REPEAT_EXECUTION_INPUT_CONFLICT', 'A durable terminal observation is immutable.', 409)
  }
}

export function repeatPhysicalSettlementPending(error: unknown): boolean {
  return error instanceof DomainError && ['APPROVAL_SETTLEMENT_PENDING', 'REPEAT_BOUNDARY_PENDING',
    'REPEAT_CLEANUP_PENDING'].includes(error.code)
}

/** Neither a delivery decision nor an acknowledgement alone ends a review turn. */
export function reviewPhysicallySettled(job: ReviewJob): boolean {
  return job.state === 'completed' && Boolean(job.providerTurnOrMessageId)
    || job.state === 'failed' && Boolean(job.cleanup?.completedAt)
      && ['terminal', 'closed', 'not_started'].includes(job.cleanup!.nativeState)
      && ['revoked', 'not_required'].includes(job.cleanup!.credentialState)
}

export function assertSameReviewJob(expected: ReviewJob, actual: ReviewJob): void {
  for (const field of ['id', 'interactionId', 'reviewerAgentId', 'provider', 'nativeSessionId',
    'correlationId', 'attempt'] as const) {
    if (expected[field] !== actual[field]) throw new DomainError('REVIEW_JOB_IDENTITY_CONFLICT',
      'A review finalizer cannot close a different assignment or lease attempt.', 409)
  }
  if (expected.providerTurnOrMessageId && expected.providerTurnOrMessageId !== actual.providerTurnOrMessageId) {
    throw new DomainError('REVIEW_JOB_IDENTITY_CONFLICT', 'A review finalizer cannot replace its native turn.', 409)
  }
}
