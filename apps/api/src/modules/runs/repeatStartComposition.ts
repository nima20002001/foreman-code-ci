import type { HarnessExecution } from '@foreman-code/contracts'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import type { ApprovalExecutionCoordinator } from '../interactions/execution.js'
import type { RepeatNativeLaunchStore } from '../interactions/repeatObservation.js'
import { DomainError } from '../errors.js'
import type { PostgresWorkflowRepository } from '../workflows/postgres.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'
import type { RunOwnership } from './ownership.js'
import type { WorkflowNativeEntryPermit } from './workflowNativeEntry.js'
import type { RepeatNativeBoundaryEvidence } from './repeatNativeRepository.js'
import { repeatRuntimeDirectory, type RepeatRepositoryFactory } from './repeatRepositoryHost.js'
import { executeRepeatRuntime, repeatExecutionDriver, repeatNativeObserver, type RepeatRuntimeLifecycle } from './repeatRuntime.js'
import { readAcceptedRepeatRunLocked, type AcceptedRepeatRunSnapshot } from './repeatStartRead.js'
import type { RunnerAdmission } from './runnerAdmission.js'
import type { ExecutionLimiter } from './limiter.js'

/** These are existing-engine dependencies, not another owner, scheduler, gate
 * or checkpoint thread. Production composes the real current lifecycle and
 * original-native-proof services on these same owners. */
export interface RepeatEngineStartContext {
  owner: RunOwnership
  signal: AbortSignal
  checkpointer: BaseCheckpointSaver
  admission: RunnerAdmission
  configuredParallelism: number
  limiter?: ExecutionLimiter
  runtimeRoot: string
  factory: RepeatRepositoryFactory
  native: Pick<ApprovalExecutionCoordinator, 'observeExact' | 'assertResume' | 'failIntervalCheck' | 'abandonAttempt'>
  workflows: Pick<PostgresWorkflowRepository, 'getAgentConfiguration' | 'resolveNodeSkills' | 'referencesCreatedByExecution'>
  locations: Pick<WorkspaceLocationService, 'revalidateRunAuthorization' | 'revalidateSnapshot'>
  jobs?: (owner: RunOwnership, version: import('@foreman-code/contracts/wave25').WorkflowVersionV3) => {
    store: import('../jobs/workflowNode.js').WorkflowJobNodeStore; driver: import('../jobs/workflowRuntimePorts.js').WorkflowJobDriver }
  lifecycle: RepeatRuntimeLifecycle
  /** Must capture REAL current coordinator/manager/lease/command evidence on
   * each call. No DB-membership-only proof or fabricated first_launch fallback. */
  nativeBoundaryEvidence(executionId: string): Promise<RepeatNativeBoundaryEvidence>
}

/** Bridge the N1 and N2 ports without laundering a receipt into a new launch
 * permission. Only immutable directory identity is cached; execution state and
 * physical authority are always reread/revalidated. */
