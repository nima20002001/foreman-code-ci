import { isDatabasePoolTimeout } from '../../infrastructure/databaseReadRetry.js'
import { isDatabaseTimeout, retryDatabaseTimeout, retryDatabaseOperation } from '../../infrastructure/databaseTimeout.js'
import { beginRuntimeTiming, timeRuntimeOperation } from '../../infrastructure/runtimeTiming.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { interrupt, isGraphInterrupt } from '@langchain/langgraph'
import { HarnessExecutionSchema, type ExecutionResult, type HarnessExecution } from '@foreman-code/contracts'
import { AcceptedWorkflowRunV3Schema, CurrentRunVersionSnapshotSchema,
  type AcceptedWorkflowRunV3, type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'
import { REPEAT_NATIVE_PENDING_MESSAGE } from '../interactions/repeatNativeEvidence.js'
import { assertNativeWorkflowConfiguration } from '../harnesses/nativeWorkflowConfiguration.js'
import type { ApprovalExecutionCoordinator } from '../interactions/execution.js'
import { workflowDeliverableContract } from './workflowDeliverable.js'
import { assertSameRepeatExecution, type RepeatNativeLaunchStore, type RepeatNativeObservationStore } from '../interactions/repeatObservation.js'
import { withFilesystemDeadline } from '../workspaces/filesystem.js'
import { requiredLocationAccess, type WorkspaceLocationService } from '../workspaces/location.js'
import type { PostgresWorkflowRepository } from '../workflows/postgres.js'
import type { RunnerAdmission } from './runnerAdmission.js'
import { workflowExecutionRequest } from './workflowExecutionRequest.js'
import { currentInitialPrompt } from './currentRouting.js'
import { readUnconsumedWorkflowApprovals } from './workflowLifecycle.js'

import type { RunOwnership } from './ownership.js'
import { normalizeRepeatTerminal, type RepeatExecutionDriver } from './repeatNode.js'
import { assertRepeatExecution, repeatConflict, repeatTickIndex, type RepeatNodeRef, type RepeatScope } from './repeatResolution.js'
import type { RepeatRunRepository } from './repeatPostgres.js'
import { buildWorkHandoffGraph } from './workHandoffGraph.js'
import { workHandoffNodeAction } from './workHandoffNode.js'
import { WorkExecutionFailure } from './workExecutionFailure.js'
import { isTransientExecutionError, repeatSettlementPending, transientExecutionFailure } from './executionRetryPolicy.js'
export { repeatSettlementPending } from './executionRetryPolicy.js'
import { ExecutionLimiter } from './limiter.js'
import { ZodError } from 'zod'
import { componentLogger } from '../diagnostics/logger.js'
import { logIgnoredError } from '../diagnostics/ignoredError.js'

/** Adapt the existing exact-session native driver, not a second native runtime.
 * The shell supplies the same ApprovalExecutionCoordinator/SingleWriterSessionManager
 * path with a v3-capable repository. It must retain claimLaunch/one-use COMMIT permits,
 * unknown-submission reconciliation, connection generation, credential/owner fences,
 * graph.resume, real Worker acknowledgement and exact native closure/cleanup.
 * Neither a saved occurrence nor a returned candidate is a dispatch permission.
 */
export function repeatExecutionDriver(input: {
  scope: RepeatScope; version: WorkflowVersionV3
  owner: Pick<RunOwnership, 'assertOwned'>
  store: Pick<RepeatRunRepository, 'readExecution' | 'settleNativeExecution'>
  /** Required existing native boundary; never supply native.ensureObserve directly.
   * Completed input is per-execution cleanup/reconciliation ONLY. It must never
   * allocate a candidate, directory, credential, session or turn, or call finishRun. */
  observeExact(execution: HarnessExecution, signal: AbortSignal): Promise<void>
  /** Close one attempt for its recorded cause without fencing the Run. */
  abandonAttempt(executionId: string, failure: ExecutionResult): Promise<void>
  failIntervalCheck?(executionId: string, failure: ExecutionResult): Promise<void>
  reconcileArtifacts?(execution: HarnessExecution, signal: AbortSignal): Promise<void>
}): RepeatExecutionDriver {
  const inFlight = new Map<string, Promise<void>>()
  return {
    candidate: (ref, attempt) => {
      input.owner.assertOwned()
      const node = input.version.definition.nodes.find((item) => item.id === ref.nodeId)
      if (!node) return repeatConflict('WORKFLOW_NODE_NOT_FOUND')
      if (node.kind === 'job') return repeatConflict('WORKFLOW_NODE_KIND_CONFLICT')
      const execution = HarnessExecutionSchema.parse({ id: `execution-${randomUUID()}`, runId: input.scope.runId,
        workflowNodeId: ref.nodeId, agentId: node.agentId,
        agentConfigurationVersionId: input.version.agentConfigurationVersionIds[node.agentId],
        attempt, input: {}, state: 'queued', createdAt: new Date().toISOString() })
      assertRepeatExecution(input.version, input.scope, ref, execution)
      return execution
    },
    observe: (execution, signal) => {
      input.owner.assertOwned()
      signal.throwIfAborted()
      const previous = inFlight.get(execution.id)
      if (previous) return previous
      const task = (async () => {
        const finalize = async (terminal: HarnessExecution) => {
          await input.store.settleNativeExecution(terminal.id)
          input.owner.assertOwned()
          signal.throwIfAborted()
          await input.reconcileArtifacts?.(terminal, signal)
          input.owner.assertOwned()
          signal.throwIfAborted()
        }
        const stored = await input.store.readExecution(execution.id)
        if (stored.execution.id !== execution.id || stored.execution.runId !== input.scope.runId) return repeatConflict('REPEAT_EXECUTION_INPUT_CONFLICT')
        input.owner.assertOwned()
        signal.throwIfAborted()
        // A completed replay first repairs finalization from durable closure.
        // No native callback at all is needed for a close/COMMIT reply gap.
        if (stored.execution.state === 'completed') {
          try {
            await finalize(stored.execution)
            return
          } catch (error) {
            if (!repeatSettlementPending(error)) throw error
            input.owner.assertOwned()
            signal.throwIfAborted()
          }
        }
        // Reload rather than trusting checkpoint/native caller input or location.
        // Completed input requests ONLY this execution's outstanding cleanup;
        // nonterminal input uses the existing claim/session/owner native boundary.
        try { await input.observeExact(stored.execution, signal) }
        catch (error) {
          if (isGraphInterrupt(error)) throw error
          input.owner.assertOwned()
          signal.throwIfAborted()
          const terminal = await retryDatabaseTimeout(() => input.store.readExecution(execution.id), {
            signal, check: () => input.owner.assertOwned(),
          })
          if (terminal.execution.state !== 'completed') {
            if (repeatTickIndex(terminal.execution.input) !== undefined && !repeatSettlementPending(error)) {
              const failCheck = input.failIntervalCheck
              if (!failCheck) return repeatConflict('TICK_FAILURE_WRITER_REQUIRED')
              const failure: ExecutionResult = { outcome: 'failed', error: {
                code: error instanceof DomainError ? error.code : 'EXECUTION_START_INTERRUPTED',
                message: error instanceof DomainError ? error.message : 'The interval check could not start.',
                retryable: false,
              } }
              await retryDatabaseTimeout(() => failCheck(execution.id, failure), {
                signal, check: () => input.owner.assertOwned(),
              })
              await finalize((await input.store.readExecution(execution.id)).execution)
              return
            }
            // A start that failed for an infrastructure cause (including an
            // uncertain dispatch) abandons this attempt; the node starts a fresh one.
            if (isTransientExecutionError(error) && !terminal.execution.nativeSessionId
              && ['queued', 'starting'].includes(terminal.execution.state)) {
              await retryDatabaseTimeout(() => input.abandonAttempt(execution.id, transientExecutionFailure(error)), {
                signal, check: () => input.owner.assertOwned(),
              })
              await finalize((await input.store.readExecution(execution.id)).execution)
              return
            }
            throw error
          }
          // Native cleanup can throw after the terminal committed. Preserve it,
          // but never let that fact alone unblock a repeat or technical retry.
          await finalize(terminal.execution)
          return
        }
        input.owner.assertOwned()
        signal.throwIfAborted()
        const terminal = await input.store.readExecution(execution.id)
        if (terminal.execution.state !== 'completed') return repeatConflict('REPEAT_BOUNDARY_PENDING')
        await finalize(terminal.execution)
      })().catch((error: unknown) => {
        if (!repeatSettlementPending(error)) throw error
        input.owner.assertOwned()
        signal.throwIfAborted()
        // LangGraph persists name/message, not DomainError.code. Give ONLY the
        // allowlisted live settlement waits a stable retry marker; retain the
        // original diagnostic locally and leave every other error unchanged.
        const pending = new DomainError(String((error as { code: unknown }).code), REPEAT_NATIVE_PENDING_MESSAGE, 409)
        pending.cause = error
        throw pending
      }).finally(() => { if (inFlight.get(execution.id) === task) inFlight.delete(execution.id) })
      inFlight.set(execution.id, task)
      return task
    },
  }
}

export interface RepeatNativeObserverContext {
  run: AcceptedWorkflowRunV3
  version: WorkflowVersionV3
  owner: RunOwnership
  store: RepeatNativeLaunchStore
  native: Pick<ApprovalExecutionCoordinator, 'observeExact' | 'assertResume'>
  /** Shared startup capacity, scoped to the execution's accepted computer. */
  admission: RunnerAdmission
  workflows: Pick<PostgresWorkflowRepository, 'getAgentConfiguration' | 'resolveNodeSkills' | 'referencesCreatedByExecution'>
  locations: Pick<WorkspaceLocationService, 'revalidateRunAuthorization' | 'revalidateSnapshot'>
  /** Existing accepted runtime root + repeatExecutionDirectoryKey(executionId). */
  executionHostKey?(execution: HarnessExecution): Promise<string>
  preparePlacement?(execution: HarnessExecution): Promise<{ workingDirectory: string; runtimeDirectory: string; revalidate(): Promise<void> } | undefined>
  directory(executionId: string): string
}

/** Physical adapter for repeatExecutionDriver.observeExact. The same coordinator
 * owns native events, response delivery, approval checkpointing and cleanup.
 * No Run-wide finishRun, candidate allocation, new scheduler or provider shim. */
export function repeatNativeObserver(context: RepeatNativeObserverContext):
  (admitted: HarnessExecution, signal: AbortSignal) => Promise<void> {
  const run = AcceptedWorkflowRunV3Schema.parse(context.run)
  CurrentRunVersionSnapshotSchema.parse({ run, version: context.version })
  const { owner, store, native, locations } = context
  const common = { workflowId: run.workflowId, graphThreadId: run.id, approval: run.approval, owner,
    agentActiveTimeoutMs: context.version.definition.executionPolicy?.agentActiveTimeoutMs }
  return async (admitted, signal) => {
    const check = () => {
      signal.throwIfAborted()
      owner.assertOwned()
      if (admitted.runId !== run.id || owner.runId !== run.id) throw new DomainError(
        'GRAPH_SCOPE_MISMATCH', 'An occurrence cannot borrow another Run owner or admission slot.', 409)
    }
    const reload = async () => {
      check()
      const stored = await store.readExecution(admitted.id)
      assertSameRepeatExecution(admitted, stored.execution)
      assertRepeatExecution(context.version, { workspaceId: run.workspaceId, workflowId: run.workflowId,
        workflowVersionId: run.workflowVersionId, runId: run.id, executionSemanticsVersion: 3 }, stored.ref, stored.execution)
      check()
      return stored.execution
    }
    let execution = await reload()
    // Do not even enter capacity or compute a directory for terminal replay.
    if (execution.state === 'completed') {
      await native.observeExact({ ...common, execution, store, signal })
      return
    }
    // LangGraph restarts every unresolved wrapper, not just the notified
    // branch. Re-interrupt an unconsumed sibling before budget resume, native
    // preflight, attachment or observation. An old task-local resume value is
    // only a notification: it cannot release a newer/unconsumed approval.
    const waitForApprovals = async () => {
      while (execution.state === 'waiting') {
        const pending = await readUnconsumedWorkflowApprovals(owner, execution)
        check()
        if (!pending.length) break
        const resumed: unknown = interrupt({ interactionId: pending[0]!.id,
          interactionIds: pending.map((item) => item.id) })
        await native.assertResume(execution, resumed)
        execution = await reload()
      }
    }
    await waitForApprovals()
    execution = await reload()
    if (execution.state === 'completed') {
      await native.observeExact({ ...common, execution, store, signal })
      return
    }
    // Failed profiles must be rejected before waiting for startup capacity.
    const placement = await context.preparePlacement?.(execution)
    check()
    const node = context.version.definition.nodes.find((item) => item.id === execution.workflowNodeId)
    const hostKey = await context.executionHostKey?.(execution) ?? (node && node.kind !== 'job'
      && node.placement?.hostRef.kind === 'device' ? `device:${node.placement.hostRef.deviceId}` : 'main')
    check()
    await context.admission.run(run.id, signal, async release => {
      execution = await reload() // Stop or another exact observation may win while queued.
      if (execution.state === 'completed') {
        await native.observeExact({ ...common, execution, store, signal })
        return
      }
      const pinnedConfiguration = await retryDatabaseOperation(
        () => context.workflows.getAgentConfiguration(execution.agentConfigurationVersionId),
        (error) => isDatabaseTimeout(error) || isDatabasePoolTimeout(error), { signal, check },
      )
      check()
      if (!node || node.kind === 'job' || !pinnedConfiguration || pinnedConfiguration.id !== context.version.agentConfigurationVersionIds[node.agentId]
        || pinnedConfiguration.agentId !== node.agentId || pinnedConfiguration.workspaceId !== run.workspaceId) {
        throw new DomainError('REPEAT_EXECUTION_INPUT_CONFLICT', 'Native work requires the immutable occurrence configuration.', 409)
      }
      const configuration = node.skills ? await context.workflows.resolveNodeSkills(
        pinnedConfiguration, node.skills, context.version.nodeSkillSnapshots?.[node.id],
      ) : pinnedConfiguration
      assertNativeWorkflowConfiguration(configuration.harness, run.approval,
        run.approval.handler === 'orchestrator' && configuration.agentId === run.approval.designatedOrchestratorAgentId)
      const validate = async () => {
        check()
        await locations.revalidateRunAuthorization(run.authorizationPrincipalId, run.workspaceId, run.workflowId, owner.client)
        check()
        if (placement) await placement.revalidate()
        else await locations.revalidateSnapshot(run.workspaceId, run.executionLocation, requiredLocationAccess([configuration]), signal)
        check()
      }
      await validate()
      const paths = placement ? { workingDirectory: placement.workingDirectory, runtimeDirectory: placement.runtimeDirectory }
        : { workingDirectory: run.executionLocation.rootPath, runtimeDirectory: context.directory(execution.id) }
      const claimed = await store.claimLaunch(execution.id, paths)
      check()
      execution = claimed ?? await store.recoverSession(execution.id)
      check()
      assertSameRepeatExecution(admitted, execution)
      if (execution.state === 'completed') {
        await native.observeExact({ ...common, execution, store, signal })
        return
      }
      if (execution.workingDirectory !== paths.workingDirectory || execution.runtimeDirectory !== paths.runtimeDirectory) {
        throw new DomainError('REPEAT_EXECUTION_INPUT_CONFLICT', 'Recovery cannot replace the accepted occurrence directories.', 409)
      }
      if (!claimed && !execution.nativeSessionId) throw new DomainError('NATIVE_SESSION_START_UNCERTAIN',
        'Dispatch may have occurred; this attempt is abandoned and its node starts a fresh attempt.', 409)
      await validate()
      await store.assertExecutionAdmission(execution.id)
      check()
      if (claimed) {
        // Preparation permits only directory setup. A second acknowledged
        // transition is required before manager or credential preflight.
        if (execution.nativeSessionId) throw new DomainError('NATIVE_ENTRY_CONFLICT', 'A first entry already owns a native session.', 409)
        await store.beginNativeEntry(execution.id)
        check()
        if (node.placement?.hostRef.kind !== 'device') {
          await withFilesystemDeadline((checkFilesystem) => checkFilesystem(() => mkdir(paths.runtimeDirectory, { recursive: true })), signal)
        }
        check()
      }
      const boundary: RepeatNativeObservationStore = {
        readExecution: (id) => store.readExecution(id),
        settleNativeExecution: (id) => store.settleNativeExecution(id),
        exactSession: (id) => store.exactSession(id),
        assertExecutionAdmission: async (id) => { await validate(); await store.assertExecutionAdmission(id); check() },
        assertNativeBoundary: async (id) => { await validate(); await store.assertNativeBoundary(id); check() },
        authorizeNativeSubmission: async (id) => {
          check()
          if (id !== execution.id || !claimed) throw new DomainError('NATIVE_ENTRY_CONFLICT', 'Recovery cannot authorize another submission.', 409)
          await validate()
          await store.authorizeNativeSubmission(id)
          check()
        },
        consumeLaunch: (id) => { check(); return id === execution.id && store.consumeLaunch(id) },
      }
      const executionContext = context.version.definition.handoffs && repeatTickIndex(execution.input) === undefined
        ? await store.readWorkExecutionContext(execution.id) : undefined
      check()
      const request = workflowExecutionRequest({ execution: { ...execution, ...paths },
        version: context.version, configuration, workspaceId: run.workspaceId, executionContext })
      const workHandoffContract = context.version.definition.handoffs && repeatTickIndex(execution.input) === undefined
        ? currentInitialPrompt({ ...node, initialPrompt: undefined }, false, true) : undefined
      const deliverable = workflowDeliverableContract(context.version, execution,
        (kind, values) => context.workflows.referencesCreatedByExecution(kind, values, run.workspaceId, execution.id))
      for (;;) {
        const observation = await native.observeExact({ ...common, execution, request, store: boundary, signal, onStarted: release,
          workHandoffContract, deliverable })
        execution = observation.execution
        if (observation.state === 'completed') {
          return
        }
        // Also gate a later request in this same native turn. Replaying older
        // task-local resume values must not reopen its budget/native observer.
        await waitForApprovals()
      }
    }, { hostKey, execution })
  }
}

/** Directory identity must not use only workflowNodeId: each occurrence/attempt
 * has a distinct execution ID. The existing directory allocator owns the root. */
export function repeatExecutionDirectoryKey(executionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(executionId)) return repeatConflict('REPEAT_EXECUTION_ID_INVALID')
  // Fixed-length opaque hash avoids reserved components and filesystem name limits.
  return createHash('sha256').update(executionId).digest('hex')
}

