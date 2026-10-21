import { isDatabaseTimeout, retryDatabaseTimeout } from '../../infrastructure/databaseTimeout.js'
import { withAbortSignal } from '../../infrastructure/abortSignal.js'
import { RETIRED_OPENCODE_MESSAGE } from '@foreman-code/contracts'
import { runtimeTimingPoint, timeRuntimeOperation, withRuntimeTimingContext } from '../../infrastructure/runtimeTiming.js'
import { inspectNativeResponse } from '../harnesses/responseAvailability.js'
import type { InteractionActivityEvidence } from './activityProjection.js'
import type { ReviewNativeCapture, ReviewNativeCapturePort, ReviewOriginalNativeSource } from './reviewNativeCapture.js'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'

import {
  HarnessExecutionSchema,
  ExecutionResultSchema,
  NativeSessionReferenceSchema,
  type DurableInteraction,
  type ExecutionResult,
  type HarnessExecution,
  type HarnessExecutionRequest,
  type WorkflowApprovalConfiguration,
  type AgentConfigurationVersion,
  type NativeSessionReference,
  type NativeHarnessEvent,
  type PendingNativeInteraction,
  type ReviewJob,
  type WorkflowRun,
  HarnessExecutionRequestSchema,
} from '@foreman-code/contracts'

import { remainingCredentialLifetime } from '../access/credentialLifetime.js'
import { APP_MCP_TOKEN_ENVIRONMENT_VARIABLE, WORKER_CREDENTIAL_RENEWAL_WINDOW_MS,
  type IssuedWorkerCredential } from '../access/workerCredentials.js'
import type { NativeHarnessSessionManager, NativeHistory } from '../harnesses/port.js'
import { DomainError } from '../errors.js'
import { ReviewerDispatcher } from './reviewer.js'
import { nativePersistenceRedactor } from './nativePersistence.js'
import { workResultRepairPrompt } from './workResultRepair.js'
import { deliverableRepairPrompt, deliverableVerdict, nativeOutputSchema, type DeliverableContract } from './deliverable.js'
import { NATIVE_EVENT_BATCH_SIZE } from './nativeEventBatches.js'
import { assertOriginalWorkflowTerminal } from './workflowTerminalSource.js'
import { workResultRepairCorrelation } from '../runs/workResultRepair.js'
import { reviewTurnEvidence } from './reviewerEvidence.js'
import type { ReviewCleanupSession, ReviewCredentialMaintenance } from './reviewerRuntime.js'
import { coordinateSessionManager, isLeaseLost, type SingleWriterSessionManager } from './sessionWriter.js'
import { HarnessExecutionError, NativeDeliveryError } from '../harnesses/errors.js'
import { assertNativeWorkflowConfiguration } from '../harnesses/nativeWorkflowConfiguration.js'
import { attemptCleanup, cleanupTimeoutMs, withCleanupDeadline } from './cleanup.js'
import { deviceRequestTimeoutMs } from '../devices/deviceRequestRetry.js'
import { readExecutionPlacement } from '../placement/persistence.js'
import { buildHarnessPrompt } from '../harnesses/prompt.js'
import { isTransientRefreshFailure, renewOwnedLeases, type OwnedLease } from '../leases/ownerLeases.js'
import { componentLogger } from '../diagnostics/logger.js'
import { isTransientExecutionError, isTransientExecutionResult, transientExecutionFailure } from '../runs/executionRetryPolicy.js'
import type { PostgresRunRepository } from '../runs/postgres.js'
import type { RunOwnership } from '../runs/ownership.js'
import { capturedWorkflowNativeTime, type WorkflowNativeCapturePort, type WorkflowOriginalNativeSource } from './workflowNativeCapture.js'
import type { RepeatNativeEvidence } from '../runs/repeatNativeRepository.js'
import type { SessionWriteLease } from './sessionWriter.js'
import type { WorkflowNativeLease } from '../runs/workflowNativeGraph.js'
import { normalizeNativeProducerEvent } from '../run-graph/nativeProducerNormalization.js'
import type { PostgresApprovalBudgetRepository } from './budget.js'
import type { Wave25InteractionRepository as PostgresInteractionRepository } from './wave25/repository.js'
import type {
  AttachedInteractionSession,
  NativeManagerResolutionContext,
  NativeManagerOwnershipContext,
  NativeSessionManagerResolver,
  ResolvedNativeSessionManager,
} from './runtimePorts.js'
import type { ExecutionCredentialProvider } from '../harnesses/mcpDetection.js'
import { readDetachedWorkflowLifetime, readDetachedWorkflowSession, readRemoteWorkflowContinuation, recoverWorkflowNativeClosure,
  type ClosedWorkflowSession, type WorkflowClosureStore } from './workflowClosure.js'
import { finishRecoveredWorkflowCredentials } from './workflowTerminalRecovery.js'
import { assertSavedPendingApprovalOriginalLocked } from './nativeApprovalProof.js'
import { openWorkflowLifecycleLocked } from '../runs/repeatLifecycle.js'
import { workflowExecutionRequest } from '../runs/workflowExecutionRequest.js'
import { repeatTickIndex } from '../runs/repeatResolution.js'
import { readRecoverableRemoteReviewer, readRetainedRemoteReviewer,
  retainRemoteReviewerCredential } from './retainedRemoteReviewer.js'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { reviewPreflightIdentity } from './reviewPolicy.js'
import type { RepeatReviewerBindings } from './repeatReviewer.js'
import { assertSameRepeatExecution, assertSameReviewJob, repeatPhysicalSettlementPending,
  reviewPhysicallySettled, type RepeatNativeObservationStore } from './repeatObservation.js'

export type ApprovalExecutionObservation =
  | { state: 'waiting'; execution: HarnessExecution; interaction: DurableInteraction; interactions: DurableInteraction[] }
  | { state: 'completed'; execution: HarnessExecution; result: ExecutionResult }

function isRestartCancellation(error: unknown, signal?: AbortSignal): boolean {
  const reason = signal?.reason
  if (!(reason instanceof DomainError) || reason.code !== 'ENGINE_RESTART') return false
  return error === reason || error instanceof NativeDeliveryError
    && error.cleanup === 'confirmed' && error.cause === reason
}

function isCredentialAuthorityLost(error: unknown): boolean {
  return error instanceof DomainError && ([401, 403].includes(error.status)
    || error.code === 'WORKER_CREDENTIAL_NOT_RENEWABLE')
}

interface OwnedNativeSession {
  execution: HarnessExecution
  context: NativeManagerResolutionContext
  manager: SingleWriterSessionManager
  controller: AbortController
  generation: number
  closureGeneration?: string
  closureRegistration?: Promise<string>
  launchReserved?: boolean
  launchReservation?: Promise<void>
  failed?: boolean
  session?: NativeSessionReference
  starting?: Promise<void>
  /** Restart stopped waiting for this startup; it is still in flight. */
  startupPending?: boolean
  opening?: Promise<NativeSessionReference>
  openingFailed?: boolean
  preparing?: Promise<IssuedWorkerCredential['environment'] | undefined>
  // A canceled remote attach can leave the original Worker session running without a Main acknowledgment.
  restartAttachment?: { session: NativeSessionReference; request: HarnessExecutionRequest }
  restartRecovery?: {
    owner: RunOwnership
    session: NativeSessionReference
    generation: string
    attachmentGeneration?: string
    principalId?: string
  }
  terminalRecoveredWithoutCredential?: boolean
  cleanup?: Promise<Error[]>
  reviewFinalizer?: symbol
  reviewFinishing?: boolean
  reviewOwner?: RunOwnership
  releaseReviewOwner?: () => Promise<void>
  runOwner?: RunOwnership
  stopWaitingRenewal?: () => Promise<void>
  stopReviewerRenewal?: () => Promise<void>
  reviewerRenewal?: Promise<void>
  reviewerRecoveryPending?: boolean
  pendingApprovalRestoration?: boolean
  retainedObservationError?: unknown
}

interface ApprovalObservationInput {
  candidate: HarnessExecution
  request: HarnessExecutionRequest
  approval?: WorkflowApprovalConfiguration | undefined
  agentActiveTimeoutMs?: number | undefined
  workflowId: string
  graphThreadId: string
  owner: RunOwnership
  signal: AbortSignal
  workHandoffContract?: string | undefined
  /** Enforced deliverable contract for every workflow Agent execution. */
  deliverable?: DeliverableContract | undefined
  onStarted?: (() => void) | undefined
}

interface WorkflowObservationState {
  input: ApprovalObservationInput
  ensured: { execution: HarnessExecution; created: boolean }
  repeat: RepeatNativeObservationStore
  credentialFailure: AbortController
  signal: AbortSignal
  execution: HarnessExecution
  repeatLaunch: boolean
  nativeTurnOffered: boolean
  workResultRepairs: number
  committedNativeSequences: Map<string, number>
  workflowCorrelation: string
  context?: NativeManagerResolutionContext | undefined
  manager?: SingleWriterSessionManager | undefined
  resolved?: (ResolvedNativeSessionManager & { manager: SingleWriterSessionManager }) | undefined
  ownedSession?: OwnedNativeSession | undefined
  session?: NativeSessionReference | undefined
  existing?: NativeSessionReference | undefined
  request?: HarnessExecutionRequest | undefined
  restartRecovery?: OwnedNativeSession['restartRecovery']
  stopRenewal?: (() => Promise<void>) | undefined
  finishStartup?: (() => void) | undefined
  budgetTimer?: ReturnType<typeof setTimeout> | undefined
  knownSecrets: string[]
  bookkeeping<T>(work: () => Promise<T>): Promise<T>
  validateContinuation(): Promise<void>
  assertBoundary(): Promise<void>
  watchCredential(): void
  safeValue<T>(value: T): T
  safeError(error: unknown): unknown
  startCredentialMaintenance(): void
  observePending(history: NativeHistory, sourceLease?: WorkflowNativeLease): Promise<ApprovalExecutionObservation | undefined>
}

/** Native dispatch never began, so the original request must still be pending natively. */
function nativeDispatchNotStarted(interaction: DurableInteraction): boolean {
  return ['not_started', 'pending', 'failed'].includes(interaction.deliveryState)
}

/** Cold restoration keeps the original session for unanswered, answered and delivered
 * approvals; delivery recovery and checkpoint consumption then settle them without resending. */
function restorableApproval(interaction: DurableInteraction): boolean {
  return interaction.status !== 'canceled'
}

/** Idempotent ensure/observe boundary called first on every LangGraph node entry. */
export class ApprovalExecutionCoordinator {
  private readonly managerCredentials = new WeakMap<NativeHarnessSessionManager, IssuedWorkerCredential>()

  private readonly credentialRenewals = new WeakMap<NativeHarnessSessionManager, Promise<void>>()

  readonly reviewers: ReviewerDispatcher
  get reviewCoordination() { return this.interactions.coordination }
  private readonly writers = new WeakMap<NativeHarnessSessionManager, SingleWriterSessionManager>()
  private readonly rawManagers = new WeakMap<NativeHarnessSessionManager, NativeHarnessSessionManager>()
  // A waiting graph has no active task, but still owns its native process.
  private readonly ownedSessions = new Map<string, OwnedNativeSession>()
  private readonly closedExecutions = new Set<string>()
  // Closure survives the early ownerless Stop pass, but never a new connection.
  private readonly closedWorkflowSessions = new Map<string, ClosedWorkflowSession>()
  private readonly stoppingRuns = new Set<string>()
  private readonly pendingCleanupRuns = new Set<string>()
  private readonly cancellations = new Map<string, Promise<void>>()
  private readonly reviewerRecoveries = new Map<string, Promise<boolean>>()
  private readonly sharedRunOwners = new Map<string, RunOwnership>()
  private closing = false
  private restartClosure: Promise<void> | undefined

  residentRunIds(): string[] {
    return [...new Set([...this.pendingCleanupRuns, ...[...this.ownedSessions.values()].map((owned) => owned.execution.runId)])]
  }

  private ownSession(execution: HarnessExecution, context: NativeManagerResolutionContext, manager: SingleWriterSessionManager): OwnedNativeSession {
    if (this.closing) throw new Error('Native sessions are shutting down.')
    if (this.stoppingRuns.has(execution.runId)) throw new Error('The Run is stopping; native work cannot be restarted.')
    let owned = this.ownedSessions.get(execution.id)
    if (!owned) {
      this.closedExecutions.delete(execution.id)
      this.closedWorkflowSessions.delete(execution.id)
      owned = { execution, context, manager, controller: new AbortController(), generation: 0 }
      this.ownedSessions.set(execution.id, owned)
    }
    return owned
  }

  private openingSession(owned: OwnedNativeSession, operation: Promise<NativeSessionReference>): Promise<NativeSessionReference> {
    const opening = operation.then(
      (session) => {
        owned.session = session
        owned.generation += 1
        // A late create/attach completion invalidates earlier closure evidence.
        this.closedExecutions.delete(owned.execution.id)
        this.closedWorkflowSessions.delete(owned.execution.id)
        delete owned.openingFailed
        return session
      },
      (error: unknown) => { owned.openingFailed = true; throw error },
    ).finally(() => { if (owned.opening === opening) delete owned.opening })
    owned.opening = opening
    return opening
  }

  private rememberClosedWorkflowSession(execution: HarnessExecution, session: NativeSessionReference): void {
    this.closedWorkflowSessions.set(execution.id, {
      execution: { id: execution.id, runId: execution.runId, workflowNodeId: execution.workflowNodeId,
        agentId: execution.agentId, agentConfigurationVersionId: execution.agentConfigurationVersionId,
        attempt: execution.attempt, nativeSessionId: session.nativeSessionId,
        ...(execution.workingDirectory ? { workingDirectory: execution.workingDirectory } : {}),
        ...(execution.runtimeDirectory ? { runtimeDirectory: execution.runtimeDirectory } : {}) },
      session: { ...session },
    })
  }

