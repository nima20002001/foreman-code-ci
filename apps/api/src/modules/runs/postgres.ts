import {
  HarnessExecutionSchema, HarnessNativeEventSchema, RunActivitySchema,
  type ExecutionResult, type HarnessExecution, type HarnessNativeEvent, type RunActivity, type WorkflowRunSummary,
} from '@foreman-code/contracts'
import { RunDetailsV3Schema, canonicalGraphJson } from '@foreman-code/contracts/wave25'
import type pg from 'pg'
import { DomainError } from '../errors.js'
import type { PostgresWorkflowRepository } from '../workflows/postgres.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'
import { assertSameRepeatExecution } from '../interactions/repeatObservation.js'
import { beforeGraphCommit, withExclusiveGraphConnection, type GraphTransactionSql } from '../run-graph/connection.js'
import { openRepeatCanonicalPublicationLocked } from '../run-graph/repeatPublication.js'
import { withNativeGraphProjectionBatch } from '../run-graph/nativeIngestion.js'
import { RunOwnership } from './ownership.js'
import type { RepeatRepositoryActivation, RepositoryExecutionSemantics, RepositoryWorkflowRun, RunStateUpdate } from './port.js'
import { runStartSemantics } from './repeatStartDispatch.js'
import { RepeatRepositoryFactory } from './repeatRepositoryHost.js'
import { readRepeatExecutionLocked, readRepeatAcceptedResultLocked } from './repeatPostgres.js'
import { readRepeatExecutionsLocked } from './repeatExecutionRead.js'
import { readAcceptedRepeatRunSnapshot, type AcceptedRepeatRunSnapshot } from './repeatStartRead.js'
import { captureRepeatNativeEvidence, type RepeatLaunchPaths, type RepeatNativeBoundaryEvidence, type RepeatNativeEvidence } from './repeatNativeRepository.js'
import { sameRepeatValue, type RepeatNodeRef } from './repeatResolution.js'
import { markRepeatRunRunning, requestRepeatRunStop, openWorkflowLifecycleLocked, type AuthorizeWorkflowStop } from './repeatLifecycle.js'
import { requestWorkflowCleanup, finishWorkflowCleanup, settleWorkflowRun, recordWorkflowExecutionFailure } from './workflowLifecycle.js'
import type { WorkflowResumePermit } from './approvalCheckpointResume.js'
import type { WorkflowNativeLease, WorkflowApprovalCorrelation, WorkflowContinuationProof } from './workflowNativeGraph.js'
import { isWorkflowTranscriptEvent, WorkflowNativeProofServices } from './workflowNativeProof.js'
import { NATIVE_EVENT_BATCH_SIZE } from '../interactions/nativeEventBatches.js'

/** Saved pins never default to an old mode. Independent native/graph protocol
 * versions and WorkflowVersion revision numbers are not execution semantics. */
export function runRepositorySemantics(record: unknown): RepositoryExecutionSemantics {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new DomainError(
    'EXECUTION_SEMANTICS_UNSUPPORTED', 'A saved Run requires the current explicit execution pin.', 409)
  return runStartSemantics(record as { executionSemanticsVersion?: unknown })
}

/** The single current repository. Ordinary and repeated V3 work share admission,
 * native source capture, input/result receipts, owner and lifecycle writers.
 * Run creation is intentionally absent: authenticated Start owns that atomic
 * command/authority/publication transaction, not an uncredentialed create(). */
