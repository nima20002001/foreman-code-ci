import { beginRuntimeTiming, runtimeTimingPoint, withRuntimeTimingContext } from '../../infrastructure/runtimeTiming.js'
import { resolve } from 'node:path'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import type { DurableInteraction } from '@foreman-code/contracts'
import { CurrentRunVersionSnapshotSchema, ExecutableWorkflowV3Schema,
  type WorkflowRunV3 } from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'
import { assertNativeWorkflowConfiguration } from '../harnesses/nativeWorkflowConfiguration.js'
import type { ExecutionCredentialProvider } from '../harnesses/mcpDetection.js'
import type { ApprovalExecutionCoordinator } from '../interactions/execution.js'
import type { PostgresInteractionRepository } from '../interactions/postgres.js'
import type { GraphResumeClaim } from '../interactions/deliveryPostgres.js'
import { hasRecoveredWorkflowNativeLifetime } from '../interactions/workflowClosure.js'
import { withCleanupDeadline } from '../interactions/cleanup.js'
import type { PostgresWorkflowRepository } from '../workflows/postgres.js'
import { requiredLocationAccess, type WorkspaceLocationService } from '../workspaces/location.js'
import { executeRepeatEngineStart } from './repeatStartComposition.js'
import { repeatSettlementPending } from './repeatRuntime.js'
import { readWorkflowCheckpoint } from './repeatGraph.js'
import { hasWorkDirectionWait, persistWorkDirectionWait, recordWorkflowExecutionFailure,
  persistWorkflowApprovalWait, settleWorkForRestart, settleWorkflowRun } from './workflowLifecycle.js'
import { consumeDeliveredApprovals, type WorkflowResumePermit } from './approvalCheckpointResume.js'
import type { AuthorizeWorkflowStop } from './repeatLifecycle.js'
import type { PostgresRunRepository } from './postgres.js'
import type { RunOwnership } from './ownership.js'
import { RunnerAdmission } from './runnerAdmission.js'
import { componentLogger } from '../diagnostics/logger.js'
import { isAtomicApprovalCheckpointSaver } from '../../infrastructure/approvalCheckpointSaver.js'
import type { WorkflowRestartApprovals } from './workflowRepositoryServices.js'
import { readRunAcceptedPlacements } from '../placement/persistence.js'
import { ignoreError } from '../diagnostics/ignoredError.js'
import { executionFailureClass } from './executionRetryPolicy.js'

/** One engine, Run owner, checkpoint thread and repository for all current V3
 * graphs. Optional bounded blocks are compiled into this same LangGraph; an
 * ordinary graph has no block/round/carry/decision storage. There is no legacy
 * dispatcher, retagging, second scheduler, or caller-supplied runtime binding. */
export class LangGraphWorkflowEngine {
  private readonly workerAdmission: RunnerAdmission
  private readonly configuredParallelism: number
  private readonly maximumActiveRuns: number
  private readonly activeRuns = new Map<string, AbortController>()
  private readonly activeOwners = new Map<string, RunOwnership>()
  private readonly activeTasks = new Map<string, Promise<void>>()
  private readonly resumeTasks = new Map<string, Promise<void>>()
  private readonly cleanupTasks = new Map<string, Promise<boolean>>()
  private readonly workspaceRoot: string
  private closing = false
  private reconciliation: Promise<void> | undefined
  private shutdownTask: Promise<void> | undefined
  private restartIntent: Promise<void> | undefined
  private restartClosure: Promise<void> | undefined
  private readonly restartPreservedOwners = new WeakSet<RunOwnership>()

