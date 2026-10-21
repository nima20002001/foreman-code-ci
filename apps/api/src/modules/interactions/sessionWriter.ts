import { logIgnoredError } from '../diagnostics/ignoredError.js'
import { beginRuntimeTiming, timeRuntimeOperation, runtimeTimingPoint } from '../../infrastructure/runtimeTiming.js'
import type { ResponseAvailabilityInspector } from '../harnesses/responseAvailability.js'
import { randomUUID } from 'node:crypto'
import { nativeEventBatches } from './nativeEventBatches.js'
import { reviewPreflightIdentity } from './reviewPolicy.js'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { componentLogger } from '../diagnostics/logger.js'
import { isDatabaseTimeout, retryDatabaseTimeout, retryDatabaseOperation } from '../../infrastructure/databaseTimeout.js'
import { isTransactionConflict } from '../../infrastructure/transaction.js'
import { isRetryableLaneRenewal } from './laneRenewal.js'

import type { NativeHarnessEvent, NativeSessionLane, NativeSessionReference } from '@foreman-code/contracts'
import type { DeviceHistoryGap } from '@foreman-code/contracts/device-application'

import { DomainError } from '../errors.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput, NativeInitialTurnInput,
  NativeSteerInput, NativeCancelInput } from '../harnesses/port.js'
import { PostgresInteractionCoordinationRepository, type WriterFence } from './coordination.js'
import { ReviewEvidenceTracker, reviewTurnEvidence, type TurnEvidence } from './reviewerEvidence.js'

/** Native sessions can retain their transport while fenced ownership confirmation waits for the database. */
export class LeaseGuard {
  private readonly controller = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private deadline: ReturnType<typeof setTimeout> | undefined
  private expiresAt: number
  private readonly lostCode: string
  private readonly recover: (() => Promise<string>) | undefined
  readonly signal: AbortSignal

  constructor(
    leaseMs: number,
    private readonly assertOwned: () => Promise<void>,
    renew: () => Promise<string>,
    signal?: AbortSignal,
    expiresAt = new Date(Date.now() + leaseMs).toISOString(),
    options: { lostCode?: string; recover?: () => Promise<string> } = {},
  ) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 3) throw new RangeError('leaseMs must be an integer of at least 3 milliseconds.')
    this.signal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal
    this.lostCode = options.lostCode ?? 'SESSION_LANE_LEASE_LOST'
    this.recover = options.recover
    this.expiresAt = Date.parse(expiresAt)
    const armDeadline = (expiry: string) => {
      this.expiresAt = Date.parse(expiry)
      if (this.deadline) clearTimeout(this.deadline)
      if (this.recover) return
      this.deadline = setTimeout(() => this.controller.abort(
        new DomainError(this.lostCode, 'The lease expired without a confirmed renewal.', 409),
      ), Math.max(0, this.expiresAt - Date.now()))
      this.deadline.unref()
    }
    armDeadline(expiresAt)
    const intervalMs = Math.max(1, Math.floor(leaseMs / 3))
    const retryMs = Math.max(1, Math.min(250, Math.floor(leaseMs / 10)))
    const safetyMarginMs = Math.max(1, Math.min(1_000, Math.floor(leaseMs / 10)))
    runtimeTimingPoint('harness', 'lease.heartbeat_interval', { intervalMs })
    const scheduleRenewal = (delayMs: number) => {
      if (this.stopped || this.signal.aborted) return
      if (!this.recover && Date.now() + delayMs >= this.expiresAt - safetyMarginMs) return
      this.timer = setTimeout(() => {
        if (this.stopped || this.signal.aborted) return
        if (!this.recover && Date.now() >= this.expiresAt - safetyMarginMs) return
        const renewal = this.recover ?? renew
        void Promise.resolve().then(() => timeRuntimeOperation('harness', 'lease.renew', renewal)).then((expiry) => {
          if (this.stopped || this.signal.aborted) return
          this.checkExpiry()
          armDeadline(expiry)
          scheduleRenewal(intervalMs)
        }).catch((error: unknown) => {
          if (this.stopped || this.signal.aborted) return
          if (error instanceof DomainError && error.code === this.lostCode
            || this.recover && !isRetryableLaneRenewal(error)) {
            this.controller.abort(error)
            return
          }
          if (!(error instanceof DomainError && error.code === 'SESSION_LANE_RENEWAL_BUSY')) {
            componentLogger('harness').warn({ err: error }, 'Lease renewal is awaiting database confirmation.')
          }
          scheduleRenewal(retryMs)
        })
      }, delayMs)
      this.timer.unref()
    }
    scheduleRenewal(intervalMs)
  }

  private checkExpiry(): void {
    if (!this.recover && Date.now() >= this.expiresAt) {
      this.controller.abort(new DomainError(this.lostCode, 'The lease expired without a confirmed renewal.', 409))
    }
    this.signal.throwIfAborted()
  }

  private async confirmOwnership(): Promise<void> {
    if (this.recover && Date.now() >= this.expiresAt) {
      this.expiresAt = Date.parse(await this.recover())
      return
    }
    try {
      await this.assertOwned()
    } catch (error) {
      // A check can reach PostgreSQL after expiry even though it began under a valid lease.
      if (!this.recover || !isLeaseLost(error) || Date.now() < this.expiresAt) throw error
      this.expiresAt = Date.parse(await this.recover())
    }
  }

  async check(): Promise<void> {
    this.checkExpiry()
    try {
      await retryDatabaseOperation(() => timeRuntimeOperation('harness', 'lease.check', () => this.confirmOwnership()),
        isRetryableLaneRenewal, {
          signal: this.signal,
          check: () => this.checkExpiry(),
        })
    } catch (cause) {
      this.checkExpiry()
      const error = new DomainError(this.lostCode, 'The lease could not be confirmed.', 409)
      error.cause = cause
      this.controller.abort(error)
      throw error
    }
    this.checkExpiry()
  }

  async wait<T>(work: Promise<T>, signal: AbortSignal = this.signal): Promise<T> {
    const ownedSignal = signal === this.signal ? signal : AbortSignal.any([this.signal, signal])
    const finished = beginRuntimeTiming('harness', 'lease.wait')
    let abort: (() => void) | undefined
    return Promise.race([work, new Promise<never>((_resolve, reject) => {
      abort = () => reject(ownedSignal.reason)
      ownedSignal.addEventListener('abort', abort, { once: true })
      if (ownedSignal.aborted) abort()
    })]).finally(() => { finished(); if (abort) ownedSignal.removeEventListener('abort', abort) })
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.deadline) clearTimeout(this.deadline)
  }
}