export function repeatNativeStartStore(input: Pick<RepeatEngineStartContext, 'owner' | 'runtimeRoot' | 'nativeBoundaryEvidence'>,
  snapshot: AcceptedRepeatRunSnapshot, store: ReturnType<RepeatRepositoryFactory['forOwner']>): {
    store: RepeatNativeLaunchStore; directory(executionId: string): string
  } {
  const { run, version } = snapshot
  const { owner, runtimeRoot } = input
  if (typeof input.nativeBoundaryEvidence !== 'function') throw new DomainError('REPEAT_NATIVE_HOST_REQUIRED', 'A real native boundary evidence reader is required.', 409)
  const nativeBoundaryEvidence = input.nativeBoundaryEvidence.bind(input)
  const scope = { runId: run.id, workspaceId: run.workspaceId, workflowId: run.workflowId,
    workflowVersionId: version.id, executionSemanticsVersion: 3 as const }
  const paths = new Map<string, string>()
  const firstClaims = new Set<string>()
  const entryPermits = new Map<string, WorkflowNativeEntryPermit>()
  const availableEntries = new Set<string>()
  const owned = () => {
    owner.assertOwned()
    if (owner.runId !== run.id) throw new DomainError('GRAPH_SCOPE_MISMATCH', 'A repeat observer cannot borrow another Run owner.', 409)
  }
  const capturePath = (execution: HarnessExecution) => {
    owned()
    const path = repeatRuntimeDirectory(runtimeRoot, scope, execution)
    const previous = paths.get(execution.id)
    if (previous !== undefined && previous !== path) throw new DomainError('RUN_PIN_CONFLICT', 'An exact execution cannot change runtime directory identity.', 409)
    paths.set(execution.id, path)
  }
  return {
    store: {
      readWorkExecutionContext: async (id) => {
        owned()
        const context = await store.readWorkExecutionContext(id)
        owned()
        return context
      },
      readExecution: async (id) => {
        owned()
        const current = await store.readExecution(id)
        if (current.execution.id !== id) throw new DomainError('REPEAT_EXECUTION_INPUT_CONFLICT', 'The repository returned a different execution.', 409)
        capturePath(current.execution)
        return current
      },
      claimLaunch: async (id, requested) => {
        owned()
        const claimed = await store.claimLaunch(id, requested)
        owned()
        if (claimed) {
          if (claimed.id !== id) throw new DomainError('REPEAT_EXECUTION_INPUT_CONFLICT', 'A launch claim cannot change execution identity.', 409)
          capturePath(claimed); firstClaims.add(id)
        }
        return claimed
      },
      beginNativeEntry: async (id) => {
        owned()
        if (!firstClaims.delete(id)) throw new DomainError('NATIVE_ENTRY_CONFLICT', 'No exact fresh launch claim exists.', 409)
        const permit = await store.beginNativeEntry(id)
        owned()
        entryPermits.set(id, permit)
        return permit
      },
      authorizeNativeSubmission: async (id) => {
        owned()
        const prepared = entryPermits.get(id)
        if (!prepared || availableEntries.has(id)) throw new DomainError('NATIVE_ENTRY_CONFLICT', 'No one-use preparation permit exists.', 409)
        entryPermits.delete(id)
        const entered = await store.authorizeNativeSubmission(id, prepared)
        owned()
        entryPermits.set(id, entered); availableEntries.add(id)
      },
      consumeLaunch: (id) => { owned(); return availableEntries.delete(id) },
      assertExecutionAdmission: async (id) => { owned(); await store.assertExecutionAdmission(id); owned() },
      recoverSession: async (id) => {
        owned()
        const current = await store.recoverSession(id)
        if (current.id !== id) throw new DomainError('REPEAT_EXECUTION_INPUT_CONFLICT', 'Recovery returned a different execution.', 409)
        capturePath(current)
        return current
      },
      exactSession: async (id) => { owned(); const session = await store.exactSession(id); owned(); return session },
      settleNativeExecution: async (id) => { owned(); await store.settleNativeExecution(id); owned() },
      assertNativeBoundary: async (id) => {
        owned()
        const current = await store.readExecution(id)
        const permit = entryPermits.get(id)
        const evidence = !current.execution.nativeSessionId && permit
          ? { kind: 'first_launch' as const, permit } : await nativeBoundaryEvidence(id)
        owned()
        await store.assertNativeBoundary(id, evidence)
        owned()
      },
    },
    directory: (id) => {
      owned()
      const path = paths.get(id)
      if (path === undefined) throw new DomainError('REPEAT_EXECUTION_INPUT_CONFLICT', 'Read the exact admitted execution before deriving its directory.', 409)
      return path
    },
  }
}

/** Entry for queued Start or active recovery on the EXISTING engine owner and
 * checkpointer. No public resume Command is accepted: approval recovery must
 * first commit the exact atomic graph.resume/checkpoint consumption elsewhere.
 * The existing engine calls this for every ordinary/repeated V3 graph. */