/** Call from the existing coordinator BEFORE either durable terminal observation.
 * Never invoke this to replace an already-written terminal with a different one. */
export function repeatTerminalNormalizer(version: WorkflowVersionV3, scope: RepeatScope, ref: RepeatNodeRef) {
  return (execution: HarnessExecution): HarnessExecution => normalizeRepeatTerminal(version, scope, ref, execution)
}

/** Adapter to the existing Run lifecycle writers/coordinator. These operations are
 * not new state authority. Implementations retain the existing native closure,
 * Stop, finalization, selected-work result and cleanup-intent transactions. */
export interface RepeatRuntimeLifecycle {
  preflight(): Promise<void>
  markRunning(): Promise<void>
  currentState(): Promise<{ executionState: string; stopRequested: boolean; cleanupPending?: boolean }>
  persistWait(snapshot: import('./repeatGraph.js').RepeatCheckpoint): Promise<boolean>
  persistDirectionWait?(): Promise<void>
  recordExecutionFailure?(executionId: string, failure: ExecutionResult): Promise<void>
  /** Persist cleanup intent BEFORE native cancellation; false retains uncertainty. */
  cancelNativeAndRequestCleanup(): Promise<boolean>
  settleRun(stopped: boolean, interrupted: boolean): Promise<void>
  /** These are the existing post-terminal cleanup/finalization paths, not fake ack. */
  requestCleanup(failure?: ExecutionResult): Promise<void>
  finishNative(): Promise<void>
  finishCleanup(): Promise<void>
}