  constructor(
    private readonly runs: PostgresRunRepository,
    private readonly workflows: PostgresWorkflowRepository,
    private readonly nativeExecutions: ApprovalExecutionCoordinator,
    private readonly checkpointer: BaseCheckpointSaver,
    workspaceRoot: string,
    private readonly locations: WorkspaceLocationService,
    private readonly workerCredentials: ExecutionCredentialProvider,
    private readonly interactions: PostgresInteractionRepository,
    private readonly onRunTerminal?: (runId: string, reason: string) => Promise<void>,
    limits: { workerParallelism?: number; maximumWaiting?: number; maximumActiveRuns?: number } = {},
    private readonly jobComposition?: NonNullable<import('./repeatStartComposition.js').RepeatEngineStartContext['jobs']>,
  ) {
    this.workspaceRoot = resolve(workspaceRoot)
    this.configuredParallelism = limits.workerParallelism ?? 4
    this.maximumActiveRuns = limits.maximumActiveRuns ?? 32
    this.workerAdmission = new RunnerAdmission(this.configuredParallelism, limits.maximumWaiting ?? 1000, this.maximumActiveRuns)
    this.runs.repeatRepositoryFactory()
    if (!this.interactions || !this.nativeExecutions || !this.checkpointer) throw new DomainError(
      'WORKFLOW_RUNTIME_COMPOSITION_REQUIRED', 'The current production workflow runtime is incomplete.', 503)
  }

  assertCurrentProduction(runs: PostgresRunRepository, workflows: PostgresWorkflowRepository,
    native: ApprovalExecutionCoordinator, checkpointer: BaseCheckpointSaver): void {
    if (this.runs !== runs || this.workflows !== workflows || this.nativeExecutions !== native
      || this.checkpointer !== checkpointer || !this.interactions || !this.workerCredentials) throw new DomainError(
      'CURRENT_ENGINE_COMPOSITION_REQUIRED', 'The current engine must retain the actual native, repository and checkpoint ports.', 503)
    runs.repeatRepositoryFactory()
  }
  acceptsCurrentWork(): boolean { return !this.closing }

  start(runId: string): Promise<void> {
    const existing = this.resumeTasks.get(runId) ?? this.activeTasks.get(runId)
    runtimeTimingPoint('engine', 'run.start', { runId, reused: existing !== undefined })
    if (existing) return existing
    return this.trackRun(runId, (controller) => this.drive(runId, controller))
  }

  private trackRun(runId: string, work: (controller: AbortController) => Promise<void>): Promise<void> {
    if (this.closing) return Promise.reject(new DomainError('ENGINE_CLOSING', 'The workflow engine is shutting down.', 503))
    if (this.activeTasks.has(runId)) return this.activeTasks.get(runId)!
    if (this.activeTasks.size >= this.maximumActiveRuns) return Promise.reject(new DomainError(
      'RUNNER_ADMISSION_FULL', 'The runner is at its active Run limit. Durable queued work was not launched.', 503))
    const controller = new AbortController()
    this.activeRuns.set(runId, controller)
    // Publish before dispatch, so Stop can abort even owner acquisition/preflight.
    const finished = beginRuntimeTiming('engine', 'run.drive', { runId })
    const task = Promise.resolve().then(() => withRuntimeTimingContext({ runId }, () => work(controller))).finally(() => {
      finished()
      if (this.activeRuns.get(runId) === controller) this.activeRuns.delete(runId)
      if (this.activeTasks.get(runId) === task) this.activeTasks.delete(runId)
    })
    this.activeTasks.set(runId, task)
    return task
  }

  resume(runId: string): Promise<void> { return this.queueResume(runId) }

  async prepareInteraction(interaction: DurableInteraction): Promise<void> {
    if (this.closing) throw new DomainError('ENGINE_CLOSING', 'The workflow engine is shutting down.', 503)
    if (interaction.runId !== interaction.graphThreadId) throw new DomainError(
      'INTERACTION_RUN_MISMATCH', 'Approval preparation must name its original Run checkpoint.', 409)
    if (this.nativeExecutions.hasOriginalRequester(interaction)) return
    // Join the existing recovery task before recording a decision that changes its pending-source classification.
    await this.start(interaction.runId)
    if (!this.nativeExecutions.hasOriginalRequester(interaction)) throw new DomainError(
      'NATIVE_SESSION_RECOVERY_REQUIRED', 'The original requester has not recovered from its saved checkpoint.', 409)
  }

  resumeInteraction(interaction: DurableInteraction, claim?: GraphResumeClaim): Promise<void> {
    // Notifications select only; the real current checkpoint is re-read below.
    if (!interaction.runId || interaction.runId !== interaction.graphThreadId) return Promise.reject(new DomainError(
      'INTERACTION_RUN_MISMATCH', 'Resume must name one exact Run checkpoint.', 409))
    return this.queueResume(interaction.runId, [interaction.id], claim)
  }