export class PostgresRunRepository {
  private readonly factory: RepeatRepositoryFactory
  private readonly nativeProof: WorkflowNativeProofServices
  constructor(private readonly pool: pg.Pool, private readonly workflows: PostgresWorkflowRepository,
    private readonly locations: WorkspaceLocationService, runtime: RepeatRepositoryActivation,
    private readonly nativeCommitted?: (evidence: RepeatNativeEvidence) => Promise<void>) {
    if (!runtime || !(runtime.native instanceof WorkflowNativeProofServices)) throw new DomainError(
      'NATIVE_CAPTURE_COMPOSITION_REQUIRED', 'Compose the real native capture/proof service before starting the product.', 500)
    this.nativeProof = runtime.native
    this.factory = new RepeatRepositoryFactory(locations, runtime.runtimeRoot, {
      ...runtime.services, openPublicationLocked: openRepeatCanonicalPublicationLocked,
    })
  }
  assertCurrentProduction(pool: pg.Pool, workflows: PostgresWorkflowRepository, locations: WorkspaceLocationService): void {
    if (this.pool !== pool || this.workflows !== workflows || this.locations !== locations
      || !(this.nativeProof instanceof WorkflowNativeProofServices)) throw new DomainError(
      'CURRENT_REPOSITORY_COMPOSITION_REQUIRED', 'The current repository must retain the actual primary-pool native proof services.', 503)
  }
  private owned(runId: string, owner?: RunOwnership): void {
    owner?.assertOwned()
    if (owner && owner.runId !== runId) throw new DomainError('GRAPH_SCOPE_MISMATCH', 'A Run cannot borrow another Run owner.', 409)
  }
  private requireOwner(runId: string, owner?: RunOwnership): RunOwnership {
    this.owned(runId, owner)
    if (!owner) throw new DomainError('RUN_OWNERSHIP_REQUIRED', 'A current workflow mutation requires its existing Run owner.', 409)
    return owner
  }
  private async read<T>(runId: string, owner: RunOwnership | undefined,
    work: (sql: GraphTransactionSql, snapshot: AcceptedRepeatRunSnapshot) => Promise<T>,
    readAcceptedRun = readAcceptedRepeatRunSnapshot): Promise<T> {
    this.owned(runId, owner)
    const body = async (sql: GraphTransactionSql) => {
      const fence = owner && await owner.readOneShotFence(sql)
      const snapshot = await readAcceptedRun(sql, runId)
      const value = await work(sql, snapshot)
      if (owner) beforeGraphCommit(sql, async () => {
        if (!sameRepeatValue(fence, await owner.readOneShotFence(sql))) throw new DomainError('RUN_OWNERSHIP_LOST', 'The Run owner changed before read completion.', 409)
      })
      return value
    }
    return owner ? owner.oneShotConnection().transaction(body, true)
      : withExclusiveGraphConnection(this.pool, (connection) => connection.transaction(body, true))
  }
  getRepeatSnapshot(runId: string, owner?: RunOwnership) {
    return this.read(runId, owner, async (_sql, snapshot) => snapshot, readAcceptedRepeatRunSnapshot)
  }
  async executionSemantics(runId: string, owner?: RunOwnership): Promise<RepositoryExecutionSemantics> {
    return runRepositorySemantics((await this.getRepeatSnapshot(runId, owner)).run)
  }
  async getRepeatVersion(runId: string, versionId: string, owner?: RunOwnership) {
    const { version } = await this.getRepeatSnapshot(runId, owner)
    if (version.id !== versionId) throw new DomainError('RUN_PIN_CONFLICT', 'Only the exact accepted workflow version can be read.', 409)
    return version
  }
  repeatRepositoryFactory(): RepeatRepositoryFactory { return this.factory }
  async repeat(owner: RunOwnership) {
    owner.assertOwned()
    // Every store transaction checks its immutable version against the locked Run.
    return this.factory.existingForOwner(owner)
      ?? this.factory.forOwner(owner, (await this.getRepeatSnapshot(owner.runId, owner)).version)
  }
  acquireOwnership(runId: string, onLost: () => void) { return RunOwnership.acquire(this.pool, runId, onLost) }
  async get(runId: string, owner?: RunOwnership): Promise<RepositoryWorkflowRun | undefined> {
    this.owned(runId, owner)
    const found = await (owner?.client ?? this.pool).query('select id from runs where id=$1', [runId])
    return found.rowCount === 0 ? undefined : (await this.getRepeatSnapshot(runId, owner)).run
  }
  async getForWorkspace(workspaceId: string, runId: string) {
    const found = await this.pool.query('select id from runs where id=$1 and workspace_id=$2', [runId, workspaceId])
    if (found.rowCount === 0) return undefined
    const run = (await this.getRepeatSnapshot(runId)).run
    if (run.workspaceId !== workspaceId) throw new DomainError('RUN_PIN_CONFLICT', 'The physical Run scope changed.', 409)
    return run
  }
  async admitRepeatExecution(ref: RepeatNodeRef, candidate: () => HarnessExecution, owner: RunOwnership) {
    return (await this.repeat(owner)).admit(structuredClone(ref), candidate)
  }
  async claimRepeatLaunch(id: string, paths: RepeatLaunchPaths, owner: RunOwnership) {
    return (await this.repeat(owner)).claimLaunch(id, { ...paths })
  }
  consumeRepeatLaunch(id: string, owner: RunOwnership) { return this.factory.consumeLaunchPermit(owner, id) }
  async recoverRepeatSession(id: string, owner: RunOwnership) { return (await this.repeat(owner)).recoverSession(id) }
  async exactRepeatSession(id: string, owner: RunOwnership) { return (await this.repeat(owner)).exactSession(id) }
  async assertRepeatNativeBoundary(id: string, owner: RunOwnership, evidence: RepeatNativeBoundaryEvidence) {
    return (await this.repeat(owner)).assertNativeBoundary(id, evidence.kind === 'first_launch' ? evidence : captureRepeatNativeEvidence(evidence))
  }
  async reserveWorkResultRepair(id: string, providerId: string, owner: RunOwnership, evidence: RepeatNativeEvidence) {
    return (await this.repeat(owner)).reserveWorkResultRepair(id, providerId, captureRepeatNativeEvidence(evidence))
  }
  async readWorkResultRepairAttempt(id: string, owner: RunOwnership) {
    return (await this.repeat(owner)).readWorkResultRepairAttempt(id)
  }
  async acceptRepeatTerminal(execution: HarnessExecution, owner: RunOwnership, candidate?: (attempt: number) => HarnessExecution) {
    const incoming = HarnessExecutionSchema.parse(structuredClone(execution))
    this.owned(incoming.runId, owner)
    return (await this.repeat(owner)).acceptTerminal(incoming.id, candidate, incoming)
  }
  async getExecution(id: string, owner?: RunOwnership): Promise<HarnessExecution | undefined> {
    owner?.assertOwned()
    const row = (await (owner?.client ?? this.pool).query<{ run_id: string }>('select run_id from harness_executions where id=$1', [id])).rows[0]
    if (!row) return undefined
    this.owned(row.run_id, owner)
    return this.read(row.run_id, owner, async (sql, snapshot) => (await readRepeatExecutionLocked(sql, snapshot, id)).execution)
  }
  async getExecutionConfiguration(id: string, execution?: HarnessExecution) {
    const configuration = await this.workflows.getAgentConfiguration(id)
    if (!configuration || !execution) return configuration
    const { version } = await this.getRepeatSnapshot(execution.runId)
    const node = version.definition.nodes.find(item => item.id === execution.workflowNodeId)
    return node && node.kind !== 'job' && node.skills
      ? this.workflows.resolveNodeSkills(configuration, node.skills, version.nodeSkillSnapshots?.[node.id])
      : configuration
  }
  async updateExecution(execution: HarnessExecution, owner: RunOwnership, evidence: RepeatNativeEvidence): Promise<void> {
    const original = captureRepeatNativeEvidence(evidence), incoming = HarnessExecutionSchema.parse(structuredClone(execution))
    this.requireOwner(incoming.runId, owner)
    await (await this.repeat(owner)).updateExecution(incoming, original)
    await this.nativeCommitted?.(original)
  }
  async getAcceptedResult(id: string, owner?: RunOwnership): Promise<ExecutionResult | undefined> {
    const execution = await this.getExecution(id, owner)
    if (!execution) return undefined
    return this.read(execution.runId, owner, (sql, snapshot) => readRepeatAcceptedResultLocked(sql, snapshot, id))
  }
  async acceptExecutionResult(execution: HarnessExecution, owner: RunOwnership): Promise<void> {
    if (execution.state !== 'completed' || execution.result?.outcome !== 'succeeded') throw new DomainError('EXECUTION_RESULT_NOT_ACCEPTABLE', 'Acceptance requires the exact successful terminal.', 409)
    await this.acceptRepeatTerminal(execution, owner)
  }
  /** Read-only idempotent coordinator entry. Only the common input.bind writer
   * creates an attempt. This method cannot create a legacy first-launch path. */
  async ensureExecution(expected: HarnessExecution, owner: RunOwnership) {
    const current = await this.getExecution(expected.id, this.requireOwner(expected.runId, owner))
    if (!current) throw new DomainError('EXECUTION_ADMISSION_REQUIRED', 'Native work requires its committed input/attempt receipt.', 409)
    assertSameRepeatExecution(expected, current)
    return { execution: current, created: false }
  }
  async appendNativeEvent(event: HarnessNativeEvent, owner: RunOwnership, lease?: WorkflowNativeLease,
    approval?: WorkflowApprovalCorrelation, continuation?: WorkflowContinuationProof, suppliedEvidence?: RepeatNativeEvidence): Promise<void> {
    if (!suppliedEvidence) throw new DomainError('NATIVE_SOURCE_NOT_CAPTURED', 'Only the original coordinator native capture can enter the journal.', 409)
    const original = HarnessNativeEventSchema.parse(structuredClone(event)), evidence = captureRepeatNativeEvidence(suppliedEvidence)
    owner.assertOwned()
    await owner.oneShotConnection().transaction(async (sql) => {
      if (approval === undefined && continuation === undefined && await this.nativeProof.tryAppendTranscriptsLocked(sql,
        [{ event: original, evidence }], owner, lease)) return
      const { snapshot } = await openWorkflowLifecycleLocked(sql, owner.runId)
      await this.nativeProof.appendEventLocked(sql, snapshot.run, original, evidence, owner, lease, approval, continuation)
    })
    await this.nativeCommitted?.(evidence)
  }
  async appendNativeEvents(input: readonly { event: HarnessNativeEvent; evidence: RepeatNativeEvidence }[],
    owner: RunOwnership, lease?: WorkflowNativeLease): Promise<void> {
    if (!input.length || input.length > NATIVE_EVENT_BATCH_SIZE) throw new DomainError(
      'NATIVE_EVENT_BATCH_INVALID', 'Native event publication requires a bounded group of captured frames.', 409)
    const frames = input.map(({ event, evidence }) => ({
      event: HarnessNativeEventSchema.parse(structuredClone(event)),
      evidence: captureRepeatNativeEvidence(evidence),
    }))
    owner.assertOwned()
    const groups: typeof frames[] = []
    for (const frame of frames) {
      const previous = groups.at(-1)
      if (previous && isWorkflowTranscriptEvent(previous[0]!.event) === isWorkflowTranscriptEvent(frame.event)) {
        previous.push(frame)
      } else {
        groups.push([frame])
      }
    }
    // Transcript groups commit before a graph writer takes the exclusive Run lock.
    for (const group of groups) {
      await owner.oneShotConnection().transaction(async (sql) => {
        if (await this.nativeProof.tryAppendTranscriptsLocked(sql, group, owner, lease)) return
        const { snapshot } = await openWorkflowLifecycleLocked(sql, owner.runId)
        await withNativeGraphProjectionBatch(sql, owner.runId,
          () => this.nativeProof.appendEventsLocked(sql, snapshot.run, group, owner, lease))
      })
      for (const { evidence } of group) await this.nativeCommitted?.(evidence)
    }
  }
  async updateState(runId: string, update: RunStateUpdate, owner: RunOwnership, resume?: WorkflowResumePermit): Promise<void> {
    await markRepeatRunRunning(this.requireOwner(runId, owner), this.locations, update, resume)
  }
  async requestStop(runId: string, authorize: AuthorizeWorkflowStop): Promise<void> {
    await requestRepeatRunStop(this.pool, runId, authorize)
  }
  async hasRequestedStop(runId: string, owner?: RunOwnership): Promise<boolean> { return (await this.getRepeatSnapshot(runId, owner)).stopRequested }
  async hasPendingCleanup(runId: string, owner?: RunOwnership): Promise<boolean> { return (await this.getRepeatSnapshot(runId, owner)).cleanupPending }
  /** Record one attempt's own failure cause without fencing its Run. */
  async recordExecutionFailure(owner: RunOwnership, executionId: string, failure: ExecutionResult): Promise<void> {
    await recordWorkflowExecutionFailure(this.requireOwner(owner.runId, owner), executionId, failure)
  }
  async requestCleanup(runId: string, owner?: RunOwnership, failure?: ExecutionResult,
    options?: { executionId: string }): Promise<void> {
    await requestWorkflowCleanup(this.pool, runId, owner, failure, options)
  }
  async finishCleanup(runId: string, failed: boolean, owner: RunOwnership): Promise<void> { await finishWorkflowCleanup(this.requireOwner(runId, owner), failed) }
  async settleOrphan(runId: string, owner: RunOwnership, canceled: boolean): Promise<boolean> {
    this.requireOwner(runId, owner)
    const snapshot = await this.getRepeatSnapshot(runId, owner)
    if (snapshot.run.executionState === 'completed') return false
    if (snapshot.stopRequested !== canceled) throw new DomainError('GRAPH_STOP_CONFLICT', 'Use the current durable Stop fence, not a stale cancellation flag.', 409)
    const store = await this.repeat(owner)
    for await (const page of this.executionPages(runId, owner)) {
      for (const execution of page) await store.settleNegativeExecution(execution.id, canceled)
    }
    return settleWorkflowRun(owner, !canceled)
  }
  async listRepeatExecutions(runId: string, afterId = '', limit = 100, owner?: RunOwnership) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || typeof afterId !== 'string') throw new DomainError('REPEAT_READ_BOUND_INVALID', 'Use an execution-ID cursor and a limit from 1 to 1000.', 409)
    return this.read(runId, owner, async (sql, snapshot) => {
      const ids = (await sql.query<{ id: string }>('select id from harness_executions where run_id=$1 and id>$2 order by id limit $3', [runId, afterId, limit])).rows
      return readRepeatExecutionsLocked(sql, snapshot, ids.map(({ id }) => id))
    })
  }
  async *executionPages(runId: string, owner?: RunOwnership): AsyncGenerator<HarnessExecution[]> {
    let after = ''
    for (;;) {
      const page = (await this.listRepeatExecutions(runId, after, 100, owner)).map((item) => item.execution)
      if (page.length) yield page
      if (page.length < 100) return
      after = page[page.length - 1]!.id
    }
  }
  async reconciliationCandidates(afterId = '', limit = 100): Promise<{ id: string }[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new DomainError('RUN_READ_LIMIT', 'Use a bounded Run cursor.', 409)
    // Failed Main-local Runs can outlive their detached runtime. Selection still requires physical closure in cleanup.
    const rows = (await this.pool.query<{ id: string }>(`select id from runs where id>$1 and
      ((execution_state in ('queued','running','waiting') and not exists(
          select 1 from run_work_direction_waits d
            join durable_interactions i on i.run_id=d.run_id
          where d.run_id=runs.id and d.workflow_version_id=runs.workflow_version_id
            and runs.execution_state='waiting' and runs.record->>'executionState'='waiting'
            and runs.record->>'outcome'='pending' and runs.stop_requested_at is null
            and i.record->>'kind'='work_direction' and i.status in ('pending','delivery_pending')))
        or exists(select 1 from run_cleanup_intents c where c.run_id=runs.id and c.pending)
        or (execution_state='completed' and record->>'outcome'='failed'
          and exists(select 1 from harness_executions e
            join lateral (select * from execution_native_closures where execution_id=e.id
              order by generation desc limit 1) c on true
            where e.run_id=runs.id and c.detached_at is not null and c.closed_at is null
              and not exists(select 1 from execution_native_recoveries p where p.generation=c.generation)
              and not exists(select 1 from run_node_placements p where p.run_id=e.run_id
                and p.node_id=e.workflow_node_id and p.record#>>'{hostRef,kind}'='device'))))
      order by id limit $2`, [afterId, limit])).rows
    return rows
  }
  async remainingApprovalTime(runId: string, executionIds: string[], owner: RunOwnership): Promise<number> {
    this.requireOwner(runId, owner)
    const ids = [...new Set(executionIds)]
    if (!ids.length || ids.length > 1000) throw new DomainError('RUN_READ_LIMIT', 'Approval budgets require exact bounded executions.', 409)
    const result = await owner.client.query<{ remaining_ms: string; stopped_at: Date | null }>(`select
      (b.active_timeout_ms-b.active_elapsed_ms-case when b.approval_wait_started_at is not null then 0
        else greatest(0,coalesce(extract(epoch from(clock_timestamp()-b.active_started_at))*1000,0)) end)::text as remaining_ms,b.stopped_at
      from approval_execution_state b join harness_executions e on e.id=b.execution_id where e.run_id=$1 and e.id=any($2::text[])`, [runId, ids])
    if (result.rows.length !== ids.length || result.rows.some((row) => row.stopped_at || !Number.isFinite(Number(row.remaining_ms)))) throw new DomainError('EXECUTION_STOPPED', 'An exact resumed execution lacks an active budget.', 409)
    return Math.max(0, Math.min(...result.rows.map((row) => Number(row.remaining_ms))))
  }
  async getDetails(workspaceId: string, runId: string) {
    if (!(await this.getForWorkspace(workspaceId, runId))) return undefined
    return this.read(runId, undefined, async (sql, snapshot) => {
      const ids = (await sql.query<{ id: string }>('select id from harness_executions where run_id=$1 order by id limit 1001', [runId])).rows
      if (ids.length > 1000) throw new DomainError('RUN_DETAIL_LIMIT', 'Use the paged history/occurrence detail APIs for this Run.', 409)
      const stored = await readRepeatExecutionsLocked(sql, snapshot, ids.map(({ id }) => id))
      const executions = stored.map(item => item.execution)
      const activity = await this.activityLocked(sql, runId)
      const details = { run: snapshot.run, executions, activity, cleanupPending: snapshot.cleanupPending }
      try { canonicalGraphJson(details, 4 * 1024 * 1024) } catch { throw new DomainError('RUN_DETAIL_LIMIT', 'Use paged history for this Run.', 409) }
      return RunDetailsV3Schema.parse(details)
    })
  }
  private async activityLocked(sql: GraphTransactionSql, runId: string): Promise<RunActivity[]> {
    const rows = (await sql.query<{ sequence: string; source: RunActivity['source']; kind: RunActivity['kind'];
      harness_execution_id: string | null; occurred_at: Date; payload: Record<string, unknown> }>(
      'select sequence::text,source,kind,harness_execution_id,occurred_at,payload from run_activity where run_id=$1 order by sequence limit 1001', [runId])).rows
    if (rows.length > 1000) throw new DomainError('RUN_DETAIL_LIMIT', 'Use paged history rather than an unbounded activity list.', 409)
    return rows.map((row) => RunActivitySchema.parse({ id: `activity-${runId}-${row.sequence}`, runId,
      sequence: Number(row.sequence), source: row.source, kind: row.kind, occurredAt: row.occurred_at.toISOString(),
      ...(row.harness_execution_id ? { harnessExecutionId: row.harness_execution_id } : {}), payload: row.payload }))
  }
  listActivity(runId: string) { return this.read(runId, undefined, (sql) => this.activityLocked(sql, runId)) }
  async listSummaries(workspaceId: string): Promise<WorkflowRunSummary[]> {
    const rows = (await this.pool.query<{ id: string }>(`select r.id from runs r where r.workspace_id=$1 and
      (r.execution_state<>'completed' or exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending)
        or r.id in(select id from runs where workspace_id=$1 order by created_at desc,id desc limit 20)) order by r.created_at desc,r.id desc limit 1001`, [workspaceId])).rows
    if (rows.length > 1000) throw new DomainError('RUN_READ_LIMIT', 'Use the authorized paged Run list.', 409)
    const summaries: WorkflowRunSummary[] = []
    for (const { id } of rows) {
      const { run, cleanupPending } = await this.getRepeatSnapshot(id)
      summaries.push({ id: run.id, workspaceId: run.workspaceId, workflowId: run.workflowId,
        executionCondition: run.executionCondition, executionState: run.executionState, outcome: run.outcome,
        authRequired: false, browserWait: null, cleanupPending,
        ...(run.stopCause ? { stopCause: run.stopCause } : {}), runnerHealth: { status: 'healthy', checkedAt: new Date().toISOString() },
        ...(run.startedAt ? { startedAt: run.startedAt } : {}), ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}) })
    }
    return summaries
  }
}