const preparationFailureCodes = new Set(['SOURCE_MATERIALIZATION_UNCERTAIN', 'HARNESS_PROFILE_UNAVAILABLE'])

function isRuntimeFailure(error: unknown): boolean {
  if (error instanceof WorkExecutionFailure) return true
  if (repeatSettlementPending(error) || isGraphInterrupt(error) || isTransientExecutionError(error)) return false
  if (error instanceof ZodError || (error instanceof Error && error.message === 'GRAPH_JSON_LIMIT')) return true
  if (typeof error !== 'object' || !error || !('code' in error)) return false
  const code = String(error.code)
  return preparationFailureCodes.has(code) || code.startsWith('REPEAT_') || code.startsWith('AUTH_') || [
    'WORKFLOW_SELECTED_EXECUTION_FAILED', 'WORKFLOW_UNRESOLVED', 'WORKFLOW_RESULT_TOO_LARGE', 'EXECUTION_OCCURRENCE_CONFLICT',
    'WORKFLOW_EXECUTION_BUDGET_EXHAUSTED', 'JOB_PREPARATION_TIMEOUT',
    'EXECUTION_START_INTERRUPTED',
    'RUN_PIN_CONFLICT', 'ACCESS_DENIED', 'GRAPH_SECURITY_UNQUALIFIED', 'GRAPH_STOP_CONFLICT', 'GRAPH_TERMINAL_CONFLICT',
    // Launch preflight refusals happen before any native session exists.
    'APP_MCP_PREFLIGHT_FAILED', 'APP_MCP_PREFLIGHT_TIMEOUT',
    'MCP_INSPECTION_CONTEXT_MISMATCH', 'HARNESS_INSPECTOR_UNAVAILABLE',
    'WORKER_EXECUTION_IDENTITY_INVALID', 'HARNESS_CONFIGURATION_MISMATCH',
    'WORKER_NATIVE_OUTPUT_PROTECTION_FAILED', 'WORKFLOW_ARTIFACT_OUTPUTS_CONFLICT',
    'WORKFLOW_ARTIFACT_SOURCE_CONFLICT', 'WORKFLOW_TERMINAL_SOURCE_CONFLICT',
    'WORK_SELECTED_EXECUTION_FAILED', 'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED',
    'WORK_POLICY_PIN_CONFLICT', 'WORK_ACTIVATION_REPLAY_CONFLICT', 'WORK_ACTIVATION_PIN_CONFLICT',
    'WORK_TERMINAL_REPLAY_CONFLICT', 'WORK_RETRY_ACTIVATION_CONFLICT', 'WORK_RETRY_NOT_ALLOWED',
    'WORK_RESULT_RECEIPT_MISSING', 'WORK_SOURCE_RESULT_CONFLICT', 'WORK_SOURCE_PIN_CONFLICT',
    'WORK_SOURCE_ACTIVATION_CONFLICT', 'WORK_COUNTER_PIN_CONFLICT',
    'WORK_REQUEST_OUTCOME_UNDECLARED', 'WORK_REQUEST_ROUTE_FORBIDDEN', 'WORK_REQUEST_REPLAY_CONFLICT',
    'WORK_RETURN_REQUEST_MISSING', 'WORK_RETURN_ANCESTRY_CONFLICT', 'WORK_RETURN_RESULT_CONFLICT',
    'WORK_RETURN_SOURCE_PIN_CONFLICT', 'WORK_RETURN_REQUESTER_CONFLICT',
    'WORK_RETURN_REPLAY_CONFLICT', 'WORK_JOIN_ACTIVATION_CONFLICT', 'WORK_JOIN_SOURCE_CONFLICT',
    'WORK_FINISH_OUTCOME_REQUIRED', 'WORK_UNRESOLVED_CAUSE_CONFLICT', 'WORK_UNRESOLVED_RECEIPT_CONFLICT',
    'WORK_UNRESOLVED_RECEIPT_MISSING', 'WORK_UNRESOLVED_REPLAY_CONFLICT',
    'WORK_DIRECTION_WAIT_WRITER_REQUIRED', 'WORK_FAILURE_WRITER_REQUIRED',
    'WORKFLOW_NATIVE_APPROVAL_UNHANDLED',
    'WORK_CHECKPOINT_ACTIVATION_MISSING', 'WORK_SUCCESSOR_DUPLICATE', 'WORK_HANDOFF_DELIVERY_TOO_LARGE',
  ].includes(code)
}

