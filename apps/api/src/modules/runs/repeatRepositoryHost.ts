import { reconcileMemoryHandoffsLocked } from './memoryBoardHandoffs.js'
import type { MemoryBoardService } from '../memory-boards/service.js'
import { applyMemoryEffectLocked, applyMemoryNativeLocked, prepareMemoryLaunchLocked, validateMemoryResultLocked } from './memoryBoardEffects.js'
import { createMemoryBoardHooks } from './memoryBoardHooks.js'
import { AgentConfigurationVersionSchema, SourceCapacityErrorDetailsSchema, type HarnessExecution, type ExecutionResult } from '@foreman-code/contracts'
import {
  AcceptedWorkflowRunV3Schema, ExecutableWorkflowV3Schema, WorkflowVersionV3Schema, RunWorktreeSchema,
  CurrentRunVersionSnapshotSchema, type AcceptedWorkflowRunV3, type WorkflowVersionV3,
} from '@foreman-code/contracts/wave25'
import type { WorkflowNativeProofRecord } from './workflowNativeProof.js'
import type { WorkflowResultEffectFailure } from './workflowResultEffectFailure.js'
import { DomainError } from '../errors.js'
import type { WorkflowCollaborationHooks } from '../collaboration/workflowHooks.js'

import {
  assertGraphTransaction, beforeGraphCommit, isReadOnlyGraphTransaction, type GraphTransactionSql,
} from '../run-graph/connection.js'
import { requireRepeatCanonicalReceiptBeforeCommit } from '../run-graph/repeatReceipts.js'
import { assertNativeWorkflowConfiguration } from '../harnesses/nativeWorkflowConfiguration.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'
import type { RunOwnership } from './ownership.js'
import { readAcceptedPlacement, readNativePlacement } from '../placement/persistence.js'
import { resolveExecutionDirectory } from './executionDirectory.js'
import { RepeatRunRepository, type RepeatEffect, type RepeatFact, type RepeatLockedHooks, type RepeatRepositoryHost } from './repeatPostgres.js'
import { requireRepeatNativeHooks, type RepeatNativeBoundaryEvidence, type RepeatNativeChange,
  type RepeatNativeEvidence, type RepeatLaunchClaim } from './repeatNativeRepository.js'
import { assertRepeatExecution, repeatConflict, repeatId, sameRepeatValue, type RepeatNodeRef, type RepeatScope, type RepeatSource } from './repeatResolution.js'

/** Required canonical-publication adapter on the existing Run/head transaction.
 * The central repository binds the real N1 producer; native authority and Run
 * lifecycle services remain mandatory. No v3 -> v2 coercion is permitted. */
