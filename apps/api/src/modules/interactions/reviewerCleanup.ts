import { asRecord } from '../../shared/records.js'
import type { NativeSessionReference, PendingNativeInteraction, ReviewCleanup, ReviewJob } from '@foreman-code/contracts'

import type { NativeHistory } from '../harnesses/port.js'
import { reviewTurnEvidence } from './reviewerEvidence.js'
import { logIgnoredError } from '../diagnostics/ignoredError.js'


/** A permission's message identity is not necessarily its root user turn identity. */
export function reviewOwnsPermission(
  session: NativeSessionReference, providerId: string, request: PendingNativeInteraction, history: NativeHistory,
): boolean {
  if (request.session.harness !== session.harness || request.session.providerVersion !== session.providerVersion
    || request.session.nativeSessionId !== session.nativeSessionId || !request.turn.nativeRequestId) return false
  if (session.harness === 'claude') {
    const submission = history.nativeSubmission, callback = asRecord(request.request)
    return submission?.kind === 'message' && submission.nativeSessionId === session.nativeSessionId
      && submission.nativeMessageId === providerId && history.correlationId === submission.clientCorrelationId
      && request.nativeRequestType === 'can_use_tool' && request.turn.nativeMessageId === providerId
      && callback.nativeMessageId === providerId && typeof callback.generation === 'string' && callback.generation.length > 0
      && typeof callback.toolUseId === 'string' && callback.toolUseId.length > 0
      && typeof callback.attemptId === 'string' && callback.attemptId.length > 0
  }
  if (session.harness === 'codex') return request.turn.nativeTurnId === providerId
  return false
}

export interface ReviewCleanupAttempt {
  job: ReviewJob
  session: NativeSessionReference
  /** False when the lane now describes a successor: never cancel it or publish it idle. */
  ownsTurn: boolean
  /** Positive closure evidence from the exact execution/session owner, not manager absence. */
  closed?: boolean
  pending?: readonly PendingNativeInteraction[]
  observe?: () => Promise<NativeHistory>
  cancel?: (providerId: string) => Promise<boolean>
  confirmClosed?: () => Promise<boolean>
  revoke?: (principalId: string) => Promise<void>
  invalidate?: () => Promise<void>
  check(): Promise<void>
  persist(cleanup: ReviewCleanup, releaseLease: boolean, providerId?: string): Promise<ReviewJob>
}

/** One bounded cleanup pass. No prompt or permission response is ever replayed. */
export async function settleReviewCleanup(input: ReviewCleanupAttempt): Promise<ReviewJob> {
  let job = input.job
  if (job.state !== 'failed' || !job.cleanup) throw new Error('Cleanup requires a durable failed review.')
  let cleanup = job.cleanup
  const save = async (fields: Partial<ReviewCleanup>, providerId?: string) => {
    await input.check()
    job = await input.persist({ ...cleanup, ...fields }, false, providerId)
    cleanup = job.cleanup!
  }
  const attempt = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    await input.check()
    try {
      const result = await work()
      await input.check()
      return result
    } catch (error) {
      logIgnoredError('engine', 'observe review cleanup', error)
      // A timeout/provider failure is recoverable. A lost lease is NOT permission
      // to continue with another side effect, including credential cleanup.
      await input.check()
      return undefined
    }
  }
  if (cleanup.nativeState === 'pending') {
    if (input.closed) await save({ nativeState: 'closed' })
    else if (input.observe) {
      const history = await attempt(input.observe)
      if (history) {
        const evidence = reviewTurnEvidence(input.session, history, job.correlationId, job.providerTurnOrMessageId)
        const requests = [...(input.pending ?? []), ...history.pendingInteractions,
          ...(history.pendingInteraction ? [history.pendingInteraction] : [])]
        if (evidence.terminal && !requests.length) {
          await save({ nativeState: 'terminal' }, evidence.providerId)
        } else if (input.ownsTurn && evidence.providerId && !evidence.identityConflict && input.cancel
          && cleanup.interruptState === 'not_sent'
          && requests.every((request) => reviewOwnsPermission(input.session, evidence.providerId!, request, history))) {
          // Journal BEFORE the native mutation. A crash or rejected promise cannot
          // turn an uncertain interrupt (which may reject permissions) into a retry.
          await save({ interruptState: 'submitted' }, evidence.providerId)
          const acknowledged = await attempt(() => input.cancel!(evidence.providerId!))
          if (acknowledged === true) await save({ interruptState: 'acknowledged' })
          // ACK is deliberately not followed by an idle/terminal inference.
        }
      }
    } else if (input.ownsTurn && input.confirmClosed && await attempt(input.confirmClosed) === true) {
      await save({ nativeState: 'closed' })
    }
  }
  if (cleanup.credentialState === 'pending') {
    const revoke = cleanup.credentialPrincipalId && input.revoke
      ? () => input.revoke!(cleanup.credentialPrincipalId!) : input.invalidate
    if (revoke && await attempt(async () => { await revoke(); return true }) === true) {
      await save({ credentialState: 'revoked' })
    }
  }
  if (cleanup.nativeState !== 'pending' && cleanup.credentialState !== 'pending' && !cleanup.completedAt) {
    await save({ completedAt: new Date().toISOString() })
  }
  await input.check()
  return input.persist(cleanup, true)
}