/** Stop requesting events when ownership is lost, even if the iterator ignores abort. */
export function ownedEvents(events: AsyncIterable<NativeHarnessEvent>, guard: LeaseGuard, signal: AbortSignal = guard.signal): AsyncIterable<NativeHarnessEvent> {
  const ownedSignal = signal === guard.signal ? signal : AbortSignal.any([guard.signal, signal])
  return observeEvents(events, ownedSignal, guard)
}

function observeEvents<T>(events: AsyncIterable<T>, signal: AbortSignal,
  guard?: LeaseGuard): AsyncIterable<T> {
  const observer = new AbortController()
  const observedSignal = AbortSignal.any([signal, observer.signal])
  const reader = read()
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => reader.next(),
      return: () => {
        // Async-generator return queues behind next; wake that read before joining cleanup.
        observer.abort(new Error('Native event observation closed.'))
        return reader.return()
      },
    }),
  }

  async function* read(): AsyncGenerator<T, void> {
    const iterator = events[Symbol.asyncIterator]()
    let count = 0
    try {
      while (true) {
        // An immediately resolved iterator must not starve lease/Stop timers.
        if (count > 0 && count % 256 === 0) {
          try {
            await yieldToEventLoop(undefined, { signal: observedSignal })
          } catch (error) {
            observedSignal.throwIfAborted()
            throw error
          }
        }
        await guard?.check()
        const next = await waitForSignal(Promise.resolve().then(() => {
          observedSignal.throwIfAborted()
          return timeRuntimeOperation('harness', 'native.event_read', () => iterator.next())
        }), observedSignal)
        await guard?.check()
        observedSignal.throwIfAborted()
        if (next.done) return
        count += 1
        yield next.value
      }
    } finally {
      const closed = Promise.resolve(iterator.return?.())
      if (observedSignal.aborted) {
        // Provider generators can ignore return while silent; their closure remains observed.
        void closed.catch(() => {
          componentLogger('harness').warn('Native event iterator cleanup failed after detachment.')
        })
      } else {
        await closed
      }
    }
  }
}

export interface SessionWriteLease {
  fence: WriterFence
  correlationId: string
  guard: LeaseGuard
  previous: NativeSessionLane
  observedStatus: NativeSessionLane['observedStatus']
  providerId?: string
  operation?: 'attach'
  finished: Promise<void>
  finish(): void
}

export function isLeaseLost(error: unknown): boolean {
  return error instanceof DomainError && (error.code === 'SESSION_LANE_LEASE_LOST' || error.code === 'REVIEW_JOB_LEASE_LOST')
}

/** One boundary for workflow turns, reviewer turns, approvals, cancellation and attach/close. */
export class SingleWriterSessionManager implements NativeHarnessSessionManager {
  readonly harness: NativeHarnessSessionManager['harness']
  private readonly active = new Map<string, SessionWriteLease>()
  private readonly releasing = new Map<string, Promise<void>>()
  private controlTail: Promise<unknown> = Promise.resolve()
  private disposal: Promise<void> | undefined
  private closing = false
  readonly startInitialTurn?: NonNullable<NativeHarnessSessionManager['startInitialTurn']>
  readonly startInitialTurnBatches?: (start: NativeSessionStart, input: NativeInitialTurnInput & { onTurnOffered?(): void },
    signal?: AbortSignal) => AsyncIterable<NativeHarnessEvent[]>
  readonly inspectResponseAvailability?: NonNullable<ResponseAvailabilityInspector['inspectResponseAvailability']>
  readonly originalEnvironment?: NonNullable<NativeHarnessSessionManager['originalEnvironment']>
  readonly steerTurn?: NonNullable<NativeHarnessSessionManager['steerTurn']>
  readonly reconcileSteers?: NonNullable<NativeHarnessSessionManager['reconcileSteers']>

  constructor(
    private readonly manager: NativeHarnessSessionManager & ResponseAvailabilityInspector,
    private readonly coordination: PostgresInteractionCoordinationRepository,
    readonly agentId: string,
    private readonly leaseMs = 30_000,
  ) {
    this.harness = manager.harness
    if (manager.originalEnvironment) this.originalEnvironment = manager.originalEnvironment.bind(manager)
    if (manager.inspectResponseAvailability) this.inspectResponseAvailability = manager.inspectResponseAvailability.bind(manager)
    if (manager.steerTurn) this.steerTurn = (session, input, signal) =>
      this.control(session, signal, owned => manager.steerTurn!(session, input, owned))
    if (manager.reconcileSteers) this.reconcileSteers = manager.reconcileSteers.bind(manager)
    if (manager.startInitialTurn) {
      this.startInitialTurn = (start, input, signal) => this.initialTurn(start, input, signal)
      this.startInitialTurnBatches = (start, input, signal) => this.initialTurnBatches(start, input, signal)
    }
  }