export interface RepeatCanonicalPublication {
  readonly sql: GraphTransactionSql
  readonly scope: RepeatScope
  publishEffectLocked(effect: RepeatEffect, facts: readonly RepeatFact[], mutate: () => Promise<void>): Promise<void>
  assertEffectReceiptLocked(effect: RepeatEffect): Promise<void>
  publishNativeLocked(change: RepeatNativeChange, mutate: () => Promise<void>): Promise<void>
  /** Native sources use sourceKind='execution' and the exact supplied source ID,
   * revision and private digest, including when G1 chooses a reset barrier. */
  assertNativeReceiptLocked(change: RepeatNativeChange): Promise<void>
  assertLaunchReceiptLocked(claim: RepeatLaunchClaim, digest: string): Promise<void>
}
export interface RepeatRepositoryServices {
  collaboration?: WorkflowCollaborationHooks
  prepareCollaborationExecution?(owner: RunOwnership, run: AcceptedWorkflowRunV3,
    version: WorkflowVersionV3, execution: HarnessExecution): Promise<void>
  readCollaborationPrompt?(owner: RunOwnership, execution: HarnessExecution, version: WorkflowVersionV3): Promise<string | undefined>
  releaseCollaborationExecution?(owner: RunOwnership, execution: HarnessExecution, version: WorkflowVersionV3): Promise<void>
  memoryBoards?: MemoryBoardService
  reconcileWorkflowArtifacts?(owner: RunOwnership, run: AcceptedWorkflowRunV3,
    execution: HarnessExecution, signal: AbortSignal): Promise<void>
  preparePlacementExecution?(owner: RunOwnership, run: AcceptedWorkflowRunV3, execution: HarnessExecution): Promise<
    { workingDirectory: string; runtimeDirectory: string; revalidate(): Promise<void> } | undefined>
  admitPlacementExecutionLocked?(sql: GraphTransactionSql, owner: RunOwnership, run: AcceptedWorkflowRunV3,
    execution: HarnessExecution, ref: RepeatNodeRef, inputDigest: string): Promise<void>
  /** Must open the EXISTING canonical publication on this exact transaction and
   * existing head. It must enlist same-transaction receipt checks before COMMIT. */
  openPublicationLocked(sql: GraphTransactionSql, scope: RepeatScope, owner: RunOwnership): Promise<RepeatCanonicalPublication>
  /** Existing coordinator/manager authority; verifies exact owner/session/lane,
   * generation, possible-submission, command and raw-event provenance. */
  assertNativeBoundaryLocked(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3,
    execution: HarnessExecution, ref: RepeatNodeRef, evidence: RepeatNativeBoundaryEvidence, owner: RunOwnership): Promise<void>
  assertNativeUpdateLocked(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3,
    previous: HarnessExecution, incoming: HarnessExecution, ref: RepeatNodeRef, evidence: RepeatNativeEvidence, owner: RunOwnership,
    resultEffectFailure?: WorkflowResultEffectFailure): Promise<WorkflowNativeProofRecord>
  /** Existing engine/lifecycle policy, not a second scheduler or finishRun call. */
  assertSettlementLocked(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3, ids: readonly string[], owner: RunOwnership): Promise<void>
  allowTechnicalRetryLocked(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3,
    version: WorkflowVersionV3, execution: HarnessExecution): Promise<boolean>
  /** Complete immutable original publication mappings, resampled in this same
   * SQL transaction and before COMMIT. Never performs byte/native IO. */
  assertWorkflowArtifactOutputsLocked?(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3,
    version: WorkflowVersionV3, execution: HarnessExecution): Promise<void>
  completeRunLocked(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3,
    version: WorkflowVersionV3, terminals: readonly RepeatSource[], owner: RunOwnership): Promise<void>
}

/** The same lexical isolation helper as native runs, with the globally unique
 * execution ID as its leaf identity. node+attempt alone collides across business
 * occurrences. This computes a path only; it allocates no directory. */
export function repeatRuntimeDirectory(root: string, scope: RepeatScope, execution: HarnessExecution): string {
  if (execution.runId !== scope.runId || scope.executionSemanticsVersion !== 3) return repeatConflict('REPEAT_SCOPE_CONFLICT')
  return resolveExecutionDirectory(root, scope.runId, execution.id, execution.attempt, scope.workspaceId)
}

/** One factory/store/ephemeral permit set per EXISTING Run owner. A recovered
 * owner gets a new repository and cannot inherit a prior native launch permit. */
export class RepeatRepositoryFactory {
  private readonly stores = new WeakMap<RunOwnership, { version: WorkflowVersionV3; store: RepeatRunRepository }>()
  private readonly collaboration: WorkflowCollaborationHooks | undefined
  constructor(private readonly locations: Pick<WorkspaceLocationService, 'revalidateRunAuthorization'>,
    private readonly runtimeRoot: string, private readonly services: RepeatRepositoryServices) {
    this.collaboration = services.memoryBoards ? createMemoryBoardHooks(services.memoryBoards) : services.collaboration
    if (!locations || typeof locations.revalidateRunAuthorization !== 'function' || !runtimeRoot
      || !services || ['openPublicationLocked', 'assertNativeBoundaryLocked', 'assertNativeUpdateLocked',
        'assertSettlementLocked', 'allowTechnicalRetryLocked', 'completeRunLocked'].some((key) =>
        typeof services[key as keyof RepeatRepositoryServices] !== 'function')) return repeatConflict('REPEAT_NATIVE_HOST_REQUIRED')
  }
  forOwner(owner: RunOwnership, suppliedVersion: WorkflowVersionV3): RepeatRunRepository {
    owner.assertOwned()
    const version = WorkflowVersionV3Schema.parse(suppliedVersion)
    const prior = this.stores.get(owner)
    if (prior) {
      if (!sameRepeatValue(prior.version, version)) return repeatConflict('RUN_PIN_CONFLICT')
      return prior.store
    }
    const host: RepeatRepositoryHost = { openLocked: (sql, scope, record, actualVersion) =>
      this.openLocked(owner, sql, scope, record, actualVersion) }
    const store = new RepeatRunRepository(owner, host, version)
    this.stores.set(owner, { version, store })
    return store
  }