  private queueResume(runId: string, requestedIds?: readonly string[], claim?: GraphResumeClaim): Promise<void> {
    if (this.closing) return Promise.reject(new DomainError('ENGINE_CLOSING', 'The workflow engine is shutting down.', 503))
    const ids = requestedIds ? [...requestedIds] : undefined
    const owner = this.activeOwners.get(runId)
    if (claim && owner && this.activeTasks.has(runId)) {
      return this.consumeActiveApproval(owner, claim, ids, this.activeRuns.get(runId)!.signal)
    }
    const previous = this.resumeTasks.get(runId) ?? this.activeTasks.get(runId) ?? Promise.resolve()
    const task = previous.catch(() => { /* ignore: the previous caller receives its failure; the queue must still admit the next operation. */ }).then(() =>
      this.trackRun(runId, (controller) => this.drive(runId, controller, ids, claim)),
    ).finally(() => { if (this.resumeTasks.get(runId) === task) this.resumeTasks.delete(runId) })
    this.resumeTasks.set(runId, task)
    return task
  }

  private async consumeActiveApproval(owner: RunOwnership, claim: GraphResumeClaim,
    requestedIds: readonly string[] | undefined, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (requestedIds && !requestedIds.includes(claim.interaction.id)) throw new DomainError(
      'GRAPH_INTERRUPT_NOT_CURRENT', 'The resume claim differs from the notified interaction.', 409)
    // Consume the persisted interrupt without invoking a second graph over active siblings.
    await consumeDeliveredApprovals(owner, this.checkpointer, this.interactions, [claim.interaction], claim,
      async (sql, run) => {
        signal.throwIfAborted()
        await this.authorize(sql, run)
        signal.throwIfAborted()
      })
    signal.throwIfAborted()
    const continuation = this.queueResume(owner.runId, requestedIds)
    void continuation.catch((error: unknown) => {
      componentLogger('engine').error({ err: error }, 'approval continuation failed')
    })
  }