  capabilities: NativeHarnessSessionManager['capabilities'] = (signal) => this.manager.capabilities(signal)
  canDetachForRestart = (session: NativeSessionReference) => this.manager.canDetachForRestart?.(session) ?? false
  get retainsReviewerSession() { return this.manager.retainsReviewerSession === true }
  prepareReview: NonNullable<NativeHarnessSessionManager['prepareReview']> = async (session, job, signal) => {
    await this.manager.prepareReview?.(session, job, signal)
  }
  originalApplicationAccess: NonNullable<NativeHarnessSessionManager['originalApplicationAccess']> = (session, signal) => {
    if (!this.manager.originalApplicationAccess) throw new Error('Original application lease recovery is unavailable')
    return this.manager.originalApplicationAccess(session, signal)
  }
  inspectMcp: NativeHarnessSessionManager['inspectMcp'] = (signal) => this.manager.inspectMcp(signal)
  pending: NativeHarnessSessionManager['pending'] = (session, signal) => this.manager.pending(session, signal)
  history: NativeHarnessSessionManager['history'] = async (session, signal) => {
    const lease = this.active.get(session.nativeSessionId)
    const history = await this.manager.history(session, signal)
    if (!lease || lease.providerId) return history
    this.assertCapturedLease(session, lease)
    await lease.guard.check()
    const evidence = reviewTurnEvidence(session, history, lease.correlationId)
    if (evidence.identityConflict) throw new DomainError('NATIVE_TURN_IDENTITY_CONFLICT',
      'The observed history belongs to a different native turn.', 409)
    // History may advance beyond the event batch currently being published.
    // Bind its correlated provider identity before a caller captures that history.
    if (evidence.providerId) {
      await this.coordination.acknowledgeLaneTurn(lease.fence, lease.correlationId, evidence.providerId)
      this.assertCapturedLease(session, lease)
      lease.providerId = evidence.providerId
      await lease.guard.check()
    }
    return history
  }
  observeBoundary: NonNullable<NativeHarnessSessionManager['observeBoundary']> = async (session, signal) => {
    await this.manager.observeBoundary?.(session, signal)
  }
  reconcile: NativeHarnessSessionManager['reconcile'] = (session, correlation, signal) => this.manager.reconcile(session, correlation, signal)
  reconcileResponse: NonNullable<NativeHarnessSessionManager['reconcileResponse']> = (session, response, signal) =>
    this.manager.reconcileResponse ? this.manager.reconcileResponse(session, response, signal) : this.manager.history(session, signal)

  isActive(session: NativeSessionReference): boolean {
    return this.active.has(session.nativeSessionId)
  }

  /** A current callback may present this exact native-writer lease to its
   * persisted graph producer. History outside the lease cannot mint authority. */
  currentProjectionLease(session: NativeSessionReference) {
    const lease = this.active.get(session.nativeSessionId)
    return lease && !lease.guard.signal.aborted
      ? { id: lease.fence.id, token: lease.fence.token, ...(lease.providerId ? { providerId: lease.providerId } : {}), live: true as const }
      : undefined
  }

  /** Synchronous counterpart of lease.check for use while G1 holds the lane.
   * The SQL verifier additionally checks the actual token, generation and DB
   * clock through that SAME transaction, never a detached heartbeat query. */
  assertCapturedLease(session: NativeSessionReference, lease: SessionWriteLease): void {
    if (this.active.get(session.nativeSessionId) !== lease
      || session.harness !== this.harness || lease.previous.nativeSessionId !== session.nativeSessionId) {
      throw new DomainError('SESSION_LANE_LEASE_LOST', 'The original native source no longer owns its writer lane.', 409)
    }
    lease.guard.signal.throwIfAborted()
  }

  capturedLease(session: NativeSessionReference): SessionWriteLease | undefined {
    const lease = this.active.get(session.nativeSessionId)
    if (lease) this.assertCapturedLease(session, lease)
    return lease
  }

  private ensure(session: NativeSessionReference, status: NativeSessionLane['observedStatus']) {
    return this.coordination.ensureLane({
      id: `lane-${randomUUID()}`, harness: session.harness, nativeSessionId: session.nativeSessionId,
      ownerAgentId: this.agentId, observedStatus: status, connectionGeneration: 0,
      observedAt: new Date().toISOString(), revision: 0,
    })
  }

  /** Positively close every transport owned by this exact manager, including
   * creates that failed before a native ID was returned. Never infer disposal
   * from an empty local session map. New writes stay fenced after any attempt. */
  dispose(signal?: AbortSignal): Promise<void> {
    this.closing = true
    if (this.disposal) return this.disposal
    if (!this.manager.dispose) return Promise.reject(new DomainError('NATIVE_DISPOSAL_UNSUPPORTED',
      'The native manager cannot prove closure of an unbound transport.', 409))
    const active = [...this.active.values()]
    const operation = Promise.resolve().then(() => this.manager.dispose!(signal)).then(async () => {
      await Promise.all(active.map((lease) => lease.finished))
    }).catch((error: unknown) => {
      if (this.disposal === operation) this.disposal = undefined
      throw error
    })
    this.disposal = operation
    return operation
  }