  /** Persist only the exact manager's confirmed close, for Stop AND ordinary
   * runtime disposal. This does not cancel the Run, stop its budget, retire its
   * approval, revoke execution authority or finalize its workflow lifetime. */
  private async closeWorkflowSession(owned: OwnedNativeSession,
    options: { restart?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    if (owned.context.acceptedPlacement?.hostRef.kind !== 'device')
      return this.closeWorkflowSessionOwned(owned, options)
    let owner = owned.reviewOwner ?? owned.runOwner
    try { owner?.assertOwned() }
    catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'RUN_OWNERSHIP_LOST') throw error
      await owner?.release()
      owner = undefined
    }
    const acquired = !owner
    owner ??= await this.runs.acquireOwnership(owned.execution.runId, () => owned.controller.abort())
    if (!owner) throw new DomainError('SESSION_LANE_BUSY', 'The Run is still draining its native owner.', 409)
    this.adoptRunOwner(owner)
    const releaseOwner = owner.retain(() => owned.controller.abort())
    try { await this.closeWorkflowSessionOwned(owned, options) }
    finally {
      await releaseOwner()
      if (acquired) await owner.release()
    }
  }
  private async closeWorkflowSessionOwned(owned: OwnedNativeSession,
    options: { restart?: boolean; signal?: AbortSignal }): Promise<void> {
    const { restart, signal } = options
    signal?.throwIfAborted()
    const session = owned.session
    if (!session) throw new DomainError('NATIVE_WORKFLOW_CLOSURE_CONFLICT',
      'The native connection is not ready for an exact close receipt.', 409)
    const generation = owned.generation
    if (restart) await owned.manager.closeForRestart(session, signal)
    else await owned.manager.close(session, signal)
    // Persist the same positive close that formerly survived only in RAM.
    // Registration precedes native preflight/spawn; no cold resolver or
    // terminal business state can create this receipt.
    const assertCurrent = () => {
      signal?.throwIfAborted()
      if (this.ownedSessions.get(owned.execution.id) !== owned
        || owned.generation !== generation || owned.opening) {
        throw new DomainError('NATIVE_WORKFLOW_CLOSURE_CONFLICT', 'The native manager lifetime changed during close.', 409)
      }
    }
    assertCurrent()
    if (this.workflowClosures && owned.closureRegistration
      && (!owned.closureGeneration || owned.generation === 0 || owned.openingFailed)) {
      throw new DomainError('NATIVE_WORKFLOW_CLOSURE_CONFLICT', 'No confirmed native connection owns this close receipt.', 409)
    }
    if (!this.workflowClosures || !owned.closureGeneration) throw new DomainError(
      'NATIVE_WORKFLOW_CLOSURE_CONFLICT', 'The exact original native lifetime has no durable reservation.', 409)
    if (restart) {
      // Detachment makes a later exact attach eligible, not Stop, a result or a
      // cleanup success. It can never be upgraded into a terminal close receipt.
      await this.workflowClosures.recordDetached(owned.execution, session, owned.closureGeneration, assertCurrent)
      assertCurrent()
      this.closedExecutions.delete(owned.execution.id)
      this.closedWorkflowSessions.delete(owned.execution.id)
      return
    }
    const durable = await this.workflowClosures.record(owned.execution, session, owned.closureGeneration, assertCurrent)
    assertCurrent()
    this.closedExecutions.add(owned.execution.id)
    this.closedWorkflowSessions.set(owned.execution.id, durable)
  }

  private cleanupSession(owned: OwnedNativeSession, cancel = true): Promise<Error[]> {
    if (cancel) owned.controller.abort()
    if (owned.cleanup) return owned.cleanup
    const safe = nativePersistenceRedactor(Object.values(this.managerCredentials.get(owned.manager)?.environment.variables ?? {}))
    const task = (async () => {
      const failures: Error[] = []
      const attempt = <T>(label: string, operation: (signal: AbortSignal) => Promise<T>) =>
        attemptCleanup(failures, `${owned.execution.id}: ${label}`, operation,
          owned.context.acceptedPlacement?.hostRef.kind === 'device' ? { timeoutMs: deviceRequestTimeoutMs } : {})
      // Create/attach can be in flight when Stop arrives. Never invent an identity
      // or replay a turn to obtain a session that can be canceled.
      if (owned.launchReservation) await attempt('await native launch reservation', async () => { await owned.launchReservation })
      if (owned.opening) await attempt('await native session', async () => { await owned.opening })
      // A persisted session reference is not evidence that THIS manager ever
      // attached it. A failed cold attach cannot close an invented local session.
      let closed = false
      if (owned.session && owned.execution.nativeSessionId) {
        const session = owned.session
        const proof = await attempt('read exact durable closure', () => this.workflowClosures!.read(owned.execution))
        if (proof?.durableGeneration === owned.closureGeneration) closed = true
        if (!closed) {
          if (cancel) await attempt('cancel native session', (signal) => owned.manager.cancel(session, signal))
          closed = await attempt('close native session', async signal => {
            await this.closeWorkflowSession(owned, { signal })
            return true
          }) === true
        }
      } else {
        // Positive disposal, not an empty map, no-session row or a terminal enum.
        // The captured manager rejects future setup and drains all its creates.
        const manager = owned.manager
        const generation = owned.generation
        const observedSession = owned.session
        const disposed = await attempt('dispose original unbound native manager', async signal => {
          await manager.dispose(signal)
          return true
        }) === true
        if (disposed && !owned.opening && owned.session === observedSession && owned.generation === generation) {
          const check = () => {
            if (this.ownedSessions.get(owned.execution.id) !== owned || owned.manager !== manager
              || owned.generation !== generation || owned.opening || owned.session !== observedSession
              || owned.execution.nativeSessionId) throw new DomainError('NATIVE_LIFETIME_CHANGED',
              'The unbound native manager changed during disposal.', 409)
          }
          const registration = owned.closureRegistration && await attempt('read native lifetime reservation', async () => {
            try {
              return await owned.closureRegistration!
            } catch (error) {
              check()
              const neverEntered = generation === 0 && !observedSession && !owned.closureGeneration
                && !owned.openingFailed
              // Stop can reject reservation before entry; this manager has already confirmed disposal.
              if (neverEntered && error instanceof DomainError && error.code === 'NATIVE_WORKFLOW_CLOSURE_CONFLICT') {
                return undefined
              }
              throw error
            }
          })
          if (registration && this.workflowClosures) {
            const proof = await attempt('record positive unbound disposal', () => this.workflowClosures!.recordUnbound(owned.execution, registration, check))
            closed = proof?.durableGeneration === registration
          } else {
            // No lifetime was entered. The repository must additionally seal its
            // positive reserved/prepared entry before any terminal can commit.
            check(); closed = true
          }
        }
      }
      if (closed) this.closedExecutions.add(owned.execution.id)
      const revoked = await attempt('revoke execution credential', async () => {
        await this.credentials?.revokeForExecution(owned.execution.id)
        return true
      })
      if (closed && revoked && !owned.opening) {
        const released = await attempt('release native manager', async () => { this.managerCredentials.delete(owned.manager); this.managers.release?.(owned.context, this.rawManagers.get(owned.manager) ?? owned.manager, owned.failed ? 'failed' : 'released'); return true })
        if (released && this.ownedSessions.get(owned.execution.id) === owned) this.ownedSessions.delete(owned.execution.id)
      }
      if ((!closed || owned.opening) && !failures.length) failures.push(new Error(`${owned.execution.id}: native session closure is unconfirmed.`))
      return failures.map((error) => safe.error(error) as Error)
    })().finally(() => { delete owned.cleanup })
    owned.cleanup = task
    return task
  }
  /** Close only the captured, registered native lifetime. Unlike Stop recovery,
   * this path has no resolver, capability query, orphan-process fallback or new
   * credential. Failure leaves the owner resident and the durable barrier closed. */
  private async closeRepeatLifetime(owned: OwnedNativeSession, assertCurrent: () => void,
    finishRecoveredCredentials?: () => Promise<void>): Promise<void> {
    const session = owned.session
    const generation = owned.generation
    const registration = owned.closureGeneration
    const credential = this.managerCredentials.get(owned.manager)
    const check = () => {
      assertCurrent()
      if (this.ownedSessions.get(owned.execution.id) !== owned || owned.generation !== generation
        || owned.opening || owned.openingFailed || !session || !registration || !this.workflowClosures
        || owned.closureGeneration !== registration || owned.session !== session
        || this.credentials && !credential
          && !(owned.terminalRecoveredWithoutCredential && finishRecoveredCredentials)
        || credential && (this.managerCredentials.get(owned.manager)?.principalId !== credential.principalId
          || this.managerCredentials.get(owned.manager)?.environment !== credential.environment)) {
        throw new DomainError('REPEAT_CLEANUP_PENDING', 'The exact native lifetime cannot yet be closed.', 409)
      }
    }
    check()
    if (owned.cleanup) throw new DomainError('REPEAT_CLEANUP_PENDING', 'Native cleanup is already in progress.', 409)
    // Keep the actual operation registered even when a caller's outer deadline
    // expires. A timeout is not closure and cannot start a competing finalizer.
    const close = async (signal: AbortSignal): Promise<Error[]> => {
      check()
      const proof = await this.workflowClosures!.read(owned.execution)
      check()
      if (!proof || proof.durableGeneration !== registration) await this.closeWorkflowSession(owned, { signal })
      check()
      if (credential) await this.credentials?.revoke({ principalId: credential.principalId })
      else if (owned.terminalRecoveredWithoutCredential && finishRecoveredCredentials) {
        await finishRecoveredCredentials()
      }
      check()
      this.managerCredentials.delete(owned.manager)
      await owned.stopWaitingRenewal?.()
      await owned.stopReviewerRenewal?.()
      await owned.releaseReviewOwner?.()
      delete owned.reviewOwner
      delete owned.releaseReviewOwner
      this.managers.release?.(owned.context, this.rawManagers.get(owned.manager) ?? owned.manager,
        owned.failed ? 'failed' : 'released')
      if (this.ownedSessions.get(owned.execution.id) === owned) this.ownedSessions.delete(owned.execution.id)
      return []
    }
    const failures: Error[] = []
    const bounded: Promise<Error[]> = (async () => {
      await attemptCleanup(failures, `${owned.execution.id}: close exact repeat lifetime`, signal => {
        const task = close(signal)
        // Keep an unfinished close registered until its operation acknowledges cancellation.
        void task.finally(() => { if (owned.cleanup === bounded) delete owned.cleanup }).catch(() => {
          // ignore: the bounded cleanup promise reports the same failure to its caller.
        })
        return task
      }, owned.context.acceptedPlacement?.hostRef.kind === 'device' ? { timeoutMs: deviceRequestTimeoutMs } : {})
      const safe = nativePersistenceRedactor(Object.values(credential?.environment.variables ?? {}))
      return failures.map((error) => safe.error(error) as Error)
    })()
    owned.cleanup = bounded
    const errors = await bounded
    if (errors.length) throw new AggregateError(errors, 'Exact native lifetime cleanup is incomplete.')
  }

  /** First repair durable receipts. A terminal input cannot obtain a replacement
   * native process merely to clean it up. Related reviewers close via their own
   * captured job finalizers; the repository checks all their receipts together. */
  private async finishRepeatExecution(execution: HarnessExecution, store: RepeatNativeObservationStore,
    owner: RunOwnership, signal: AbortSignal): Promise<void> {
    const check = () => { signal.throwIfAborted(); owner.assertOwned() }
    check()
    if (execution.state !== 'completed' || !execution.result || !execution.finishedAt) throw new DomainError(
      'REPEAT_BOUNDARY_PENDING', 'Cleanup requires the exact durable terminal result.', 409)
    const retained = this.ownedSessions.get(execution.id)
    if (retained?.manager.retainsReviewerSession) {
      retained.execution = execution
      await this.budgets.finish(execution.id, execution.finishedAt)
      await store.settleNativeExecution(execution.id)
      check()
      retained.context = { ...retained.context, purpose: 'reviewer' }
      this.maintainRetainedReviewer(retained)
      return
    }
    try { await store.settleNativeExecution(execution.id); check(); return }
    catch (error) { if (!repeatPhysicalSettlementPending(error)) throw error; check() }
    const owned = this.ownedSessions.get(execution.id)
    if (owned) {
      // Workflow terminal repair must never close a later reviewer lifetime on
      // the same execution. Only its captured review job may do that.
      if (owned.context.purpose === 'reviewer') throw new DomainError('REPEAT_CLEANUP_PENDING',
        'The exact reviewer lifetime is still responsible for its cleanup.', 409)
      assertSameRepeatExecution(owned.execution, execution)
      if (!owned.session || owned.session.nativeSessionId !== execution.nativeSessionId) throw new DomainError(
        'REPEAT_CLEANUP_PENDING', 'No captured session matches the terminal execution.', 409)
      owned.execution = execution
      await this.budgets.finish(execution.id, execution.finishedAt)
      check()
      await this.closeRepeatLifetime(owned, check,
        () => finishRecoveredWorkflowCredentials(owner, execution, this.credentials, signal))
    } else {
      // A crash after close/COMMIT is repaired without touching a native manager.
      // The proof reader rejects newer generations and any older unclosed one.
      const proof = await this.workflowClosures?.read(execution)
      check()
      if (!proof) throw new DomainError('REPEAT_CLEANUP_PENDING',
        'No durable exact-session closure exists. Native work will not be restarted.', 409)
      await this.budgets.finish(execution.id, execution.finishedAt)
      check()
      // Capture and revoke only exact workflow-purpose principals under the
      // owner/closure fence. Never revoke a successor reviewer's credential.
      await finishRecoveredWorkflowCredentials(owner, execution, this.credentials, signal)
      check()
    }
    check()
    await store.settleNativeExecution(execution.id)
    check()
  }

  /** Capture at reviewer attachment, not in its eventual finally callback. The
   * marker also distinguishes two jobs reusing the same resident connection. */
  captureReviewFinalizer(executionId: string, session: NativeSessionReference, assigned: ReviewJob):
    ((settled: ReviewJob) => Promise<void>) | undefined {
    // Do not let a mutable dispatch argument retarget the captured identity.
    assigned = { ...assigned }
    session = { ...session }
    const owned = this.ownedSessions.get(executionId)
    if (!owned?.session) return undefined
    this.assertSessionIdentity(owned.session, session)
    if (owned.context.purpose !== 'reviewer' || owned.execution.agentId !== assigned.reviewerAgentId
      || session.harness !== assigned.provider || session.nativeSessionId !== assigned.nativeSessionId) {
      throw new DomainError('REVIEW_JOB_IDENTITY_CONFLICT', 'The reviewer finalizer has no captured assignment.', 409)
    }
    const generation = owned.generation
    const marker = Symbol(assigned.id)
    owned.reviewFinalizer = marker
    // Stop, ownership loss or credential loss can close or tear down this same lifetime while the review ends.
    // That path then owns the closure, so the finalizer has nothing left to do and must not report a conflict.
    let yielded: DomainError | undefined
    const check = () => {
      if (this.ownedSessions.get(executionId) !== owned || owned.generation !== generation
        || owned.reviewFinalizer !== marker || owned.opening || owned.controller.signal.aborted) {
        const lost = new DomainError('REVIEW_JOB_IDENTITY_CONFLICT', 'The reviewer finalizer lost its native lifetime.', 409)
        const registered = this.ownedSessions.get(executionId)
        if (owned.generation === generation && owned.reviewFinalizer === marker && !owned.opening
          && (registered === undefined || registered === owned)) yielded = lost
        throw lost
      }
      this.assertSessionIdentity(owned.session!, session)
    }
    const finalize = async (settled: ReviewJob) => {
      assertSameReviewJob(assigned, settled)
      check()
      const run = await this.runs.get(owned.execution.runId)
      check()
      if (!run) throw new DomainError('RUN_NOT_FOUND', 'The captured reviewer Run is unavailable.', 404)
      if (!reviewPhysicallySettled(settled)) return
      owned.reviewFinishing = true
      try {
        const context = await this.interactions.coordination.getReviewJobContext(assigned.id)
        check()
        if (context.executionId !== executionId || context.workingDirectory !== owned.context.workingDirectory
          || context.providerVersion !== session.providerVersion) throw new DomainError('REVIEW_JOB_IDENTITY_CONFLICT',
          'The review job no longer names the captured execution and provider.', 409)
        // The same native writer lane fences a successor in another process.
        await owned.manager.withLane(session, assigned.correlationId, undefined, async (_manager, lane) => {
          const guard = async () => { check(); await lane.guard.check(); check() }
          await guard()
          const current = await this.interactions.coordination.findReviewJob(assigned.interactionId, assigned.reviewerAgentId)
          await guard()
          if (!current) throw new DomainError('REVIEW_JOB_IDENTITY_CONFLICT', 'The captured review job is missing.', 409)
          assertSameReviewJob(settled, current)
          if (!reviewPhysicallySettled(current) || current.state !== settled.state) throw new DomainError(
            'REPEAT_CLEANUP_PENDING', 'The exact reviewer terminal receipt is not settled.', 409)
          await this.interactions.coordination.assertReviewPhysicalSettlement(current, executionId)
          await guard()
          const notStarted = current.state === 'failed' && current.cleanup?.nativeState === 'not_started'
          if (lane.previous.correlationId !== assigned.correlationId
            && !(notStarted && lane.previous.correlationId === `execution:${executionId}`)
            || current.providerTurnOrMessageId && lane.previous.currentTurnOrMessageId !== current.providerTurnOrMessageId) {
            throw new DomainError('REVIEW_JOB_IDENTITY_CONFLICT', 'The captured review no longer owns the native turn.', 409)
          }
          // A sibling's queued/uncertain review remains responsible for this
          // session. It is not closed under an earlier job's callback.
          if (await this.interactions.coordination.hasUnsettledReview(executionId)) return
          const currentRun = await this.runs.get(owned.execution.runId)
          await guard()
          if (owned.manager.retainsReviewerSession && currentRun && ['running', 'waiting'].includes(currentRun.executionState)
            && currentRun.outcome === 'pending') return
          await guard()
          await this.closeRepeatLifetime(owned, check)
          lane.observedStatus = 'idle'
          await lane.guard.check()
        })
      } finally { if (owned.reviewFinalizer === marker) delete owned.reviewFinishing }
    }
    return async (settled) => {
      try { await finalize(settled) } catch (error) {
        if (yielded && error === yielded) return
        throw error
      }
    }
  }

  constructor(
    private readonly runs: PostgresRunRepository,
    private readonly interactions: PostgresInteractionRepository,
    private readonly budgets: PostgresApprovalBudgetRepository,
    private readonly managers: NativeSessionManagerResolver,
    private readonly activeTimeoutMs: number,
    private readonly credentials?: ExecutionCredentialProvider,
    private readonly validateContinuation?: ((executionId: string, signal?: AbortSignal) => Promise<void>) & {
      forRestart?(executionId: string): Promise<void>
    },
    private readonly workflowClosures?: WorkflowClosureStore,
    private readonly repeatReviewerBindings?: RepeatReviewerBindings,
    private readonly nativeCaptures?: WorkflowNativeCapturePort,
    private readonly reviewNativeCaptures?: ReviewNativeCapturePort,
    private readonly recoverNativeProcesses?: (executionId: string, signal: AbortSignal, owner: RunOwnership) => Promise<boolean>,
    private readonly reserveNativeLaunch?: (executionId: string, manager: NativeHarnessSessionManager) => void | Promise<void>,
    private readonly prepareManagerContext?: (context: NativeManagerResolutionContext) => Promise<NativeManagerResolutionContext>,
    private readonly commitReviewNative?: (executionId: string) => Promise<void>,
  ) {
    this.reviewers = new ReviewerDispatcher(interactions.coordination, this)
  }

  assertCurrentProduction(runs: PostgresRunRepository): void {
    if (this.runs !== runs || !this.nativeCaptures || !this.reviewNativeCaptures || !this.workflowClosures || !this.repeatReviewerBindings
      || !this.credentials || !this.validateContinuation) throw new DomainError(
      'CURRENT_NATIVE_COMPOSITION_REQUIRED', 'The original native capture, closure, reviewer, credential and continuation ports are required.', 503)
    this.interactions.coordination.assertOriginalNativeComposition()
  }

  private captureNative(owner: RunOwnership, execution: HarnessExecution, source: WorkflowOriginalNativeSource,
    kind: 'live' | 'recovery', lease?: SessionWriteLease): RepeatNativeEvidence {
    const owned = this.ownedSessions.get(execution.id)
    if (!owned?.session || !this.nativeCaptures) throw new DomainError('NATIVE_CAPTURE_COMPOSITION_REQUIRED',
      'The original native coordinator capture channel is not composed.', 409)
    const manager = owned.manager, session = owned.session, generation = owned.generation
    const closureGeneration = owned.closureGeneration ?? null
    return this.nativeCaptures.capture({ owner, execution, session, manager, source, kind, ...(lease ? { lease } : {}),
      lifetimeGeneration: generation, closureGeneration,
      assertCurrent: () => {
        owner.assertOwned()
        if (this.ownedSessions.get(execution.id) !== owned || owned.manager !== manager || owned.session !== session
          || owned.generation !== generation || (owned.closureGeneration ?? null) !== closureGeneration
          || owned.opening || owned.openingFailed || owned.failed || owned.controller.signal.aborted) {
          throw new DomainError('NATIVE_LIFETIME_CHANGED', 'The original native source lost its coordinator lifetime.', 409)
        }
      } })
  }

  /** Permission to observe/attach only the exact accepted session. This capture
   * is not a terminal result, no-submission proof or native acknowledgement. */
  async nativeBoundaryEvidence(executionId: string, owner: RunOwnership): Promise<RepeatNativeEvidence> {
    const execution = await this.runs.getExecution(executionId, owner)
    if (!execution) throw new DomainError('EXECUTION_NOT_FOUND', 'The exact execution is unavailable.', 404)
    await this.recoverRetainedReviewer(execution, owner)
    const owned = this.ownedSessions.get(executionId)
    if (owned?.session) {
      owned.runOwner = owner
      this.managers.adoptOwner?.(executionId, this.rawManagers.get(owned.manager) ?? owned.manager, owner)
      await owned.manager.observeBoundary(owned.session, owned.controller.signal)
    }
    return this.captureNative(owner, execution, { type: 'boundary' }, 'recovery')
  }

  /** Bind only an existing execution of the designated reviewer in this Run. Never spawn a substitute. */
  async enqueueReview(interaction: DurableInteraction): Promise<void> {
    if (interaction.status !== 'pending' || interaction.approval.handler !== 'orchestrator') return
    const agentId = interaction.approval.designatedOrchestratorAgentId
    if (!agentId || agentId === interaction.requestingAgentId) return
    const connection = await this.interactions.assertOrchestratorConnection(interaction)
    const existingJob = await this.interactions.coordination.findReviewJob(interaction.id, agentId)
    if (existingJob) {
      await this.interactions.coordination.assertReviewConnection(existingJob)
      return
    }
    if (!this.repeatReviewerBindings || !connection) throw new DomainError('REPEAT_REVIEW_IDENTITY_CONFLICT',
      'The occurrence-qualified reviewer binding is unavailable.', 409)
    const executions = [(await this.repeatReviewerBindings.select(interaction, connection.orchestratorNodeId)).execution]
    const candidates = executions
      .filter((execution) => execution.agentId === agentId && execution.workflowNodeId === connection?.orchestratorNodeId
        && execution.nativeSessionId && execution.workingDirectory && execution.runtimeDirectory)
    // No guessing between attempts/sessions. The pending interaction remains the recovery source.
    if (candidates.length !== 1) return
    const execution = candidates[0]!
    const configuration = await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId, execution)
    if (!configuration || (configuration.productRole !== 'master' && configuration.productRole !== 'orchestrator')) return
    const native = await this.interactions.coordination.workflowSession(execution.id)
    if (!native?.finalized || execution.state !== 'completed') return
    await this.reviewers.enqueue(interaction, agentId, {
      ...native.session,
    }, { executionId: execution.id, workingDirectory: execution.workingDirectory! })
  }

  /** Pending interactions repair a crash between creation and enqueue, including sessions bound later. */
  async reconcileReviews(onError: (error: unknown) => void): Promise<void> {
    let afterId: string | undefined
    do {
      const page = await this.interactions.list({ handler: 'orchestrator', status: 'pending', limit: 100,
        ...(afterId ? { afterId } : {}) })
      for (const interaction of page) await this.enqueueReview(interaction).catch(onError)
      afterId = page.length === 100 ? page.at(-1)!.id : undefined
    } while (afterId)
    await this.reviewers.reconcile(onError)
  }

  private detachedWorkflowSession(owner: RunOwnership,
    execution: HarnessExecution): Promise<NativeSessionReference | undefined> {
    if (this.workflowClosures?.recoverDetached) return this.workflowClosures.recoverDetached(owner, execution)
    return readDetachedWorkflowSession(owner, execution)
  }

  private async waitForRestartWriter(owner: RunOwnership, execution: HarnessExecution,
    session: NativeSessionReference, correlationId: string, readLifetime: () => Promise<unknown>, signal?: AbortSignal) {
    owner.assertOwned()
    signal?.throwIfAborted()
    const lane = await this.interactions.coordination.getLane(session.harness, session.nativeSessionId)
    if (!lane?.leaseToken || !lane.leaseExpiresAt || Date.parse(lane.leaseExpiresAt) <= Date.now()) return
    const expiresAt = Date.parse(lane.leaseExpiresAt)
    const conflict = () => new DomainError('SESSION_LANE_BUSY',
      'The original native writer changed during restart recovery.', 409)
    const control = lane.correlationId && /^(?:control|close|attach)-/.test(lane.correlationId)
    if (lane.ownerAgentId !== execution.agentId || lane.leaseOwner !== execution.agentId
      || lane.correlationId && !control && lane.correlationId !== correlationId
      || expiresAt - Date.now() > 30_000) throw conflict()
    const lifetime = await readLifetime()
    if (!lifetime) throw conflict()
    for (;;) {
      owner.assertOwned()
      signal?.throwIfAborted()
      if (this.closing) throw new DomainError('ENGINE_RESTART',
        'The native session recovery is stopping for application restart.', 409)
      const currentLifetime = await readLifetime()
      const currentLane = await this.interactions.coordination.getLane(session.harness, session.nativeSessionId)
      owner.assertOwned()
      if (!isDeepStrictEqual(currentLifetime, lifetime) || !isDeepStrictEqual(currentLane, lane)) throw conflict()
      const remaining = expiresAt - Date.now()
      if (remaining <= 0) return
      await delay(Math.min(100, remaining), undefined, { signal })
    }
  }

  /** Restore a detached Main session before source verification requires its writer. */
  private async restoreSourceSession(owner: RunOwnership, execution: HarnessExecution): Promise<void> {
    if (!execution.nativeSessionId || !['running', 'waiting'].includes(execution.state)) return
    const session = await this.detachedWorkflowSession(owner, execution)
    if (!session) return
    const configuration = await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId, execution)
    if (!configuration) throw new DomainError('AGENT_CONFIGURATION_NOT_FOUND',
      'The accepted Agent configuration is unavailable.', 409)
    const context = await this.managerContext(execution, configuration)
    if (context.acceptedPlacement?.hostRef.kind !== 'main') return
    const resolved = this.resolveManager(context, owner)
    // Detect a lost process before reserving another attachment lifetime.
    if (context.harness === 'codex' && resolved.manager.originalEnvironment
      && !await resolved.manager.originalEnvironment(session)) {
      resolved.markFailed?.()
      await resolved.manager.dispose()
      this.managers.release?.(context, this.rawManagers.get(resolved.manager) ?? resolved.manager, 'failed')
      await this.restartInterrupted(owner, execution)
      throw new HarnessExecutionError('EXECUTION_INTERRUPTED',
        'The original workflow native process is no longer available.', true)
    }
    try {
      await this.attachSession(context, session, { restartOwner: owner })
    } catch (error) {
      if (error instanceof HarnessExecutionError && error.result.error?.code === 'EXECUTION_INTERRUPTED') {
        await this.restartInterrupted(owner, execution)
      }
      throw error
    }
    owner.assertOwned()
  }

  /** Revalidate source under the resident session's writer lease between turns. */
  async withSourceObservationLane<T>(owner: RunOwnership, execution: HarnessExecution, work: () => Promise<T>): Promise<T> {
    owner.assertOwned()
    if (owner.runId !== execution.runId) throw new DomainError('RUN_OWNERSHIP_LOST', 'Source observation requires its original Run owner.', 409)
    if (!this.ownedSessions.has(execution.id)) await this.restoreSourceSession(owner, execution)
    const owned = this.ownedSessions.get(execution.id)
    if (!owned?.session) return work()
    const session = owned.session, generation = owned.generation
    const check = () => {
      owner.assertOwned()
      if (this.ownedSessions.get(execution.id) !== owned || owned.session !== session || owned.generation !== generation
        || owned.context.purpose === 'reviewer' || owned.failed || owned.cleanup || owned.opening || owned.controller.signal.aborted)
        throw new DomainError('SOURCE_NATIVE_SESSION_CONFLICT', 'The original resident workflow source owner changed.', 409)
    }
    check()
    const active = owned.manager.capturedLease(session)
    const observe = async () => { check(); const value = await work(); check(); return value }
    if (active) { await active.guard.check(); const value = await observe(); await active.guard.check(); return value }
    return owned.manager.withLane(session, `execution:${execution.id}`, owned.controller.signal, observe)
  }

  /** Read-only current manager/lease facts; absence is not replaced with a historic lane. */
  passiveOwnedNativeSessions() {
    return [...this.ownedSessions.values()].flatMap(owned => {
      if (!owned.session || owned.failed || owned.cleanup) return []
      const lease = owned.manager.capturedLease(owned.session)
      const manager = this.rawManagers.get(owned.manager)
      if (!lease || !manager || lease.guard.signal.aborted) return []
      const session = owned.session, generation = owned.generation
      return [{ execution: structuredClone(owned.execution), session: structuredClone(session), manager,
        generation, signal: lease.guard.signal, writer: { id: lease.fence.id, token: lease.fence.token, connectionGeneration: lease.previous.connectionGeneration },
        assertCurrent: () => {
          if (this.ownedSessions.get(owned.execution.id) !== owned || owned.generation !== generation || owned.session !== session
            || owned.failed || owned.cleanup || owned.controller.signal.aborted) throw new DomainError('WORKER_EXECUTION_IDENTITY_INVALID', 'The captured native manager lifetime is no longer current.', 409)
          owned.manager.assertCapturedLease(session, lease)
        } }]
    })
  }

  private async managerContext(
    execution: HarnessExecution,
    configuration: AgentConfigurationVersion,
    purpose?: NativeManagerResolutionContext['purpose'],
  ): Promise<NativeManagerResolutionContext> {
    if (!execution.workingDirectory) throw new Error('The durable execution has no accepted working directory.')
    if (configuration.id !== execution.agentConfigurationVersionId || configuration.agentId !== execution.agentId) {
      throw new Error('The pinned Agent configuration does not match its durable execution.')
    }
    if (configuration.harness.harness === 'opencode') {
      throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
    }
    const context = {
      harness: configuration.harness.harness, executionId: execution.id, agentId: execution.agentId,
      runId: execution.runId, attempt: execution.attempt,
      ...(execution.nativeSessionId ? { nativeSessionId: execution.nativeSessionId } : {}),
      workingDirectory: execution.workingDirectory, configuration,
      ...(purpose ? { purpose } : {}),
    }
    return this.prepareManagerContext ? this.prepareManagerContext(context) : context
  }

  private resolveManager(context: NativeManagerResolutionContext, owner?: RunOwnership) {
    const resolved = this.managers.resolve(context, owner)
    if (resolved.manager.harness !== context.harness) {
      throw new Error('The resolved native manager does not match the durable execution harness.')
    }
    let manager = this.writers.get(resolved.manager)
    if (!manager) {
      manager = coordinateSessionManager(resolved.manager, this.interactions.coordination, context.agentId)
      this.writers.set(resolved.manager, manager)
      this.rawManagers.set(manager, resolved.manager)
    }
    return {
      ...resolved, manager,
      get processState() { return resolved.processState },
    }
  }

  private async workflowRequest(execution: HarnessExecution, configuration: AgentConfigurationVersion,
    run: Pick<WorkflowRun, 'id' | 'workflowVersionId' | 'workspaceId'>, owner?: RunOwnership) {
    const version = await this.runs.getRepeatVersion(run.id, run.workflowVersionId, owner)
    let executionContext
    if (version.definition.handoffs && repeatTickIndex(execution.input) === undefined) {
      const retained = owner ? undefined : await this.retainRunOwner(execution, () => {})
      try {
        executionContext = await (await this.runs.repeat(owner ?? retained!.owner)).readWorkExecutionContext(execution.id)
      } finally { await retained?.release() }
    }
    return workflowExecutionRequest({ execution, version, configuration, workspaceId: run.workspaceId, executionContext })
  }

  private prepareEnvironment(
    context: NativeManagerResolutionContext,
    resolved: ResolvedNativeSessionManager,
    options: { signal?: AbortSignal | undefined; purpose?: 'reviewer' | undefined;
      enterNative?: () => Promise<void>; restartOwner?: RunOwnership | undefined },
  ): Promise<IssuedWorkerCredential['environment'] | undefined> {
    const owned = this.ownedSessions.get(context.executionId)!
    const preparation = this.prepareOwnedEnvironment(context, resolved, options).finally(() => {
      if (owned.preparing === preparation) delete owned.preparing
    })
    owned.preparing = preparation
    return preparation
  }

  private async prepareOwnedEnvironment(
    context: NativeManagerResolutionContext,
    resolved: ResolvedNativeSessionManager,
    options: { signal?: AbortSignal | undefined; purpose?: 'reviewer' | undefined;
      enterNative?: () => Promise<void>; restartOwner?: RunOwnership | undefined },
  ) {
    const { signal, purpose, enterNative, restartOwner } = options
    restartOwner?.assertOwned()
    const owned = this.ownedSessions.get(context.executionId)
    if (!owned || owned.manager !== resolved.manager) throw new Error('Native preflight has no exact manager owner.')
    const continuing = restartOwner && owned.session && resolved.processState === 'needs_start'
      && context.acceptedPlacement?.hostRef.kind === 'device'
      ? await readRemoteWorkflowContinuation(restartOwner, owned.execution) : undefined
    if (continuing) {
      this.assertSessionIdentity(continuing.session, owned.session!)
      if (!continuing.detached) {
        owned.closureRegistration = Promise.resolve(continuing.generation)
        owned.closureGeneration = continuing.generation
      }
    }
    if (this.workflowClosures) {
      // The original process intent must be durable before entered commits.
      // Allocation/reviewer cleanup alone must not reserve or dispatch anything.
      if (resolved.processState === 'needs_start' && !owned.launchReserved && !continuing) {
        signal?.throwIfAborted()
        owned.launchReservation ??= Promise.resolve().then(async () => {
          await this.reserveNativeLaunch?.(context.executionId, this.rawManagers.get(owned.manager) ?? owned.manager)
          owned.launchReserved = true
        })
        await owned.launchReservation
      }
      owned.closureRegistration ??= this.workflowClosures.begin(owned.execution)
      const generation = await owned.closureRegistration
      if (owned.closureGeneration !== generation) {
        this.closedExecutions.delete(context.executionId)
        this.closedWorkflowSessions.delete(context.executionId)
        owned.closureGeneration = generation
      }
      if (owned.restartRecovery) owned.restartRecovery.attachmentGeneration = generation
      signal?.throwIfAborted()
      if (this.ownedSessions.get(context.executionId) !== owned || owned.controller.signal.aborted) {
        throw new Error('Native preflight lost its manager owner.')
      }
    }
    await enterNative?.()
    signal?.throwIfAborted()
    if (!this.credentials) return undefined
    if (owned.session && owned.restartAttachment && context.acceptedPlacement?.hostRef.kind === 'device'
      && resolved.processState === 'needs_start') {
      if (!this.credentials.restore) throw new DomainError('NATIVE_CREDENTIAL_RECOVERY_REQUIRED',
        'The original Worker credential cannot be restored.', 409)
      const { session, request } = owned.restartAttachment
      const lane = await this.interactions.coordination.getLane(session.harness, session.nativeSessionId)
      const identity = reviewPreflightIdentity(lane, `execution:${context.executionId}`)
      const attached = await this.openingSession(owned,
        resolved.manager.attachSession(session, { request, ...identity }, signal))
      this.assertSessionIdentity(session, attached)
      const completed = async () => {
        const history = await resolved.manager.reconcile(session, identity.correlationId, signal)
        const terminal = history.terminalTurn
        return terminal?.correlationId === identity.correlationId
          && history.correlationId === terminal.correlationId
          && terminal.providerId === (history.nativeTurnId ?? history.nativeMessageId)
          && !history.pendingInteraction && history.pendingInteractions.length === 0
      }
      if (await completed()) {
        owned.terminalRecoveredWithoutCredential = true
        resolved.markResident?.()
        return undefined
      }
      const originalApplicationAccess = resolved.manager.originalApplicationAccess
      if (!originalApplicationAccess) throw new DomainError('NATIVE_CREDENTIAL_RECOVERY_REQUIRED',
        'The original Worker application access cannot be restored.', 409)
      let access: Awaited<ReturnType<typeof originalApplicationAccess>>
      try { access = await originalApplicationAccess.call(resolved.manager, session, signal) }
      catch (error) {
        if (!await completed()) throw error
        owned.terminalRecoveredWithoutCredential = true
        resolved.markResident?.()
        return undefined
      }
      const credential = await this.credentials.restore(context.executionId, { agentId: context.agentId,
        variables: { [APP_MCP_TOKEN_ENVIRONMENT_VARIABLE]: access.token } })
      if (continuing) {
        const current = await readRemoteWorkflowContinuation(restartOwner!, owned.execution)
        const expected = { ...continuing, generation: owned.closureGeneration, detached: false }
        if (credential.principalId !== continuing.principalId || !isDeepStrictEqual(current, expected)) {
          throw new DomainError('NATIVE_CREDENTIAL_RECOVERY_REQUIRED', 'The original remote process lease changed.', 409)
        }
      }
      if (owned.closureGeneration) credential.nativeLifetimeGeneration = owned.closureGeneration
      this.managerCredentials.set(resolved.manager, credential)
      signal?.throwIfAborted()
      resolved.markResident?.()
      return undefined
    }
    if (owned.session && resolved.manager.originalEnvironment && resolved.processState === 'needs_start') {
      const variables = await resolved.manager.originalEnvironment(owned.session, signal)
      if (variables) {
        if (!this.credentials.restore) throw new DomainError('NATIVE_CREDENTIAL_RECOVERY_REQUIRED',
          'The original native process credential cannot be restored.', 409)
        const credential = await this.credentials.restore(context.executionId, { agentId: context.agentId, variables })
        if (owned.closureGeneration) credential.nativeLifetimeGeneration = owned.closureGeneration
        this.managerCredentials.set(resolved.manager, credential)
        signal?.throwIfAborted()
        return credential.environment
      }
    }
    if (resolved.processState === 'resident') {
      const credential = this.managerCredentials.get(resolved.manager)
      if (!credential) throw new Error('The resident native process has no owned worker credential lease.')
      const remaining = remainingCredentialLifetime(credential)
      if (!Number.isFinite(remaining)) throw new Error('The worker credential expiry is invalid.')
      if (remaining <= 0) {
        throw new Error('The resident worker credential cannot be renewed without replacing its process.')
      }
      if (this.credentials.renew && remaining <= WORKER_CREDENTIAL_RENEWAL_WINDOW_MS) {
        await this.renewCredential(resolved.manager, context.executionId, {
          signal,
          check: async () => { signal?.throwIfAborted() },
        })
      }
      signal?.throwIfAborted()
      // A resident process keeps its original token/environment, including across long waits.
      return undefined
    }
    const prepared = await this.credentials.prepare({
      executionId: context.executionId, harness: context.harness, workingDirectory: context.workingDirectory,
      ...(purpose ? { purpose } : {}),
      ...(signal ? { signal } : {}),
    })
    const remaining = remainingCredentialLifetime(prepared.credential)
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('The prepared worker credential is not live.')
    if (owned.closureGeneration) prepared.credential.nativeLifetimeGeneration = owned.closureGeneration
    this.managerCredentials.set(resolved.manager, prepared.credential)
    signal?.throwIfAborted()
    return prepared.credential.environment
  }

  /** The execution credential as one lease of its owner; Worker relays and launcher routes follow its expiry. */
  private credentialLease(manager: NativeHarnessSessionManager, renew: () => Promise<void>): OwnedLease {
    return { name: 'execution credential', renewWithinMs: WORKER_CREDENTIAL_RENEWAL_WINDOW_MS,
      remainingMs: () => remainingCredentialLifetime(this.managerCredentials.get(manager)), renew }
  }

  private renewCredential(manager: NativeHarnessSessionManager, executionId: string,
    options: { force?: boolean; signal?: AbortSignal | undefined; check(): Promise<void> }): Promise<void> {
    const renew = async () => {
      options.signal?.throwIfAborted()
      await options.check()
      const credential = this.managerCredentials.get(manager)
      if (!credential) throw new Error('The native process lost its credential lease.')
      if (!options.force && remainingCredentialLifetime(credential) > WORKER_CREDENTIAL_RENEWAL_WINDOW_MS) return
      if (!this.credentials?.renew) throw new Error('The native credential cannot be renewed.')
      const expiresAt = await this.credentials.renew(executionId, credential, options.signal)
      await options.check()
      if (this.managerCredentials.get(manager) !== credential || !Number.isFinite(Date.parse(expiresAt))
        || remainingCredentialLifetime({ ...credential, expiresAt }) <= 0) {
        throw new Error('Native credential renewal lost its owner or returned an invalid expiry.')
      }
      this.managerCredentials.set(manager, { ...credential, expiresAt })
    }
    const enqueue = () => {
      // A restart joins the heartbeat before reading and replacing the same process credential.
      const previous = this.credentialRenewals.get(manager)
      const renewal = (previous ? previous.then(renew, renew) : renew()).finally(() => {
        if (this.credentialRenewals.get(manager) === renewal) this.credentialRenewals.delete(manager)
      })
      this.credentialRenewals.set(manager, renewal)
      return renewal
    }
    return options.signal ? withAbortSignal(enqueue, options.signal) : enqueue()
  }

  /** Snapshot the owned process values before a terminal cleanup can discard them. */
  reviewPersistence(executionId: string) {
    const owned = this.ownedSessions.get(executionId)
    const credential = owned && this.managerCredentials.get(owned.manager)
    if (this.credentials && !credential) throw new DomainError('REVIEWER_CREDENTIAL_LOST',
      'Native persistence requires the exact process credential redaction context.', 409)
    return nativePersistenceRedactor(Object.values(credential?.environment.variables ?? {}))
  }

  captureReviewNative(executionId: string, session: NativeSessionReference, job: ReviewJob,
    lane: SessionWriteLease, source: ReviewOriginalNativeSource): ReviewNativeCapture {
    const owned = this.ownedSessions.get(executionId)
    if (!owned?.session || !owned.closureGeneration || !this.reviewNativeCaptures
      || owned.context.purpose !== 'reviewer') throw new DomainError('REVIEW_ORIGINAL_SOURCE_REQUIRED',
      'The designated reviewer has no captured original native lifetime.', 409)
    const generation = owned.generation, manager = owned.manager
    const check = () => {
      if (this.ownedSessions.get(executionId) !== owned || owned.manager !== manager
        || owned.generation !== generation || owned.opening || !owned.session
        || source.type === 'entry' && (owned.controller.signal.aborted || this.stoppingRuns.has(owned.execution.runId))) {
        throw new DomainError('REVIEWER_AUTHORITY_LOST', 'The original review native lifetime is no longer current.', 409)
      }
      this.assertSessionIdentity(owned.session, session)
    }
    check()
    return this.reviewNativeCaptures.capture({ execution: owned.execution, session, job, manager, lease: lane,
      ...(owned.reviewOwner ? { owner: owned.reviewOwner } : {}),
      lifetimeGeneration: generation, closureGeneration: owned.closureGeneration, source, assertCurrent: check })
  }

  reviewCredentialIdentity(executionId: string, session: NativeSessionReference): { required: boolean; principalId?: string } {
    const owned = this.ownedSessions.get(executionId)
    if (owned?.session) this.assertSessionIdentity(owned.session, session)
    const credential = owned && this.managerCredentials.get(owned.manager)
    return { required: Boolean(this.credentials), ...(credential ? { principalId: credential.principalId } : {}) }
  }

  async revokeReviewCredential(principalId: string): Promise<void> {
    if (!this.credentials) throw new Error('The captured reviewer credential cannot be revoked without its provider.')
    // The durable job stores only the captured principal, not a reusable token.
    // Never revokeForExecution here: a successor may own a different principal.
    await this.credentials.revoke({ principalId })
  }

  async recoverReviewCleanup(executionId: string, session: NativeSessionReference, job: ReviewJob,
    signal: AbortSignal): Promise<ReviewCleanupSession> {
    signal.throwIfAborted()
    const execution = await this.runs.getExecution(executionId)
    const native = await this.interactions.coordination.workflowSession(executionId)
    const configuration = execution && await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId, execution)
    if (!job.cleanup || job.state !== 'failed' || !execution || execution.agentId !== job.reviewerAgentId
      || execution.nativeSessionId !== job.nativeSessionId || session.nativeSessionId !== job.nativeSessionId
      || session.harness !== job.provider || !native?.finalized || !configuration
      || configuration.harness.harness !== job.provider || configuration.agentId !== job.reviewerAgentId) {
      throw new DomainError('REVIEW_JOB_IDENTITY_CONFLICT', 'Cleanup does not match the durable reviewer execution.', 409)
    }
    this.assertSessionIdentity(native.session, session)
    signal.throwIfAborted()
    const owned = this.ownedSessions.get(executionId)
    if (owned?.session) this.assertSessionIdentity(owned.session, session)
    const context = await this.managerContext(execution, configuration, 'reviewer')
    const resolved = owned ? undefined : this.resolveManager(context)
    const manager = owned?.manager ?? resolved!.manager
    // Resolving a writer is not starting/attaching it. In particular there is no
    // prepareEnvironment, beginStart, capabilities, or credential heartbeat here.
    const resident = owned ? Boolean(owned.session && !owned.opening) : resolved!.processState === 'resident'
    return {
      manager, resident, closed: this.closedExecutions.has(executionId),
      confirmClosed: async (cleanupSignal) => {
        cleanupSignal.throwIfAborted()
        const proof = await this.workflowClosures?.read(execution)
        cleanupSignal.throwIfAborted()
        if (!proof) return false
        this.assertSessionIdentity(proof.session, session)
        // The receipt already proves original close and every older generation.
        // Neither process absence nor a new manager's empty map is consulted.
        return true
      },
    }
  }

  private async validateReviewer(owned: OwnedNativeSession, session: NativeSessionReference, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.ownedSessions.get(owned.execution.id) !== owned || owned.context.purpose !== 'reviewer'
      || owned.controller.signal.aborted || this.stoppingRuns.has(owned.execution.runId)) {
      throw new DomainError('REVIEWER_AUTHORITY_LOST', 'The reviewer no longer owns this native process.', 409)
    }
    const execution = await this.runs.getExecution(owned.execution.id)
    const run = await this.runs.get(owned.execution.runId)
    const native = await this.interactions.coordination.workflowSession(owned.execution.id)
    const configuration = execution && await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId, execution)
    signal.throwIfAborted()
    if (!execution || execution.state !== 'completed' || execution.agentId !== owned.context.agentId
      || execution.runId !== owned.execution.runId || execution.nativeSessionId !== session.nativeSessionId
      || execution.agentConfigurationVersionId !== owned.execution.agentConfigurationVersionId
      || execution.workingDirectory !== owned.context.workingDirectory
      || execution.runtimeDirectory !== owned.execution.runtimeDirectory
      || !run || run.id !== owned.execution.runId || !['running', 'waiting'].includes(run.executionState) || run.outcome !== 'pending'
      || run.approval?.handler !== 'orchestrator' || run.approval.designatedOrchestratorAgentId !== execution.agentId
      || !configuration || (configuration.productRole !== 'master' && configuration.productRole !== 'orchestrator')
      || configuration.agentId !== execution.agentId
      || configuration.id !== execution.agentConfigurationVersionId || configuration.workspaceId !== run.workspaceId
      || configuration.harness.harness !== session.harness || !native?.finalized) {
      throw new DomainError('REVIEWER_AUTHORITY_LOST', 'The Run or finalized reviewer execution no longer authorizes this review.', 409)
    }
    this.assertSessionIdentity(native.session, session)
    await this.validateContinuation?.(execution.id, signal)
    signal.throwIfAborted()
  }

  async maintainReviewCredential(executionId: string, session: NativeSessionReference, parentSignal: AbortSignal,
    assertOwned: () => Promise<void>): Promise<ReviewCredentialMaintenance> {
    const owned = this.ownedSessions.get(executionId)
    if (!owned) throw new DomainError('REVIEWER_CREDENTIAL_LOST', 'The reviewer native process is no longer owned.', 409)
    const initial = this.managerCredentials.get(owned.manager)
    const generation = owned.generation
    if (this.credentials && !initial) throw new DomainError('REVIEWER_CREDENTIAL_LOST', 'The reviewer credential is no longer owned.', 409)
    const stopped = new AbortController()
    const failed = new AbortController()
    const signal = AbortSignal.any([parentSignal, owned.controller.signal, stopped.signal, failed.signal])
    const check = async () => {
      signal.throwIfAborted()
      await assertOwned()
      if (owned.generation !== generation || owned.opening) throw new DomainError('REVIEWER_AUTHORITY_LOST',
        'The native reviewer connection changed during credential maintenance.', 409)
      await this.validateReviewer(owned, session, signal)
      await assertOwned()
      signal.throwIfAborted()
    }
    let invalidation: Promise<void> | undefined
    const invalidate = () => {
      // No revokeForExecution: a successor may already own a different principal.
      invalidation ??= (initial && this.credentials ? this.credentials.revoke(initial) : Promise.resolve())
        .catch((error: unknown) => { invalidation = undefined; throw error })
      return invalidation
    }
    // Initial authority reads can stall too. Do not wait past the process token's
    // safety deadline before publishing a fail-closed handle to the dispatcher.
    const preflightDeadline = initial ? setTimeout(() => failed.abort(new DomainError('REVIEWER_CREDENTIAL_LOST',
      'Reviewer credential authority validation exceeded its safety deadline.', 409)),
    Math.max(0, remainingCredentialLifetime(initial) - 5_000)) : undefined
    preflightDeadline?.unref()
    let abortPreflight: (() => void) | undefined
    try {
      await Promise.race([check(), new Promise<never>((_resolve, reject) => {
        abortPreflight = () => reject(signal.reason)
        signal.addEventListener('abort', abortPreflight, { once: true })
        if (signal.aborted) abortPreflight()
      })])
    } catch (error) {
      if (isLeaseLost(error) || parentSignal.aborted || owned.controller.signal.aborted) throw error
      // Return the captured owner handle even on failed preflight, so dispatch
      // can persist the failure and cancel/revoke without guessing an owner.
      const failure = new DomainError('REVIEWER_CREDENTIAL_LOST',
        'The reviewer authority could not be confirmed before credential maintenance.', 409)
      failure.cause = error
      failed.abort(failure)
    } finally {
      clearTimeout(preflightDeadline)
      if (abortPreflight) signal.removeEventListener('abort', abortPreflight)
    }
    const stopRenewal = !signal.aborted && initial && this.credentials ? renewOwnedLeases({
      signal,
      check,
      leases: [this.credentialLease(owned.manager, async () => {
        const credential = this.managerCredentials.get(owned.manager)
        if (!credential || credential.principalId !== initial.principalId || credential.environment !== initial.environment
          || !Number.isFinite(remainingCredentialLifetime(credential)) || remainingCredentialLifetime(credential) <= 0) {
          throw new DomainError('REVIEWER_CREDENTIAL_LOST', 'The reviewer lost its live process credential.', 409)
        }
        if (remainingCredentialLifetime(credential) <= WORKER_CREDENTIAL_RENEWAL_WINDOW_MS) {
          await this.renewCredential(owned.manager, executionId, { check, signal })
        }
      })],
      onFailure: (error) => {
        // Lease loss must remain distinguishable: it cannot cancel a successor's native turn.
        if (isLeaseLost(error)) {
          failed.abort(error)
          return
        }
        const failure = new DomainError('REVIEWER_CREDENTIAL_LOST',
          'Review stopped because its App MCP credential or authority could not be maintained. No native work was restarted.', 409)
        failure.cause = error
        failed.abort(failure)
        void invalidate().catch(() => {
          // ignore: invalidation already reports its failure through the retained cleanup state.
        })
      },
    }) : undefined
    return { signal, invalidate, ...(initial ? { principalId: initial.principalId } : {}),
      stop: async () => { stopped.abort(); await stopRenewal?.() } }
  }

  async recordReviewFailure(executionId: string, job: ReviewJob, error: NonNullable<ReviewJob['error']>,
    pending?: PendingNativeInteraction, pendingRequests?: readonly PendingNativeInteraction[]): Promise<void> {
    const owned = this.ownedSessions.get(executionId)
    if (!owned || owned.execution.agentId !== job.reviewerAgentId || owned.session?.nativeSessionId !== job.nativeSessionId) {
      throw new DomainError('REVIEW_JOB_IDENTITY_CONFLICT', 'The failure does not belong to this reviewer execution.', 409)
    }
    // The owning review-job writer persists the sanitized negative disposition.
    // This callback validates identity only; it cannot manufacture native proof.
    void error; void pending; void pendingRequests
  }

  async prepareReviewTurn(executionId: string, session: NativeSessionReference, job: ReviewJob,
    lane: SessionWriteLease, signal: AbortSignal): Promise<void> {
    const owned = this.ownedSessions.get(executionId)
    if (!owned?.manager.retainsReviewerSession) return
    const credential = this.managerCredentials.get(owned.manager)
    if (!credential || !this.credentials?.bindReviewerJob || !owned.reviewOwner)
      throw new DomainError('REVIEWER_CREDENTIAL_LOST', 'The original reviewer process lease is unavailable.', 409)
    owned.reviewOwner.assertOwned()
    await this.credentials.bindReviewerJob(executionId, credential, job, lane)
    await owned.manager.prepareReview(session, job, signal)
    await lane.guard.check()
  }

  async releaseReviewSession(executionId: string): Promise<void> {
    const owned = this.ownedSessions.get(executionId)
    const release = owned?.releaseReviewOwner
    try { await this.afterReviewCommit(executionId) }
    finally {
      if (owned) {
        delete owned.reviewOwner
        delete owned.releaseReviewOwner
      }
      await release?.()
    }
  }
  afterReviewCommit(executionId: string): Promise<void> {
    return this.commitReviewNative?.(executionId) ?? Promise.resolve()
  }

  private maintainWaitingWorkflowCredential(owned: OwnedNativeSession): void {
    const initial = this.managerCredentials.get(owned.manager)
    const session = owned.session
    if (owned.stopWaitingRenewal || !initial || !session || !this.credentials?.renew) return
    const generation = owned.generation
    const lifetime = owned.closureGeneration
    const check = async () => {
      owned.controller.signal.throwIfAborted()
      const credential = this.managerCredentials.get(owned.manager)
      if (this.ownedSessions.get(owned.execution.id) !== owned || !isDeepStrictEqual(owned.session, session)
        || owned.generation !== generation || owned.closureGeneration !== lifetime || owned.failed || owned.cleanup
        || credential?.principalId !== initial.principalId || credential.environment !== initial.environment) {
        throw new DomainError('WORKER_CREDENTIAL_LOST', 'The waiting requester no longer owns its native lifetime.', 409)
      }
      const current = await this.runs.getExecution(owned.execution.id)
      if (!current || current.state !== 'waiting') throw new DomainError(
        'WORKER_EXECUTION_TERMINAL', 'The requester no longer has a pending approval wait.', 409)
      assertSameRepeatExecution(owned.execution, current)
      if (current.nativeSessionId !== session.nativeSessionId) throw new DomainError(
        'NATIVE_SESSION_IDENTITY_MISMATCH', 'The waiting requester session changed.', 409)
      await this.validateContinuation?.(owned.execution.id, owned.controller.signal)
      owned.controller.signal.throwIfAborted()
    }
    owned.stopWaitingRenewal = renewOwnedLeases({
      signal: owned.controller.signal,
      check,
      leases: [this.credentialLease(owned.manager, async () => {
        try {
          await owned.manager.withCredentialLease(session, owned.controller.signal, async signal => {
            await this.renewCredential(owned.manager, owned.execution.id, { signal, check: async () => {
              signal.throwIfAborted()
              await check()
              signal.throwIfAborted()
            } })
          })
        } catch (error) {
          if (!(error instanceof DomainError) || error.code !== 'SESSION_LANE_BUSY') throw error
          const busy = new DomainError('WORKER_CREDENTIAL_RENEWAL_BUSY',
            'The requester is completing another native operation.', 503, { retryable: true })
          busy.cause = error
          throw busy
        }
      })],
      onFailure: error => owned.controller.abort(error),
    })
  }

  private maintainRetainedReviewer(owned: OwnedNativeSession): void {
    if (owned.stopReviewerRenewal || !this.credentials?.renew) return
    owned.stopReviewerRenewal = renewOwnedLeases({
      signal: owned.controller.signal,
      leases: [this.credentialLease(owned.manager, () => {
        const renewal = this.renewRetainedReviewer(owned).finally(() => {
          if (owned.reviewerRenewal === renewal) delete owned.reviewerRenewal
        })
        owned.reviewerRenewal = renewal
        return renewal
      })],
      onFailure: error => owned.controller.abort(error),
    })
  }

  private async renewRetainedReviewer(owned: OwnedNativeSession): Promise<void> {
    const credential = this.managerCredentials.get(owned.manager)
    if (!credential || this.ownedSessions.get(owned.execution.id) !== owned)
      throw new DomainError('REVIEWER_CREDENTIAL_LOST', 'The retained process lease changed.', 409)
    await this.renewCredential(owned.manager, owned.execution.id, {
      signal: owned.controller.signal,
      check: async () => {
        owned.controller.signal.throwIfAborted()
        if (this.ownedSessions.get(owned.execution.id) !== owned)
          throw new DomainError('REVIEWER_CREDENTIAL_LOST', 'The retained process no longer owns its lease.', 409)
        await this.validateContinuation?.(owned.execution.id, owned.controller.signal)
      },
    })
    if (!owned.reviewOwner && owned.session) {
      try {
        const retained = await this.retainRunOwner(owned.execution, () => {})
        try {
          this.adoptRunOwner(retained.owner)
          await owned.manager.observeBoundary(owned.session, owned.controller.signal)
          delete owned.retainedObservationError
        } finally { await retained.release() }
      } catch (error) { owned.retainedObservationError = error }
    }
  }

  private recoverRetainedReviewer(execution: HarnessExecution, owner: RunOwnership,
    parentSignal?: AbortSignal, job?: ReviewJob): Promise<boolean> {
    const existing = this.reviewerRecoveries.get(execution.id)
    if (existing) return existing
    const recovery = this.recoverRetainedReviewerOwned(execution, owner, parentSignal, job)
      .finally(() => {
        if (this.reviewerRecoveries.get(execution.id) === recovery) this.reviewerRecoveries.delete(execution.id)
      })
    this.reviewerRecoveries.set(execution.id, recovery)
    return recovery
  }

  private async recoverRetainedReviewerOwned(execution: HarnessExecution, owner: RunOwnership,
    parentSignal?: AbortSignal, job?: ReviewJob): Promise<boolean> {
    const existing = this.ownedSessions.get(execution.id)
    if (existing) {
      if (existing.failed) throw new DomainError('REVIEWER_AUTHORITY_LOST',
        'The original remote reviewer recovery did not complete.', 409)
      if (!existing.reviewerRecoveryPending) return existing.manager.retainsReviewerSession
    }
    if (execution.state !== 'completed' || execution.result?.outcome !== 'succeeded' || !execution.nativeSessionId)
      return false
    const configuration = await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId, execution)
    if (!configuration || (configuration.productRole !== 'master' && configuration.productRole !== 'orchestrator')) return false
    const context = await this.managerContext(execution, configuration)
    if (context.acceptedPlacement?.hostRef.kind !== 'device') return false
    const native = await this.interactions.coordination.workflowSession(execution.id)
    if (!native?.finalized) return false
    owner.assertOwned()
    const run = await this.runs.get(execution.runId, owner)
    if (!run || !['running', 'waiting'].includes(run.executionState) || !this.workflowClosures
      || !this.credentials?.recoverRemote) return false
    const retained = await owner.oneShotConnection().transaction(sql => readRecoverableRemoteReviewer(sql, execution))
    if (!retained) return false
    const request = await this.workflowRequest(execution, configuration, run, owner)
    const resolved = this.resolveManager({ ...context, workflowRequest: request }, owner)
    if (!existing) resolved.beginStart?.()
    const owned = this.ownSession(execution,
      { ...context, workflowRequest: request, purpose: 'reviewer' }, resolved.manager)
    owned.reviewerRecoveryPending = true
    owned.runOwner = owner
    const signal = AbortSignal.any([owned.controller.signal, ...(parentSignal ? [parentSignal] : [])])
    owned.closureRegistration = Promise.resolve(retained.generation)
    owned.closureGeneration = retained.generation
    owned.restartAttachment = { session: native.session, request }
    try {
      let lane = await this.interactions.coordination.getLane(native.session.harness, native.session.nativeSessionId)
      while (lane?.leaseExpiresAt && Date.parse(lane.leaseExpiresAt) > Date.now()) {
        owner.assertOwned()
        signal.throwIfAborted()
        await delay(Math.min(100, Date.parse(lane.leaseExpiresAt) - Date.now()), undefined, { signal })
        lane = await this.interactions.coordination.getLane(native.session.harness, native.session.nativeSessionId)
      }
      owner.assertOwned()
      signal.throwIfAborted()
      const current = await owner.oneShotConnection().transaction(sql => readRecoverableRemoteReviewer(sql, execution))
      if (!isDeepStrictEqual(current, retained)) throw new DomainError('REVIEWER_AUTHORITY_LOST',
        'The retained reviewer changed while its original writer lease expired.', 409)
      // Only the dispatcher supplies a claimed, heartbeating job. A saved lease can belong to the crashed Main.
      if (job) {
        if (!this.credentials.bindReviewerJob) throw new DomainError('REVIEWER_CREDENTIAL_LOST',
          'The original reviewer credential cannot bind its current job.', 409)
      }
      const identity = reviewPreflightIdentity(lane, `execution:${execution.id}`)
      if (retained.detached) {
        owned.closureRegistration = this.workflowClosures.begin(execution)
        owned.closureGeneration = await owned.closureRegistration
      }
      const session = await this.openingSession(owned, resolved.manager.attachSession(native.session,
        { request, ...identity }, signal))
      this.assertSessionIdentity(native.session, session)
      if (!resolved.manager.retainsReviewerSession) throw new DomainError('REVIEWER_AUTHORITY_LOST',
        'The original remote reviewer lifetime has already closed.', 409)
      const access = await resolved.manager.originalApplicationAccess(session, signal)
      const expected = { generation: owned.closureGeneration, principalId: retained.principalId, session: retained.session }
      const assertRetainedReviewer = async (sql: GraphSqlClient) => {
        const current = await readRetainedRemoteReviewer(sql, execution)
        if (!isDeepStrictEqual(current, expected)) throw new DomainError('REVIEWER_AUTHORITY_LOST',
          'The retained reviewer no longer matches its original terminal and process lease.', 409)
      }
      await owner.oneShotConnection().transaction(async sql => {
        await assertRetainedReviewer(sql)
        if (!job) await retainRemoteReviewerCredential(sql, execution, expected)
      })
      if (job) {
        await this.credentials.bindReviewerJob!(execution.id, { principalId: retained.principalId }, job)
      }
      const credential = await this.credentials.recoverRemote(execution.id, access, job)
      if (credential.principalId !== retained.principalId) throw new DomainError('REVIEWER_AUTHORITY_LOST',
        'The original reviewer credential changed during recovery.', 409)
      this.managerCredentials.set(owned.manager, credential)
      await owner.oneShotConnection().transaction(assertRetainedReviewer)
      resolved.markResident?.()
      this.maintainRetainedReviewer(owned)
      delete owned.reviewerRecoveryPending
      return true
    } catch (error) {
      if (isRestartCancellation(error, signal)) throw error
      const attemptCanceled = parentSignal?.aborted && !owned.controller.signal.aborted
      if (attemptCanceled || isTransientRefreshFailure(error) || isLeaseLost(error)
        || error instanceof DomainError && error.code === 'SESSION_LANE_BUSY') throw error
      resolved.markFailed?.()
      owned.failed = true
      throw error
    }
  }

  private async awaitWorkflowStartup(owned: OwnedNativeSession, owner: RunOwnership): Promise<boolean> {
    const starting = owned.starting
    // An opening session can publish its identity and first batch while restart waits.
    if (!starting || !owned.opening && !owned.session) return true
    const manager = owned.manager
    const generation = owned.generation + (owned.opening ? 1 : 0)
    const closureGeneration = owned.closureGeneration
    const failures: Error[] = []
    await attemptCleanup(failures, 'Await original workflow startup', async () => { await starting })
    owner.assertOwned()
    owned.startupPending = failures.length > 0
    if (failures.length) {
      componentLogger('engine').warn({ executionId: owned.execution.id },
        'Workflow startup wait timed out; checking the published session for restart preservation')
    }
    return this.ownedSessions.get(owned.execution.id) === owned && owned.runOwner === owner
      && owned.starting === starting && owned.manager === manager && owned.generation === generation
      && owned.closureGeneration === closureGeneration
      && !owned.openingFailed && !owned.failed && !owned.cleanup
  }

  async preserveActiveForRestart(owner: RunOwnership): Promise<boolean> {
    const snapshot = await this.runs.getRepeatSnapshot(owner.runId, owner)
    if (snapshot.stopRequested || snapshot.cleanupPending || snapshot.run.executionState === 'completed') return false
    const active: OwnedNativeSession[] = []
    const executionsToPreserve: HarnessExecution[] = []
    // An attempt that cannot survive the restart is abandoned alone; its node retries after
    // restart. An attempt waiting for an approval keeps the Run-level restart cleanup.
    let unpreservedWait = false, retried = 0
    const abandon = async (execution: HarnessExecution, resident?: OwnedNativeSession) => {
      if (execution.state === 'waiting') { unpreservedWait = true; return }
      retried++
      // A startup still in flight cannot be closed here without waiting on it: restart
      // closure disposes its manager and recovery after restart abandons the attempt.
      if (resident && (resident.opening || resident.preparing || resident.startupPending || !resident.session)) return
      await this.restartInterrupted(owner, execution,
        'The application restarted before this attempt produced an accepted result.')
    }
    for await (const executions of this.runs.executionPages(owner.runId, owner)) {
      for (const execution of executions) {
        const owned = this.ownedSessions.get(execution.id)
        if (owned && !await this.awaitWorkflowStartup(owned, owner)) {
          // Startup is still settling: restart closure disposes its manager and recovery
          // after restart abandons the attempt, so its node retries it.
          if (execution.state === 'waiting') unpreservedWait = true
          else retried++
          continue
        }
        owner.assertOwned()
        const manager = owned?.manager
        const generation = owned?.generation
        const closureGeneration = owned?.closureGeneration
        const current = await this.runs.getExecution(execution.id, owner)
        owner.assertOwned()
        if (!current || this.ownedSessions.get(execution.id) !== owned
          || owned?.manager !== manager || owned?.generation !== generation
          || owned?.closureGeneration !== closureGeneration) return false
        assertSameRepeatExecution(execution, current)
        if (current.state === 'completed' || current.state === 'queued') continue
        if (repeatTickIndex(current.input) !== undefined
          && !await this.preserveIntervalCheckForRestart(owner, current, owned)) continue
        if (!current.nativeSessionId) { await abandon(current, owned); continue }
        if (!owned) {
          const session = ['running', 'waiting'].includes(current.state) && (await this.detachedWorkflowSession(owner, current)
            ?? (await readRemoteWorkflowContinuation(owner, current))?.session)
          if (session) executionsToPreserve.push(current)
          else await abandon(current)
          continue
        }
        if (!owned.session || owned.openingFailed || owned.failed || owned.cleanup
          || owned.session.nativeSessionId !== current.nativeSessionId) { await abandon(current, owned); continue }
        assertSameRepeatExecution(owned.execution, current)
        const recovery = owned.restartRecovery
        const credential = this.managerCredentials.get(owned.manager)
        if (recovery?.principalId && credential && credential.principalId !== recovery.principalId) { await abandon(current, owned); continue }
        const restoring = recovery?.owner === owner && !!(owned.preparing || owned.opening)
          && recovery.attachmentGeneration === owned.closureGeneration
          && isDeepStrictEqual(recovery.session, owned.session)
        if (!restoring && (!owned.closureGeneration || owned.opening
          || !owned.manager.canDetachForRestart?.(owned.session))) { await abandon(current, owned); continue }
        active.push(owned)
        executionsToPreserve.push(current)
      }
    }
    if (unpreservedWait || !executionsToPreserve.length && !retried) return false
    const ready = await this.runs.getRepeatSnapshot(owner.runId, owner)
    if (ready.stopRequested || ready.cleanupPending || ready.run.executionState === 'completed') return false
    owner.assertOwned()
    const waiting = new Set<string>()
    for (const execution of executionsToPreserve) {
      try { await this.budgets.beginWait(execution.id) }
      catch (error) {
        // An execution that finished after it was listed has nothing left to preserve.
        if (!(error instanceof DomainError && error.code === 'EXECUTION_NOT_WAITABLE')
          || (await this.runs.getExecution(execution.id, owner))?.state !== 'completed') throw error
        continue
      }
      waiting.add(execution.id)
    }
    owner.assertOwned()
    if (!waiting.size && !retried) return false
    for (const owned of active.filter(item => waiting.has(item.execution.id))) {
      try { await this.renewForRestart(owned, owner) }
      catch (error) {
        if (isCredentialAuthorityLost(error)) return false
        throw error
      }
    }
    owner.assertOwned()
    return true
  }

  private async preserveIntervalCheckForRestart(owner: RunOwnership, execution: HarnessExecution,
    owned: OwnedNativeSession | undefined): Promise<boolean> {
    if (execution.nativeSessionId && !owned) {
      const session = await this.detachedWorkflowSession(owner, execution)
        ?? (await readRemoteWorkflowContinuation(owner, execution))?.session
      if (session) return true
    } else if (execution.nativeSessionId && owned?.session && !owned.openingFailed && !owned.failed
      && !owned.cleanup && owned.manager.canDetachForRestart?.(owned.session)) {
      return true
    }
    await this.failIntervalCheck(owner, execution)
    return false
  }

  private async renewForRestart(owned: OwnedNativeSession, owner?: RunOwnership): Promise<void> {
    if (!this.credentials?.renew || !this.managerCredentials.has(owned.manager)) return
    await this.renewCredential(owned.manager, owned.execution.id, {
      force: true,
      check: async () => {
        owner?.assertOwned()
        if (this.ownedSessions.get(owned.execution.id) !== owned || owned.failed || owned.cleanup)
          throw new DomainError('NATIVE_CREDENTIAL_RECOVERY_REQUIRED', 'The native process no longer owns its lease.', 409)
        if (this.validateContinuation?.forRestart) await this.validateContinuation.forRestart(owned.execution.id)
        else await this.validateContinuation?.(owned.execution.id)
        owner?.assertOwned()
      },
    })
  }

  /** Production calls this AFTER stopping/draining producers and BEFORE raw
   * manager disposal. Waiting Workers and retained reviewers are not Stop: their
   * checkpoints, budgets, credentials and business records must survive restart.
   * Every sibling is attempted; failed/uncertain closure keeps shutdown failed. */
  closeForRestart(): Promise<void> {
    this.closing = true
    if (this.restartClosure) return this.restartClosure
    const sessions = [...this.ownedSessions.values()]
    const reason = new DomainError('ENGINE_RESTART', 'The native lifetime is detaching for application restart.', 409)
    const drainingReviews = this.reviewers.shutdown()
    // A captured finalizer may already be running outside the dispatch guard.
    // Keep its lifetime valid until the dispatcher has joined it.
    for (const owned of sessions) {
      if (!owned.reviewFinalizer) owned.controller.abort(reason)
    }
    const task = (async () => {
      const reviewResults = await Promise.allSettled([drainingReviews])
      for (const owned of sessions) owned.controller.abort(reason)
      const closeSession = async (owned: OwnedNativeSession, owner?: RunOwnership) => {
        const safe = nativePersistenceRedactor(Object.values(this.managerCredentials.get(owned.manager)?.environment.variables ?? {}))
        const failures: Error[] = []
        await attemptCleanup(failures, `${owned.execution.id}: close for restart`, async signal => {
          if (this.ownedSessions.get(owned.execution.id) !== owned) return
          if (this.closedExecutions.has(owned.execution.id)) return
          // Local engine ownership can finish before its native session detaches.
          const snapshot = await this.runs.getRepeatSnapshot(owned.execution.runId, owner)
          // A failed or closing attempt has no lifetime to preserve; renewing it for detachment fails its lease check.
          if (snapshot.stopRequested || snapshot.cleanupPending || owned.failed || owned.cleanup) {
            const cleanup = await this.cleanupSession(owned)
            if (cleanup.length) throw new AggregateError(cleanup, 'Interrupted native cleanup remains unconfirmed.')
            return
          }
          if (owned.restartAttachment && !owned.failed
            && (!owned.session || owned.openingFailed || owned.generation === 0)) {
            const { session, request } = owned.restartAttachment
            const remote = owned.context.acceptedPlacement?.hostRef.kind === 'device'
            const variables = remote ? undefined : await owned.manager.originalEnvironment?.(session)
            if (remote || variables) {
              const lane = await this.interactions.coordination.getLane(session.harness, session.nativeSessionId)
              const identity = reviewPreflightIdentity(lane, `execution:${owned.execution.id}`)
              const attached = await this.openingSession(owned, owned.manager.attachSession(session, {
                request, ...identity,
                ...(variables ? { environment: { agentId: owned.execution.agentId, variables } } : {}),
              }))
              this.assertSessionIdentity(session, attached)
            }
          }
          // Creation can finish before the session binding commits. Dispose the
          // captured manager when startup settles without a persisted binding.
          if (!owned.session || owned.openingFailed || owned.generation === 0 || !owned.execution.nativeSessionId) {
            await owned.manager.dispose(signal)
            return
          }
          if (snapshot.run.executionState !== 'completed') {
            try { await this.renewForRestart(owned, owner) }
            catch (error) {
              if (!isCredentialAuthorityLost(error)) throw error
              await this.runs.requestCleanup(owned.execution.runId, owner)
              const cleanup = await this.cleanupSession(owned)
              if (cleanup.length) {
                throw new AggregateError(cleanup, 'Interrupted native cleanup remains unconfirmed.', { cause: error })
              }
              return
            }
          }
          await this.closeWorkflowSessionOwned(owned, { restart: true, signal })
        }, owned.context.acceptedPlacement?.hostRef.kind === 'device' ? { timeoutMs: deviceRequestTimeoutMs } : {})
        return failures.map((error) => safe.error(error) as Error)
      }
      const runs = new Map<string, OwnedNativeSession[]>()
      for (const owned of sessions) {
        const siblings = runs.get(owned.execution.runId) ?? []
        siblings.push(owned)
        runs.set(owned.execution.runId, siblings)
      }
      const results = await Promise.allSettled([...runs.values()].map(async siblings => {
        // Aborting renewal stops its timer, but an observation can still be
        // acquiring or releasing the Run lock. Join it before selecting an owner.
        await withCleanupDeadline(async () => Promise.all(siblings.map(async owned => {
          // Startup errors belong to their caller; its manager and cleanup must still drain.
          await Promise.allSettled([
            this.reviewerRecoveries.get(owned.execution.id), owned.starting, owned.preparing, owned.opening,
            owned.stopWaitingRenewal?.(), owned.stopReviewerRenewal?.(), owned.reviewerRenewal,
          ])
          await owned.cleanup
        })), siblings.some(owned => owned.context.acceptedPlacement?.hostRef.kind === 'device')
          ? deviceRequestTimeoutMs : cleanupTimeoutMs)
        const resident = siblings.filter(owned => this.ownedSessions.get(owned.execution.id) === owned
          && !this.closedExecutions.has(owned.execution.id))
        const ownerSession = resident.find(owned => owned.context.acceptedPlacement?.hostRef.kind === 'device'
          || this.credentials?.renew && this.managerCredentials.has(owned.manager))
        const retained = ownerSession && await withCleanupDeadline(async signal => {
          for (;;) {
            signal.throwIfAborted()
            try {
              return await this.retainRunOwner(ownerSession.execution, () => {
                for (const owned of siblings) owned.controller.abort()
              })
            } catch (error) {
              if (!(error instanceof DomainError) || error.code !== 'SESSION_LANE_BUSY') throw error
              await delay(25, undefined, { signal })
            }
          }
        }, ownerSession.context.acceptedPlacement?.hostRef.kind === 'device' ? deviceRequestTimeoutMs : cleanupTimeoutMs)
        try {
          // Sibling closes share one Run lock until every close or cleanup commits.
          if (retained) this.adoptRunOwner(retained.owner)
          return (await Promise.all(resident.map(owned => closeSession(owned, retained?.owner)))).flat()
        } finally { if (retained) await retained.release() }
      }))
      const safe = nativePersistenceRedactor(sessions.flatMap(owned =>
        Object.values(this.managerCredentials.get(owned.manager)?.environment.variables ?? {})))
      const failures = results.flatMap(result => result.status === 'fulfilled'
        ? result.value : [safe.error(result.reason) as Error])
      for (const result of reviewResults) {
        if (result.status === 'rejected') failures.push(safe.error(result.reason) as Error)
      }
      if (failures.length) throw new AggregateError(failures, 'Native restart closure was incomplete.', { cause: failures[0] })
    })()
    this.restartClosure = task
    // A failed receipt/close is not cached success. The same captured manager
    // may retry; no new generation or substitute session is admitted here.
    void task.catch(() => { if (this.restartClosure === task) this.restartClosure = undefined })
    return task
  }

  async finishIdleReviewers(runId: string, owner: RunOwnership, signal: AbortSignal): Promise<void> {
    if (owner.runId !== runId) throw new DomainError('RUN_OWNERSHIP_LOST', 'The reviewer Run owner changed.', 409)
    const run = await this.runs.get(runId, owner)
    owner.assertOwned()
    signal.throwIfAborted()
    for (const owned of this.ownedSessions.values()) {
      if (owned.execution.runId !== runId || owned.context.purpose !== 'reviewer'
        || !owned.manager.retainsReviewerSession) continue
      // Remote closure needs the cleanup intent committed with Run completion.
      if (owned.context.acceptedPlacement?.hostRef.kind === 'device' && run?.executionState !== 'completed') continue
      const session = owned.session
      if (!session) throw new DomainError('REPEAT_CLEANUP_PENDING', 'The reviewer session is unavailable.', 409)
      const check = () => {
        owner.assertOwned()
        signal.throwIfAborted()
        if (this.ownedSessions.get(owned.execution.id) !== owned || owned.reviewFinishing) {
          throw new DomainError('REPEAT_CLEANUP_PENDING', 'The reviewer lifetime is still settling.', 409)
        }
      }
      check()
      const savedLane = await this.interactions.coordination.getLane(session.harness, session.nativeSessionId)
      check()
      if (!savedLane) throw new DomainError('REPEAT_CLEANUP_PENDING', 'The reviewer writer lane is unavailable.', 409)
      const correlationId = savedLane.correlationId ?? `execution:${owned.execution.id}`
      try {
        await owned.manager.withLane(session, correlationId,
          signal, async (manager, lane) => {
            check()
            await lane.guard.check()
            if (await this.interactions.coordination.hasUnsettledReview(owned.execution.id)) {
              throw new DomainError('REPEAT_CLEANUP_PENDING', 'The reviewer still has unfinished reviews.', 409)
            }
            await owned.manager.requireIdle(manager, session, correlationId, lane, signal)
            check()
            await this.closeRepeatLifetime(owned, check)
            lane.observedStatus = 'idle'
            await lane.guard.check()
          })
      } catch (error) {
        if (error instanceof DomainError && error.code === 'SESSION_LANE_BUSY') {
          throw new DomainError('REPEAT_CLEANUP_PENDING', 'The reviewer writer is still active.', 409, undefined, { cause: error })
        }
        throw error
      }
    }
  }

  async finishRun(runId: string): Promise<void> {
    const run = await this.runs.get(runId)
    if (run?.executionState !== 'completed') throw new DomainError('GRAPH_TERMINAL_CONFLICT', 'Only a terminal Run may finish native cleanup.', 409)
    const failures: Error[] = []
    for (const owned of this.ownedSessions.values()) {
      if (owned.execution.runId !== runId) continue
      // An active reviewer may be awaiting this graph response through MCP.
      // Its captured job finalizer releases the exact session after settlement.
      if (owned.session && owned.manager.isActive(owned.session)) continue
      if (owned.context.purpose === 'reviewer' && owned.manager.retainsReviewerSession
        && owned.context.acceptedPlacement?.hostRef.kind === 'device') {
        const owner = owned.runOwner
        if (!owner) throw new DomainError('RUN_OWNERSHIP_LOST', 'The reviewer Run owner is unavailable.', 409)
        await this.finishIdleReviewers(runId, owner, owned.controller.signal)
        continue
      }
      failures.push(...await this.cleanupSession(owned, false))
    }
    if (failures.length) throw new AggregateError(failures, 'Completed Run session cleanup was incomplete.')
  }

  /** Read-only exact callback qualification. A cold read never allocates or attaches a manager. */
  async inspectInteractionActivity(interaction: DurableInteraction): Promise<InteractionActivityEvidence> {
    const identity = { interactionId: interaction.id, revision: interaction.revision, sessionId: interaction.nativeSessionId,
      requestId: interaction.nativeRequestId, executionId: interaction.executionId }
    const unavailable: InteractionActivityEvidence = { response: { authorized: false, qualified: false,
      path: null, usable: false, identity } }
    const owned = this.ownedSessions.get(interaction.executionId)
    if (!owned?.session || this.closing || owned.failed || owned.cleanup || owned.openingFailed
      || owned.controller.signal.aborted || this.stoppingRuns.has(interaction.runId)) return unavailable
    const execution = await this.runs.getExecution(interaction.executionId)
    const run = await this.runs.get(interaction.runId)
    if (!execution || !run || execution.runId !== interaction.runId || execution.agentId !== interaction.requestingAgentId
      || execution.nativeSessionId !== interaction.nativeSessionId || execution.state === 'completed'
      || run.workspaceId !== interaction.workspaceId || run.workflowId !== interaction.workflowId || run.outcome !== 'pending'
      || owned.execution.id !== execution.id || owned.execution.attempt !== execution.attempt
      || owned.session.nativeSessionId !== interaction.nativeSessionId || owned.session.harness !== interaction.harness
      || owned.session.providerVersion !== interaction.providerVersion) return unavailable
    const manager = this.rawManagers.get(owned.manager) ?? owned.manager
    const response = await inspectNativeResponse(manager, owned.session, {
      nativeRequestId: interaction.nativeRequestId, nativeRequestType: interaction.nativeRequestType,
    }, { signal: AbortSignal.any([owned.controller.signal, AbortSignal.timeout(5_000)]),
      isCurrent: () => this.ownedSessions.get(execution.id) === owned && !this.closing && !owned.cleanup
        && !owned.failed && !owned.controller.signal.aborted && !this.stoppingRuns.has(interaction.runId) })
    return { response: { authorized: false, qualified: response.qualified, usable: response.state === 'available',
      path: response.state === 'available' ? response.path : null, identity },
      ...(response.nativeTurnId ? { nativeTurnId: response.nativeTurnId } : {}) }
  }

  async validateInteraction(interaction: DurableInteraction, signal?: AbortSignal): Promise<void> {
    await this.validateContinuation?.(interaction.executionId, signal)
  }

  hasOriginalRequester(interaction: DurableInteraction): boolean {
    const owned = this.ownedSessions.get(interaction.executionId)
    return !!owned?.session && !owned.failed && !owned.cleanup && !owned.opening
      && !owned.openingFailed && !owned.pendingApprovalRestoration && owned.generation > 0
      && !owned.controller.signal.aborted && owned.execution.runId === interaction.runId
      && owned.session.nativeSessionId === interaction.nativeSessionId
      && owned.session.harness === interaction.harness
      && owned.session.providerVersion === interaction.providerVersion
  }

  async withInteractionOwner<T>(interaction: DurableInteraction, signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const owned = this.ownedSessions.get(interaction.executionId)
    if (owned?.context.acceptedPlacement?.hostRef.kind !== 'device') return work(signal)
    if (owned.execution.runId !== interaction.runId) throw new DomainError(
      'INTERACTION_RUN_MISMATCH', 'The native interaction does not belong to this Run.', 409)
    signal.throwIfAborted()
    const controller = new AbortController()
    const retained = await this.retainRunOwner(owned.execution, () => controller.abort())
    try {
      const ownedSignal = AbortSignal.any([signal, controller.signal])
      ownedSignal.throwIfAborted()
      this.adoptRunOwner(retained.owner)
      return await work(ownedSignal)
    } finally { await retained.release() }
  }

  async attachInteraction(interaction: DurableInteraction, signal?: AbortSignal): Promise<AttachedInteractionSession> {
    if (interaction.harness === 'opencode') {
      throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
    }
    const execution = await this.runs.getExecution(interaction.executionId)
    if (!execution?.workingDirectory || !execution.runtimeDirectory) throw new Error('The durable execution cannot reconstruct its native session start input.')
    if (execution.agentId !== interaction.requestingAgentId || execution.runId !== interaction.runId) {
      throw new Error('The interaction requester does not own its durable execution.')
    }
    return this.attachOwnedSession({
      harness: interaction.harness, executionId: execution.id, agentId: execution.agentId,
      workingDirectory: execution.workingDirectory,
    }, {
      harness: interaction.harness, providerVersion: interaction.providerVersion,
      nativeSessionId: interaction.nativeSessionId,
    }, signal)
  }

  async attachOwnedSession(
    context: NativeManagerOwnershipContext,
    sessionReference: { harness: NativeManagerResolutionContext['harness']; providerVersion: string; nativeSessionId: string },
    signal?: AbortSignal,
  ): Promise<AttachedInteractionSession> {
    return this.attachSession(context, sessionReference, { signal })
  }

  private async attachSession(
    context: NativeManagerOwnershipContext,
    sessionReference: NativeSessionReference,
    options: { signal?: AbortSignal | undefined; restartOwner?: RunOwnership },
  ): Promise<AttachedInteractionSession> {
    let signal = options.signal
    options.restartOwner?.assertOwned()
    const execution = await this.runs.getExecution(context.executionId)
    if (!execution?.workingDirectory || !execution.runtimeDirectory || execution.agentId !== context.agentId
      || execution.workingDirectory !== context.workingDirectory
      || execution.nativeSessionId !== sessionReference.nativeSessionId || sessionReference.harness !== context.harness) {
      throw new Error('The native session ownership context does not match its durable execution.')
    }
    if (context.purpose === 'reviewer') {
      const configuration = await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId, execution)
      if (!configuration) throw new Error('The reviewer configuration is unavailable')
      const placementContext = await this.managerContext(execution, configuration)
      if (placementContext.acceptedPlacement?.hostRef.kind === 'device') {
        const controller = new AbortController()
        const { owner, release: releaseOwner } = await this.retainRunOwner(execution, () => controller.abort())
        try {
          await this.recoverRetainedReviewer(execution, owner, signal, context.reviewJob)
          const owned = this.ownedSessions.get(execution.id)
          if (!owned?.session || !owned.manager.retainsReviewerSession) throw new DomainError('REVIEWER_AUTHORITY_LOST',
            'The original remote reviewer is no longer resident.', 409)
          if (owned.reviewOwner) throw new DomainError('SESSION_LANE_BUSY', 'The reviewer already owns an active review.', 409)
          this.assertSessionIdentity(owned.session, sessionReference)
          owned.reviewOwner = owner
          owned.releaseReviewOwner = releaseOwner
          this.adoptRunOwner(owner)
          const combined = AbortSignal.any([owned.controller.signal, controller.signal, ...(signal ? [signal] : [])])
          if (context.reviewJob) {
            const credential = this.managerCredentials.get(owned.manager)
            if (!credential || !this.credentials?.bindReviewerJob) throw new DomainError('REVIEWER_CREDENTIAL_LOST',
              'The original reviewer credential cannot bind its current job.', 409)
            await this.credentials.bindReviewerJob(execution.id, credential, context.reviewJob)
          }
          await this.validateReviewer(owned, sessionReference, combined)
          return { manager: owned.manager, session: sessionReference, signal: combined }
        } catch (error) {
          const owned = this.ownedSessions.get(execution.id)
          if (owned?.releaseReviewOwner === releaseOwner) {
            delete owned.reviewOwner
            delete owned.releaseReviewOwner
          }
          await releaseOwner()
          throw error
        }
      }
    }
    const continuing = !this.ownedSessions.has(execution.id) && options.restartOwner
      ? await readRemoteWorkflowContinuation(options.restartOwner, execution) : undefined
    let recovery: Awaited<ReturnType<typeof readDetachedWorkflowLifetime>>
      | Awaited<ReturnType<typeof readRemoteWorkflowContinuation>> = undefined
    if (!this.ownedSessions.has(execution.id)) {
      const detached = options.restartOwner
        ? await this.detachedWorkflowSession(options.restartOwner, execution) : undefined
      if (continuing) this.assertSessionIdentity(continuing.session, sessionReference)
      else if (detached) this.assertSessionIdentity(detached, sessionReference)
      else if (execution.state !== 'completed' || !await this.workflowClosures?.read(execution)) throw new DomainError(
        'NATIVE_SESSION_RECOVERY_REQUIRED', 'The original requester requires verified Run recovery.', 409)
      recovery = continuing ?? (detached && options.restartOwner
        ? await readDetachedWorkflowLifetime(options.restartOwner, execution) : undefined)
      if (options.restartOwner && (continuing || detached)) {
        await this.waitForRestartWriter(options.restartOwner, execution, sessionReference,
          context.correlationId ?? `execution:${execution.id}`, continuing
            ? () => readRemoteWorkflowContinuation(options.restartOwner!, execution)
            : () => readDetachedWorkflowLifetime(options.restartOwner!, execution), signal)
      }
    }
    const run = await this.runs.get(execution.runId)
    if (!run) throw new Error('The durable execution Run is unavailable.')
    if (run.executionState === 'completed') throw new Error('A completed Run cannot restart native work.')
    const configuration = await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId, execution)
    if (!configuration || configuration.harness.harness !== context.harness) throw new Error('The durable execution configuration is unavailable or mismatched.')
    if (context.purpose === 'reviewer') {
      const previous = this.ownedSessions.get(execution.id)
      if (previous?.cleanup || previous?.reviewFinishing) throw new DomainError('SESSION_LANE_BUSY',
        'The captured reviewer lifetime is still closing.', 409)
      const native = await this.interactions.coordination.workflowSession(execution.id)
      if ((configuration.productRole !== 'master' && configuration.productRole !== 'orchestrator') || !['running', 'waiting'].includes(run.executionState)
        || run.outcome !== 'pending' || execution.state !== 'completed' || !native?.finalized || run.approval?.handler !== 'orchestrator'
        || run.approval.designatedOrchestratorAgentId !== execution.agentId) {
        throw new DomainError('SESSION_LANE_BUSY', 'Workflow finalization must finish before review attachment.', 409)
      }
      this.assertSessionIdentity(native.session, sessionReference)
    } else if (execution.state === 'completed') {
      throw new DomainError('WORKER_EXECUTION_TERMINAL', 'A completed workflow execution cannot resume native work.', 409)
    }
    await this.validateContinuation?.(execution.id, signal)
    let request = this.ownedSessions.get(execution.id)?.context.workflowRequest
    if (!request) {
      request = await this.workflowRequest(execution, configuration, run, options.restartOwner)
    }
    const resolutionContext = {
      ...await this.managerContext(execution, configuration, context.purpose), workflowRequest: request,
    }
    if (this.stoppingRuns.has(execution.runId)) throw new Error('The Run is stopping.')
    const resolved = this.resolveManager(resolutionContext, options.restartOwner)
    const retryingAttachment = resolved.lifecycle === 'starting'
      && this.ownedSessions.get(execution.id)?.pendingApprovalRestoration
    // Claim outside cleanup: losing a concurrent startup race does not own its credentials.
    if (resolved.processState === 'needs_start' && !retryingAttachment) resolved.beginStart?.()
    const owned = this.ownSession(execution, resolutionContext, resolved.manager)
    if (options.restartOwner) owned.runOwner = options.restartOwner
    if (continuing) {
      owned.closureRegistration = Promise.resolve(continuing.generation)
      owned.closureGeneration = continuing.generation
    }
    if (recovery && options.restartOwner) {
      owned.restartRecovery ??= { ...recovery, owner: options.restartOwner }
      if (owned.closureGeneration) owned.restartRecovery.attachmentGeneration = owned.closureGeneration
    }
    owned.session = sessionReference
    signal = signal ? AbortSignal.any([signal, owned.controller.signal]) : owned.controller.signal
    if (resolutionContext.acceptedPlacement?.hostRef.kind === 'device'
      || resolutionContext.harness === 'codex' && !resolutionContext.purpose) {
      owned.restartAttachment = { session: sessionReference, request }
    }
    try {
      if (continuing) {
        if (!this.credentials?.restore || !resolved.manager.originalApplicationAccess) throw new DomainError(
          'NATIVE_CREDENTIAL_RECOVERY_REQUIRED', 'The original remote process credential cannot be restored.', 409)
        if (continuing.detached) {
          if (!this.workflowClosures) throw new DomainError('NATIVE_WORKFLOW_CLOSURE_CONFLICT',
            'The detached native lifetime cannot reserve its attachment.', 409)
          owned.closureRegistration = this.workflowClosures.begin(execution)
          owned.closureGeneration = await owned.closureRegistration
          if (owned.restartRecovery) owned.restartRecovery.attachmentGeneration = owned.closureGeneration
        }
        const session = await this.openingSession(owned, resolved.manager.attachSession(sessionReference,
          { kind: 'workflow', correlationId: `execution:${execution.id}`, request }, signal))
        this.assertSessionIdentity(sessionReference, session)
        const access = await resolved.manager.originalApplicationAccess(session, signal)
        const credential = await this.credentials.restore(execution.id, { agentId: execution.agentId,
          variables: { [APP_MCP_TOKEN_ENVIRONMENT_VARIABLE]: access.token } })
        const current = await readRemoteWorkflowContinuation(options.restartOwner!, execution)
        const expected = { ...continuing, generation: owned.closureGeneration, detached: false }
        if (credential.principalId !== continuing.principalId || !isDeepStrictEqual(current, expected))
          throw new DomainError('NATIVE_CREDENTIAL_RECOVERY_REQUIRED', 'The original remote process lease changed.', 409)
        if (owned.closureGeneration) credential.nativeLifetimeGeneration = owned.closureGeneration
        this.managerCredentials.set(resolved.manager, credential)
        await this.validateContinuation?.(execution.id, signal)
        signal.throwIfAborted()
        resolved.markResident?.()
        return { manager: resolved.manager, session, signal: owned.controller.signal }
      }
      const environment = await this.prepareEnvironment(resolutionContext, resolved, {
        signal, purpose: context.purpose, restartOwner: options.restartOwner,
      })
      await this.validateContinuation?.(execution.id, signal)
      options.restartOwner?.assertOwned()
      signal.throwIfAborted()
      if (resolved.processState === 'resident') {
        await resolved.manager.history(sessionReference, signal)
        return { manager: resolved.manager, session: sessionReference, signal: owned.controller.signal }
      }
      const session = await this.openingSession(owned, resolved.manager.attachSession(sessionReference, {
        kind: 'workflow', correlationId: context.correlationId ?? `execution:${execution.id}`, request,
        ...(context.nativeTurnId ? { nativeTurnId: context.nativeTurnId } : {}),
        ...(environment ? { environment } : {}),
      }, signal))
      this.assertSessionIdentity(sessionReference, session)
      resolved.markResident?.()
      signal.throwIfAborted()
      return { manager: resolved.manager, session, signal: owned.controller.signal }
    } catch (error) {
      const safe = nativePersistenceRedactor(Object.values(this.managerCredentials.get(owned.manager)?.environment.variables ?? {}))
      if (isRestartCancellation(error, signal)) throw safe.error(error)
      componentLogger('harness').warn({ err: safe.error(error), executionId: execution.id },
        'workflow approval attachment failed')
      if (isTransientExecutionError(error) || isTransientRefreshFailure(error) || isLeaseLost(error)
        || (error instanceof DomainError && error.code === 'SESSION_LANE_BUSY')) throw safe.error(error)
      resolved.markFailed?.()
      owned.failed = true
      if (options.restartOwner) throw safe.error(error)
      await this.cleanupSession(owned)
      throw safe.error(error)
    }
  }

  private async restorePendingWorkflowApprovals(owner: RunOwnership, execution: HarnessExecution,
    pending: readonly DurableInteraction[], signal?: AbortSignal): Promise<boolean> {
    const resident = this.ownedSessions.get(execution.id)
    const detached = resident?.restartAttachment?.session ?? await this.detachedWorkflowSession(owner, execution)
      ?? (await readRemoteWorkflowContinuation(owner, execution))?.session
    if (!detached) return false
    if (detached.harness === 'opencode') {
      throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
    }
    if (pending.some((item) => item.runId !== owner.runId || item.nativeSessionId !== detached.nativeSessionId
      || item.harness !== detached.harness || item.providerVersion !== detached.providerVersion
      || item.requestingAgentId !== execution.agentId || !item.graphInterruptId)) {
      throw new DomainError('INTERACTION_IDENTITY_CONFLICT', 'Restart approval changed its saved native identity.', 409)
    }
    const originals = await owner.oneShotConnection().transaction(async (sql) => {
      await openWorkflowLifecycleLocked(sql, owner.runId)
      const requests: PendingNativeInteraction[] = []
      let correlationId = `execution:${execution.id}`
      for (const item of pending) {
        const proof = await assertSavedPendingApprovalOriginalLocked(sql, item)
        if (proof.original.type !== 'history') throw new DomainError(
          'APPROVAL_ORIGINAL_SOURCE_REQUIRED', 'The approval has no saved native request.', 409)
        if (!requests.length) correlationId = proof.original.history.correlationId ?? correlationId
        requests.push(proof.original.history.pendingInteractions.find((request) =>
          request.turn.nativeRequestId === item.nativeRequestId)!)
      }
      return { requests, correlationId }
    })
    try {
      const first = originals.requests[0]!
      const attached = await this.attachSession({ harness: detached.harness, executionId: execution.id,
        agentId: execution.agentId, workingDirectory: execution.workingDirectory!, correlationId: originals.correlationId,
        ...(first.turn.nativeTurnId ? { nativeTurnId: first.turn.nativeTurnId } : {}),
      }, detached, { signal, restartOwner: owner })
      const history = await attached.manager.reconcile(detached, originals.correlationId, attached.signal)
      owner.assertOwned()
      for (const [index, original] of originals.requests.entries()) {
        const restored = history.pendingInteractions.find((request) =>
          request.turn.nativeRequestId === original.turn.nativeRequestId)
        // A started or delivered answer may already have consumed the native request.
        if (restored ? !isDeepStrictEqual(restored, original) : nativeDispatchNotStarted(pending[index]!)) throw new DomainError(
          'NATIVE_SESSION_IDENTITY_MISMATCH', 'The restored session has no matching pending approval.', 409)
      }
      const owned = this.ownedSessions.get(execution.id)
      if (owned) {
        delete owned.pendingApprovalRestoration
        this.maintainWaitingWorkflowCredential(owned)
      }
      return true
    } catch (error) {
      owner.assertOwned()
      signal?.throwIfAborted()
      if (isTransientExecutionError(error) || isTransientRefreshFailure(error)) {
        const owned = this.ownedSessions.get(execution.id)
        if (owned) {
          owned.pendingApprovalRestoration = true
          if (!owned.openingFailed && owned.generation > 0) this.maintainWaitingWorkflowCredential(owned)
        }
        throw error
      }
      await this.runs.requestCleanup(owner.runId, owner)
      const owned = this.ownedSessions.get(execution.id)
      if (!owned) throw error
      const safe = nativePersistenceRedactor(Object.values(this.managerCredentials.get(owned.manager)?.environment.variables ?? {}))
      owned.controller.abort(error)
      // Dispose the attempted attachment; the cold registry still has to prove physical closure.
      await owned.manager.dispose()
      this.managerCredentials.delete(owned.manager)
      this.managers.release?.(owned.context, this.rawManagers.get(owned.manager) ?? owned.manager, 'failed')
      if (this.ownedSessions.get(execution.id) === owned) this.ownedSessions.delete(execution.id)
      componentLogger('harness').warn({ err: safe.error(error), executionId: execution.id }, 'workflow approval restoration requires cleanup')
      return false
    }
  }

  private assertSessionIdentity(expected: NativeSessionReference, actual: NativeSessionReference): void {
    if (expected.harness !== actual.harness || expected.providerVersion !== actual.providerVersion
      || expected.nativeSessionId !== actual.nativeSessionId) {
      throw new DomainError('NATIVE_SESSION_IDENTITY_MISMATCH', 'The native manager returned a different session identity.', 409)
    }
  }

  /** Resume values are delivery notifications, never decisions for the currently pending request. */
  async assertResume(execution: HarnessExecution, value: unknown): Promise<void> {
    const id = value && typeof value === 'object' && 'interactionId' in value ? value.interactionId : undefined
    const interaction = typeof id === 'string' ? await this.interactions.get(id) : undefined
    const configuration = await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId, execution)
    if (!interaction || interaction.deliveryState !== 'delivered'
      || !configuration || configuration.harness.harness !== interaction.harness
      || interaction.executionId !== execution.id || interaction.runId !== execution.runId
      || interaction.requestingAgentId !== execution.agentId
      || interaction.nativeSessionId !== execution.nativeSessionId) {
      throw new DomainError('GRAPH_INTERRUPT_RESUME_INVALID', 'The resume value is not a delivered interaction for this execution.', 409)
    }
  }

  private async retainRunOwner(execution: HarnessExecution, onLost: () => void) {
    let owner = this.ownedSessions.get(execution.id)?.runOwner ?? this.sharedRunOwners.get(execution.runId)
    try { owner?.assertOwned() }
    catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'RUN_OWNERSHIP_LOST') throw error
      await owner?.release()
      owner = undefined
    }
    if (owner) {
      const release = owner.retain(onLost)
      runtimeTimingPoint('engine', 'run.retain_owner', {
        runId: execution.runId, executionId: execution.id, reused: true, success: true,
      })
      return { owner, release }
    }
    const acquired = await this.runs.acquireOwnership(execution.runId, onLost)
    runtimeTimingPoint('engine', 'run.retain_owner', {
      runId: execution.runId, executionId: execution.id, reused: false, success: Boolean(acquired),
    })
    if (!acquired) throw new DomainError('SESSION_LANE_BUSY', 'The Run is still completing its current native operation.', 409)
    return { owner: acquired, release: () => acquired.release() }
  }

  shareRunOwner(owner: RunOwnership): () => void {
    this.adoptRunOwner(owner)
    // Cold review attachment can start before recovery registers any session.
    this.sharedRunOwners.set(owner.runId, owner)
    return () => {
      if (this.sharedRunOwners.get(owner.runId) === owner) this.sharedRunOwners.delete(owner.runId)
    }
  }

  adoptRunOwner(owner: RunOwnership): void {
    owner.assertOwned()
    for (const owned of this.ownedSessions.values()) {
      if (owned.execution.runId !== owner.runId) continue
      owned.runOwner = owner
      this.managers.adoptOwner?.(owned.execution.id, this.rawManagers.get(owned.manager) ?? owned.manager, owner)
    }
  }

  /** Recover restart-detached turns and checkpoint-bound approvals, answered or not.
   * Other cold nonterminal lifetimes require physical cleanup before settlement. */
  async requestColdRunCleanup(owner: RunOwnership, approvals: readonly DurableInteraction[] = [],
    signal?: AbortSignal): Promise<boolean> {
    owner.assertOwned()
    this.adoptRunOwner(owner)
    for await (const executions of this.runs.executionPages(owner.runId, owner)) {
      for (const execution of executions) {
        if (repeatTickIndex(execution.input) !== undefined && execution.state !== 'completed') {
          const failed = await owner.oneShotConnection().query(
            'select 1 from approval_execution_state where execution_id=$1 and failure_result is not null',
            [execution.id])
          if (failed.rowCount) {
            await this.failIntervalCheck(owner, execution)
            continue
          }
        }
        const resident = this.ownedSessions.get(execution.id)
        if (resident) {
          if (resident.controller.signal.aborted && execution.state !== 'completed') {
            if (execution.state !== 'waiting') {
              await this.restartInterrupted(owner, execution)
              continue
            }
            await this.runs.requestCleanup(owner.runId, owner)
            return true
          }
          if (resident.pendingApprovalRestoration) {
            const pending = approvals.filter(item => item.executionId === execution.id)
            if (execution.state === 'waiting' && pending.length && pending.every(restorableApproval)
              && await this.restorePendingWorkflowApprovals(owner, execution, pending, signal)) continue
            await this.runs.requestCleanup(owner.runId, owner)
            return true
          }
          continue
        }
        if (execution.state === 'queued' && !execution.nativeSessionId && !execution.startedAt) continue
        if (execution.state === 'running' && execution.nativeSessionId
          && (await this.detachedWorkflowSession(owner, execution)
            ?? (await readRemoteWorkflowContinuation(owner, execution))?.session)) continue
        const pending = approvals.filter((item) => item.executionId === execution.id)
        if (execution.state === 'waiting' && pending.length && pending.every(restorableApproval)) {
          if (await this.restorePendingWorkflowApprovals(owner, execution, pending, signal)) continue
        }
        if (execution.state === 'waiting' && !pending.length && execution.nativeSessionId
          && (await this.detachedWorkflowSession(owner, execution)
            ?? (await readRemoteWorkflowContinuation(owner, execution))?.session)) continue
        if (execution.state === 'completed') continue
        // Restart lost this attempt's native lifetime: close it alone and let its node retry.
        // An attempt waiting for an approval keeps the Run-level recovery path.
        if (execution.state !== 'waiting') {
          await this.restartInterrupted(owner, execution)
          continue
        }
        await this.runs.requestCleanup(owner.runId, owner)
        owner.assertOwned()
        return true
      }
    }
    // Close interrupted attempts before recovering the completed reviewer.
    for await (const executions of this.runs.executionPages(owner.runId, owner)) {
      for (const execution of executions) {
        if (this.ownedSessions.has(execution.id) || execution.state !== 'completed') continue
        try {
          if (await this.recoverRetainedReviewer(execution, owner, signal)) continue
        } catch (error) {
          if (!(error instanceof DomainError) || error.code !== 'REVIEWER_AUTHORITY_LOST') throw error
          await this.runs.requestCleanup(owner.runId, owner, { outcome: 'failed',
            error: { code: error.code, message: error.message, retryable: false } })
          owner.assertOwned()
          return true
        }
        if (execution.nativeSessionId && !await this.workflowClosures?.read(execution)) {
          // A finalized workflow has already closed its original lifetime and
          // may have handed this session to a reviewer. Missing closure now
          // belongs to that later lifetime, not to the original terminal gap.
          // This owner-bound read selects cleanup only; it is NOT closure
          // evidence. The negative pass still rechecks generation/session
          // and requires positive physical proof under the committed fence.
          const native = (await owner.oneShotConnection().query<{ reference: unknown; finalized: boolean }>(
            'select reference,workflow_finalized_at is not null as finalized from execution_native_sessions where execution_id=$1 for share',
            [execution.id])).rows[0]
          owner.assertOwned()
          if (native?.finalized === true) {
            if (NativeSessionReferenceSchema.parse(native.reference).nativeSessionId !== execution.nativeSessionId) {
              throw new DomainError('NATIVE_SESSION_IDENTITY_MISMATCH', 'Cleanup changed the captured native session.', 409)
            }
            await this.runs.requestCleanup(owner.runId, owner)
            owner.assertOwned()
            return true
          }
          const failures: Error[] = []
          await attemptCleanup(failures, `${execution.id}: recover terminal native lifetime`, (signal) =>
            recoverWorkflowNativeClosure(owner, execution, this.recoverNativeProcesses, signal, { purpose: 'terminal' }),
          { timeoutMs: await this.recoveryCleanupTimeout(owner, execution) })
          owner.assertOwned()
          if (failures.length) throw new AggregateError(failures, 'Terminal native closure remains unconfirmed.')
        }
        // Includes a failed original terminal: do not poison technical retry
        // by setting cleanupPending before the repository evaluates its slot.
      }
    }
    return false
  }

  /** Close one failed check before its successor can be admitted. */
  async failIntervalCheck(owner: RunOwnership, execution: HarnessExecution,
    failure: ExecutionResult = { outcome: 'failed', error: {
      code: 'EXECUTION_INTERRUPTED',
      message: 'The native attempt was closed without an accepted result.',
      retryable: false,
    } }): Promise<void> {
    if (repeatTickIndex(execution.input) === undefined) throw new DomainError(
      'TICK_NODE_CONFLICT', 'Only an interval check may settle independently of graph work.', 409)
    await this.abandonAttempt(owner, execution, failure)
  }

  /** An interval check fails until its next tick; any other attempt is retried by its node. */
  private restartInterrupted(owner: RunOwnership, execution: HarnessExecution,
    message = 'The attempt lost its native session before it produced an accepted result.'): Promise<void> {
    if (repeatTickIndex(execution.input) !== undefined) return this.failIntervalCheck(owner, execution)
    return this.abandonAttempt(owner, execution, { outcome: 'failed',
      error: { code: 'EXECUTION_INTERRUPTED', message, retryable: true } })
  }

  private async recoveryCleanupTimeout(owner: RunOwnership, execution: HarnessExecution): Promise<number> {
    const resident = this.ownedSessions.get(execution.id)
    const placement = resident ? resident.context.acceptedPlacement
      : await readExecutionPlacement(owner.oneShotConnection(), execution.id)
    owner.assertOwned()
    return placement?.hostRef.kind === 'device' ? deviceRequestTimeoutMs : cleanupTimeoutMs
  }

  /** Close one attempt for its own recorded cause, without fencing the Run or
   * touching sibling credentials, budgets or sessions. Closure is best effort:
   * an unconfirmed close leaves only this attempt's settlement pending. A
   * retryable cause lets the node start a fresh attempt with the same input. */
  async abandonAttempt(owner: RunOwnership, execution: HarnessExecution, failure: ExecutionResult): Promise<void> {
    owner.assertOwned()
    const store = await this.runs.repeat(owner)
    const stored = (await store.readExecution(execution.id)).execution
    assertSameRepeatExecution(execution, stored)
    if (stored.state === 'completed') return
    componentLogger('harness').warn({ executionId: stored.id, runId: owner.runId, attempt: stored.attempt,
      code: failure.outcome === 'failed' ? failure.error?.code : undefined }, 'Abandoning one native attempt')
    await this.budgets.ensure(stored.id, owner.runId, this.activeTimeoutMs)
    await this.runs.recordExecutionFailure(owner, stored.id, failure)
    const timeoutMs = await this.recoveryCleanupTimeout(owner, stored)
    const resident = this.ownedSessions.get(stored.id)
    if (resident) {
      // A session save can commit even when its acknowledgement never reaches the caller.
      resident.execution = stored
      resident.failed = true
      resident.controller.abort(new DomainError('EXECUTION_ABANDONED', 'This attempt was abandoned for a fresh attempt.', 409))
      const errors = await this.cleanupSession(resident)
      if (errors.length) {
        await withCleanupDeadline(signal => recoverWorkflowNativeClosure(
          owner, stored, this.recoverNativeProcesses, signal, {
            purpose: 'failed_attempt', ...(resident.closureGeneration ? { generation: resident.closureGeneration } : {}),
          }), timeoutMs)
        const remaining = await this.cleanupSession(resident)
        if (remaining.length) throw new AggregateError(remaining, 'Abandoned attempt native closure remains unconfirmed.')
      }
    } else {
      await withCleanupDeadline(signal => recoverWorkflowNativeClosure(
        owner, stored, this.recoverNativeProcesses, signal, { purpose: 'failed_attempt' }), timeoutMs)
      await this.credentials?.revokeForExecution(stored.id)
    }
    owner.assertOwned()
    await this.budgets.stop(stored.id)
    await store.settleNegativeExecution(stored.id, false)
  }

  /** Stop first fences all new work in the database. This pass only cancels
   * ORIGINAL resident managers and revokes execution resources under that fence.
   * The owner-only cold pass also recovers failed resident transports using
   * positive closure receipts for their captured lifetime generation.
   * Positive repository proof, not this method's return value, settles a Run. */
  async cancelRun(runId: string, owner?: RunOwnership): Promise<void> {
    owner?.assertOwned()
    if (owner && owner.runId !== runId) throw new DomainError('GRAPH_SCOPE_MISMATCH', 'The Run owner does not match cleanup.', 409)
    const snapshot = await this.runs.getRepeatSnapshot(runId, owner)
    if (!snapshot.stopRequested && !snapshot.cleanupPending && snapshot.run.executionState !== 'completed') {
      throw new DomainError('GRAPH_STOP_CONFLICT', 'Native cancellation requires the committed Stop or cleanup fence.', 409)
    }
    this.stoppingRuns.add(runId)
    this.pendingCleanupRuns.add(runId)
    if (owner) {
      if (owner.runId !== runId) throw new DomainError('RUN_OWNERSHIP_LOST', 'The cancellation owner belongs to another Run.', 409)
      this.adoptRunOwner(owner)
    }
    let task = this.cancellations.get(runId)
    if (!task) {
      task = (async () => {
        const failures: Error[] = []
        const owned = [...this.ownedSessions.values()].filter((item) => item.execution.runId === runId)
        for (const item of owned) item.controller.abort()
        const closures = owned.map((item) => this.cleanupSession(item))
        await attemptCleanup(failures, 'cancel unresolved interactions', () => this.interactions.cancelPendingForRun(runId).then(() => undefined))
        // Every sibling is attempted, even when one native close fails. Budget
        // and credential revocation are negative actions, not closure evidence.
        for await (const executions of this.runs.executionPages(runId)) {
          for (const execution of executions) {
            await attemptCleanup(failures, `${execution.id}: revoke credentials`, () =>
              this.credentials ? this.credentials.revokeForExecution(execution.id).then(() => undefined) : Promise.resolve())
            await attemptCleanup(failures, `${execution.id}: stop budget`, () => this.budgets.stop(execution.id))
          }
        }
        for (const result of await Promise.allSettled(closures)) {
          if (result.status === 'fulfilled') failures.push(...result.value)
          else failures.push(new Error('Captured native cleanup failed.', { cause: result.reason }))
        }
        if (failures.length) throw new AggregateError(failures, 'Captured native cleanup remains incomplete.')
      })().finally(() => { this.cancellations.delete(runId) })
      this.cancellations.set(runId, task)
    }
    let retryResidentCleanup = false
    try {
      await task
    } catch (error) {
      if (!owner || !(error instanceof AggregateError)) throw error
      // Retry every failed operation only after owner-fenced physical recovery.
      retryResidentCleanup = true
    }
    if (owner) {
      owner.assertOwned()
      const store = await this.runs.repeat(owner)
      const failures: Error[] = []
      for await (const executions of this.runs.executionPages(runId, owner)) {
        for (const execution of executions) {
          const resident = this.ownedSessions.get(execution.id)
          if (resident && !retryResidentCleanup) continue
          await attemptCleanup(failures, `${execution.id}: recover original native lifetime`, async (signal) => {
            if (resident) {
              assertSameRepeatExecution(resident.execution, execution)
              if (resident.opening || resident.cleanup || !resident.closureGeneration) throw new DomainError(
                'REPEAT_CLEANUP_PENDING', 'The original native operation is still completing cleanup.', 409)
            }
            await recoverWorkflowNativeClosure(owner, execution, this.recoverNativeProcesses, signal,
              resident ? { generation: resident.closureGeneration! } : {})
          }, { timeoutMs: deviceRequestTimeoutMs })
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Cold native closure remains unconfirmed.')
      if (retryResidentCleanup) await this.cancelRun(runId)
      // Original closures and revocations above precede review retirement. The
      // attempt settlement gate below requires those review receipts, not vice versa.
      await this.interactions.coordination.finishStoppedReviews(runId, Boolean(this.credentials))
      owner.assertOwned()
      for await (const executions of this.runs.executionPages(runId, owner)) {
        for (const execution of executions) {
          // Seals a positively reserved/prepared attempt or verifies its exact
          // native close/disposal. An entered unknown lifetime stays pending.
          await store.settleNegativeExecution(execution.id, snapshot.stopRequested)
        }
      }
      owner.assertOwned()
    }
  }

  /** The exact ordinary/occurrence attempt is already admitted.
   * Completed re-entry has no request/configuration/preflight/native-start path. */
  async observeExact(input: Omit<ApprovalObservationInput, 'candidate' | 'request'> & {
    execution: HarnessExecution; request?: HarnessExecutionRequest; store: RepeatNativeObservationStore
  }): Promise<ApprovalExecutionObservation> {
    input.signal.throwIfAborted()
    input.owner.assertOwned()
    const { execution } = await input.store.readExecution(input.execution.id)
    assertSameRepeatExecution(input.execution, execution)
    if (execution.runId !== input.owner.runId || input.graphThreadId !== execution.runId) {
      throw new DomainError('GRAPH_SCOPE_MISMATCH', 'Native observation cannot cross Run owners or checkpoints.', 409)
    }
    if (execution.state === 'completed') {
      await this.finishRepeatExecution(execution, input.store, input.owner, input.signal)
      return { state: 'completed', execution, result: execution.result! }
    }
    const request = input.request
    if (!request || request.executionId !== execution.id || request.runId !== execution.runId
      || request.workflowNodeId !== execution.workflowNodeId
      || request.configuration.agentId !== execution.agentId
      || request.configuration.id !== execution.agentConfigurationVersionId) {
      throw new DomainError('REPEAT_EXECUTION_INPUT_CONFLICT', 'Native work requires its exact pinned request.', 409)
    }
    await input.store.assertExecutionAdmission(execution.id)
    input.signal.throwIfAborted()
    input.owner.assertOwned()
    return withRuntimeTimingContext({ runId: execution.runId, executionId: execution.id }, () =>
      timeRuntimeOperation('engine', 'execution.observe', () => this.observeExecution(
        { ...input, candidate: execution, request }, { execution, created: false }, input.store)))
  }

  private async observeExecution(input: ApprovalObservationInput,
    ensured: { execution: HarnessExecution; created: boolean }, repeat: RepeatNativeObservationStore): Promise<ApprovalExecutionObservation> {
    const credentialFailure = new AbortController()
    const observation: WorkflowObservationState = {
      input, ensured, repeat, credentialFailure,
      signal: AbortSignal.any([input.signal, credentialFailure.signal]),
      execution: ensured.execution, repeatLaunch: false, nativeTurnOffered: false, workResultRepairs: 0,
      workflowCorrelation: `execution:${ensured.execution.id}`, knownSecrets: [],
      committedNativeSequences: new Map(),
      bookkeeping: work => retryDatabaseTimeout(work, { signal: observation.signal, check: () => input.owner.assertOwned() }),
      validateContinuation: () => observation.bookkeeping(async () => {
        await this.validateContinuation?.(observation.execution.id, observation.signal)
      }),
      assertBoundary: async () => {
        observation.signal.throwIfAborted()
        input.owner.assertOwned()
        await observation.bookkeeping(() => repeat.assertNativeBoundary(observation.execution.id))
        observation.signal.throwIfAborted()
        input.owner.assertOwned()
      },
      watchCredential: () => {
        const credential = observation.manager && this.managerCredentials.get(observation.manager)
        if (credential) observation.knownSecrets.push(...Object.values(credential.environment.variables))
      },
      safeValue: value => nativePersistenceRedactor(observation.knownSecrets).value(value),
      safeError: error => nativePersistenceRedactor(observation.knownSecrets).error(error),
      startCredentialMaintenance: () => this.startWorkflowCredentialMaintenance(observation),
      observePending: (history, sourceLease) => this.observePendingWorkflowHistory(observation, history, sourceLease),
    }
    observation.signal.throwIfAborted()
    assertNativeWorkflowConfiguration(input.request.configuration.harness, input.approval,
      input.approval?.handler === 'orchestrator'
        && input.request.configuration.agentId === input.approval.designatedOrchestratorAgentId)
    try {
      const completed = await this.prepareWorkflowObservation(observation)
      if (completed) return completed
      const waiting = await this.startWorkflowObservation(observation)
      if (waiting) return waiting
      return await this.reconcileWorkflowObservation(observation)
    } catch (rawError) {
      return await this.failWorkflowObservation(observation, rawError)
    } finally {
      try { await observation.stopRenewal?.() }
      finally {
        if (observation.budgetTimer) clearTimeout(observation.budgetTimer)
        observation.finishStartup?.()
      }
    }
  }

  private startWorkflowCredentialMaintenance(observation: WorkflowObservationState): void {
    const { input } = observation
    observation.watchCredential()
    if (!this.credentials || observation.stopRenewal || !observation.manager! || !this.managerCredentials.has(observation.manager!)) return
    observation.stopRenewal = renewOwnedLeases({
      signal: observation.signal,
      check: async () => {
        observation.signal.throwIfAborted()
        input.owner.assertOwned()
        await this.validateContinuation?.(observation.execution.id, observation.signal)
        input.owner.assertOwned()
      },
      leases: [this.credentialLease(observation.manager!, async () => {
        const credential = this.managerCredentials.get(observation.manager!)
        if (!credential) throw new Error('The execution lost its native credential lease.')
        if (remainingCredentialLifetime(credential) <= WORKER_CREDENTIAL_RENEWAL_WINDOW_MS) {
          await this.renewCredential(observation.manager!, observation.context!.executionId, {
            signal: observation.signal,
            check: async () => {
              observation.signal.throwIfAborted()
              input.owner.assertOwned()
            },
          })
        }
        input.owner.assertOwned()
      })],
      onFailure: (error, phase, lease) => {
        const failure = new DomainError('WORKER_CREDENTIAL_EXPIRING',
          'Execution stopped before its App credential expired. Active native work was not restarted.', 409)
        failure.cause = error
        componentLogger('harness').warn({ operation: 'maintain workflow credential',
          executionId: observation.execution.id, runId: observation.execution.runId, phase, lease,
          remainingMs: remainingCredentialLifetime(this.managerCredentials.get(observation.manager!)),
          err: observation.safeError(failure) }, 'Worker credential maintenance failed')
        observation.credentialFailure.abort(failure)
      },
    })
  }

  private async resumeWorkflowBudget(observation: WorkflowObservationState):
    Promise<ApprovalExecutionObservation | undefined> {
    try {
      await observation.bookkeeping(() => this.budgets.resume(observation.execution.id))
      return undefined
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'EXECUTION_STOPPED') throw error
      const { input, repeat } = observation
      const saved = await observation.bookkeeping(async () => (await input.owner.oneShotConnection()
        .query<{ failure_result: unknown }>(`select failure_result from approval_execution_state
          where execution_id=$1 and graph_thread_id=$2`, [observation.execution.id, input.owner.runId])).rows[0])
      if (!saved?.failure_result) throw error
      const failure = ExecutionResultSchema.parse(saved.failure_result)
      if (!isTransientExecutionResult(failure)) throw error
      // The budget was stopped before negative settlement committed. Finish that
      // attempt's cleanup before its node can start a replacement.
      await observation.bookkeeping(() => this.abandonAttempt(input.owner, observation.execution, failure))
      observation.execution = (await observation.bookkeeping(() => repeat.readExecution(observation.execution.id))).execution
      await this.finishRepeatExecution(observation.execution, repeat, input.owner, observation.signal)
      return { state: 'completed', execution: observation.execution, result: observation.execution.result! }
    }
  }

  private async prepareWorkflowObservation(observation: WorkflowObservationState):
    Promise<ApprovalExecutionObservation | undefined> {
    const { input, repeat } = observation
    observation.signal.throwIfAborted()
    input.owner.assertOwned()
    if (observation.execution.state === 'completed') {
      if (!observation.execution.result) throw new Error('The completed execution has no durable result.')
      await this.finishRepeatExecution(observation.execution, repeat, input.owner, observation.signal)
      return { state: 'completed', execution: observation.execution, result: observation.execution.result }
    }
    await observation.bookkeeping(() => this.budgets.ensure(
      observation.execution.id, input.graphThreadId, input.agentActiveTimeoutMs ?? this.activeTimeoutMs))
    const settled = await this.resumeWorkflowBudget(observation)
    if (settled) return settled
    if (input.workHandoffContract || input.deliverable) {
      observation.workResultRepairs = await observation.bookkeeping(() => this.runs.readWorkResultRepairAttempt(observation.execution.id, input.owner))
      observation.workflowCorrelation = workResultRepairCorrelation(observation.execution.id, observation.workResultRepairs)
    }
    const budgetStarted = performance.now()
    // An exhausted budget found on recovery takes the same deadline path as a
    // live timeout: abort, close the exact session and settle negatively.
    const remainingMs = await observation.bookkeeping(() => this.budgets.remaining(observation.execution.id)).catch((error: unknown) => {
      if (error instanceof DomainError && error.code === 'EXECUTION_ACTIVE_TIMEOUT') return 0
      throw error
    })
    const deadline = new AbortController()
    observation.budgetTimer = setTimeout(() => deadline.abort(new DomainError('EXECUTION_ACTIVE_TIMEOUT', 'The execution exhausted its active-time budget.', 409)),
      Math.max(0, remainingMs - (performance.now() - budgetStarted)))
    observation.budgetTimer.unref()
    observation.signal = AbortSignal.any([observation.signal, deadline.signal])
    // Read the durable reference before resolving a manager: a repository
    // failure must not evict a resident session still needed by run cleanup.
    observation.existing = observation.execution.nativeSessionId
      ? await observation.bookkeeping(() => this.interactions.getForExecution(observation.execution.id)) : undefined
    observation.request = HarnessExecutionRequestSchema.parse({
      ...input.request, executionId: observation.execution.id, runId: observation.execution.runId,
      workflowNodeId: observation.execution.workflowNodeId, workingDirectory: observation.execution.workingDirectory,
      runtimeDirectory: observation.execution.runtimeDirectory, systemPrompt: observation.execution.systemPrompt, input: observation.execution.input,
    })
    if (observation.request!.systemPrompt === undefined) delete observation.request!.systemPrompt
    observation.context = {
      ...await observation.bookkeeping(() => this.managerContext(observation.execution, input.request.configuration)),
      workflowRequest: observation.request!,
    }
    await observation.validateContinuation()
    {
      await observation.bookkeeping(() => repeat.assertExecutionAdmission(observation.execution.id))
      // Resolving this manager constructs an object only. Native preflight
      // is fenced below, AFTER its durable lifetime registration commits.
      if (observation.execution.nativeSessionId) {
        observation.session = await observation.bookkeeping(() => repeat.exactSession(observation.execution.id))
        if (observation.session!.harness !== observation.context!.harness || observation.session!.nativeSessionId !== observation.execution.nativeSessionId) {
          throw new DomainError('NATIVE_SESSION_IDENTITY_MISMATCH', 'Recovery changed the captured native session.', 409)
        }
      }
      const resident = this.ownedSessions.get(observation.execution.id)
      if (resident) {
        assertSameRepeatExecution(observation.execution, resident.execution)
        if (resident.context.purpose === 'reviewer' || resident.cleanup || resident.reviewFinishing) {
          throw new DomainError('SESSION_LANE_BUSY', 'The exact native lifetime is finishing other work.', 409)
        }
        if (resident.session && observation.session!) this.assertSessionIdentity(resident.session, observation.session!)
      }
      if (!resident && observation.session!) {
        const continuing = observation.context!.acceptedPlacement?.hostRef.kind === 'device'
          ? await observation.bookkeeping(() => readRemoteWorkflowContinuation(input.owner, observation.execution)) : undefined
        const detached = continuing ? undefined : await this.detachedWorkflowSession(input.owner, observation.execution)
        if (continuing || detached) {
          this.assertSessionIdentity(continuing?.session ?? detached!, observation.session!)
          const recovery = continuing ?? await readDetachedWorkflowLifetime(input.owner, observation.execution)
          if (recovery) observation.restartRecovery = { ...recovery, owner: input.owner }
          await this.waitForRestartWriter(input.owner, observation.execution, observation.session!, observation.workflowCorrelation, continuing
            ? () => readRemoteWorkflowContinuation(input.owner, observation.execution)
            : () => readDetachedWorkflowLifetime(input.owner, observation.execution), observation.signal)
        }
      }
    }
    observation.resolved = this.resolveManager(observation.context!, input.owner)
    if (observation.resolved!.processState === 'needs_start') observation.resolved!.beginStart?.()
    observation.manager = observation.resolved!.manager
    observation.ownedSession = this.ownSession(observation.execution, observation.context!, observation.manager!)
    observation.ownedSession!.runOwner = input.owner
    await observation.ownedSession!.stopWaitingRenewal?.()
    delete observation.ownedSession!.stopWaitingRenewal
    if (observation.restartRecovery) observation.ownedSession!.restartRecovery ??= observation.restartRecovery
    if (observation.session! && !observation.ownedSession!.session) observation.ownedSession!.session = observation.session!
    if (observation.session! && (observation.context!.acceptedPlacement?.hostRef.kind === 'device'
      || observation.context!.harness === 'codex' && !observation.context!.purpose)) {
      observation.ownedSession!.restartAttachment = { session: observation.session!, request: observation.request! }
    }
    observation.signal = AbortSignal.any([observation.signal, observation.ownedSession!.controller.signal])
    if (!observation.execution.nativeSessionId) {
      observation.ownedSession!.starting = new Promise<void>((resolve) => { observation.finishStartup = resolve })
    }
  }

  private async observePendingWorkflowHistory(observation: WorkflowObservationState, history: NativeHistory,
    sourceLease?: WorkflowNativeLease): Promise<ApprovalExecutionObservation | undefined> {
    const manager = observation.manager!
    const ownedSession = observation.ownedSession!
    const session = observation.session!
    const { input, repeat } = observation
    observation.signal.throwIfAborted()
    input.owner.assertOwned()
    if (!history.pendingInteractions.length) return undefined
    const originalHistory = this.captureNative(input.owner, observation.execution,
      { type: 'history', history: observation.safeValue(history) }, sourceLease?.live ? 'live' : 'recovery',
      manager.capturedLease(session))
    history = { ...history, events: history.events.map((event) => normalizeNativeProducerEvent(
      observation.safeValue({ ...event, executionId: observation.execution.id })).event) }
    observation.signal.throwIfAborted()
    input.owner.assertOwned()
    const pendingExecution = HarnessExecutionSchema.parse({ ...observation.execution, state: 'waiting' })
    await observation.bookkeeping(() => this.runs.updateExecution(pendingExecution, input.owner, originalHistory))
    observation.execution = (await observation.bookkeeping(() => repeat.readExecution(pendingExecution.id))).execution
    ownedSession.execution = observation.execution
    const waiting: DurableInteraction[] = []
    for (const pending of history.pendingInteractions) {
      const interaction = await observation.bookkeeping(() => this.interactions.getNativeRequest(observation.execution.id, session.harness,
        session.nativeSessionId, pending.turn.nativeRequestId!))
      if (!interaction) throw new DomainError('APPROVAL_ORIGINAL_SOURCE_REQUIRED',
        'The owned native request publication did not commit.', 409)
      if (interaction.deliveryState !== 'delivered') waiting.push(interaction)
      await this.enqueueReview(interaction)
    }
    if (!waiting.length) return undefined
    observation.signal.throwIfAborted()
    this.maintainWaitingWorkflowCredential(ownedSession)
    return { state: 'waiting', execution: observation.execution, interaction: waiting[0]!, interactions: waiting }
  }

  private async startWorkflowObservation(observation: WorkflowObservationState):
    Promise<ApprovalExecutionObservation | undefined> {
    const context = observation.context!
    const manager = observation.manager!
    const resolved = observation.resolved!
    const ownedSession = observation.ownedSession!
    const request = observation.request!
    const { input, repeat } = observation
    if (!observation.execution.nativeSessionId) {
      const launchContext = context
      const launchManager = resolved
      const environment = await timeRuntimeOperation('harness', 'native.prepare_environment', () =>
        this.prepareEnvironment(launchContext, launchManager, { signal: observation.signal, enterNative: async () => {
          await repeat.authorizeNativeSubmission(observation.execution.id)
          observation.repeatLaunch = repeat.consumeLaunch(observation.execution.id)
          if (!observation.repeatLaunch) throw new DomainError('NATIVE_SESSION_START_UNCERTAIN',
            'No exact committed launch permit exists. Native work was not started.', 409)
        } }))
      observation.startCredentialMaintenance()
      await observation.validateContinuation()
      observation.signal.throwIfAborted()
      input.owner.assertOwned()
      await observation.assertBoundary()
      const start = { request, correlationId: observation.workflowCorrelation, ...(environment ? { environment } : {}),
        ...(observation.execution.sessionContinuation ? { sessionContinuation: observation.execution.sessionContinuation } : {}) }
      const persistObservedSession = async (observed: NativeSessionReference, setupLane?: SessionWriteLease) => {
        if (observed.harness !== context.harness) throw new Error('The observed native session has the wrong harness.')
        observation.session = observed
        resolved.markResident?.()
        const createdEvidence = this.captureNative(input.owner, observation.execution, { type: 'session_created', session: observed }, 'live', setupLane ?? manager.capturedLease(observed))
        observation.execution = HarnessExecutionSchema.parse({ ...observation.execution, nativeSessionId: observed.nativeSessionId, state: 'running' })
        await observation.bookkeeping(async () => {
          await this.runs.updateExecution(observation.execution, input.owner, createdEvidence)
          ownedSession.execution = observation.execution
        })
        await observation.validateContinuation()
        observation.signal.throwIfAborted()
        input.owner.assertOwned()
        await observation.assertBoundary()
      }
      const publishObservedSession = async (observed: NativeSessionReference) => {
        const active = manager.capturedLease(observed)
        if (!context.acceptedPlacement || active) {
          await persistObservedSession(observed, active)
          input.onStarted?.()
          return
        }
        // Actual source continuation needs the original native owner and a
        // live lane during publication/revalidation before its first turn.
        const correlationId = observation.workflowCorrelation
        await manager.withLane(observed, correlationId, observation.signal, async (native, lane) => {
          await manager.requireIdle(native, observed, correlationId, lane, observation.signal)
          await this.interactions.coordination.bindLaneTurn(lane.fence, correlationId)
          return persistObservedSession(observed, lane)
        })
        input.onStarted?.()
      }
      const nativeSchema = input.deliverable ? nativeOutputSchema(input.deliverable) : undefined
      let nativeEvents: AsyncIterable<NativeHarnessEvent[]>
      let rejectObserved: ((error: unknown) => void) | undefined
      try {
        if (manager.startInitialTurnBatches && !observation.execution.sessionContinuation) {
          let resolveObserved!: (observed: NativeSessionReference) => void
          const observed = new Promise<NativeSessionReference>((resolve, reject) => { resolveObserved = resolve; rejectObserved = reject })
          const opening = this.openingSession(ownedSession, observed)
          void opening.catch(() => {
            // ignore: the owned-session lifecycle joins this opening promise during cleanup.
          })
          nativeEvents = manager.startInitialTurnBatches(start, {
            prompt: buildHarnessPrompt(request), clientCorrelationId: observation.workflowCorrelation,
            deferSettlement: true,
            ...(nativeSchema ? { outputSchema: nativeSchema } : {}),
            onTurnOffered: () => { observation.nativeTurnOffered = true },
            onSessionObserved: async (native) => {
              resolveObserved(native)
              await publishObservedSession(await opening)
            },
          }, observation.signal)
        } else {
          const observed = await this.openingSession(ownedSession,
            timeRuntimeOperation('harness', 'native.create_session', () => manager.createSession(start, observation.signal)))
          nativeEvents = manager.startTurnBatches(observed, {
            prompt: buildHarnessPrompt(request), clientCorrelationId: observation.workflowCorrelation,
            deferSettlement: true,
            ...(nativeSchema ? { outputSchema: nativeSchema } : {}),
            onSessionReady: () => publishObservedSession(observed),
            onTurnOffered: () => { observation.nativeTurnOffered = true },
          }, observation.signal)
        }
        let nativeEventsPersisted = false
        for await (const events of nativeEvents) {
          observation.signal.throwIfAborted()
          await observation.bookkeeping(() => this.budgets.assertActive(observation.execution.id))
          const lease = manager.currentProjectionLease(observation.session!)
          const frames = events.map((event) => {
            const original = observation.safeValue({ ...event, executionId: observation.execution.id })
            return { event: original, evidence: this.captureNative(input.owner, observation.execution,
              { type: 'event', event: original }, 'live', manager.capturedLease(observation.session!)) }
          })
          await timeRuntimeOperation('engine', 'native.persist_batch', async () => {
            const append = () => this.runs.appendNativeEvents(frames, input.owner, lease)
            if (nativeEventsPersisted) return observation.bookkeeping(append)
            // An unconfirmed first journal write yields to recovery of the original submission.
            try {
              await append()
              nativeEventsPersisted = true
            } catch (cause) {
              if (!isDatabaseTimeout(cause)) throw cause
              const error = new DomainError('NATIVE_PUBLICATION_UNCERTAIN',
                'The first native event publication could not be confirmed.', 409)
              error.cause = cause
              throw error
            }
          }, { count: frames.length })
          for (const { event } of frames) this.recordCommittedNativeEvent(observation, event)
          observation.finishStartup?.()
          const history = await manager.history(observation.session!, observation.signal)
          const waiting = await observation.observePending(history, lease)
          if (waiting) return waiting
          // Commit bounded frames while their writer lease remains held.
        }
      } catch (error) { rejectObserved?.(error); throw error }
      finally { if (!observation.session!) rejectObserved?.(new Error('Initial input has no observed native session.')) }

    } else {
      if (!observation.session!) throw new DomainError('NATIVE_SESSION_IDENTITY_MISMATCH', 'Recovery requires the exact saved session.', 409)
      ownedSession.session = observation.session!
      if (observation.existing) this.assertSessionIdentity(observation.session!, observation.existing)
      const environment = await this.prepareEnvironment(context, resolved, { signal: observation.signal, restartOwner: input.owner })
      observation.startCredentialMaintenance()
      await observation.validateContinuation()
      observation.signal.throwIfAborted()
      input.owner.assertOwned()
      await observation.assertBoundary()
      if (resolved.processState === 'needs_start') {
        const attached = await this.openingSession(ownedSession, manager.attachSession(observation.session!, {
          kind: 'workflow', correlationId: observation.workflowCorrelation, request,
          ...(environment ? { environment } : {}),
        }, observation.signal))
        this.assertSessionIdentity(observation.session!, attached)
        resolved.markResident?.()
      }
      // Resident sessions retain their original scoped process credentials.
      // history() below verifies the already-owned exact session, without a
      // redundant attachSession() requiring a newly supplied environment.
      input.onStarted?.()
    }
  }

  private recordCommittedNativeEvent(observation: WorkflowObservationState, event: NativeHarnessEvent): void {
    const connection = event.connectionId ?? ''
    const previous = observation.committedNativeSequences.get(connection) ?? -1
    observation.committedNativeSequences.set(connection, Math.max(previous, event.sequence))
  }

  private async publishRecoveredNativeEvents(observation: WorkflowObservationState, events: readonly NativeHarnessEvent[],
    lane: SessionWriteLease, lease: WorkflowNativeLease): Promise<boolean> {
    const pending = events.filter(event => event.sequence
      > (observation.committedNativeSequences.get(event.connectionId ?? '') ?? -1))
    for (let offset = 0; offset < pending.length; offset += NATIVE_EVENT_BATCH_SIZE) {
      await lane.guard.check()
      const frames = pending.slice(offset, offset + NATIVE_EVENT_BATCH_SIZE).map(event => {
        const original = observation.safeValue({ ...event, executionId: observation.execution.id })
        return { event: original, evidence: this.captureNative(observation.input.owner, observation.execution,
          { type: 'event', event: original }, 'recovery', lane) }
      })
      await observation.bookkeeping(() => this.runs.appendNativeEvents(frames, observation.input.owner, lease))
      for (const { event } of frames) this.recordCommittedNativeEvent(observation, event)
    }
    return pending.length > 0
  }

  private async reconcileWorkflowObservation(observation: WorkflowObservationState): Promise<ApprovalExecutionObservation> {
    const manager = observation.manager!
    const ownedSession = observation.ownedSession!
    const { input, repeat } = observation
    if (!observation.session) throw new DomainError('NATIVE_SESSION_IDENTITY_REQUIRED', 'Initial input has no observed session identity.', 409)
    const nativeSchema = input.deliverable ? nativeOutputSchema(input.deliverable) : undefined
    const observed = await manager.withLane(observation.session!, observation.workflowCorrelation, observation.signal, async (nativeManager, lane) => {
      let idleDelayMs = 100
      for (;;) {
        let publishedEvents = false
        lane.guard.signal.throwIfAborted()
        input.owner.assertOwned()
        await observation.bookkeeping(() => this.budgets.assertActive(observation.execution.id))
        let observed = await timeRuntimeOperation('harness', 'native.reconcile',
          () => nativeManager.reconcile(observation.session!, observation.workflowCorrelation, lane.guard.signal))
        const messageReceipt = observed.nativeSubmission
        const messageIdentity = messageReceipt?.kind === 'message' && messageReceipt.nativeSessionId === observation.session!.nativeSessionId
          && messageReceipt.clientCorrelationId === observation.workflowCorrelation
        let providerId = observed.nativeTurnId
        if (observation.session!.harness === 'claude') {
          providerId = messageIdentity ? messageReceipt.nativeMessageId : undefined
        }
        const exactTerminal = observed.terminalTurn?.correlationId === observation.workflowCorrelation
          && observed.correlationId === observation.workflowCorrelation && Boolean(providerId)
          && observed.terminalTurn.providerId === providerId
          && !observed.pendingInteraction && observed.pendingInteractions.length === 0
        if (exactTerminal) {
          lane.providerId = observed.terminalTurn!.providerId
        } else if (observed.correlationId === observation.workflowCorrelation && providerId) {
          lane.providerId = providerId
        }
        if (lane.providerId) {
          await observation.bookkeeping(() => this.interactions.coordination.acknowledgeLaneTurn(
            lane.fence, observation.workflowCorrelation, lane.providerId!,
          ))
        }
        const lease = { ...lane.fence, ...(lane.providerId ? { providerId: lane.providerId } : {}), live: false as const }
        let captured = this.captureNative(input.owner, observation.execution,
          { type: 'history', history: observation.safeValue(observed) }, 'recovery', lane)
        const waiting = await observation.observePending(observed, lease)
        if (waiting) return { waiting }
        if (exactTerminal) {
          const handoffPrompt = input.workHandoffContract
            ? workResultRepairPrompt(observed.terminalTurn!.result, input.workHandoffContract, observation.execution.input,
              input.request?.executionContext)
            : undefined
          // The deliverable is judged once the handoff envelope itself is valid.
          const verdict = input.deliverable && !handoffPrompt
            ? await observation.bookkeeping(() => deliverableVerdict(observed.terminalTurn!.result, input.deliverable!)) : undefined
          const repairPrompt = handoffPrompt ?? (verdict ? deliverableRepairPrompt(verdict, input.deliverable!.outputSchema) : undefined)
          if (repairPrompt && observation.workResultRepairs < 2) {
            assertOriginalWorkflowTerminal(observation.execution, observation.session!, observed, observation.workflowCorrelation)
            const reserved = await observation.bookkeeping(() => this.runs.reserveWorkResultRepair(
              observation.execution.id, observed.terminalTurn!.providerId, input.owner, captured))
            if (reserved) {
              observation.workResultRepairs = reserved
              await observation.validateContinuation()
              await observation.assertBoundary()
              await lane.guard.check()
              const idle = reviewTurnEvidence(observation.session!, observed, observation.workflowCorrelation, lane.providerId)
              if (!idle.nativeIdle || idle.nativeBusy || idle.identityConflict) throw new DomainError(
                'SESSION_LANE_BUSY', 'The native session has active or unreconciled work.', 409)
              observation.workflowCorrelation = workResultRepairCorrelation(observation.execution.id, reserved)
              await this.interactions.coordination.bindLaneTurn(lane.fence, observation.workflowCorrelation)
              lane.correlationId = observation.workflowCorrelation
              delete lane.providerId
              lane.observedStatus = 'uncertain'
              const acknowledge = async (providerId: string) => {
                await lane.guard.check()
                await observation.bookkeeping(() => this.interactions.coordination.acknowledgeLaneTurn(
                  lane.fence, observation.workflowCorrelation, providerId))
                lane.providerId = providerId
              }
              const events = nativeManager.startTurn(observation.session!, {
                prompt: repairPrompt, ...(nativeSchema ? { outputSchema: nativeSchema } : {}), clientCorrelationId: observation.workflowCorrelation,
                deferSettlement: true,
                onSubmitted: acknowledge,
                onMessageSubmitted: async receipt => {
                  if (receipt.nativeSessionId !== observation.session!.nativeSessionId
                    || receipt.clientCorrelationId !== observation.workflowCorrelation) throw new DomainError(
                      'NATIVE_MESSAGE_IDENTITY_CONFLICT', 'The corrective message differs from the owned session.', 409)
                  await acknowledge(receipt.nativeMessageId)
                },
              }, lane.guard.signal)
              for await (const event of events) {
                await lane.guard.check()
                await observation.bookkeeping(() => this.budgets.assertActive(observation.execution.id))
                const original = observation.safeValue({ ...event, executionId: observation.execution.id })
                const evidence = this.captureNative(input.owner, observation.execution,
                  { type: 'event', event: original }, 'live', lane)
                await observation.bookkeeping(() => this.runs.appendNativeEvent(original, input.owner,
                  { ...lane.fence, ...(lane.providerId ? { providerId: lane.providerId } : {}), live: true },
                  undefined, undefined, evidence))
                this.recordCommittedNativeEvent(observation, original)
                const history = await nativeManager.history(observation.session!, lane.guard.signal)
                const waiting = await observation.observePending(history,
                  { ...lane.fence, ...(lane.providerId ? { providerId: lane.providerId } : {}), live: true })
                if (waiting) return { waiting }
              }
              continue
            }
          }
          if (nativeManager.settleTurn) {
            const settled = await nativeManager.settleTurn(observation.session!, observation.workflowCorrelation, lane.guard.signal)
            assertOriginalWorkflowTerminal(observation.execution, observation.session!, settled, observation.workflowCorrelation)
            if (!isDeepStrictEqual(settled.terminalTurn, observed.terminalTurn)) throw new DomainError(
              'NATIVE_TERMINAL_SOURCE_REQUIRED', 'The settled result differs from the validated provider output.', 409)
            observed = settled
            captured = this.captureNative(input.owner, observation.execution,
              { type: 'history', history: observation.safeValue(observed) }, 'recovery', lane)
          }
          // The native result stays the evidence; a deliverable still failing after repair is failed where the terminal is normalized.
          const completed = HarnessExecutionSchema.parse({ ...observation.execution, state: 'completed',
            result: observation.safeValue(observed.terminalTurn!.result), finishedAt: capturedWorkflowNativeTime(captured) })
          // Terminal publication ends workflow credential authority before native disposal finishes.
          await observation.stopRenewal?.()
          observation.signal.throwIfAborted()
          await timeRuntimeOperation('engine', 'execution.accept_terminal',
            () => observation.bookkeeping(() => this.runs.updateExecution(completed, input.owner, captured)))
          // Read the first-terminal normalizer's immutable result, not a local
          // copy of unvalidated provider output. The original remains private.
          observation.execution = (await observation.bookkeeping(() => repeat.readExecution(observation.execution.id))).execution
          ownedSession.execution = observation.execution
        } else {
          publishedEvents = await this.publishRecoveredNativeEvents(observation, observed.events, lane, lease)
        }
        if (exactTerminal) return { waiting: undefined }
        if (publishedEvents) idleDelayMs = 100
        await timeRuntimeOperation('engine', 'execution.backoff',
          () => delay(idleDelayMs, undefined, { signal: lane.guard.signal }), { intervalMs: idleDelayMs })
        idleDelayMs = Math.min(1000, idleDelayMs * 2)
      }
    })
    const { waiting } = observed
    if (waiting) return waiting
    observation.execution = (await observation.bookkeeping(() => repeat.readExecution(observation.execution.id))).execution
    assertSameRepeatExecution(observation.ensured.execution, observation.execution)
    if (observation.execution.state !== 'completed' || !observation.execution.result || !observation.execution.finishedAt) throw new DomainError(
      'REPEAT_BOUNDARY_PENDING', 'The exact original native terminal has not committed.', 409)
    ownedSession.execution = observation.execution
    await timeRuntimeOperation('engine', 'execution.settle',
      () => this.finishRepeatExecution(observation.execution, repeat, input.owner, observation.signal))
    return { state: 'completed', execution: observation.execution, result: observation.execution.result }
  }

  private async failWorkflowObservation(observation: WorkflowObservationState, rawError: unknown): Promise<never> {
    const { input, repeat } = observation
    // A credential may have been issued just before an abort rejected setup.
    const credential = observation.manager! && this.managerCredentials.get(observation.manager!)
    if (credential) observation.knownSecrets.push(...Object.values(credential.environment.variables))
    const error = observation.safeError(observation.signal.aborted && observation.signal.reason instanceof DomainError
      && ['WORKER_CREDENTIAL_EXPIRING', 'EXECUTION_ACTIVE_TIMEOUT'].includes(observation.signal.reason.code)
      ? observation.signal.reason : rawError)
    let code: string | null = error instanceof Error ? error.constructor.name : typeof error
    if (error instanceof DomainError) code = error.code
    else if (rawError instanceof HarnessExecutionError) {
      code = rawError.result.outcome === 'failed' ? rawError.result.error?.code ?? null : rawError.result.outcome
    }
    // Codes only: provider messages may carry model content or secrets.
    componentLogger('engine').warn({ executionId: observation.execution.id, aborted: observation.signal.aborted,
      code,
      reason: error instanceof DomainError && typeof (error.details as { reason?: unknown } | undefined)?.reason === 'string'
        ? (error.details as { reason: string }).reason : undefined,
      // Source locations only (no message text) so unclassified failures stay diagnosable.
      at: rawError instanceof Error && !(rawError instanceof DomainError) ? (rawError.stack ?? '').split('\n')
        .filter(line => line.trimStart().startsWith('at ')).slice(0, 4)
        .map(line => line.replace(/^.*?(\/dist\/|\/src\/)/, '').replace(/[()]/g, '').trim()) : undefined },
    'Workflow native execution failed')
    if (observation.execution.state === 'completed' && !observation.signal.aborted) {
      input.owner.assertOwned()
      throw error
    }
    if (!observation.signal.aborted && error instanceof HarnessExecutionError
      && error.result.error?.code === 'CODEX_OBSERVER_UNAVAILABLE') {
      input.owner.assertOwned()
      throw new DomainError('CODEX_OBSERVER_UNAVAILABLE', error.message, 503)
    }
    if (error instanceof DomainError && error.code === 'APPROVAL_SETTLEMENT_PENDING' && !observation.signal.aborted) {
      input.owner.assertOwned()
      // Waiting for durable proof is not active model time or a reason to
      // close the requester/credential needed by the exact delivery retry.
      try { await this.budgets.beginWait(observation.execution.id) }
      catch {
        input.owner.assertOwned()
        throw new DomainError('APPROVAL_SETTLEMENT_PENDING',
          'Exact approval settlement is pending and its budget pause could not be confirmed. Reconcile the same execution; no native work was replayed.', 409)
      }
      input.owner.assertOwned()
      throw error
    }
    // A created session with no offered turn cannot recover by observing a turn.
    // Close its original manager before recording failure; possible submissions remain recoverable.
    const sessionWithoutTurn = observation.repeatLaunch && observation.ownedSession?.session && !observation.nativeTurnOffered
    const activeTimeout = error instanceof DomainError && error.code === 'EXECUTION_ACTIVE_TIMEOUT'
    // A persisted budget check can detect expiry before the deadline timer fires.
    // Only a non-waiting attempt is abandoned for a transient failure; a waiting one is recovered, never fenced for it.
    if (!observation.signal.aborted && !activeTimeout && !(rawError instanceof HarnessExecutionError)
      && !sessionWithoutTurn && !(isTransientExecutionError(error) && observation.execution.state !== 'waiting')) {
      input.owner.assertOwned()
      if (repeatPhysicalSettlementPending(error)) await this.budgets.beginWait(observation.execution.id)
      input.owner.assertOwned()
      throw error
    }
    if ((observation.resolved! && !observation.manager!) || isLeaseLost(rawError)
      || (error instanceof DomainError && error.code === 'SESSION_LANE_BUSY')) throw error
    // Restart's cleanup intent can reject SQL preflight before it observes the abort.
    const restarting = observation.signal.reason instanceof DomainError && observation.signal.reason.code === 'ENGINE_RESTART'
    if (restarting) throw error
    let held = true
    try { input.owner.assertOwned() } catch { held = false }
    if (sessionWithoutTurn && held) {
      const stored = (await repeat.readExecution(observation.execution.id)).execution
      assertSameRepeatExecution(observation.ensured.execution, stored)
      observation.ownedSession!.execution = stored
    }
    if (observation.execution.state === 'completed' && (!observation.ownedSession! || this.closedExecutions.has(observation.execution.id))) throw error
    // A transient transport error abandons only this attempt so its node can
    // retry. Any other failure fences the Run, closes the captured manager,
    // then lets the repository prove a negative disposition.
    if (held) {
      let code = 'NATIVE_EXECUTION_FAILED'
      if (error instanceof HarnessExecutionError) code = error.result.error?.code ?? code
      if (error instanceof DomainError) code = error.code
      componentLogger('harness').warn({ executionId: observation.execution.id, code, err: error },
        'Workflow native execution failed before cleanup')
      let failure: ExecutionResult | undefined
      const failedRestartAttachment = observation.restartRecovery && observation.ownedSession?.openingFailed
      if (activeTimeout) {
        failure = { outcome: 'failed', error: { code: error.code, message: error.message, retryable: false } }
      } else if (!observation.signal.aborted && !failedRestartAttachment
        && error instanceof HarnessExecutionError && error.result.error) {
        // A closed transport is a failed observation, not a retryable native terminal.
        failure = { outcome: 'failed', error: { ...error.result.error, retryable: false } }
      }
      const persist = <T>(work: () => Promise<T>) =>
        retryDatabaseTimeout(work, { check: () => input.owner.assertOwned() })
      // A late failure of an attempt that another path abandoned or already settled never affects the Run.
      const abandoned = observation.signal.reason instanceof DomainError && observation.signal.reason.code === 'EXECUTION_ABANDONED'
      if (abandoned || !observation.signal.aborted
        && (await persist(() => repeat.readExecution(observation.execution.id))).execution.state === 'completed') {
        if (observation.ownedSession && !observation.ownedSession.failed) {
          observation.ownedSession.failed = true
          const failures = await this.cleanupSession(observation.ownedSession)
          if (failures.length) componentLogger('harness').warn({ executionId: observation.execution.id,
            failures: failures.length }, 'Closing a settled attempt remains unconfirmed')
        }
        throw error
      }
      if (repeatTickIndex(observation.execution.input) !== undefined && !input.signal.aborted) {
        await persist(() => this.failIntervalCheck(input.owner, observation.execution, failure))
        throw error
      }
      if (!input.signal.aborted && !activeTimeout && observation.execution.state !== 'waiting'
        && isTransientExecutionError(error)) {
        // Infrastructure failure: close this attempt alone; its node starts a fresh one.
        observation.resolved?.markFailed?.()
        // The stored attempt, not the in-memory copy, which may hold an unpublished session.
        await persist(async () => {
          const execution = (await repeat.readExecution(observation.execution.id)).execution
          const startInterrupted = !execution.nativeSessionId && ['queued', 'starting'].includes(execution.state)
          const fallbackCode = startInterrupted ? 'EXECUTION_START_INTERRUPTED' : 'NATIVE_EXECUTION_FAILED'
          await this.abandonAttempt(input.owner, execution, transientExecutionFailure(error, fallbackCode))
        })
        throw error
      }
      await persist(() => this.runs.requestCleanup(observation.execution.runId, input.owner, failure,
        failure ? { executionId: observation.execution.id } : undefined))
      if (observation.ownedSession!) {
        observation.resolved?.markFailed?.()
        observation.ownedSession!.failed = true
        const failures = await this.cleanupSession(observation.ownedSession!)
        // The caught error may contain provider secrets; retain only its sanitized form.
        if (failures.length) throw new AggregateError(failures, 'Original native closure is still pending.', { cause: error })
      }
      await persist(() => this.budgets.stop(observation.execution.id))
      await persist(async () => (await this.runs.repeat(input.owner)).settleNegativeExecution(observation.execution.id,
        (await this.runs.getRepeatSnapshot(observation.execution.runId, input.owner)).stopRequested))
    } else if (observation.ownedSession!) {
      // An old owner may dispose its own captured transport only. It cannot
      // revoke a successor's credential, budget or execution authority.
      const owned = observation.ownedSession!
      const failures: Error[] = []
      await attemptCleanup(failures, 'close lost-owner transport', async signal => {
        if (owned.session) await this.closeWorkflowSession(owned, { restart: true, signal })
        else await owned.manager.dispose(signal)
      }, owned.context.acceptedPlacement?.hostRef.kind === 'device' ? { timeoutMs: deviceRequestTimeoutMs } : {})
      if (!failures.length) await this.forgetLostOwnerSession(owned)
    }
    throw error
  }

  /** The successor owner re-enters through the durable detachment like a restart:
   * a fresh manager attaches the same native session under a new lifetime
   * generation. A resident kept here would replay the detached generation. */
  private async forgetLostOwnerSession(owned: OwnedNativeSession): Promise<void> {
    if (this.ownedSessions.get(owned.execution.id) !== owned) return
    await owned.stopWaitingRenewal?.()
    if (this.ownedSessions.get(owned.execution.id) !== owned) return
    this.ownedSessions.delete(owned.execution.id)
    this.managerCredentials.delete(owned.manager)
    this.managers.release?.(owned.context, this.rawManagers.get(owned.manager) ?? owned.manager, 'released')
  }

}