function runtimeFailureResult(error: unknown): ExecutionResult | undefined {
  if (error instanceof WorkExecutionFailure) return error.result
  if (!(error instanceof DomainError)) return undefined
  if (!preparationFailureCodes.has(error.code) && !['WORKFLOW_EXECUTION_BUDGET_EXHAUSTED', 'JOB_PREPARATION_TIMEOUT',
    'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED', 'EXECUTION_START_INTERRUPTED'].includes(error.code)) return undefined
  return { outcome: 'failed', error: { code: error.code, message: error.message, retryable: false } }
}

/** Re-activates interval nodes beside the graph: one loop per node admits a check when it is due
 * and observes it through the same native driver without using graph parallelism slots. Each loop
 * re-observes its node's latest check until that check is settled, also after a restart. The
 * returned stop only ends scheduling: the caller's task drain waits for in-flight checks, with the
 * bounded cleanup deadline after Stop or graph failure. Failed checks settle independently;
 * incomplete cleanup backs off and re-observes the same check. */
export function startIntervalChecks(input: {
  version: WorkflowVersionV3; store: Partial<Pick<RepeatRunRepository, 'admitTick'>>
  driver: RepeatExecutionDriver; signal: AbortSignal
  track(task: Promise<unknown>): void
}): () => void {
  const nodes = input.version.definition.nodes.filter((node) => node.kind !== 'job' && node.interval)
  if (!nodes.length) return () => {}
  const admitTick = input.store.admitTick?.bind(input.store)
  if (!admitTick) return repeatConflict('TICK_STORE_REQUIRED')
  const stopped = new AbortController(), scheduling = AbortSignal.any([input.signal, stopped.signal])
  for (const node of nodes) input.track((async () => {
    let settled: string | null = null
    for (;;) {
      let waitMs = 5_000
      try {
        // A check is never admitted once scheduling stopped; the throw rolls the admission back.
        const admission = await admitTick(node.id, () => {
          scheduling.throwIfAborted()
          return input.driver.candidate({ nodeId: node.id, occurrence: null }, 1)
        }, settled)
        const execution = admission.kind === 'admitted' ? admission.execution
          : admission.kind === 'busy' ? admission.execution : undefined
        if (execution) {
          await input.driver.observe(execution, input.signal)
          settled = execution.id
          waitMs = 1_000
        } else if (admission.kind === 'wait' && admission.dueAt) {
          waitMs = Math.min(60_000, Math.max(1_000, Date.parse(admission.dueAt) - Date.now()))
        }
      } catch (error) {
        if (input.signal.aborted) return
        if (!scheduling.aborted) componentLogger('engine').warn({ err: error, workflowNodeId: node.id }, 'interval check failed')
      }
      if (scheduling.aborted) return
      await delay(waitMs, undefined, { signal: scheduling }).catch(() => { /* ignore: aborting the wait is how scheduling stops early */ })
    }
  })())
  return () => stopped.abort()
}

