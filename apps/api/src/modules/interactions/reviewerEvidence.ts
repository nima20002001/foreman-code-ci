import { asRecord } from '../../shared/records.js'
import { ExecutionResultSchema, type NativeHarnessEvent, type NativeSessionReference } from '@foreman-code/contracts'

import type { NativeHistory } from '../harnesses/port.js'
import { NativeDeliveryError } from '../harnesses/errors.js'


export interface TurnEvidence {
  acknowledged: boolean
  terminal: boolean
  nativeIdle: boolean
  nativeBusy: boolean
  providerId?: string
  identityConflict?: boolean
}

/**
 * Constant-size, session-bound evidence. Stream callers feed each event once;
 * authoritative history is folded once at reconciliation, never after each delta.
 * No transcript, result body, or diagnostic event window is retained here.
 */
export class ReviewEvidenceTracker {
  private providerId: string | undefined
  private acknowledged: boolean
  private terminal = false
  private nativeIdle = false
  private nativeBusy = false
  private busyProviderId: string | undefined
  private pending = false
  private identityConflict = false
  private count = 0

  constructor(
    private readonly session: NativeSessionReference,
    private readonly correlationId: string,
    knownProviderId?: string,
  ) {
    this.providerId = knownProviderId
    this.acknowledged = Boolean(knownProviderId)
    // Claude message identity is supplied by its admitted SDK manager and exact
    // native receipt. This tracker does not grant release/profile qualification.
  }

  get processedEvents(): number { return this.count }
  get retainedEventCount(): number { return 0 }

  /** The provider's submission receipt is bound by the startTurn call, not by an idle event. */
  acknowledge(providerId: string): void {
    if (!providerId || (this.providerId && this.providerId !== providerId)) {
      this.identityConflict = true
      return
    }
    this.providerId = providerId
    this.acknowledged = true
  }

  snapshot(): TurnEvidence {
    return {
      acknowledged: this.acknowledged,
      terminal: this.terminal && !this.pending && !this.nativeBusy && !this.identityConflict,
      nativeIdle: this.nativeIdle && !this.pending && !this.identityConflict,
      nativeBusy: this.nativeBusy || this.pending,
      ...(this.providerId ? { providerId: this.providerId } : {}),
      ...(this.identityConflict ? { identityConflict: true } : {}),
    }
  }

  private busy(providerId?: string): void { this.nativeIdle = false; this.nativeBusy = true; this.busyProviderId = providerId }
  private idle(): void { this.nativeIdle = true; this.nativeBusy = false }