export async function executeRepeatEngineStart(input: RepeatEngineStartContext): Promise<void> {
  const check = () => { input.owner.assertOwned(); input.signal.throwIfAborted() }
  check()
  if (!Number.isInteger(input.configuredParallelism) || input.configuredParallelism < 1
    || typeof input.nativeBoundaryEvidence !== 'function') {
    throw new DomainError('REPEAT_NATIVE_HOST_REQUIRED', 'Use the existing engine limits and real native evidence adapter.', 409)
  }
  const snapshot = await input.owner.oneShotConnection().transaction((sql) => readAcceptedRepeatRunLocked(sql, input.owner.runId))
  check()
  if (snapshot.stopRequested || snapshot.cleanupPending) throw new DomainError('GRAPH_STOP_CONFLICT', 'A stopped/cleanup-pending Run cannot enter repeat execution.', 409)
  if (!['queued', 'running', 'waiting'].includes(snapshot.run.executionState)) {
    throw new DomainError('GRAPH_TERMINAL_CONFLICT', 'Terminal/interrupted repeat work requires cleanup, not another graph invocation.', 409)
  }
  const store = input.factory.forOwner(input.owner, snapshot.version)
  const boundary = repeatNativeStartStore(input, snapshot, store)
  const observeExact = repeatNativeObserver({ run: snapshot.run, version: snapshot.version, owner: input.owner,
    store: boundary.store, native: input.native, admission: input.admission, workflows: input.workflows,
    locations: input.locations, directory: boundary.directory,
    executionHostKey: execution => input.factory.executionHostKey(input.owner, execution),
    readCollaborationPrompt: execution => input.factory.readCollaborationPrompt(input.owner, execution),
    preparePlacement: execution => input.factory.preparePlacementExecution(input.owner, snapshot.run, execution) })
  const scope = { runId: snapshot.run.id, workspaceId: snapshot.run.workspaceId, workflowId: snapshot.run.workflowId,
    workflowVersionId: snapshot.version.id, executionSemanticsVersion: 3 as const }
  const driver = repeatExecutionDriver({ scope, version: snapshot.version, owner: input.owner, store, observeExact,
    abandonAttempt: async (executionId, failure) => {
      const { execution } = await store.readExecution(executionId)
      await input.native.abandonAttempt(input.owner, execution, failure)
    },
    failIntervalCheck: async (executionId, failure) => {
      const { execution } = await store.readExecution(executionId)
      await input.native.failIntervalCheck(input.owner, execution, failure)
    },
    reconcileArtifacts: (execution, signal) =>
      input.factory.reconcileWorkflowArtifacts(input.owner, snapshot.run, execution, signal) })
  // Capture the lifecycle object, rather than reading mutable context properties
  // from future callbacks. Each writer still owns its concrete SQL/native proof.
  const lifecycle = input.lifecycle
  if (!lifecycle || ['preflight', 'markRunning', 'currentState', 'persistWait', 'cancelNativeAndRequestCleanup',
    'settleRun', 'requestCleanup', 'finishNative', 'finishCleanup'].some((key) =>
    typeof lifecycle[key as keyof RepeatRuntimeLifecycle] !== 'function')
    || snapshot.version.definition.handoffs && typeof lifecycle.persistDirectionWait !== 'function') {
    throw new DomainError('REPEAT_NATIVE_HOST_REQUIRED', 'Repeat lifecycle proof writers are required.', 409)
  }
  const recordExecutionFailure = lifecycle.recordExecutionFailure?.bind(lifecycle)
  await executeRepeatRuntime({ runId: snapshot.run.id, version: snapshot.version, owner: input.owner,
    ...(input.limiter ? { limiter: input.limiter } : {}),
    checkpointOwnerGeneration: input.owner.checkpointGeneration,
    signal: input.signal, store, driver, ...(input.jobs ? { jobs: input.jobs(input.owner, snapshot.version) } : {}), checkpointer: input.checkpointer, configuredParallelism: input.configuredParallelism,
    lifecycle: {
      markRunning: () => lifecycle.markRunning(),
      currentState: () => lifecycle.currentState(),
      persistWait: (checkpoint) => lifecycle.persistWait(checkpoint),
      ...(lifecycle.persistDirectionWait ? { persistDirectionWait: () => lifecycle.persistDirectionWait!() } : {}),
      ...(recordExecutionFailure ? { recordExecutionFailure } : {}),
      cancelNativeAndRequestCleanup: () => lifecycle.cancelNativeAndRequestCleanup(),
      settleRun: (stopped, interrupted) => lifecycle.settleRun(stopped, interrupted),
      requestCleanup: (failure) => lifecycle.requestCleanup(failure),
      finishNative: () => lifecycle.finishNative(),
      finishCleanup: () => lifecycle.finishCleanup(),
      preflight: async () => {
        check()
        const current = await input.owner.oneShotConnection().transaction((sql) => readAcceptedRepeatRunLocked(sql, input.owner.runId))
        if (!sameWorkflowValue(current.version, snapshot.version)
          || !sameWorkflowValue(current.run, snapshot.run) || current.stopRequested || current.cleanupPending) {
          throw new DomainError('RUN_PIN_CONFLICT', 'The accepted Run changed before repeat runtime preflight.', 409)
        }
        await lifecycle.preflight()
        check()
      },
    },
  })
}