async function drainRuntimeTasks(tasks: Set<Promise<unknown>>, signal: AbortSignal,
  options: { cleanup: boolean }): Promise<void> {
  const { withCleanupDeadline } = await import('../interactions/cleanup.js')
  const finished = beginRuntimeTiming('engine', 'wrapper.drain', { count: tasks.size })
  try {
    const wait = async () => { while (tasks.size) await Promise.allSettled([...tasks]) }
    if (options.cleanup) return await withCleanupDeadline(wait)
    // Healthy siblings retain their active budgets; the cleanup deadline applies
    // only after cancellation/restart, not while observing their original work.
    let abort: (() => void) | undefined
    try {
      await Promise.race([wait(), new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })])
    } finally { if (abort) signal.removeEventListener('abort', abort) }
  } finally { finished() }
}

/** An idle loop Run retains its owner and scheduler until Stop, failure or restart. */
async function waitForIntervalRun(input: Parameters<typeof startIntervalChecks>[0] & {
  currentState: RepeatRuntimeLifecycle['currentState']
}): Promise<void> {
  const stopChecks = startIntervalChecks(input)
  try {
    for (;;) {
      input.signal.throwIfAborted()
      const current = await input.currentState()
      if (current.stopRequested || current.cleanupPending) {
        throw new DomainError('GRAPH_STOP_CONFLICT', 'The Run has a Stop or cleanup request.', 409)
      }
      if (current.executionState !== 'running') return
      try {
        await delay(1_000, undefined, { signal: input.signal })
      } catch (error) {
        input.signal.throwIfAborted()
        throw error
      }
    }
  } finally { stopChecks() }
}