  private async drive(runId: string, controller: AbortController, requestedIds?: readonly string[],
    claim?: GraphResumeClaim): Promise<void> {
    const acquired = beginRuntimeTiming('engine', 'run.acquire_owner', { runId })
    const owner = await this.runs.acquireOwnership(runId, () => controller.abort(new DomainError(
      'RUN_OWNERSHIP_LOST', 'The database execution owner disconnected.', 409))).finally(acquired)
    if (!owner) throw new DomainError('RUN_ALREADY_OWNED', 'This Run is owned by another engine.', 409)
    this.activeOwners.set(runId, owner)
    let runtimeEntered = false
    let stopObservingInterrupts: (() => void) | undefined
    let stopSharingOwner: (() => void) | undefined
    try {
      owner.assertOwned(); controller.signal.throwIfAborted()
      stopSharingOwner = this.nativeExecutions.shareRunOwner(owner)
      let snapshot = await this.runs.getRepeatSnapshot(runId, owner)
      if (snapshot.stopRequested || snapshot.cleanupPending || snapshot.run.executionState === 'completed') {
        await this.cleanupOwned(owner)
        return
      }
      if (!['queued', 'running', 'waiting'].includes(snapshot.run.executionState)) throw new DomainError(
        'RUN_NOT_RESUMABLE', 'This Run requires Stop settlement or a separately authorized new Run.', 409)
      if (snapshot.run.executionState === 'waiting' && snapshot.version.definition.handoffs
        && await hasWorkDirectionWait(owner)) {
        await persistWorkDirectionWait(owner, this.locations)
        const store = await this.runs.repeat(owner)
        if (await store.completeWorkRun() === 'needs_direction') return
        await this.nativeExecutions.finishRun(runId)
        await this.runs.finishCleanup(runId, false, owner)
        await this.finishOwned(owner)
        return
      }
      const checkpoint = await readWorkflowCheckpoint(runId, snapshot.version, this.checkpointer)
      if (checkpoint.values.runId && checkpoint.values.runId !== runId) throw new DomainError('RUN_PIN_CONFLICT', 'The checkpoint belongs to another Run.', 409)
      const current = checkpoint.tasks.some((task) => task.interrupts?.length)
        ? await persistWorkflowApprovalWait(owner, this.checkpointer, checkpoint) : []
      if (await this.nativeExecutions.requestColdRunCleanup(owner, current, controller.signal)) {
        await this.cleanupOwned(owner)
        return
      }
      let permit: WorkflowResumePermit | undefined
      if (checkpoint.tasks.some((task) => task.interrupts?.length)) {
        owner.assertOwned(); controller.signal.throwIfAborted()
        if (requestedIds && !current.some((item) => requestedIds.includes(item.id))) return
        const delivered = current.filter((item) => item.status === 'delivered' && item.deliveryState === 'delivered')
        if (!delivered.length) return
        permit = await consumeDeliveredApprovals(owner, this.checkpointer, this.interactions, delivered, claim,
          (sql, run) => this.authorize(sql, run))
        if (!permit) return
        snapshot = await this.runs.getRepeatSnapshot(runId, owner)
      } else if (snapshot.run.executionState === 'waiting') {
        throw new DomainError('GRAPH_INTERRUPT_NOT_CURRENT', 'A waiting Run has no matching durable approval checkpoint.', 409)
      } else if (requestedIds) return
      owner.assertOwned(); controller.signal.throwIfAborted()
      const { run } = snapshot
      runtimeEntered = true
      if (isAtomicApprovalCheckpointSaver(this.checkpointer)) {
        const version = snapshot.version
        stopObservingInterrupts = this.checkpointer.observeApprovalInterrupts(runId, async () => {
          owner.assertOwned()
          controller.signal.throwIfAborted()
          const checkpoint = await readWorkflowCheckpoint(runId, version, this.checkpointer)
          await persistWorkflowApprovalWait(owner, this.checkpointer, checkpoint)
          owner.assertOwned()
          controller.signal.throwIfAborted()
        })
      }
      await executeRepeatEngineStart({ owner, signal: controller.signal,
        limiter: this.nativeExecutions.executionCapacity(runId, snapshot.version.definition.executionPolicy!.maxParallelism),
        checkpointer: this.checkpointer, admission: this.workerAdmission,
        configuredParallelism: this.configuredParallelism, runtimeRoot: this.workspaceRoot,
        factory: this.runs.repeatRepositoryFactory(), native: this.nativeExecutions,
        ...(this.jobComposition ? { jobs: this.jobComposition } : {}),
        workflows: this.workflows, locations: this.locations,
        nativeBoundaryEvidence: (id) => this.nativeExecutions.nativeBoundaryEvidence(id, owner),
        lifecycle: {
          preflight: async () => {
            owner.assertOwned(); controller.signal.throwIfAborted()
            const current = await this.runs.getRepeatSnapshot(runId, owner)
            ExecutableWorkflowV3Schema.parse({ version: current.version, configurations: current.configurations })
            for (const configuration of current.configurations) assertNativeWorkflowConfiguration(configuration.harness, run.approval,
              run.approval.handler === 'orchestrator' && configuration.agentId === run.approval.designatedOrchestratorAgentId)
            await this.locations.revalidateRunAuthorization(run.authorizationPrincipalId, run.workspaceId, run.workflowId, owner.client)
            const nodes = current.version.definition.nodes
            const expectsPlacements = nodes.some(node => node.kind !== 'job' && (node.placement || node.artifactOutputs))
            const placements = expectsPlacements ? await readRunAcceptedPlacements(owner.client, run.id) : []
            const allNodesPlaced = placements.length === nodes.length && nodes.every(node => node.kind !== 'job'
              && placements.some(pin => pin.nodeId === node.id && pin.payload.kind === 'agent'
                && pin.payload.agentId === node.agentId
                && pin.payload.agentConfigurationVersionId === run.agentConfigurationVersionIds[node.agentId]))
            if (expectsPlacements && nodes.every(node => node.kind !== 'job') && !allNodesPlaced) {
              throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'The Run is missing its accepted Agent placements.', 409)
            }
            if (!allNodesPlaced) {
              await this.locations.revalidateSnapshot(run.workspaceId, run.executionLocation,
                requiredLocationAccess(current.configurations), controller.signal)
            }
            owner.assertOwned(); controller.signal.throwIfAborted()
          },
          markRunning: () => this.runs.updateState(runId, { executionState: 'running', outcome: 'pending',
            startedAt: run.startedAt ?? new Date().toISOString() }, owner, permit),
          currentState: async () => {
            const current = await this.runs.getRepeatSnapshot(runId, owner)
            return { executionState: current.run.executionState, stopRequested: current.stopRequested,
              cleanupPending: current.cleanupPending }
          },
          persistWait: async (current) => {
            const waiting = (await persistWorkflowApprovalWait(owner, this.checkpointer, current)).length > 0
            // A finished graph needs retained reviewer closure before the Run completion transaction.
            if (!waiting && !current.next.length && !snapshot.version.definition.handoffs) {
              await this.nativeExecutions.finishIdleReviewers(runId, owner, controller.signal)
            }
            return waiting
          },
          persistDirectionWait: () => persistWorkDirectionWait(owner, this.locations),
          recordExecutionFailure: (executionId, failure) => recordWorkflowExecutionFailure(owner, executionId, failure),
          cancelNativeAndRequestCleanup: async () => {
            await this.runs.requestCleanup(runId, owner)
            try { await this.nativeExecutions.cancelRun(runId, owner); return true } catch { return false }
          },
          settleRun: async () => { await this.cleanupOwned(owner) },
          requestCleanup: (failure) => this.runs.requestCleanup(runId, owner, failure),
          finishNative: () => this.nativeExecutions.finishRun(runId),
          finishCleanup: () => this.runs.finishCleanup(runId, false, owner),
        },
      })
      if ((await this.runs.getRepeatSnapshot(runId, owner)).run.executionState === 'completed') await this.finishOwned(owner)
    } catch (error) {
      owner.assertOwned(); controller.signal.throwIfAborted()
      // A selected node that failed after its settlement is the Run's failed outcome, not a start error.
      if (runtimeEntered && error instanceof DomainError
        && ['GRAPH_STOP_CONFLICT', 'WORKFLOW_SELECTED_EXECUTION_FAILED'].includes(error.code)) {
        const current = await this.runs.getRepeatSnapshot(runId, owner)
        if (current.run.executionState === 'completed') {
          await this.cleanupOwned(owner)
          return
        }
      }
      // Only an entered runtime may yield settlement to existing recovery. In
      // particular, NEVER turn a pre-consume/claim/COMMIT failure into a void
      // successful resume callback (which would have no graph.resume receipt).
      if (!runtimeEntered || !repeatSettlementPending(error)) throw error
      const current = await this.runs.getRepeatSnapshot(runId, owner)
      if (current.stopRequested || current.cleanupPending
        || !['running', 'waiting'].includes(current.run.executionState)) throw error
      // The exact task/error and native lifetime remain durable/resident. A
      // consumed approval is not callback failure merely because cleanup or a
      // sibling reviewer still needs to finish; reconcile() retries this thread.
      this.deferReconciliation(runId, error)
    } finally {
      stopObservingInterrupts?.()
      // Shutdown publishes this barrier before queuing cleanup SQL. A drive may
      // finish naturally during that write; its owner must remain usable. A
      // failed intent retains the owner for the same shutdown retry.
      if (this.restartIntent) await this.restartIntent
      // Keep the owner usable for the same closure retry; shutdown drains this drive separately.
      if (this.restartClosure) await this.restartClosure
      // Drains in-flight G1 writes. Old captures cannot write after release.
      if (this.activeOwners.get(runId) === owner) this.activeOwners.delete(runId)
      stopSharingOwner?.()
      await owner.release()
    }
  }

  private authorize(sql: import('../run-graph/connection.js').GraphTransactionSql, run: WorkflowRunV3): Promise<void> {
    if (!run.authorizationPrincipalId) throw new DomainError('RUN_AUTHORIZATION_REVOKED', 'The accepted Run authority is missing.', 403)
    return this.locations.revalidateRunAuthorization(run.authorizationPrincipalId, run.workspaceId, run.workflowId, sql)
  }

  private async cleanupOwned(owner: RunOwnership): Promise<void> {
    const finished = beginRuntimeTiming('engine', 'run.cleanup', { runId: owner.runId })
    try {
      owner.assertOwned()
      this.nativeExecutions.adoptRunOwner(owner)
      const snapshot = await this.runs.getRepeatSnapshot(owner.runId, owner)
      if (!snapshot.stopRequested && !snapshot.cleanupPending && snapshot.run.executionState !== 'completed') throw new DomainError(
        'GRAPH_STOP_CONFLICT', 'Cleanup requires the committed negative or terminal fence.', 409)
      // A settled terminal Run has no pending resources, regardless of its outcome.
      const cleanupRequired = snapshot.cleanupPending || snapshot.run.executionState !== 'completed'
      if (cleanupRequired) {
        await this.runs.requestCleanup(owner.runId, owner)
      }
      try {
        if (cleanupRequired && (snapshot.run.executionState !== 'completed'
          || snapshot.stopRequested || snapshot.run.outcome !== 'succeeded')) {
          await this.nativeExecutions.cancelRun(owner.runId, owner)
          await settleWorkflowRun(owner, await hasRecoveredWorkflowNativeLifetime(owner), this.runs.memoryBoards)
        } else await this.nativeExecutions.finishRun(owner.runId)
        await this.finishOwned(owner)
      } catch (error) {
        await this.runs.finishCleanup(owner.runId, true, owner).catch(ignoreError('engine', 'record failed run cleanup', { runId: owner.runId }))
        throw error
      }
    } finally { finished() }
  }

  private async finishOwned(owner: RunOwnership, reason = 'The Run stopped or completed.'): Promise<void> {
    const finished = beginRuntimeTiming('engine', 'run.finish', { runId: owner.runId })
    try {
      const current = await this.runs.getRepeatSnapshot(owner.runId, owner)
      if (current.run.executionState !== 'completed') throw new DomainError('GRAPH_TERMINAL_CONFLICT', 'The Run has not settled.', 409)
      this.nativeExecutions.adoptRunOwner(owner)
      await this.nativeExecutions.finishRun(owner.runId)
      await this.onRunTerminal?.(owner.runId, reason)
      await this.runs.finishCleanup(owner.runId, false, owner)
    } finally { finished() }
  }

  async finishRunLifecycle(runId: string, reason = 'The Run stopped or completed.'): Promise<void> {
    const owner = await this.runs.acquireOwnership(runId, () => undefined)
    if (!owner) throw new DomainError('RUN_ALREADY_OWNED', 'The existing Run owner must finish cleanup.', 409)
    try { await this.finishOwned(owner, reason) } finally { await owner.release() }
  }

  /** Supply the SQL Stop authorizer or ALREADY commit the authorized Stop/cleanup
   * intent. A cleanup callback return never substitutes for settlement proof. */
  async cancel(runId: string, authorize?: AuthorizeWorkflowStop): Promise<boolean> {
    if (authorize) await this.runs.requestStop(runId, authorize)
    const initial = await this.runs.getRepeatSnapshot(runId)
    if (!initial.stopRequested && !initial.cleanupPending && initial.run.executionState !== 'completed') throw new DomainError(
      'REPEAT_STOP_AUTHORIZATION_REQUIRED', 'Commit the authorized Stop before native cancellation.', 409)
    const existing = this.cleanupTasks.get(runId)
    if (existing) return existing
    this.activeRuns.get(runId)?.abort(new DomainError('GRAPH_STOP_CONFLICT', 'The Run has a durable Stop or cleanup request.', 409))
    const task = (async () => {
      const physical = initial.run.executionState === 'completed' && initial.run.outcome === 'succeeded'
        && !initial.stopRequested ? this.nativeExecutions.finishRun(runId) : this.nativeExecutions.cancelRun(runId)
      const active = this.activeTasks.get(runId)
      const resumed = this.resumeTasks.get(runId)
      await Promise.allSettled([physical, ...(active ? [active] : []), ...(resumed ? [resumed] : [])])
      const owner = await this.runs.acquireOwnership(runId, () => undefined)
      if (!owner) return false
      try {
        await this.cleanupOwned(owner)
        const final = await this.runs.getRepeatSnapshot(runId, owner)
        return final.run.executionState === 'completed' && !final.cleanupPending
      } finally { await owner.release() }
    })().finally(() => { if (this.cleanupTasks.get(runId) === task) this.cleanupTasks.delete(runId) })
    this.cleanupTasks.set(runId, task)
    return task
  }

  /** Bounded current recovery. Never reset an existing checkpoint to initial state. */
  private reconcileCursor = ''
  private readonly reconciliationRetries = new Map<string, { delayMs: number; retryAt: number; failures: number }>()
  private deferReconciliation(runId: string, error: unknown): { permanent: boolean; failures: number } {
    const retry = this.reconciliationRetries.get(runId)
    const delayMs = Math.min((retry?.delayMs ?? 500) * 2, 60_000)
    const permanent = executionFailureClass(error) === 'permanent'
      && !(error instanceof DomainError && error.status >= 500)
    const failures = (retry?.failures ?? 0) + (permanent ? 1 : 0)
    this.reconciliationRetries.set(runId, { delayMs, retryAt: Date.now() + delayMs, failures })
    return { permanent, failures }
  }

  /** Transient recovery failures retry forever with backoff. After this many permanent ones the Run gets a failed
   * cleanup request carrying the real cause, and the next sweep settles it through the ordinary cleanup path. */
  private static readonly permanentReconciliationFailures = 10
  reconcile(onError: (error: unknown) => void = (error) => componentLogger('engine').error({ err: error }, 'run reconciliation failed')): Promise<void> {
    runtimeTimingPoint('engine', 'reconcile.request', { reused: this.reconciliation !== undefined })
    if (this.reconciliation) return this.reconciliation
    if (this.closing) return Promise.resolve()
    const finished = beginRuntimeTiming('engine', 'reconcile.pass')
    const task = (async () => {
      await this.workerCredentials.reconcileTerminalCredentials?.().catch(onError)
      await this.nativeExecutions.reconcileWorkflowControls(onError)
      await this.nativeExecutions.reconcileReviews(onError)
      // Fair sweep: a capacity-limited pass resumes after the last candidate it
      // handled, wrapping once, so a persistently unresolved prefix cannot starve
      // later Runs.
      const start = this.reconcileCursor
      let after = start, wrapped = start === ''
      sweep: while (!this.closing) {
        const page = await this.runs.reconciliationCandidates(after, 100)
        for (const candidate of page) {
          if (this.closing) break sweep
          if (wrapped && start !== '' && candidate.id > start) break sweep
          if (this.activeTasks.has(candidate.id) || this.resumeTasks.has(candidate.id) || this.cleanupTasks.has(candidate.id)) { after = candidate.id; continue }
          const retry = this.reconciliationRetries.get(candidate.id)
          if (retry && Date.now() < retry.retryAt) { after = candidate.id; continue }
          if (this.activeTasks.size >= this.maximumActiveRuns) { this.reconcileCursor = after; return }
          after = candidate.id
          void this.start(candidate.id).then(() => {
            // A successful callback may have yielded settlement and scheduled its next retry.
            if (this.reconciliationRetries.get(candidate.id) === retry) this.reconciliationRetries.delete(candidate.id)
          }).catch(error => {
            // A retained reviewer can own the Run between engine passes; retry on the next sweep.
            if (error instanceof DomainError && error.code === 'RUN_ALREADY_OWNED') return
            // A joined drive ends this way on Stop; the Stop and cleanup path settles the Run.
            if (error instanceof DomainError && error.code === 'GRAPH_STOP_CONFLICT') return
            if (this.closing && error instanceof DomainError && error.code === 'ENGINE_RESTART') return
            const { permanent, failures } = this.deferReconciliation(candidate.id, error)
            onError(error)
            if (permanent && failures % LangGraphWorkflowEngine.permanentReconciliationFailures === 0) {
              return this.failUnrecoverable(candidate.id, error).catch(onError)
            }
          })
        }
        if (page.length < 100) {
          if (wrapped) break
          wrapped = true; after = ''
        }
      }
      this.reconcileCursor = ''
    })().finally(() => { finished(); if (this.reconciliation === task) this.reconciliation = undefined })
    this.reconciliation = task
    return task
  }

  private async failUnrecoverable(runId: string, error: unknown): Promise<void> {
    const owner = await this.runs.acquireOwnership(runId, () => undefined)
    if (!owner) return
    try {
      await this.runs.requestCleanup(runId, owner, { outcome: 'failed', error: {
        code: error instanceof DomainError ? error.code : 'RUN_RECOVERY_FAILED',
        message: (error instanceof Error && error.message ? error.message : 'Run recovery failed.').slice(0, 2_000),
        retryable: false } })
    } finally { await owner.release() }
  }

  /** Graceful restart is NOT Stop. Original transport close receipts precede
   * ownership release. Unknown closure fails shutdown, not the Run's history. */
  shutdown(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask
    this.closing = true
    const reason = new DomainError('ENGINE_RESTART', 'The engine is preserving the current checkpoint for restart.', 409)
    this.shutdownTask = (async () => {
      // Retain each actual Run owner until its durable stop-only cleanup intent
      // commits. Failed persistence must not authorize a Job abort or close.
      this.restartIntent = Promise.resolve().then(async () => {
        const intents = await Promise.allSettled([...this.activeOwners.entries()].map(async ([runId, owner]) => {
          if (this.activeOwners.get(runId) === owner) {
            const { accepted, approvals } = await withCleanupDeadline(async () => {
              const run = await this.runs.get(runId)
              const version = run && await this.workflows.getVersion(run.workflowVersionId)
              const accepted = CurrentRunVersionSnapshotSchema.parse({ run, version })
              let approvals: WorkflowRestartApprovals | undefined
              if (accepted.version.definition.handoffs) {
                const checkpoint = await readWorkflowCheckpoint(runId, accepted.version, this.checkpointer)
                const interactions = checkpoint.tasks.some(task => task.interrupts?.length)
                  ? await persistWorkflowApprovalWait(owner, this.checkpointer, checkpoint) : []
                if (interactions.length && isAtomicApprovalCheckpointSaver(this.checkpointer)) {
                  approvals = { saver: this.checkpointer, interactions }
                }
              }
              return { accepted, approvals }
            })
            // Decide before cancellation drains observation; reuse that decision
            // for closure retries under the same Run owner.
            // Startup has its own bounded wait; it must not consume the cleanup intent's deadline.
            const preserved = this.restartPreservedOwners.has(owner)
              || await this.nativeExecutions.preserveActiveForRestart(owner)
            await withCleanupDeadline(async () => {
              if (preserved) this.restartPreservedOwners.add(owner)
              // Freeze handoff tasks before classifying their queued reservations.
              // These tasks do not abort Jobs, which require the cleanup fence first.
              if (accepted.version.definition.handoffs) this.activeRuns.get(runId)?.abort(reason)
              if (!preserved) await this.requestRestartCleanup(owner, approvals)
            })
          }
        }))
        const intentErrors = intents.flatMap((item) => item.status === 'rejected' ? [item.reason] : [])
        if (intentErrors.length) throw new AggregateError(intentErrors, 'Workflow restart cleanup intent remains unconfirmed.')
      })
      await this.restartIntent
      this.restartClosure = this.nativeExecutions.closeForRestart()
      for (const controller of this.activeRuns.values()) controller.abort(reason)
      const outcomes = await Promise.allSettled([
        this.restartClosure,
        withCleanupDeadline(async () => { await Promise.allSettled([...this.activeTasks.values(), ...this.resumeTasks.values()]) }),
        ...this.cleanupTasks.values(),
      ])
      const errors = outcomes.flatMap((item) => item.status === 'rejected' ? [item.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Workflow restart closure or task draining remains unconfirmed.')
      // A naturally finished drive may have retained its owner after a failed
      // intent. Its task has already drained; successful retry closes its exact
      // captured native lifetime before releasing that original owner.
      for (const [runId, owner] of this.activeOwners) {
        if (!this.activeTasks.has(runId)) {
          this.activeOwners.delete(runId)
          await owner.release()
        }
      }
    })()
    const attempt = this.shutdownTask
    // Preserve the admission fence, but retry the same captured native lifetime
    // when its close receipt or draining was unconfirmed on the previous attempt.
    void attempt.catch(() => { if (this.shutdownTask === attempt) this.shutdownTask = undefined })
    return attempt
  }

  private async requestRestartCleanup(owner: RunOwnership, approvals?: WorkflowRestartApprovals): Promise<void> {
    if (await settleWorkForRestart(owner, approvals)) return
    await this.runs.requestCleanup(owner.runId, owner)
  }
}