  existingForOwner(owner: RunOwnership): RepeatRunRepository | undefined {
    owner.assertOwned()
    return this.stores.get(owner)?.store
  }

  async executionHostKey(owner: RunOwnership, execution: HarnessExecution): Promise<string> {
    owner.assertOwned()
    if (execution.runId !== owner.runId) return repeatConflict('GRAPH_SCOPE_MISMATCH')
    const placement = await owner.oneShotConnection().transaction(sql =>
      readAcceptedPlacement(sql, execution.runId, execution.workflowNodeId), true)
    owner.assertOwned()
    return placement?.hostRef.kind === 'device' ? `device:${placement.hostRef.deviceId}` : 'main'
  }

  async preparePlacementExecution(owner: RunOwnership, run: AcceptedWorkflowRunV3, execution: HarnessExecution) {
    owner.assertOwned()
    try {
      const current = this.stores.get(owner)
      if (!current) return repeatConflict('REPEAT_NATIVE_HOST_REQUIRED')
      await current.store.assertExecutionAdmission(execution.id)
      await this.services.prepareCollaborationExecution?.(owner, run, current.version, execution)
      owner.assertOwned()
      return await this.services.preparePlacementExecution?.(owner, run, execution)
    } catch (error) {
      owner.assertOwned()
      if (error instanceof DomainError && error.code === 'SOURCE_CAPACITY' && error.details?.retryable === true) {
        throw error
      }
      const permanent = error instanceof DomainError && error.status >= 400 && error.status < 500
        && error.status !== 408 && error.status !== 429 && error.details?.retryable !== true
      if (permanent) {
        if (execution.state === 'queued' && !execution.nativeSessionId) {
          const current = this.stores.get(owner)
          if (!current) return repeatConflict('REPEAT_NATIVE_HOST_REQUIRED')
          const details = error.code === 'SOURCE_CAPACITY' && error.details
            ? SourceCapacityErrorDetailsSchema.parse(error.details) : undefined
          await current.store.failPreparation(execution.id, { outcome: 'failed', error: {
            code: error.code, message: error.message, retryable: false,
            ...(details ? { details } : {}),
          } })
        }
        throw error
      }
      // Preparation transport failures are retried from the saved checkpoint,
      // rather than treated as an interrupted native launch by the driver.
      const unavailable = new DomainError('EXECUTION_PREPARATION_UNAVAILABLE',
        'Execution preparation is temporarily unavailable.', 503, { retryable: true })
      unavailable.cause = error
      throw unavailable
    }
  }
  async reconcileWorkflowArtifacts(owner: RunOwnership, run: AcceptedWorkflowRunV3,
    execution: HarnessExecution, signal: AbortSignal): Promise<void> {
    owner.assertOwned()
    const current = this.stores.get(owner)
    if (!current) return repeatConflict('REPEAT_NATIVE_HOST_REQUIRED')
    await this.services.releaseCollaborationExecution?.(owner, execution, current.version)
    owner.assertOwned()
    return this.services.reconcileWorkflowArtifacts?.(owner, run, execution, signal)
  }
  readCollaborationPrompt(owner: RunOwnership, execution: HarnessExecution): Promise<string | undefined> {
    owner.assertOwned()
    if (!this.services.readCollaborationPrompt) return Promise.resolve(undefined)
    const current = this.stores.get(owner)
    if (!current) return repeatConflict('REPEAT_NATIVE_HOST_REQUIRED')
    return this.services.readCollaborationPrompt(owner, execution, current.version)
  }

  /** Same actual Run owner and locked hooks for the concrete Job store. */
  hostForOwner(owner: RunOwnership, version: WorkflowVersionV3): RepeatRepositoryHost {
    this.forOwner(owner, version)
    return { openLocked: (sql, scope, record, actualVersion) => this.openLocked(owner, sql, scope, record, actualVersion) }
  }