/** Executes the one graph on the existing Run thread. Settlement retries drain
 * wrappers and re-enter the same checkpoint; business progression stays inside
 * guarded graph edges. The shared engine owns Run ownership/admission,
 * authenticated graph-resume claims and choosing this semantics-3 entry point. */
export async function executeRepeatRuntime(input: {
  jobs?: { store: import('../jobs/workflowNode.js').WorkflowJobNodeStore; driver: import('../jobs/workflowRuntimePorts.js').WorkflowJobDriver }
  runId: string; version: WorkflowVersionV3
  owner: Pick<RunOwnership, 'assertOwned'>; signal: AbortSignal
  checkpointOwnerGeneration?: string | undefined
  store: Pick<RepeatRunRepository, 'admit' | 'acceptTerminal' | 'enterBlock' | 'readOccurrence' | 'transition'
    | 'resolveExcluded' | 'completeRun' | 'ensureWorkEntry' | 'admitWorkActivation' | 'acceptWorkTerminal'
    | 'admitWorkRequest' | 'returnWork' | 'recordWorkUnresolved' | 'resolveWaitingWorkJoins' | 'completeWorkRun'>
    & Partial<Pick<RepeatRunRepository, 'admitTick'>>
  driver: RepeatExecutionDriver; lifecycle: RepeatRuntimeLifecycle
  checkpointer: import('@langchain/langgraph-checkpoint').BaseCheckpointSaver
  configuredParallelism?: number
}): Promise<void> {
  const { buildRepeatGraph } = await import('./repeatGraph.js')
  const failed = new AbortController(), signal = AbortSignal.any([input.signal, failed.signal])
  const bookkeeping = <T>(work: () => Promise<T>) => retryDatabaseTimeout(work, {
    signal, check: () => input.owner.assertOwned(),
  })
  const readCurrentState = () => retryDatabaseTimeout(() => input.lifecycle.currentState(), {
    check: () => input.owner.assertOwned(),
  })
  const requestCleanup = (failure?: ExecutionResult) => retryDatabaseTimeout(
    () => input.lifecycle.requestCleanup(failure), { check: () => input.owner.assertOwned() })
  const tasks = new Set<Promise<unknown>>()
  let firstFailure: unknown, preflightComplete = false, cancellation: Promise<boolean> | undefined
  const cancel = () => cancellation ??= input.lifecycle.cancelNativeAndRequestCleanup()
  const drain = (cleanup = false) => drainRuntimeTasks(tasks, signal, { cleanup })
  const track = (task: Promise<unknown>) => {
      tasks.add(task)
      void task.then(() => { tasks.delete(task) }, (error: unknown) => {
        tasks.delete(task)
        if (!(input.signal.reason instanceof DomainError && input.signal.reason.code === 'ENGINE_RESTART') && isRuntimeFailure(error)) {
          firstFailure ??= error
          const cleanup = requestCleanup(runtimeFailureResult(firstFailure)).then(() => {
            failed.abort(error)
            return cancel()
          })
          tasks.add(cleanup)
          void cleanup.then(() => { tasks.delete(cleanup) }, (cleanupError: unknown) => {
            tasks.delete(cleanup)
            firstFailure ??= cleanupError
          })
        }
      })
    }
  // Graph Agent work and Jobs share the Run's parallelism limit.
  const limiter = new ExecutionLimiter(
    input.version.definition.executionPolicy!.maxParallelism, 1000)
  const work = input.version.definition.handoffs ? buildWorkHandoffGraph({
    runId: input.runId, version: input.version, checkpointer: input.checkpointer, signal, track,
    port: { ensureEntryActivation: () => input.store.ensureWorkEntry(),
      executeActivation: async activationId => {
        try {
          return await workHandoffNodeAction({ version: input.version, store: input.store,
            driver: input.driver, limiter, signal })(activationId)
        } catch (error) {
          if (!(error instanceof WorkExecutionFailure)) throw error
          const executionId = error.pendingExecutionId
          if (executionId) {
            const recordFailure = input.lifecycle.recordExecutionFailure?.bind(input.lifecycle)
            if (!recordFailure) throw new DomainError('WORK_FAILURE_WRITER_REQUIRED',
              'A handoff launch failure requires its persisted execution cause.', 409, undefined, { cause: error })
            await bookkeeping(() => recordFailure(executionId, error.result))
          }
          return input.store.resolveWaitingWorkJoins(activationId)
        }
      },
    },
  }) : null
  const repeat = work ? null : buildRepeatGraph({ ...input, signal, track, limiter })
  const checkpointOwner = { checkpoint_owner_generation: input.checkpointOwnerGeneration }
  if (work) Object.assign(work.config.configurable, checkpointOwner)
  if (repeat) Object.assign(repeat.config.configurable, checkpointOwner)
  const readCheckpoint = (): Promise<import('./repeatGraph.js').RepeatCheckpoint> => bookkeeping(async () => work
    ? await work.graph.getState(work.config) as import('./repeatGraph.js').RepeatCheckpoint
    : await repeat!.graph.getState(repeat!.config))
  const invoke = (state: unknown): Promise<unknown> => work
    ? work.graph.invoke(state as typeof work.initial | null, work.config)
    : repeat!.graph.invoke(state as import('./repeatNode.js').RepeatGraphState | null, repeat!.config)
  try {
    input.owner.assertOwned()
    await bookkeeping(() => input.lifecycle.preflight())
    preflightComplete = true
    signal.throwIfAborted()
    await bookkeeping(() => input.lifecycle.markRunning())
    if (!work) await bookkeeping(() => input.store.resolveExcluded())
    const snapshot = await readCheckpoint()
    if (snapshot.values.runId && snapshot.values.runId !== input.runId) return repeatConflict('RUN_PIN_CONFLICT')
    // A2 commits authenticated task-local resume writes on this checkpointer.
    // The runtime never accepts an unreceipted raw resume Command.
    let state = snapshot.values.runId === input.runId ? null
      : work ? work.initial : { runId: input.runId, occurrences: {}, boundaries: {}, executionIds: {} }
    for (let attempt = 0; ; attempt++) {
      try {
        // Native iterators need not honor cancellation; the graph invocation is raced
        // independently, then existing exact native cleanup and wrapper drain run below.
        let onAbort: (() => void) | undefined
        const stopChecks = startIntervalChecks({ version: input.version, store: input.store, driver: input.driver,
          signal, track })
        try {
          const invocation = invoke(state)
          tasks.add(invocation)
          void invocation.then(() => { tasks.delete(invocation) }, () => { tasks.delete(invocation) })
          await Promise.race([invocation, new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(signal.reason)
            signal.addEventListener('abort', onAbort, { once: true })
            if (signal.aborted) onAbort()
          })])
        } finally {
          if (onAbort) signal.removeEventListener('abort', onAbort)
          stopChecks()
        }
        await drain()
        signal.throwIfAborted()
        if (await bookkeeping(async () => input.lifecycle.persistWait(await readCheckpoint()))) return
        if (!work && firstFailure) throw firstFailure
        let idle = input.version.definition.nodes.some(node => node.kind !== 'job' && node.interval)
        if (work) {
          const completion = await bookkeeping(() => input.store.completeWorkRun())
          idle = completion === 'idle'
          if (completion === 'needs_direction') {
            if (!input.lifecycle.persistDirectionWait) throw new DomainError('WORK_DIRECTION_WAIT_WRITER_REQUIRED',
              'Unresolved work requires the durable workflow direction-wait writer.', 409)
            await bookkeeping(() => input.lifecycle.persistDirectionWait!())
            return
          }
        }
        else if (!idle) await timeRuntimeOperation('engine', 'run.settle', () => bookkeeping(() => input.store.completeRun()))
        if (idle) {
          await waitForIntervalRun({ version: input.version, store: input.store, driver: input.driver,
            signal, track, currentState: readCurrentState })
          await drain()
          return
        }
        await bookkeeping(() => input.lifecycle.requestCleanup())
        await input.lifecycle.finishNative()
        await bookkeeping(() => input.lifecycle.finishCleanup())
        return
      } catch (error) {
        const databaseTimeout = isDatabaseTimeout(error)
        if (!databaseTimeout && !repeatSettlementPending(error)) throw error
        await drain()
        input.owner.assertOwned()
        signal.throwIfAborted()
        if (firstFailure) throw firstFailure
        const current = await readCurrentState()
        if (current.stopRequested || current.cleanupPending || current.executionState === 'completed') throw error
        // Yield to the caller when another REAL approval is outstanding. Holding
        // this callback could prevent the orchestrator from answering that wait.
        if (await bookkeeping(async () => input.lifecycle.persistWait(await readCheckpoint()))) return
        // Database deadlines retry the saved checkpoint. Settlement waits yield
        // after bounded retries so reviewers can receive their MCP responses.
        if (!databaseTimeout && attempt >= 2) throw error
        state = null
        const backoffMs = databaseTimeout ? 1_000 : 100
        await timeRuntimeOperation('engine', 'settlement.backoff', () => delay(backoffMs, undefined, { signal }),
          { intervalMs: backoffMs })
      }
    }
  } catch (error) {
    input.owner.assertOwned()
    if (input.signal.aborted && input.signal.reason instanceof DomainError && input.signal.reason.code === 'ENGINE_RESTART') {
      // The owning engine closes the original native sessions before releasing
      // ownership. Restart is not a synthetic Stop or terminal business result.
      failed.abort(error)
      await drain(true)
      throw error
    }
    const current = await readCurrentState()
    if (current.executionState === 'completed') throw error // immutable terminal, cleanup may still be pending
    const preflightFailure = !preflightComplete && !isTransientExecutionError(error)
    const terminalFailure = preflightFailure || isRuntimeFailure(error) || input.signal.aborted || current.stopRequested
    if (!terminalFailure) {
      await drain()
      if ((isGraphInterrupt(error) || repeatSettlementPending(error))
        && await bookkeeping(async () => input.lifecycle.persistWait(await readCheckpoint()))) return
      // I/O, ambiguous receipts and settlement waits retain exact durable work.
      // The owning engine may retry the same checkpoint, never initial state.
      throw error
    }
    await requestCleanup(runtimeFailureResult(firstFailure ?? error))
    failed.abort(error)
    const closing = cancel()
    let drained = false
    try { await drain(true); drained = true } catch (drainError) { logIgnoredError('engine', 'drain repeat work after failure', drainError, { runId: input.runId }) } // Uncertain cleanup is retained.
    const clean = await closing
    input.owner.assertOwned()
    await input.lifecycle.settleRun(current.stopRequested, input.signal.aborted && !current.stopRequested)
    if (clean && drained && (await readCurrentState()).executionState === 'completed') {
      await input.lifecycle.finishNative()
      await input.lifecycle.finishCleanup()
    }
    throw error
  }
}
