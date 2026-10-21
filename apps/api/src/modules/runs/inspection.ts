import type pg from 'pg'
import { z } from 'zod'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { JobWorkflowExecutionReferenceSchema } from '@foreman-code/contracts/job-workflow'
import {
  RUN_INSPECTION_LIMITS, RunAcceptedInputValueSchema, RunExecutionBindingSchema,
  RunExecutionBindingsListInputSchema, RunExecutionBindingsPageSchema,
  RunExecutionDetailSchema, RunExecutionGetInputSchema, RunExecutionSummarySchema,
  RunExecutionsListInputSchema, RunExecutionsPageSchema, RunInspectionRunSchema,
  RunVersionDetailSchema, RunVersionGetInputSchema, RepeatOccurrenceIdentityV1Schema,
  AcceptedCurrentNodeResultSchema, GraphDigestSchema, NodeResolutionSchema,
  canonicalGraphJson, RunRecordGetInputSchema, RunRecordDetailSchema, WorkflowRunV3Schema,
  type RunExecutionBindingsPage, type RunExecutionDetail, type RunExecutionSummary,
  type RunExecutionsPage, type RunVersionDetail, type RunRecordDetail, type GraphExecutionIdentity,
} from '@foreman-code/contracts/wave25'
import { isAuthorized, requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import { JobRepository } from '../jobs/repository.js'
import { WorkflowJobPreparationSchema } from '../jobs/workflowPreparation.js'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { canonicalRepeatEffectReceipt } from '../run-graph/repeatPublication.js'
import { assertRepeatCanonicalReceiptLocked } from '../run-graph/repeatReceipts.js'
import { withCurrentRunRead } from './currentRead.js'
import { readRecordedRepeatRunSnapshot, type AcceptedRepeatRunSnapshot } from './repeatStartRead.js'
import {
  readRecordedExecutionResultLocked, readRepeatDecision, readRepeatExecutionLocked,
  type StoredRepeatExecution,
} from './repeatPostgres.js'
import {
  assertRepeatRef, repeatDigest, repeatExecutionIdentity, repeatId, repeatSlotId, repeatTickIndex,
  sameRepeatValue, tickSlotId, workActivationSlotId,
  type RepeatScope,
} from './repeatResolution.js'
import { INSPECTION_OCCURRENCE_COLUMNS, inspectionExecutionsQuery } from './inspectionPageQuery.js'
import {
  decodeBindingPageCursor, decodeExecutionPageCursor, encodeBindingPageCursor, encodeExecutionPageCursor,
} from './inspectionCursor.js'

function evidence(value: unknown): asserts value {
  if (!value) throw new DomainError('RUN_INSPECTION_EVIDENCE_CONFLICT',
    'The inspection conflicts with its exact persisted scope or accepted evidence.', 409)
}
function scopeOf({ run }: AcceptedRepeatRunSnapshot): RepeatScope {
  return { workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id,
    workflowVersionId: run.workflowVersionId, executionSemanticsVersion: 3 }
}
function runSummary(snapshot: AcceptedRepeatRunSnapshot) {
  const { run } = snapshot
  return RunInspectionRunSchema.parse({ ...scopeOf(snapshot), executionState: run.executionState, outcome: run.outcome,
    ...(run.result?.error ? { failure: run.result.error } : {}),
    createdAt: run.createdAt, ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    ...(run.stopCause === undefined ? {} : { stopCause: run.stopCause }), cleanupPending: snapshot.cleanupPending })
}
type StoredInspectionExecution = StoredRepeatExecution & { executorKind: 'agent' } | {
  executorKind: 'job'; execution: JobExecutionRecord; identity: Extract<GraphExecutionIdentity, { kind: 'job' }>;
  ref: StoredRepeatExecution['ref']; accepted: boolean; terminalProcessed: boolean;
  slotId: string; input: StoredRepeatExecution['input']; inputDigest: string;
}
function executionIdentity(stored: StoredInspectionExecution) {
  return stored.executorKind === 'job' ? stored.identity : repeatExecutionIdentity(stored.execution)
}
function summaryOf(stored: StoredInspectionExecution): RunExecutionSummary {
  const { execution, ref, accepted } = stored
  if (stored.executorKind === 'job') {
    const job = stored.execution
    return RunExecutionSummarySchema.parse({ ...stored.identity,
      state: job.process.phase === 'preparing' ? 'starting' : job.process.phase === 'terminal' ? 'completed' : job.process.phase,
      createdAt: job.createdAt, ...(job.startedAt === null ? {} : { startedAt: job.startedAt }),
      ...(job.finishedAt === null ? {} : { finishedAt: job.finishedAt }),
      ...(ref.occurrence ? { occurrence: ref.occurrence } : {}), acceptedResultAvailable: accepted })
  }
  const tickIndex = repeatTickIndex(stored.input)
  return RunExecutionSummarySchema.parse({ ...repeatExecutionIdentity(stored.execution), state: stored.execution.state,
    ...(stored.execution.sessionContinuation ? { continuedFromExecutionId: stored.execution.sessionContinuation.previousExecutionId } : {}),
    ...(tickIndex === undefined ? {} : { tickIndex }),
    ...(stored.execution.result?.error ? { failure: stored.execution.result.error } : {}),
    createdAt: execution.createdAt, ...(execution.startedAt === undefined ? {} : { startedAt: execution.startedAt }),
    ...(execution.finishedAt === undefined ? {} : { finishedAt: execution.finishedAt }),
    ...(ref.occurrence ? { occurrence: ref.occurrence } : {}), acceptedResultAvailable: accepted })
}
function bounded<T>(value: T): T {
  try { canonicalGraphJson(value, RUN_INSPECTION_LIMITS.responseBytes) }
  catch { throw new DomainError('RUN_INSPECTION_TOO_LARGE', 'The exact inspection exceeds its response bound; it was not truncated.', 409) }
  return value
}

interface OccurrenceRow {
  occurrence_id: string | null; occurrence_run_id: string | null; occurrence_workspace_id: string | null;
  occurrence_workflow_id: string | null; occurrence_version_id: string | null;
  occurrence_block_id: string | null; occurrence_index: number | null; occurrence_identity: unknown;
}

function occurrenceOf(row: OccurrenceRow, snapshot: AcceptedRepeatRunSnapshot) {
  const identity = RepeatOccurrenceIdentityV1Schema.parse(row.occurrence_identity)
  evidence(sameRepeatValue(identity.scope, scopeOf(snapshot)) && identity.occurrenceId === row.occurrence_id
    && identity.blockId === row.occurrence_block_id && identity.occurrenceIndex === row.occurrence_index
    && row.occurrence_run_id === snapshot.run.id && row.occurrence_workspace_id === snapshot.run.workspaceId
    && row.occurrence_workflow_id === snapshot.run.workflowId && row.occurrence_version_id === snapshot.run.workflowVersionId)
  const block = snapshot.version.definition.repeat?.blocks.find((item) => item.id === identity.blockId)
  evidence(block && identity.occurrenceIndex <= block.maxOccurrences)
  return identity
}
interface ExecutionRow extends OccurrenceRow {
  id: string; run_id: string; workflow_node_id: string; agent_id: string | null; attempt: number;
  job_pinned?: boolean;
  job_definition_revision?: number | null;
  repeat_occurrence_id: string | null; accepted: boolean; summary: unknown; reported_outcome: string | null;
  page_created_at: string; identity: unknown; identity_run_id: string | null;
  identity_occurrence_id: string | null; technical_attempt: number | null;
  slot_id: string | null; slot_run_id: string | null; slot_node_id: string | null; slot_occurrence_id: string | null;
  work_activation_id?: string | null; native_work_activation_id?: string | null; attempt_work_activation_id?: string | null;
}
export function inspectionExecutionRowSummary(row: ExecutionRow, snapshot: AcceptedRepeatRunSnapshot): RunExecutionSummary {
  const summary = RunExecutionSummarySchema.parse(row.summary)
  const occurrence = row.repeat_occurrence_id === null ? null : occurrenceOf(row, snapshot)
  const ref = { nodeId: summary.workflowNodeId, occurrence }, scope = scopeOf(snapshot)
  assertRepeatRef(snapshot.version, scope, ref)
  const activationId = row.work_activation_id ?? null
  const tickIndex = summary.tickIndex ?? null
  evidence(tickIndex !== null
    ? summary.kind !== 'job' && occurrence === null
      && activationId === null && (row.native_work_activation_id ?? null) === null && (row.attempt_work_activation_id ?? null) === null
    : (snapshot.version.definition.handoffs
      ? summary.kind !== 'job' && activationId !== null && activationId.length > 0 && occurrence === null
        && row.native_work_activation_id === activationId && row.attempt_work_activation_id === activationId
      : activationId === null && (row.native_work_activation_id ?? null) === null && (row.attempt_work_activation_id ?? null) === null))
  const slotId = tickIndex !== null ? tickSlotId(scope.runId, ref.nodeId, tickIndex)
    : activationId ? workActivationSlotId(scope.runId, activationId) : repeatSlotId(scope.runId, ref)
  const node = snapshot.version.definition.nodes.find((item) => item.id === ref.nodeId)!
  const identity = summary.kind === 'job'
    ? { kind: summary.kind, executionId: summary.executionId, workflowNodeId: summary.workflowNodeId,
      jobDefinitionId: summary.jobDefinitionId, jobDefinitionVersionId: summary.jobDefinitionVersionId, attempt: summary.attempt }
    : { ...(summary.kind === undefined ? {} : { kind: summary.kind }), executionId: summary.executionId,
      workflowNodeId: summary.workflowNodeId, agentId: summary.agentId,
      agentConfigurationVersionId: summary.agentConfigurationVersionId, attempt: summary.attempt }
  evidence(summary.kind === 'job' ? row.job_pinned === true && node.kind === 'job' && summary.jobDefinitionId === node.jobDefinitionId
    && row.job_definition_revision === node.jobDefinitionRevision
    && summary.jobDefinitionVersionId === node.jobDefinitionVersionId
    : node.kind !== 'job' && row.agent_id === summary.agentId && node.agentId === summary.agentId
      && snapshot.version.agentConfigurationVersionIds[summary.agentId] === summary.agentConfigurationVersionId)
  evidence(row.run_id === scope.runId && row.id === identity.executionId && row.workflow_node_id === identity.workflowNodeId
    && row.attempt === identity.attempt
    && row.identity_run_id === scope.runId && row.slot_run_id === scope.runId && row.slot_node_id === ref.nodeId
    && row.slot_id === slotId && row.technical_attempt === identity.attempt
    && row.slot_occurrence_id === row.repeat_occurrence_id && row.identity_occurrence_id === row.repeat_occurrence_id
    && (occurrence?.occurrenceId ?? null) === row.repeat_occurrence_id
    && sameRepeatValue(row.identity, occurrence ? { ...identity, occurrence } : identity)
    && summary.acceptedResultAvailable === row.accepted
    && (summary.state === 'completed'
      ? summary.finishedAt !== undefined && ['succeeded', 'failed', 'canceled'].includes(row.reported_outcome ?? '')
      : summary.finishedAt === undefined && row.reported_outcome === null)
    && (!row.accepted || (summary.state === 'completed' && row.reported_outcome === 'succeeded')))
  return { ...summary, ...(occurrence ? { occurrence } : {}) }
}

/** ONE read-only service for management HTTP and authenticated Operator MCP.
 * Admission's immutable readers and exact receipt readers are reused, not a
 * second repository/engine, moving-head projection or lifetime-sized detail. */
export class RunInspectionService {
  constructor(private readonly pool: pg.Pool) {}

  private async read<T>(principal: ManagementPrincipal, input: { workspaceId: string; runId: string },
    work: (sql: GraphTransactionSql, snapshot: AcceptedRepeatRunSnapshot, live: ManagementPrincipal) => Promise<T>,
    readAcceptedRun = readRecordedRepeatRunSnapshot): Promise<T> {
    try {
      return await withCurrentRunRead(this.pool, principal, input.workspaceId, input.runId, 'runs:read', work, readAcceptedRun)
    } catch (caughtError) {
      let error = caughtError
      // Preserve inspection's error contract when the shared reader wraps a deadline.
      if (error instanceof DomainError && error.code === 'DATABASE_READ_TIMEOUT' && error.cause) {
        error = error.cause
      }
      // Do not serialize parser fragments of private persisted input/native data.
      if (error instanceof z.ZodError || error instanceof SyntaxError) throw new DomainError(
        'RUN_INSPECTION_EVIDENCE_CONFLICT', 'Persisted inspection evidence is invalid or unavailable.', 409, undefined, { cause: caughtError })
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      const readTimeout = error instanceof Error && error.message === 'Query read timeout'
      const reasons: Record<string, string> = {
        '57014': 'query_canceled', '55P03': 'lock_timeout', '40P01': 'deadlock',
        '53300': 'connection_limit', '42P01': 'schema_unavailable', '42703': 'schema_unavailable',
      }
      if (readTimeout || Object.hasOwn(reasons, code)
        || ['ECONNREFUSED', 'ECONNRESET', '57P01', '57P02', '57P03'].includes(code) || code.startsWith('08')) {
        const failure = new DomainError('RUN_INSPECTION_UNAVAILABLE',
          readTimeout ? 'The Run inspection query exceeded its database read deadline.' : 'The Run inspection store is unavailable.',
          503, { retryable: true, reason: readTimeout ? 'query_read_timeout' : reasons[code] ?? 'connection_unavailable',
            ...(/^\d[A-Z0-9]{4}$/.test(code) ? { sqlState: code } : {}) })
        // Retain the original exception for server diagnostics; HTTP/MCP expose
        // only the static reason and SQLSTATE, never private database text.
        failure.cause = error
        throw failure
      }
      throw error
    }
  }

  /** Run-only disclosure. The shared transaction checks live Run grants, exact
   * version/configuration/location pins and persisted lifecycle/cleanup facts.
   * Do not compose aggregate detail (or even an execution page) for this read. */
  async record(principal: ManagementPrincipal, raw: unknown): Promise<RunRecordDetail> {
    const input = RunRecordGetInputSchema.parse(raw)
    return this.read(principal, input, async (_sql, snapshot, live) => {
      // Parse a public copy: redaction must not mutate the accepted snapshot.
      const run = WorkflowRunV3Schema.parse(snapshot.run)
      delete run.authorizationPrincipalId
      if (!isAuthorized(live, 'workspace_locations:read', { workspaceId: run.workspaceId })) delete run.executionLocation
      // Bound before output validation so an oversized exact record has the same
      // explicit error on HTTP and MCP, never an input/result truncation.
      return RunRecordDetailSchema.parse(bounded({ run, stopRequested: snapshot.stopRequested,
        cleanupPending: snapshot.cleanupPending }))
    }, readRecordedRepeatRunSnapshot)
  }

  async executions(principal: ManagementPrincipal, raw: unknown): Promise<RunExecutionsPage> {
    const input = RunExecutionsListInputSchema.parse(raw)
    return this.read(principal, input, async (sql, snapshot) => {
      const scope = scopeOf(snapshot)
      if (input.workflowNodeId && !snapshot.version.definition.nodes.some((node) => node.id === input.workflowNodeId)) {
        throw new DomainError('WORKFLOW_NODE_NOT_FOUND', 'The node is not in this Run\'s pinned version.', 404)
      }
      if (input.occurrenceId) {
        const found = (await sql.query<OccurrenceRow>(`select ${INSPECTION_OCCURRENCE_COLUMNS} from run_repeat_occurrences o
          where o.run_id=$1 and o.occurrence_id=$2`, [input.runId, input.occurrenceId])).rows[0]
        if (!found) throw new DomainError('RUN_OCCURRENCE_NOT_FOUND', 'The occurrence was not found in this Run.', 404)
        const occurrence = occurrenceOf(found, snapshot)
        if (input.workflowNodeId && !snapshot.version.definition.repeat?.blocks.find((block) => block.id === occurrence.blockId)
          ?.nodeIds.includes(input.workflowNodeId)) throw new DomainError('WORKFLOW_NODE_NOT_FOUND', 'The node is not in this occurrence.', 404)
      }
      const cursorScope = [scope, input.workflowNodeId ?? null, input.occurrenceId ?? null]
      const after = decodeExecutionPageCursor(cursorScope, input.cursor)
      // One bounded metadata query. In particular, do not select e.record, input_json,
      // results, native events or the Run's entire execution/occurrence history.
      const query = inspectionExecutionsQuery(input, after)
      const rows = (await sql.query<ExecutionRow>(query.text, query.values)).rows
      const summaries = rows.map((row) => inspectionExecutionRowSummary(row, snapshot))
      const last = rows[Math.min(rows.length, input.limit) - 1]
      return bounded(RunExecutionsPageSchema.parse({ run: runSummary(snapshot), items: summaries.slice(0, input.limit),
        pageInfo: { nextCursor: rows.length > input.limit && last ? encodeExecutionPageCursor(cursorScope,
          { createdAt: last.page_created_at, executionId: last.id }) : null } }))
    })
  }

  private async execution(sql: GraphTransactionSql, snapshot: AcceptedRepeatRunSnapshot, executionId: string): Promise<StoredInspectionExecution> {
    const found = await sql.query('select id from harness_executions where id=$1 and run_id=$2', [executionId, snapshot.run.id])
    if (found.rows.length === 1) return { ...await readRepeatExecutionLocked(sql, snapshot, executionId), executorKind: 'agent' }
    const row = (await sql.query<OccurrenceRow & { reference: unknown; input_json: string; accepted: boolean;
      terminal_processed: boolean; identity: unknown; technical_attempt: number; slot_id: string;
      slot_input: string; input_digest: string; preparation: unknown; occurrence_key: string | null }>(`
      select w.reference,w.input_json,w.accepted as terminal_processed,r.execution_id is not null as accepted,
        x.identity,x.technical_attempt,x.slot_id,x.occurrence_id as occurrence_key,
        s.input_json as slot_input,s.input_digest,p.preparation,${INSPECTION_OCCURRENCE_COLUMNS}
      from workflow_job_executions w left join run_repeat_executions x on x.run_id=w.run_id and x.execution_id=w.node_execution_id
      left join run_repeat_slots s on s.slot_id=x.slot_id and s.run_id=w.run_id
      left join workflow_job_preparations p on p.slot_id=s.slot_id and p.run_id=w.run_id
      left join run_repeat_occurrences o on o.occurrence_id=x.occurrence_id and o.run_id=w.run_id
      left join run_repeat_results r on r.execution_id=w.job_execution_id and r.run_id=w.run_id
      where w.run_id=$1 and w.node_execution_id=$2`, [snapshot.run.id, executionId])).rows[0]
    if (!row) throw new DomainError('RUN_EXECUTION_NOT_FOUND', 'The execution was not found in this Run.', 404)
    const scope = scopeOf(snapshot), reference = JobWorkflowExecutionReferenceSchema.parse(row.reference)
    const execution = await new JobRepository().execution(sql, scope.workspaceId, executionId)
    const occurrence = row.occurrence_key === null ? null : occurrenceOf(row, snapshot)
    const ref = { nodeId: reference.nodeId, occurrence }
    assertRepeatRef(snapshot.version, scope, ref)
    const node = snapshot.version.definition.nodes.find((node) => node.id === ref.nodeId)
    evidence(node?.kind === 'job')
    const identity: Extract<GraphExecutionIdentity, { kind: 'job' }> = { kind: 'job', executionId, workflowNodeId: ref.nodeId,
      jobDefinitionId: node.jobDefinitionId, jobDefinitionVersionId: node.jobDefinitionVersionId, attempt: row.technical_attempt }
    const preparation = WorkflowJobPreparationSchema.parse(row.preparation), input = RunAcceptedInputValueSchema.parse(JSON.parse(row.input_json))
    evidence(reference.workspaceId === scope.workspaceId && reference.workflowId === scope.workflowId
      && reference.workflowVersionId === scope.workflowVersionId && reference.runId === scope.runId
      && reference.jobExecutionId === executionId && reference.nodeExecutionId === executionId
      && reference.occurrenceId === (occurrence?.occurrenceId ?? null) && reference.occurrenceIndex === (occurrence?.occurrenceIndex ?? 0)
      && execution.workflow?.runId === scope.runId && execution.workflow.workflowId === scope.workflowId
      && execution.workflow.nodeId === ref.nodeId && execution.workflow.nodeExecutionId === executionId
      && execution.acceptedSpec.definitionId === node.jobDefinitionId && execution.acceptedSpec.definitionRevision === node.jobDefinitionRevision
      && execution.acceptedSpec.definitionVersionId === node.jobDefinitionVersionId && row.technical_attempt === 1
      && sameRepeatValue(row.identity, occurrence ? { ...identity, occurrence } : identity)
      && row.slot_id === repeatSlotId(scope.runId, ref) && row.slot_input === row.input_json
      && repeatDigest(input, 4 * 1024 * 1024) === row.input_digest
      && sameRepeatValue(input, execution.acceptedSpec.workflowInput) && sameRepeatValue(input, preparation.input)
      && sameRepeatValue(input.occurrence?.identity ?? null, occurrence) && sameRepeatValue(input.runInput, snapshot.run.input)
      && preparation.inputDigest === row.input_digest && preparation.executionId === executionId
      && preparation.attemptId === execution.attemptId && preparation.operationId === execution.operationId
      && preparation.workspaceId === scope.workspaceId && preparation.workflowId === scope.workflowId
      && preparation.workflowVersionId === scope.workflowVersionId && preparation.runId === scope.runId && preparation.nodeId === ref.nodeId)
    await this.jobEffect(sql, scope, 'input.bind', executionId)
    return { executorKind: 'job', execution, identity, ref, input, inputDigest: row.input_digest,
      slotId: row.slot_id, accepted: row.accepted, terminalProcessed: row.terminal_processed }
  }

  private async jobEffect(sql: GraphTransactionSql, scope: RepeatScope, kind: 'input.bind' | 'terminal.accept', entityId: string) {
    const rows = (await sql.query<{ payload_digest: string }>(
      'select payload_digest from run_repeat_effects where run_id=$1 and effect_kind=$2 and entity_id=$3', [scope.runId, kind, entityId])).rows
    evidence(rows.length === 1 && GraphDigestSchema.safeParse(rows[0]?.payload_digest).success)
    await assertRepeatCanonicalReceiptLocked(sql, canonicalRepeatEffectReceipt(scope, { kind, entityId, digest: rows[0]!.payload_digest }))
  }

  private async acceptedResult(sql: GraphTransactionSql, snapshot: AcceptedRepeatRunSnapshot, stored: StoredInspectionExecution) {
    if (stored.executorKind === 'agent') return readRecordedExecutionResultLocked(sql, snapshot, stored.execution.id)
    if (!stored.accepted) {
      if (stored.terminalProcessed) await this.jobEffect(sql, scopeOf(snapshot), 'terminal.accept', stored.execution.id)
      return undefined
    }
    const result = (await sql.query<{ result_json: string; result_digest: string; occurrence_id: string | null }>(
      'select result_json,result_digest,occurrence_id from run_repeat_results where execution_id=$1 and run_id=$2',
      [stored.execution.id, snapshot.run.id])).rows[0]
    const resolutionRow = (await sql.query<{ record: { value: unknown } }>(
      'select record from run_repeat_resolutions where run_id=$1 and occurrence_key=$2 and workflow_node_id=$3',
      [snapshot.run.id, stored.ref.occurrence?.occurrenceId ?? '', stored.ref.nodeId])).rows[0]
    evidence(result && resolutionRow && stored.terminalProcessed && stored.execution.process.phase === 'terminal' && stored.execution.process.processStopped)
    const value = AcceptedCurrentNodeResultSchema.parse(JSON.parse(result.result_json))
    const resolution = NodeResolutionSchema.parse(resolutionRow.record.value)
    const output = z.object({ data: z.unknown().optional(), latestDeliverable: z.unknown().optional() }).passthrough().parse(value.output)
    const data = z.object({ latestDeliverable: z.object({ jobExecutionId: z.string(), process: z.unknown() }).passthrough() }).passthrough()
      .parse(output.data === undefined ? output : output.data)
    evidence(value.outcome === 'succeeded' && repeatDigest(value, RUN_INSPECTION_LIMITS.resultBytes) === result.result_digest
      && result.occurrence_id === (stored.ref.occurrence?.occurrenceId ?? null) && resolution.resolution === 'succeeded'
      && resolution.workflowNodeId === stored.ref.nodeId && sameRepeatValue(resolution.execution, stored.identity)
      && resolution.acceptedResultDigest === result.result_digest && data.latestDeliverable.jobExecutionId === stored.execution.id
      && sameRepeatValue(data.latestDeliverable.process, { outcome: stored.execution.process.outcome,
        exitCode: stored.execution.process.exitCode, signal: stored.execution.process.signal }))
    await this.jobEffect(sql, scopeOf(snapshot), 'terminal.accept', stored.execution.id)
    return value
  }

  async executionDetail(principal: ManagementPrincipal, raw: unknown): Promise<RunExecutionDetail> {
    const input = RunExecutionGetInputSchema.parse(raw)
    return this.read(principal, input, async (sql, snapshot) => {
      const stored = await this.execution(sql, snapshot, input.executionId)
      const accepted = await this.acceptedResult(sql, snapshot, stored)
      evidence(stored.accepted === (accepted !== undefined))
      return bounded(RunExecutionDetailSchema.parse({ run: runSummary(snapshot), execution: summaryOf(stored),
        acceptedInput: { digest: stored.inputDigest, value: stored.input },
        acceptedResult: accepted === undefined ? { status: 'not_accepted' }
          : { status: 'accepted', digest: repeatDigest(accepted, RUN_INSPECTION_LIMITS.resultBytes), value: accepted },
        ...(stored.executorKind === 'agent' && stored.execution.result !== undefined ? { reportedResult: stored.execution.result } : {}) }))
    })
  }

  async bindings(principal: ManagementPrincipal, raw: unknown): Promise<RunExecutionBindingsPage> {
    const input = RunExecutionBindingsListInputSchema.parse(raw)
    return this.read(principal, input, async (sql, snapshot) => {
      const stored = await this.execution(sql, snapshot, input.executionId), scope = scopeOf(snapshot)
      const value = RunAcceptedInputValueSchema.parse(stored.input)
      evidence(sameRepeatValue(value.occurrence?.identity ?? null, stored.ref.occurrence)
        && sameRepeatValue(value.runInput, snapshot.run.input))
      // This walks ONE already bounded, exact input snapshot, never prior occurrences.
      const sources = [
        ...value.predecessors.map((source) => ({ kind: 'predecessor' as const, source })),
        ...(value.entry?.external ?? []).map((source) => ({ kind: 'external' as const, source })),
        ...(value.entry?.carry ? [{ kind: 'carry' as const, source: value.entry.carry }] : []),
      ]
      const expected = sources.map(({ kind, source }, ordinal) => RunExecutionBindingSchema.parse({ kind, source, ordinal,
        bindingId: repeatId('repeat-binding', input.executionId, kind, ordinal), recipient: executionIdentity(stored),
        recipientOccurrence: stored.ref.occurrence, inputDigest: stored.inputDigest }))
      const cursorScope = [scope, input.executionId, stored.inputDigest]
      const after = decodeBindingPageCursor(cursorScope, input.cursor)
      interface BindingRow { binding_id: string; run_id: string; recipient_execution_id: string; source_execution_id: string;
        source_result_digest: string; input_digest: string; slot_id: string; ordinal: number; record: unknown }
      const rows = (await sql.query<BindingRow>(`select binding_id,run_id,recipient_execution_id,source_execution_id,
        source_result_digest,input_digest,slot_id,ordinal,record from run_repeat_bindings
        where run_id=$1 and recipient_execution_id=$2 and ordinal>$3 order by ordinal limit $4`,
      [input.runId, input.executionId, after, input.limit + 1])).rows
      const window = expected.slice(after + 1, after + input.limit + 2)
      evidence(rows.length === window.length)
      for (const [index, row] of rows.entries()) {
        const binding = window[index]!
        evidence(row.ordinal === binding.ordinal && row.binding_id === binding.bindingId && row.run_id === scope.runId
          && row.recipient_execution_id === input.executionId && row.source_execution_id === binding.source.execution.executionId
          && row.source_result_digest === binding.source.acceptedResultDigest && row.input_digest === stored.inputDigest
          && row.slot_id === stored.slotId && sameRepeatValue(RunExecutionBindingSchema.parse(row.record), binding))
      }
      const items = window.slice(0, input.limit)
      const checked = new Map<string, { identity: unknown; result: unknown }>()
      for (const binding of items) {
        const sourceId = binding.source.execution.executionId
        let source = checked.get(sourceId)
        if (!source) {
          const identities = await sql.query<{ identity: unknown }>(
            'select identity from run_repeat_executions where execution_id=$1 and run_id=$2', [sourceId, scope.runId])
          evidence(identities.rows.length === 1)
          const result = await this.acceptedResult(sql, snapshot, await this.execution(sql, snapshot, sourceId))
          evidence(result !== undefined)
          source = { identity: identities.rows[0]!.identity, result }; checked.set(sourceId, source)
        }
        const identity = binding.kind === 'carry' ? binding.source.execution : binding.source.occurrence
          ? { ...binding.source.execution, occurrence: binding.source.occurrence } : binding.source.execution
        evidence(sameRepeatValue(source.identity, identity) && sameRepeatValue(source.result, binding.source.acceptedResult)
          && repeatDigest(source.result, RUN_INSPECTION_LIMITS.resultBytes) === binding.source.acceptedResultDigest)
        if (binding.kind === 'carry') {
          const decision = await readRepeatDecision(sql, scope, binding.source.execution.occurrence.occurrenceId)
          evidence(decision && decision.reason === 'repeat' && decision.decisionId === binding.source.decisionId
            && sameRepeatValue(decision.exitExecution, binding.source.execution)
            && decision.acceptedResultDigest === binding.source.acceptedResultDigest
            && decision.occurrence.identity.blockId === stored.ref.occurrence?.blockId
            && decision.occurrence.identity.occurrenceIndex + 1 === stored.ref.occurrence?.occurrenceIndex)
        }
      }
      return bounded(RunExecutionBindingsPageSchema.parse({ scope, executionId: input.executionId, inputDigest: stored.inputDigest,
        items, pageInfo: { nextCursor: rows.length > input.limit
          ? encodeBindingPageCursor(cursorScope, items.at(-1)!.ordinal) : null } }))
    })
  }

  async version(principal: ManagementPrincipal, raw: unknown): Promise<RunVersionDetail> {
    const input = RunVersionGetInputSchema.parse(raw)
    return this.read(principal, input, async (_sql, snapshot, live) => {
      // Same authorization and immutable version reader as current version reads.
      // A Run-only grant must not implicitly reveal workflow prompts/topology.
      requireAuthorization(live, 'workflows:read', { workspaceId: snapshot.run.workspaceId, workflowId: snapshot.run.workflowId })
      return bounded(RunVersionDetailSchema.parse({ scope: scopeOf(snapshot), version: snapshot.version }))
    })
  }
}
