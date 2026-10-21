import type { NativeSessionLane, ReviewCleanup, ReviewJob, WorkflowRun } from '@foreman-code/contracts'

/** Never pair an old provider ID with another turn's correlation, even on attach. */
export function reviewPreflightIdentity(
  lane: Pick<NativeSessionLane, 'correlationId' | 'currentTurnOrMessageId'> | undefined,
  workflowCorrelationId: string,
): { correlationId: string; nativeTurnId?: string } {
  return lane?.correlationId
    ? { correlationId: lane.correlationId,
        ...(lane.currentTurnOrMessageId ? { nativeTurnId: lane.currentTurnOrMessageId } : {}) }
    : { correlationId: workflowCorrelationId }
}

/** Absence of a native acknowledgement is not evidence of closure. */
export function pendingReviewCleanup(): ReviewCleanup {
  return { nativeState: 'pending', credentialState: 'pending', interruptState: 'not_sent' }
}

export function reviewNeedsStop(job: Pick<ReviewJob, 'state' | 'cleanup' | 'error'>,
  run: Pick<WorkflowRun, 'executionState'>): boolean {
  if (job.state !== 'failed') return false
  if (!job.cleanup?.completedAt) return true
  return run.executionState !== 'completed'
    && !['REVIEW_NO_LONGER_PENDING', 'REVIEW_RUN_STOPPED'].includes(job.error?.code ?? '')
}

// Fixed public descriptions: provider errors can include paths, commands or credentials.
// Detailed, already-redacted evidence stays in the authorized review record.
const stopMessages: Record<string, string> = {
  REVIEWER_CREDENTIAL_LOST: 'The Orchestrator lost its App MCP credential or approval authority.',
  REVIEWER_AUTHORITY_LOST: 'The Orchestrator lost its approval authority.',
  REVIEW_JOB_IDENTITY_CONFLICT: 'The Orchestrator received conflicting native review identities.',
  REVIEW_SUBMISSION_REJECTED: 'The native provider rejected the Orchestrator review submission.',
  REVIEW_NATIVE_CLOSURE_UNCONFIRMED: 'The saved Orchestrator process boundary is missing; native closure is unconfirmed.',
  REVIEWER_NATIVE_APPROVAL_UNSUPPORTED: 'The Orchestrator requested a native approval that has no authorized reviewer.',
  REVIEW_NO_DECISION: 'The Orchestrator finished its native review without deciding the assigned request.',
  APPROVAL_DIRECT_CONNECTION_REQUIRED: 'The requesting node has no authorized direct connection to the designated Orchestrator.',
  REVIEW_NO_LONGER_PENDING: 'An obsolete review still requires native or credential cleanup.',
  REVIEW_RUN_STOPPED: 'The Run stopped before the native review finished.',
}
export function publicReviewStopError(code?: string): { code: string; message: string } {
  return code && Object.hasOwn(stopMessages, code)
    ? { code, message: stopMessages[code]! }
    : { code: 'REVIEW_FAILED', message: 'The assigned Orchestrator review failed. Inspect the review history before starting a new Run.' }
}