  async createSession(input: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference> {
    if (this.closing) throw new DomainError('NATIVE_MANAGER_DISPOSED', 'The captured native manager is disposed.', 409)
    const session = await this.manager.createSession(input, signal)
    // Return a late-created session to its owner so Stop can close the captured transport.
    if (!signal?.aborted) await this.ensure(session, 'idle')
    return session
  }

  async acquire(session: NativeSessionReference, correlationId: string, signal?: AbortSignal): Promise<SessionWriteLease> {
    signal?.throwIfAborted()
    if (this.closing) throw new DomainError('NATIVE_MANAGER_DISPOSED', 'The captured native manager is disposed.', 409)
    const finishTiming = beginRuntimeTiming('harness', 'lease.acquire', {
      nativeSessionId: session.nativeSessionId, correlationId, ownerId: this.agentId,
    })
    try {
      const previous = await retryDatabaseTimeout(() => this.ensure(session, 'uncertain'), { signal })
      const token = `writer-${randomUUID()}`
      // Preserve the unresolved turn correlation through attach/control operations and failed preflight.
      let claimUncertain = false
      const lane = await retryDatabaseTimeout(async () => {
        if (claimUncertain) {
          const current = await this.coordination.getLane(session.harness, session.nativeSessionId)
          if (current?.id === previous.id && current.leaseToken === token && current.leaseOwner === this.agentId) {
            await this.coordination.assertLaneLease(current.id, token)
            return current
          }
        }
        try {
          return await this.coordination.claimLane(previous.id, previous.revision, this.agentId, token,
            new Date(Date.now() + this.leaseMs).toISOString(), previous.correlationId ?? correlationId)
        } catch (error) {
          if (isDatabaseTimeout(error)) claimUncertain = true
          throw error
        }
      }, { signal })
      runtimeTimingPoint('harness', 'lease.claimed', {
        laneId: lane.id, nativeSessionId: session.nativeSessionId, ownerId: this.agentId,
        correlationId: previous.correlationId ?? correlationId,
      })
      const ownership = { owner: this.agentId, connectionGeneration: lane.connectionGeneration }
      const renew = () => this.coordination.renewLane(lane.id, token, this.leaseMs, ownership)
      const guard = new LeaseGuard(this.leaseMs,
        () => this.coordination.assertLaneLease(lane.id, token, ownership),
        renew, signal, lane.leaseExpiresAt, { recover: renew })
      let finish!: () => void
      const finished = new Promise<void>((resolve) => { finish = resolve })
      return {
        finished, finish, correlationId,
        fence: { id: lane.id, token }, guard, previous,
        observedStatus: previous.observedStatus,
        ...(previous.currentTurnOrMessageId ? { providerId: previous.currentTurnOrMessageId } : {}),
      }
    } finally { finishTiming() }
  }

  private async release(lease: SessionWriteLease): Promise<void> {
    await lease.guard.stop()
    try {
      if (isLeaseLost(lease.guard.signal.reason)) return
      let releaseUncertain = false
      await retryDatabaseTimeout(async () => {
        if (releaseUncertain) {
          const current = await this.coordination.getLane(lease.previous.harness, lease.previous.nativeSessionId)
          // A lost release response cannot authorize touching a successor's lane.
          if (current?.id === lease.fence.id && current.leaseToken !== lease.fence.token) return
        }
        try {
          await this.coordination.releaseLane(lease.fence.id, lease.fence.token, {
            observedStatus: lease.guard.signal.aborted ? 'uncertain' : lease.observedStatus,
            ...(lease.providerId ? { currentTurnOrMessageId: lease.providerId } : {}),
          })
        } catch (error) {
          if (isDatabaseTimeout(error)) releaseUncertain = true
          throw error
        }
      }, { signal: AbortSignal.timeout(this.leaseMs) })
    } finally { lease.finish() }
  }

  private async releaseSession(session: NativeSessionReference, lease: SessionWriteLease): Promise<void> {
    if (this.active.get(session.nativeSessionId) === lease) this.active.delete(session.nativeSessionId)
    const release = timeRuntimeOperation('harness', 'lease.release', () => this.release(lease),
      { nativeSessionId: session.nativeSessionId, laneId: lease.fence.id,
        correlationId: lease.correlationId, ownerId: this.agentId })
    // Removing the observer does not release its persisted lane. Restart close
    // must observe this exact release before attempting another fenced claim.
    this.releasing.set(session.nativeSessionId, release)
    try { await release } finally {
      if (this.releasing.get(session.nativeSessionId) === release) this.releasing.delete(session.nativeSessionId)
    }
  }

  async withLane<T>(session: NativeSessionReference, correlationId: string, signal: AbortSignal | undefined,
    work: (manager: NativeHarnessSessionManager, lease: SessionWriteLease) => Promise<T>): Promise<T> {
    const lease = await this.acquire(session, correlationId, signal)
    try {
      await lease.guard.check()
      this.active.set(session.nativeSessionId, lease)
      return await work(this.manager, lease)
    } finally {
      // A stale owner must not overwrite the successor's observations, including in cleanup.
      await this.releaseSession(session, lease)
    }
  }

  withCredentialLease<T>(session: NativeSessionReference, signal: AbortSignal,
    renew: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const work = this.controlTail.catch(() => {
      // ignore: the previous control caller receives its failure; renewal still needs its own authority check.
    }).then(async () => {
      const active = this.active.get(session.nativeSessionId)
      if (active) await waitForSignal(active.finished, signal)
      signal.throwIfAborted()
      return this.withLane(session, `credential-${randomUUID()}`, signal, async (_manager, lease) => {
        await lease.guard.check()
        const result = await renew(lease.guard.signal)
        await lease.guard.check()
        return result
      })
    })
    this.controlTail = work
    return work
  }

  async requireIdle(manager: NativeHarnessSessionManager, session: NativeSessionReference,
    correlationId: string, lease: SessionWriteLease, signal: AbortSignal = lease.guard.signal,
    preflightCorrelationId?: string): Promise<void> {
    const previous = lease.previous
    await lease.guard.check()
    signal.throwIfAborted()
    if (previous.observedStatus === 'idle' && !previous.correlationId && !previous.currentTurnOrMessageId) {
      lease.observedStatus = 'idle'
      return
    }
    lease.observedStatus = 'disconnected'
    // An unresolved native identity is an inseparable correlation/provider pair.
    // Only an unbound lane may fall back to the completed workflow correlation.
    const identity = reviewPreflightIdentity(previous, preflightCorrelationId ?? correlationId)
    const history = await lease.guard.wait(manager.reconcile(session, identity.correlationId, signal), signal)
    await lease.guard.check()
    signal.throwIfAborted()
    // Idle lanes clear their correlation but can retain the last provider ID.
    // That finished identity must not be bound to the NEXT review's correlation.
    // This preflight observes availability only; it never completes the new turn.
    const evidence = reviewTurnEvidence(session, history, identity.correlationId, identity.nativeTurnId)
    if (history.pendingInteraction || history.pendingInteractions.length || evidence.nativeBusy || evidence.identityConflict
      || (previous.observedStatus !== 'idle' && !evidence.nativeIdle)) {
      lease.observedStatus = evidence.nativeBusy ? 'busy' : 'uncertain'
      throw new DomainError('SESSION_LANE_BUSY', 'The native session has active or unreconciled work.', 409)
    }
    lease.observedStatus = 'idle'
  }

  private observe(session: NativeSessionReference, history: NativeHistory, correlationId: string, lease: SessionWriteLease): void {
    const evidence = reviewTurnEvidence(session, history, correlationId, lease.providerId)
    this.observeEvidence(evidence, lease)
  }

  private observeEvidence(evidence: TurnEvidence, lease: SessionWriteLease): void {
    if (evidence.providerId) lease.providerId = evidence.providerId
    lease.observedStatus = evidence.identityConflict ? 'uncertain' : evidence.terminal ? 'idle'
      : evidence.acknowledged || evidence.nativeBusy ? 'busy' : 'uncertain'
  }

  private async recordSkippedEvents(lease: SessionWriteLease, input: NativeTurnInput, gap: DeviceHistoryGap) {
    await lease.guard.check()
    await retryDatabaseOperation(
      () => this.coordination.recordSkippedEvents(lease.fence, input.clientCorrelationId, gap),
      error => isDatabaseTimeout(error) || isTransactionConflict(error),
      { signal: lease.guard.signal },
    )
    await input.onEventsSkipped?.(gap)
    await lease.guard.check()
  }

  private async *initialTurn(start: NativeSessionStart, input: NativeInitialTurnInput,
    signal?: AbortSignal): AsyncIterable<NativeHarnessEvent> {
    for await (const batch of this.initialTurnBatches(start, input, signal, individualEvents)) yield* batch
  }

  private async *initialTurnBatches(start: NativeSessionStart,
    input: NativeInitialTurnInput & { onTurnOffered?(): void }, signal?: AbortSignal,
    batches = nativeEventBatches): AsyncIterable<NativeHarnessEvent[]> {
    signal?.throwIfAborted()
    if (this.closing || !this.manager.startInitialTurn) throw new DomainError('NATIVE_INITIAL_TURN_UNAVAILABLE', 'The admitted initial lifecycle is unavailable.', 409)
    let session: NativeSessionReference | undefined
    let lease: SessionWriteLease | undefined
    let evidence: ReviewEvidenceTracker | undefined
    const controller = new AbortController()
    const initialSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    let lost: (() => void) | undefined
    // The existing execution/conversation admission owns the pre-SID offer.
    // There is no native lane identity until the provider actually reports it.
    try {
      input.onTurnOffered?.()
      const events = this.manager.startInitialTurn(start, {
        prompt: input.prompt, clientCorrelationId: input.clientCorrelationId,
        onEventsSkipped: async gap => {
          if (!lease) throw new DomainError('NATIVE_SESSION_IDENTITY_CONFLICT', 'Observation recovery requires an owned session.', 409)
          await this.recordSkippedEvents(lease, input, gap)
        },
        onSessionObserved: async (observed) => {
          session = observed
          if (observed.harness !== this.harness) throw new DomainError('NATIVE_SESSION_IDENTITY_CONFLICT', 'Observed session has a different provider.', 409)
          lease = await this.acquire(observed, input.clientCorrelationId, initialSignal)
          lost = () => controller.abort(lease!.guard.signal.reason)
          lease.guard.signal.addEventListener('abort', lost, { once: true })
          await lease.guard.check()
          await this.coordination.bindLaneTurn(lease.fence, input.clientCorrelationId)
          lease.observedStatus = 'uncertain'
          delete lease.providerId
          this.active.set(observed.nativeSessionId, lease)
          evidence = new ReviewEvidenceTracker(observed, input.clientCorrelationId)
          await input.onSessionObserved(observed)
          await lease.guard.check()
        },
        onMessageSubmitted: async (receipt) => {
          if (!session || !lease || !evidence || receipt.nativeSessionId !== session.nativeSessionId
            || receipt.clientCorrelationId !== input.clientCorrelationId) throw new DomainError('NATIVE_MESSAGE_IDENTITY_CONFLICT', 'Initial receipt differs from the observed owner.', 409)
          await lease.guard.check()
          evidence.acknowledge(receipt.nativeMessageId)
          if (evidence.snapshot().identityConflict) throw new DomainError('NATIVE_MESSAGE_IDENTITY_CONFLICT', 'Initial receipt conflicts with its writer lane.', 409)
          await retryDatabaseTimeout(() => this.coordination.acknowledgeLaneTurn(
            lease!.fence, input.clientCorrelationId, receipt.nativeMessageId), { signal: lease.guard.signal })
          lease.providerId = receipt.nativeMessageId
          await input.onMessageSubmitted?.(receipt)
          await lease.guard.check()
        },
      }, initialSignal)
      for await (const batch of batches(observeEvents(events, initialSignal))) {
        if (!lease || !evidence) throw new DomainError('NATIVE_SESSION_IDENTITY_REQUIRED', 'Provider output preceded observed session persistence.', 409)
        await lease.guard.check()
        for (const event of batch) evidence.observeEvent(event)
        this.observeEvidence(evidence.snapshot(), lease)
        yield batch
      }
      if (!session || !lease || !evidence) throw new DomainError('NATIVE_SESSION_IDENTITY_REQUIRED', 'Initial input has no observed native session.', 409)
      const history = await lease.guard.wait(this.manager.reconcile(session, input.clientCorrelationId, lease.guard.signal))
      await lease.guard.check()
      evidence.observeHistory(history)
      this.observeEvidence(evidence.snapshot(), lease)
    } catch (error) {
      // An offered initial input is never a definite create/non-submission failure.
      if (lease && !isLeaseLost(error)) lease.observedStatus = 'uncertain'
      throw error
    } finally {
      if (lease && lost) lease.guard.signal.removeEventListener('abort', lost)
      if (lease) await this.releaseSession(session!, lease)
    }
  }

  async *startTurn(session: NativeSessionReference, input: NativeTurnInput,
    signal?: AbortSignal): AsyncIterable<NativeHarnessEvent> {
    for await (const batch of this.turnBatches(session, input, signal, individualEvents)) yield* batch
  }

  startTurnBatches(session: NativeSessionReference,
    input: NativeTurnInput & { onTurnOffered?(): void; onSessionReady?(): Promise<void> },
    signal?: AbortSignal): AsyncIterable<NativeHarnessEvent[]> {
    return this.turnBatches(session, input, signal)
  }

  private async *turnBatches(session: NativeSessionReference,
    input: NativeTurnInput & { onTurnOffered?(): void; onSessionReady?(): Promise<void> }, signal?: AbortSignal,
    batches = nativeEventBatches): AsyncIterable<NativeHarnessEvent[]> {
    const lease = await this.acquire(session, input.clientCorrelationId, signal)
    let evidence = new ReviewEvidenceTracker(session, input.clientCorrelationId)
    let submitted = false
    try {
      await this.requireIdle(this.manager, session, input.clientCorrelationId, lease)
      await this.coordination.bindLaneTurn(lease.fence, input.clientCorrelationId)
      this.active.set(session.nativeSessionId, lease)
      const { onTurnOffered, onSessionReady, ...nativeInput } = input
      if (onSessionReady) {
        await timeRuntimeOperation('harness', 'native.publish_session', onSessionReady,
          { nativeSessionId: session.nativeSessionId, laneId: lease.fence.id })
      }
      await lease.guard.check()
      lease.observedStatus = 'uncertain'
      delete lease.providerId
      submitted = true
      onTurnOffered?.()
      const events = this.manager.startTurn(session, {
        ...nativeInput,
        onEventsSkipped: gap => this.recordSkippedEvents(lease, input, gap),
        onRetry: async (providerId) => {
          await lease.guard.check()
          if (session.harness !== 'codex' || lease.providerId !== providerId || !evidence.snapshot().terminal) {
            throw new DomainError('NATIVE_TURN_IDENTITY_CONFLICT', 'Capacity retry does not match a completed owned turn.', 409)
          }
          await input.onRetry?.(providerId)
          await this.coordination.bindLaneTurn(lease.fence, input.clientCorrelationId)
          evidence = new ReviewEvidenceTracker(session, input.clientCorrelationId)
          delete lease.providerId
          lease.observedStatus = 'uncertain'
          await lease.guard.check()
        },
        onMessageSubmitted: async (receipt) => {
          await lease.guard.check()
          if (receipt.nativeSessionId !== session.nativeSessionId || receipt.clientCorrelationId !== input.clientCorrelationId) {
            throw new DomainError('NATIVE_MESSAGE_IDENTITY_CONFLICT', 'The native message receipt differs from the owned writer lane.', 409)
          }
          evidence.acknowledge(receipt.nativeMessageId)
          if (evidence.snapshot().identityConflict) throw new DomainError('NATIVE_MESSAGE_IDENTITY_CONFLICT',
            'The provider returned conflicting message identities. Native work will not be replayed.', 409)
          await retryDatabaseTimeout(() => this.coordination.acknowledgeLaneTurn(
            lease!.fence, input.clientCorrelationId, receipt.nativeMessageId), { signal: lease.guard.signal })
          lease.providerId = receipt.nativeMessageId
          await input.onMessageSubmitted?.(receipt)
          await lease.guard.check()
        },
        onSubmitted: async (providerId) => {
          await lease.guard.check()
          evidence.acknowledge(providerId)
          if (evidence.snapshot().identityConflict) throw new DomainError('NATIVE_TURN_IDENTITY_CONFLICT',
            'The provider returned conflicting turn identities. Native work will not be replayed.', 409)
          await retryDatabaseTimeout(() => this.coordination.acknowledgeLaneTurn(
            lease.fence, input.clientCorrelationId, providerId), { signal: lease.guard.signal })
          lease.providerId = providerId
          await input.onSubmitted?.(providerId)
          await lease.guard.check()
        },
      }, lease.guard.signal)
      const observed = observeEvents(events, lease.guard.signal)
      // Database lease checks fence batches without consuming their provider flush interval.
      for await (const batch of observeEvents(batches(observed), lease.guard.signal, lease.guard)) {
        await lease.guard.check()
        for (const event of batch) evidence.observeEvent(event)
        this.observeEvidence(evidence.snapshot(), lease)
        yield batch
      }
      await lease.guard.check()
      const history = await lease.guard.wait(this.manager.reconcile(session, input.clientCorrelationId, lease.guard.signal))
      await lease.guard.check()
      evidence.observeHistory(history)
      this.observeEvidence(evidence.snapshot(), lease)
    } catch (error) {
      if (submitted && !isLeaseLost(error)) {
        lease.observedStatus = 'uncertain'
      }
      throw error
    } finally {
      await this.releaseSession(session, lease)
    }
  }

  private control<T>(session: NativeSessionReference, signal: AbortSignal | undefined,
    action: (signal: AbortSignal) => Promise<T>, cleanup = false): Promise<T> {
    const work = this.controlTail.catch(() => { /* ignore: the previous caller receives its failure; the queue must still admit the next operation. */ }).then(async () => {
      let active = this.active.get(session.nativeSessionId)
      if (cleanup && active?.operation === 'attach' && active.guard.signal.aborted
        && !isLeaseLost(active.guard.signal.reason)) {
        // The attachment still owns this lane. Stop may close its transport
        // before that attachment returns, but may not use a successor's lane.
        await this.coordination.assertLaneLease(active.fence.id, active.fence.token)
        const cleanupSignal = signal ?? AbortSignal.timeout(this.leaseMs)
        cleanupSignal.throwIfAborted()
        const result = await waitForSignal(action(cleanupSignal), cleanupSignal)
        await this.coordination.assertLaneLease(active.fence.id, active.fence.token)
        return result
      }
      if (active?.guard.signal.aborted && !isLeaseLost(active.guard.signal.reason)) {
        // Stop hands the lane back before issuing its separately fenced native cancellation.
        await active.finished
        active = this.active.get(session.nativeSessionId)
      }
      if (active) {
        await active.guard.check()
        signal?.throwIfAborted()
        const ownedSignal = signal ? AbortSignal.any([signal, active.guard.signal]) : active.guard.signal
        const result = await waitForSignal(action(ownedSignal), ownedSignal)
        await active.guard.check()
        return result
      }
      return this.withLane(session, `control-${randomUUID()}`, signal, async (_manager, lease) => {
        lease.observedStatus = 'uncertain'
        await lease.guard.check()
        const result = await lease.guard.wait(action(lease.guard.signal))
        await lease.guard.check()
        if (lease.previous.correlationId) {
          try {
            const history = await lease.guard.wait(this.manager.reconcile(session, lease.previous.correlationId, lease.guard.signal))
            this.observe(session, history, lease.previous.correlationId, lease)
          } catch (error) {
            logIgnoredError('harness', 'observe acknowledged native control', error)
            // A failed observation preserves the acknowledged action; the lease check below still fences ownership.
            lease.observedStatus = 'uncertain'
          }
          await lease.guard.check()
        }
        return result
      })
    })
    this.controlTail = work
    return work
  }

  /** Recheck a committed approval claim AFTER the control queue and native lane
   * are acquired, immediately before dispatch. The check is SQL-only and must
   * release its transaction before it returns; the native wait owns no Run lock. */
  respondQualified(session: NativeSessionReference, requestId: string,
    option: Parameters<NativeHarnessSessionManager['respond']>[2],
    beforeDispatch: (signal: AbortSignal) => Promise<void>, signal?: AbortSignal) {
    return this.control(session, signal, async (ownedSignal) => {
      await beforeDispatch(ownedSignal)
      ownedSignal.throwIfAborted()
      return this.manager.respond(session, requestId, option, ownedSignal)
    })
  }

  private qualifiedControlLease(session: NativeSessionReference, input: NativeCancelInput): SessionWriteLease {
    const lease = this.capturedLease(session)
    const providerId = session.harness === 'codex' ? input.nativeTurnId : input.inputMessageId
    if (!lease || lease.operation || lease.correlationId !== input.ownerRequestId
      || !providerId || lease.providerId !== providerId || !input.controlCommandId.trim()
      || input.controlCommandId === input.ownerRequestId
      || session.harness === 'codex' && input.inputMessageId !== undefined
      || session.harness !== 'codex' && input.nativeTurnId !== undefined) {
      throw new DomainError('CHAT_NATIVE_TARGET_CHANGED', 'The exact active native writer is no longer available.', 409)
    }
    return lease
  }

  /** Keep the captured turn across the queue, then recheck its committed command
   * in the caller's SQL-only fence immediately before the native offer. */
  steerQualified(session: NativeSessionReference,
    input: NativeSteerInput & { ownerRequestId: string; controlCommandId: string },
    beforeDispatch: (signal: AbortSignal) => Promise<void>, signal?: AbortSignal): Promise<{ nativeTurnId: string }> {
    const target = { ...input, nativeTurnId: input.expectedTurnId }
    const captured = this.qualifiedControlLease(session, target)
    if (!this.manager.steerTurn || session.harness !== 'codex' || input.clientCorrelationId !== input.controlCommandId) {
      throw new DomainError('STEER_UNAVAILABLE', 'This writer has no exact expected-turn steering operation.', 409)
    }
    return this.control(session, signal, async owned => {
      this.assertCapturedLease(session, captured)
      this.qualifiedControlLease(session, target)
      await beforeDispatch(owned)
      owned.throwIfAborted()
      this.assertCapturedLease(session, captured)
      this.qualifiedControlLease(session, target)
      const receipt = await this.manager.steerTurn!(session, input, owned)
      if (receipt.nativeTurnId !== input.expectedTurnId) throw new DomainError('NATIVE_CONTROL_RECEIPT_CONFLICT',
        'The provider acknowledged steering for a different native turn.', 409)
      return receipt
    })
  }

  cancelQualified(session: NativeSessionReference, input: NativeCancelInput,
    beforeDispatch: (signal: AbortSignal) => Promise<void>, signal?: AbortSignal): Promise<boolean> {
    const captured = this.qualifiedControlLease(session, input)
    return this.control(session, signal, async owned => {
      this.assertCapturedLease(session, captured)
      this.qualifiedControlLease(session, input)
      await beforeDispatch(owned)
      owned.throwIfAborted()
      this.assertCapturedLease(session, captured)
      this.qualifiedControlLease(session, input)
      return this.manager.cancelTurn
        ? this.manager.cancelTurn(session, input, owned)
        : this.manager.cancel(session, owned, input.nativeTurnId ?? input.inputMessageId)
    })
  }

  rebindApplicationAccess(session: NativeSessionReference, start: NativeSessionStart, signal?: AbortSignal): Promise<void> {
    if (!this.manager.rebindApplicationAccess) throw new DomainError('NATIVE_CREDENTIAL_REBIND_UNAVAILABLE',
      'The retained native process cannot change its application subject.', 409)
    return this.withCredentialLease(session, signal ?? AbortSignal.timeout(this.leaseMs), async owned => {
      const lease = this.capturedLease(session)!
      await this.requireIdle(this.manager, session, start.correlationId ?? lease.correlationId, lease, owned)
      await this.manager.rebindApplicationAccess!(session, start, owned)
      lease.observedStatus = 'idle'
    })
  }

  retireTurn(session: NativeSessionReference, correlationId: string) {
    return this.control(session, undefined, async () => this.manager.retireTurn?.(session, correlationId))
  }

  closeForResume(session: NativeSessionReference): Promise<void> {
    return this.withCredentialLease(session, AbortSignal.timeout(this.leaseMs), async owned => {
      const lease = this.capturedLease(session)!
      await this.requireIdle(this.manager, session, lease.correlationId, lease, owned)
      if (this.manager.closeForResume) await this.manager.closeForResume(session)
      else await this.manager.close(session, owned)
      lease.observedStatus = 'idle'
      delete lease.providerId
    })
  }

  respond: NativeHarnessSessionManager['respond'] = (session, requestId, option, signal) =>
    this.control(session, signal, (ownedSignal) => this.manager.respond(session, requestId, option, ownedSignal))
  cancel: NativeHarnessSessionManager['cancel'] = (session, signal, nativeTurnId) =>
    this.control(session, signal, (ownedSignal) => this.manager.cancel(session, ownedSignal, nativeTurnId), true)

  attachSession(session: NativeSessionReference, input: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference> {
    return this.withLane(session, `attach-${randomUUID()}`, signal, async (manager, lease) => {
      lease.operation = 'attach'
      // Control/close/attach lane leases are local operations, not a native
      // turn identity to fence a later recovery attachment against.
      if (input.correlationId && lease.previous.correlationId
        && !/^(?:control|close|attach)-/.test(lease.previous.correlationId)
        && (input.correlationId !== lease.previous.correlationId
          || (input.nativeTurnId && lease.previous.currentTurnOrMessageId
            && input.nativeTurnId !== lease.previous.currentTurnOrMessageId))) {
        throw new DomainError('SESSION_LANE_BUSY', 'The native lane identity changed before attachment. Recheck its saved identity pair.', 409)
      }
      // Preserve the actual attach lifetime so Stop can observe a late native
      // connection. A local abort is not evidence that the provider stopped.
      const attached = await manager.attachSession(session, input, lease.guard.signal)
      if (!lease.guard.signal.aborted) await lease.guard.check()
      if (attached.nativeSessionId !== session.nativeSessionId || attached.harness !== session.harness
        || attached.providerVersion !== session.providerVersion) throw new DomainError('NATIVE_SESSION_IDENTITY_MISMATCH', 'The native manager returned a different session identity.', 409)
      return attached
    })
  }

  private async closeOwned(session: NativeSessionReference,
    options: { restart: boolean; signal: AbortSignal | undefined }): Promise<void> {
    const { restart, signal } = options
    signal?.throwIfAborted()
    const close = (manager: NativeHarnessSessionManager) => restart && manager.closeForRestart
      ? manager.closeForRestart(session, signal) : manager.close(session, signal)
    const releasing = this.releasing.get(session.nativeSessionId)
    if (releasing) await releasing
    let active = this.active.get(session.nativeSessionId)
    if (active?.operation === 'attach' && active.guard.signal.aborted && !isLeaseLost(active.guard.signal.reason)) {
      await this.coordination.assertLaneLease(active.fence.id, active.fence.token)
      active.observedStatus = 'disconnected'
      return close(this.manager)
    }
    if (active?.guard.signal.aborted && !isLeaseLost(active.guard.signal.reason)) {
      await active.finished
      active = this.active.get(session.nativeSessionId)
    }
    if (active) {
      try {
        await active.guard.check()
      } catch (error) {
        if (!restart || !active.guard.signal.aborted || isLeaseLost(error)
          || error !== active.guard.signal.reason) throw error
        // Restart can abort observation while its ownership check is awaiting SQL.
        await active.finished
        return this.closeOwned(session, options)
      }
      active.observedStatus = 'disconnected'
      return close(this.manager)
    }
    return this.withLane(session, `close-${randomUUID()}`, signal, async (manager, lease) => {
      lease.observedStatus = lease.previous.observedStatus === 'idle' ? 'idle' : 'disconnected'
      await close(manager)
      if (!restart) {
        // Physical closure retires this process's turn; detachment must keep its exact identity.
        lease.observedStatus = 'idle'
        delete lease.providerId
      }
    })
  }

  close(session: NativeSessionReference, signal?: AbortSignal): Promise<void> {
    return this.closeOwned(session, { restart: false, signal })
  }
  closeForRestart(session: NativeSessionReference, signal?: AbortSignal): Promise<void> {
    return this.closeOwned(session, { restart: true, signal })
  }
}

async function waitForSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })])
  } finally { signal.removeEventListener('abort', abort) }
}

export function coordinateSessionManager(manager: NativeHarnessSessionManager,
  coordination: PostgresInteractionCoordinationRepository, agentId: string, leaseMs = 30_000): SingleWriterSessionManager {
  if (manager instanceof SingleWriterSessionManager) {
    if (manager.agentId !== agentId) throw new DomainError('SESSION_LANE_OWNER_CONFLICT', 'A native writer belongs to another Agent.', 409)
    return manager
  }
  return new SingleWriterSessionManager(manager, coordination, agentId, leaseMs)
}

async function* individualEvents(events: AsyncIterable<NativeHarnessEvent>): AsyncIterable<NativeHarnessEvent[]> {
  for await (const event of events) yield [event]
}