  observeEvent(event: NativeHarnessEvent): void {
    this.count += 1
    const payload = event.payload
    if (this.session.harness === 'claude') {
      // The admitted SDK reports consumed input messages, not provider turns.
      // A result/session echo without that exact message cannot settle a review.
      if (payload.nativeSessionId !== this.session.nativeSessionId
        || payload.clientCorrelationId !== this.correlationId || typeof payload.nativeMessageId !== 'string'
        || !payload.nativeMessageId) return
      if (this.providerId && payload.nativeMessageId !== this.providerId) { this.identityConflict = true; return }
      if (event.type === 'message.submitted' || event.type === 'interaction.pending'
        && typeof payload.nativeRequestId === 'string' && payload.nativeRequestId.length > 0) {
        this.acknowledge(payload.nativeMessageId)
        this.busy(payload.nativeMessageId)
      } else if (event.type === 'turn.completed' && payload.nativeMessageId === this.providerId
        && ExecutionResultSchema.safeParse(payload.result).success) {
        this.terminal = true
        this.idle()
      }
      return
    }
    if ((typeof payload.threadId === 'string' && payload.threadId !== this.session.nativeSessionId)
      || (typeof payload.sessionID === 'string' && payload.sessionID !== this.session.nativeSessionId)) return
    const turn = asRecord(payload.turn)
    const turnId = typeof payload.turnId === 'string' ? payload.turnId : typeof turn.id === 'string' ? turn.id : undefined
    if (event.type === 'turn.started' || event.type === 'turn/started') {
      this.busy(turnId)
      if (payload.clientCorrelationId === this.correlationId && turnId) this.acknowledge(turnId)
      else if (turnId === this.providerId && typeof payload.clientCorrelationId === 'string') this.identityConflict = true
    }
    const completed = event.type === 'turn.completed' || event.type === 'turn/completed'
    // Session availability is distinct from review completion. A terminal event
    // for an unrelated, observed busy turn may clear busy, but cannot acknowledge
    // or complete this review. This also lets a finalized lane accept its next turn.
    if (completed && turnId && turnId === this.busyProviderId) this.idle()
    if (completed && turnId === this.providerId && turnId) {
      if (typeof payload.clientCorrelationId === 'string' && payload.clientCorrelationId !== this.correlationId) {
        this.identityConflict = true
      } else {
        this.terminal = true
        this.idle()
      }
    }
    if (event.type === 'thread.reconciled' || event.type === 'thread.attached') {
      if (payload.threadId === this.session.nativeSessionId && turnId && turnId === this.busyProviderId
        && ['succeeded', 'failed', 'canceled'].includes(String(payload.terminal))) this.idle()
      const thread = asRecord(payload.thread)
      if (thread.id !== this.session.nativeSessionId || !Array.isArray(thread.turns)) return
      // An outer correlationId is a query echo, never an acknowledgement.
      for (const value of thread.turns) {
        const candidate = asRecord(value)
        const items = Array.isArray(candidate.items) ? candidate.items : []
        const correlated = candidate.clientUserMessageId === this.correlationId
          || items.some((item) => asRecord(item).clientUserMessageId === this.correlationId)
        const matches = correlated || (this.providerId !== undefined && candidate.id === this.providerId)
        if (!matches || typeof candidate.id !== 'string') continue
        if (typeof candidate.clientUserMessageId === 'string'
          && candidate.clientUserMessageId !== this.correlationId) this.identityConflict = true
        this.acknowledge(candidate.id)
        if (candidate.id === this.providerId) this.terminal = ['completed', 'failed', 'interrupted'].includes(String(candidate.status))
      }
      const last = asRecord(thread.turns.at(-1))
      const status = asRecord(thread.status).type ?? thread.status
      this.busyProviderId = typeof last.id === 'string' ? last.id : undefined
      this.nativeBusy = status === 'active' || last.status === 'inProgress'
      this.nativeIdle = !this.nativeBusy && (status === 'idle' && (thread.turns.length === 0
        || ['completed', 'failed', 'interrupted'].includes(String(last.status)))
        || (this.terminal && last.id === this.providerId))
    }
  }

  observeHistory(history: NativeHistory): void {
    const retryIndex = this.session.harness === 'codex' ? history.events.findLastIndex(event =>
      event.type === 'turn.capacity_retry' && event.payload.threadId === this.session.nativeSessionId) : -1
    for (const event of history.events.slice(retryIndex + 1)) this.observeEvent(event)
    const terminal = history.terminalTurn
    const submission = history.nativeSubmission
    const messageId = submission?.kind === 'message' && this.session.harness === 'claude'
      && submission.nativeSessionId === this.session.nativeSessionId
      && submission.clientCorrelationId === this.correlationId ? submission.nativeMessageId : undefined
    if (submission?.kind === 'message' && !messageId) this.identityConflict = true
    const providerId = this.session.harness === 'claude' ? messageId : history.nativeTurnId
    if (history.correlationId !== undefined) {
      if (history.correlationId !== this.correlationId) this.identityConflict = true
      else if (providerId) this.acknowledge(providerId)
    }
    if (terminal && terminal.correlationId !== this.correlationId) this.identityConflict = true
    // The caller must have attached/verified this exact session and reconciled it
    // with this correlation. NativeHistory is session-scoped by the manager port.
    // Generic terminalResult and a reconcile query echo are deliberately ignored.
    if (terminal && history.correlationId === this.correlationId && terminal.correlationId === this.correlationId) {
      if (providerId && providerId === terminal.providerId
        && ['succeeded', 'failed', 'canceled'].includes(terminal.result.outcome)) {
        this.acknowledge(providerId)
        this.terminal = true
        // Exact terminal metadata supersedes old start events for this turn,
        // but not observed work belonging to a different provider turn.
        if (!this.nativeBusy || !this.busyProviderId || this.busyProviderId === providerId) this.idle()
      } else this.identityConflict = true
    }
    this.pending = Boolean(history.pendingInteraction || history.pendingInteractions.length)
  }
}

/** One-shot adapter for lane preflight and callers with a single history snapshot. */
export function reviewTurnEvidence(
  session: NativeSessionReference,
  history: NativeHistory,
  correlationId: string,
  knownProviderId?: string,
): TurnEvidence {
  const tracker = new ReviewEvidenceTracker(session, correlationId, knownProviderId)
  tracker.observeHistory(history)
  return tracker.snapshot()
}

export function definitelyRejected(error: unknown): boolean {
  return error instanceof NativeDeliveryError
    && error.operation === 'turn_submission' && error.delivery === 'not_sent'
}