  /** Consumption never constructs a store or recreates a capability from SQL. */
  consumeLaunchPermit(owner: RunOwnership, executionId: string): boolean {
    owner.assertOwned()
    return this.stores.get(owner)?.store.consumeLaunchPermit(executionId) === true
  }

  private async openLocked(owner: RunOwnership, sql: GraphTransactionSql, scope: RepeatScope,
    record: unknown, version: WorkflowVersionV3): Promise<RepeatLockedHooks> {
    assertGraphTransaction(sql)
    owner.assertOwned()
    if (scope.runId !== owner.runId) return repeatConflict('REPEAT_SCOPE_CONFLICT')
    const run = AcceptedWorkflowRunV3Schema.parse(record)
    if (run.resultProtocol && !this.services.memoryBoards && !this.collaboration) throw new DomainError(
      'MEMORY_BOARDS_UNAVAILABLE', 'The coordination protocol requires memory board services.', 503)
    CurrentRunVersionSnapshotSchema.parse({ run, version })
    if (run.id !== scope.runId || run.workspaceId !== scope.workspaceId || run.workflowId !== scope.workflowId
      || run.workflowVersionId !== scope.workflowVersionId || scope.executionSemanticsVersion !== 3) return repeatConflict('RUN_PIN_CONFLICT')
    // The repository supplies either a locked mutation or a read-only snapshot.
    const physical = (await sql.query<{ workspace_id: string; workflow_id: string; workflow_version_id: string;
      execution_state: string; execution_semantics_version: number }>(`select r.workspace_id,r.workflow_id,r.workflow_version_id,
        r.execution_state,v.execution_semantics_version from runs r join workflow_versions v on v.id=r.workflow_version_id
        where r.id=$1`, [run.id])).rows[0]
    if (!physical || physical.workspace_id !== scope.workspaceId || physical.workflow_id !== scope.workflowId
      || physical.workflow_version_id !== scope.workflowVersionId || physical.execution_semantics_version !== 3
      || physical.execution_state !== run.executionState) return repeatConflict('RUN_PIN_CONFLICT')
    const head = await sql.query<{ protocol_version: number }>(
      `select protocol_version from run_graph_heads where run_id=$1${isReadOnlyGraphTransaction(sql) ? '' : ' for update'}`,
      [run.id])
    if (!head.rows[0] || head.rows[0].protocol_version !== 1) return repeatConflict('GRAPH_NOT_INITIALIZED')
    const publication = await this.services.openPublicationLocked(sql, scope, owner)
    if (publication.sql !== sql || !sameRepeatValue(publication.scope, scope)
      || ['publishEffectLocked', 'assertEffectReceiptLocked', 'publishNativeLocked', 'assertNativeReceiptLocked',
        'assertLaunchReceiptLocked'].some((key) => typeof publication[key as keyof RepeatCanonicalPublication] !== 'function')) {
      return repeatConflict('REPEAT_PUBLICATION_CONFLICT')
    }
    await owner.readOneShotFence(sql)
    const sameTransaction = (transaction: GraphTransactionSql) => {
      assertGraphTransaction(transaction)
      if (transaction !== sql) return repeatConflict('REPEAT_PUBLICATION_CONFLICT')
      owner.assertOwned()
    }
    let configurationsRead = false
    const configurations = async () => {
      // Immutable pins remain share-locked until this mutation commits.
      if (configurationsRead) return
      const rows = await sql.query<{ id: string; agent_id: string; workspace_id: string; record: unknown }>(
        'select id,agent_id,workspace_id,record from agent_configuration_versions where workspace_id=$1 and id=any($2::text[]) order by id for share',
        [scope.workspaceId, Object.values(version.agentConfigurationVersionIds)])
      const parsed = rows.rows.map((item) => {
        const value = AgentConfigurationVersionSchema.parse(item.record)
        if (item.id !== value.id || item.agent_id !== value.agentId || item.workspace_id !== value.workspaceId
          || item.workspace_id !== scope.workspaceId) return repeatConflict('RUN_PIN_CONFLICT')
        return value
      })
      ExecutableWorkflowV3Schema.parse({ version, configurations: parsed })
      for (const value of parsed) assertNativeWorkflowConfiguration(value.harness, run.approval,
        run.approval.handler === 'orchestrator' && value.agentId === run.approval.designatedOrchestratorAgentId)
      configurationsRead = true
    }
    let authorityEnlisted = false
    const authority = async (transaction: GraphTransactionSql, atCommit = false) => {
      sameTransaction(transaction)
      // Require the authenticated accepted Run authority. No uncredentialed-v3
      // fixture exception, inherited new grant, or read-only promotion exists.
      const id = run.authorizationPrincipalId
      await sql.query(`select principal_id from run_authority_principals
        where principal_id=$1 and run_id=$2 for share`, [id, run.id])
      await sql.query(`select p.id from management_principals p where p.id=$1
        or p.id=(select owner_principal_id from run_authority_principals where principal_id=$1 and run_id=$2)
        order by p.id for share`, [id, run.id])
      await this.locations.revalidateRunAuthorization(id, run.workspaceId, run.workflowId,
        sql, atCommit)
      await owner.readOneShotFence(sql)
      if (!authorityEnlisted) {
        authorityEnlisted = true
        // Expiry is rechecked after the source/effect finalizers. Locked grants
        // alone do not keep a credential valid through an arbitrary COMMIT.
        beforeGraphCommit(sql, () => authority(sql, true))
      }
    }
    const hooks: RepeatLockedHooks = {
      run,
      ...(this.collaboration ? { collaboration: this.collaboration } : {}),
      ...(this.services.memoryBoards ? {
        validateMemoryResultLocked: (transaction: GraphTransactionSql, execution: HarnessExecution, result: ExecutionResult) => {
          sameTransaction(transaction)
          return validateMemoryResultLocked(transaction, this.services.memoryBoards!, execution, result)
        },
        memoryWorkChangedLocked: (transaction: GraphTransactionSql, executionId: string, sourceEventKey: string) => {
          sameTransaction(transaction)
          if (version.definition.hierarchy) return Promise.resolve()
          return reconcileMemoryHandoffsLocked(transaction, this.services.memoryBoards!, executionId, sourceEventKey)
        },
        prepareMemoryLaunchLocked: (transaction: GraphTransactionSql, execution: HarnessExecution) => {
          sameTransaction(transaction)
          return prepareMemoryLaunchLocked(transaction, this.services.memoryBoards!, execution)
        },
      } : {}),
      persistDispatchLocked: async (transaction, execution, ref, inputDigest) => {
        sameTransaction(transaction)
        const node = version.definition.nodes.find(node => node.id === ref.nodeId)
        if (node?.kind !== 'job' && node?.placement && !this.services.admitPlacementExecutionLocked) return repeatConflict('REPEAT_NATIVE_HOST_REQUIRED')
        await this.services.admitPlacementExecutionLocked?.(transaction, owner, run, execution, ref, inputDigest)
      },
      assertAuthorityLocked: authority,
      ...(this.services.assertWorkflowArtifactOutputsLocked ? {
        assertWorkflowArtifactOutputsLocked: async (transaction: GraphTransactionSql, execution: HarnessExecution) => {
          sameTransaction(transaction)
          await authority(transaction)
          await this.services.assertWorkflowArtifactOutputsLocked!(transaction, run, version, execution)
        },
      } : {}),
      assertAdmissionLocked: async (transaction, execution, ref) => {
        sameTransaction(transaction)
        assertRepeatExecution(version, scope, ref, execution)
        await authority(sql)
        await configurations()
      },
      assertSettlementLocked: async (transaction, ids) => {
        sameTransaction(transaction)
        // Concrete per-execution closure proof has already run in the repository.
        // This retains additional existing global/owner obligations, not grants.
        const fence = await owner.readOneShotFence(sql)
        await this.services.assertSettlementLocked(sql, run, ids, owner)
        sameTransaction(transaction)
        if (!sameRepeatValue(fence, await owner.readOneShotFence(sql))) return repeatConflict('RUN_OWNERSHIP_LOST')
      },
      allowTechnicalRetryLocked: async (transaction, execution) => {
        sameTransaction(transaction)
        await authority(sql)
        await configurations()
        return this.services.allowTechnicalRetryLocked(sql, run, version, execution)
      },
      publishLocked: async (transaction, effect, facts, mutate) => {
        sameTransaction(transaction)
        await publication.publishEffectLocked(effect, facts, async () => {
          await mutate()
          if (this.services.memoryBoards && !version.definition.hierarchy) {
            await applyMemoryEffectLocked(transaction, this.services.memoryBoards, effect)
          }
        })
      },
      assertPublicationReceiptLocked: async (transaction, effect) => {
        sameTransaction(transaction)
        await publication.assertEffectReceiptLocked(effect)
      },
      completeRunLocked: async (transaction, terminals) => {
        sameTransaction(transaction)
        await this.services.completeRunLocked(sql, run, version, terminals, owner)
      },
      native: {
        assertLaunchLocked: async (transaction, execution, ref, paths) => {
          sameTransaction(transaction)
          assertRepeatExecution(version, scope, ref, execution)
          await authority(sql)
          await configurations()
          const placement = await readAcceptedPlacement(sql, run.id, execution.workflowNodeId)
          const native = placement && await readNativePlacement(sql, execution.id)
          if (placement && !native) return repeatConflict('RUN_LOCATION_MISSING')
          const worktreeRow = !placement && (await sql.query<{ record: unknown }>(
            `select record from run_worktrees where run_id=$1 and allocation_id in ($2,'')
              order by (allocation_id=$2) desc limit 1`, [run.id, execution.id])).rows[0]
          const worktree = worktreeRow ? RunWorktreeSchema.parse(worktreeRow.record) : undefined
          if (worktree && worktree.state !== 'active') return repeatConflict('RUN_LOCATION_MISSING')
          if (paths.workingDirectory !== (native?.workingTree.canonicalCwd ?? worktree?.workingDirectory ?? run.executionLocation.rootPath)
            || paths.runtimeDirectory !== repeatRuntimeDirectory(placement?.destination.managedRuntimeRoot ?? this.runtimeRoot, scope, execution)) return repeatConflict('RUN_LOCATION_MISSING')
        },
        assertBoundaryLocked: async (transaction, execution, ref, evidence) => {
          sameTransaction(transaction)
          assertRepeatExecution(version, scope, ref, execution)
          await authority(sql)
          await configurations()
          await this.services.assertNativeBoundaryLocked(sql, run, execution, ref, evidence, owner)
        },
        assertUpdateLocked: async (transaction, previous, incoming, ref, evidence, resultEffectFailure) => {
          sameTransaction(transaction)
          assertRepeatExecution(version, scope, ref, previous)
          assertRepeatExecution(version, scope, ref, incoming)
          return this.services.assertNativeUpdateLocked(sql, run, previous, incoming, ref, evidence, owner, resultEffectFailure)
        },
        publishLocked: async (transaction, change, mutate) => {
          sameTransaction(transaction)
          await publication.publishNativeLocked(change, async () => {
            await mutate()
            if (this.services.memoryBoards && !version.definition.hierarchy) {
              await applyMemoryNativeLocked(transaction, this.services.memoryBoards, run, change)
            }
          })
        },
        assertReceiptLocked: async (transaction, change) => {
          sameTransaction(transaction)
          await publication.assertNativeReceiptLocked(change)
          requireRepeatCanonicalReceiptBeforeCommit(sql, {
            scope, evidence: { sourceKind: 'execution', sourceId: change.sourceId, sourceRevision: change.sourceRevision },
            sourceDigest: change.sourceDigest, effect: change.effect,
          })
        },
        assertLaunchReceiptLocked: async (transaction, claim, digest) => {
          sameTransaction(transaction)
          await publication.assertLaunchReceiptLocked(claim, digest)
          requireRepeatCanonicalReceiptBeforeCommit(sql, {
            scope, evidence: { sourceKind: 'execution', sourceId: repeatId('repeat-native', scope.runId,
              claim.ref.occurrence?.occurrenceId ?? 'outside', claim.executionId, 'launch', digest), sourceRevision: '1' },
            sourceDigest: digest, effect: { kind: 'execution.launch', entityId: claim.executionId, digest },
          })
        },
      },
    }
    requireRepeatNativeHooks(hooks.native)
    return hooks
  }
}
