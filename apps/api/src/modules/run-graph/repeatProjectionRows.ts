import { readPublicRunStateLocked } from './publicRunState.js'
import {
  GraphExecutionIdentitySchema, RepeatOccurrenceV1Schema, RepeatDecisionMetadataV1Schema,
  RepeatGraphExecutionV3Schema, RepeatGraphBindingV3Schema, RepeatGraphResolutionV3Schema,
  RepeatGraphScopeV3Schema, WorkflowVersionV3Schema,
  CurrentRunVersionSnapshotSchema, AcceptedWorkflowRunV3Schema, ExecutableWorkflowV3Schema, REPEAT_GRAPH_LIMITS,
  sameCanonicalGraphScope, canonicalGraphJson, qualifyRepeatGraphExecution,
  type RepeatGraphScopeV3, type RepeatGraphExecutionV3, type RepeatGraphBindingV3,
  type RepeatGraphResolutionV3, type RepeatGraphFactV3, type WorkflowVersionV3,
} from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from './connection.js'
import { assertGraphTransaction } from './connection.js'
import { RunGraphError } from './errors.js'
import { repeatSlotId, tickSlotId, workActivationSlotId } from '../runs/repeatResolution.js'
import { readWorkflowJobGraphExecutionsLocked } from './workflowJobProjection.js'
import { readImmutableWorkflowVersion, readPinnedAgentConfigurations,
  type ImmutableAgentConfigurationRow } from '../workflows/immutableRead.js'

const conflict = (): never => { throw new RunGraphError('GRAPH_INVARIANT_VIOLATION') }
const equal = (a: unknown, b: unknown) => canonicalGraphJson(a) === canonicalGraphJson(b)
export function boundedRepeatRows<T>(rows: T[], limit: number): T[] {
  if (rows.length > limit) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
  return rows
}

/** Private pins remain local. Only the caller's explicit whitelist reaches wire
 * schemas. This is a same-transaction read, not Start admission/authorization. */
export function readRepeatGraphPinsLocked(sql: GraphTransactionSql, input: RepeatGraphScopeV3,
  prefetched?: RepeatGraphPinsRow[]) {
  return readRepeatGraphPins(sql, input, 'executable', prefetched)
}

export type RepeatGraphPinsRow = {
    workspace_id: string; workflow_id: string; workflow_version_id: string;
    version_id: string; version_number: number; entry_node_id: string; execution_state: string;
    execution_semantics_version: number; version_workspace_id: string; version_workflow_id: string;
    run_record: unknown; version_record: unknown; configurations: ImmutableAgentConfigurationRow[]
  }
export const REPEAT_GRAPH_PINS_SQL = `select r.workspace_id,r.workflow_id,r.workflow_version_id,r.execution_state,v.execution_semantics_version,
      v.id as version_id,v.version as version_number,v.entry_node_id,
      r.record as run_record,v.record as version_record,v.workspace_id as version_workspace_id,v.workflow_id as version_workflow_id,
      coalesce((select json_agg(p order by p.id) from (
        select c.id,c.workspace_id,c.agent_id,c.version,c.record from agent_configuration_versions c
        where c.id in (select pin.value from jsonb_each_text(v.record->'agentConfigurationVersionIds') pin)
      ) p),'[]'::json) as configurations
     from runs r join workflow_versions v on v.id=r.workflow_version_id where r.id=$1`

export function readRecordedRepeatGraphPinsLocked(sql: GraphTransactionSql, input: RepeatGraphScopeV3) {
  return readRepeatGraphPins(sql, input, 'recorded')
}

async function readRepeatGraphPins(sql: GraphTransactionSql, input: RepeatGraphScopeV3,
  configurationPolicy: 'executable' | 'recorded', prefetched?: RepeatGraphPinsRow[]) {
  assertGraphTransaction(sql)
  const scope = RepeatGraphScopeV3Schema.parse(input)
  const rows = prefetched ? { rows: prefetched } : await sql.query<RepeatGraphPinsRow>(
    REPEAT_GRAPH_PINS_SQL, [scope.runId])
  const row = rows.rows[0]
  if (rows.rows.length !== 1 || !row || row.workspace_id !== scope.workspaceId || row.workflow_id !== scope.workflowId
    || row.workflow_version_id !== scope.workflowVersionId || row.execution_semantics_version !== 3
    || row.version_workspace_id !== scope.workspaceId || row.version_workflow_id !== scope.workflowId) return conflict()
  const run = AcceptedWorkflowRunV3Schema.parse(row.run_record)
  const version = WorkflowVersionV3Schema.parse(readImmutableWorkflowVersion({
    id: row.version_id, workspace_id: row.version_workspace_id, workflow_id: row.version_workflow_id,
    version: row.version_number, entry_node_id: row.entry_node_id, execution_semantics_version: row.execution_semantics_version,
    record: row.version_record,
  }, { id: scope.workflowVersionId, workspaceId: scope.workspaceId, workflowId: scope.workflowId }))
  CurrentRunVersionSnapshotSchema.parse({ run, version })
  if (run.id !== scope.runId || run.workspaceId !== scope.workspaceId || run.workflowId !== scope.workflowId
    || run.workflowVersionId !== scope.workflowVersionId || run.executionState !== row.execution_state) return conflict()
  const configurations = readPinnedAgentConfigurations(version, row.configurations)
  if (configurationPolicy === 'executable') ExecutableWorkflowV3Schema.parse({ version, configurations })
  return { scope, run, version, configurations }
}
export const readRepeatRunStateLocked = readPublicRunStateLocked

interface ExecutionRow {
  execution_id: string; run_id: string; slot_id: string; occurrence_id: string | null;
  work_activation_id: string | null; slot_work_activation_id: string | null; native_work_activation_id: string | null;
  technical_attempt: number; previous_execution_id: string | null; identity: unknown;
  execution_run_id: string; execution_node_id: string; execution_agent_id: string; execution_attempt: number;
  execution_occurrence_id: string | null; record_id: string; record_run_id: string; record_node_id: string;
  record_agent_id: string; record_configuration_id: string; record_attempt: number;
  state: string; result_outcome: string | null; slot_run_id: string; slot_occurrence_id: string | null;
  continued_from_execution_id: string | null;
  slot_node_id: string; input_digest: string; occurrence: unknown;
  tick_index: number | null;
}
/** Whitelisted SQL expressions: never select input_json, result_json, an entire
 * harness record, prompt, path, session, credential, or raw native payload. */
export async function readRepeatGraphExecutionsLocked(sql: GraphTransactionSql, scope: RepeatGraphScopeV3,
  options: { executionIds?: readonly string[]; version?: WorkflowVersionV3 } = {}): Promise<RepeatGraphExecutionV3[]> {
  const { executionIds } = options
  if (executionIds && executionIds.length > REPEAT_GRAPH_LIMITS.executions) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
  const rows = await sql.query<ExecutionRow>(`select x.execution_id,x.run_id,x.slot_id,x.occurrence_id,x.technical_attempt,
      x.work_activation_id,
      e.record#>>'{sessionContinuation,previousExecutionId}' as continued_from_execution_id,
      x.previous_execution_id,x.identity,e.run_id as execution_run_id,e.workflow_node_id as execution_node_id,
      e.agent_id as execution_agent_id,e.attempt as execution_attempt,e.repeat_occurrence_id as execution_occurrence_id,
      e.work_activation_id as native_work_activation_id,
      e.record->>'id' as record_id,e.record->>'runId' as record_run_id,e.record->>'workflowNodeId' as record_node_id,
      e.record->>'agentId' as record_agent_id,e.record->>'agentConfigurationVersionId' as record_configuration_id,
      (e.record->>'attempt')::integer as record_attempt,e.record->>'state' as state,e.record #>> '{result,outcome}' as result_outcome,
      s.run_id as slot_run_id,s.occurrence_id as slot_occurrence_id,
      s.work_activation_id as slot_work_activation_id,s.workflow_node_id as slot_node_id,s.input_digest,
      (e.record #>> '{input,tick,index}')::integer as tick_index,
      o.record as occurrence
    from run_repeat_executions x left join harness_executions e on e.id=x.execution_id
    left join run_repeat_slots s on s.slot_id=x.slot_id left join run_repeat_occurrences o on o.occurrence_id=x.occurrence_id
    where x.run_id=$1 and x.executor_kind='agent' and ($2::text[] is null or x.execution_id=any($2::text[]))
    order by x.execution_id limit $3`, [scope.runId, executionIds ? [...executionIds] : null, REPEAT_GRAPH_LIMITS.executions + 1])
  const parsed = boundedRepeatRows(rows.rows, REPEAT_GRAPH_LIMITS.executions).map((row) => {
    const occurrence = row.occurrence_id === null ? null : RepeatOccurrenceV1Schema.parse(row.occurrence).identity
    const identity = qualifyRepeatGraphExecution(GraphExecutionIdentitySchema.parse({ workflowNodeId: row.execution_node_id,
      executionId: row.execution_id, agentId: row.execution_agent_id, agentConfigurationVersionId: row.record_configuration_id,
      attempt: row.execution_attempt }), occurrence)
    const { occurrence: _scope, ...bare } = identity
    void _scope
    if (row.run_id !== scope.runId || row.execution_run_id !== scope.runId || row.slot_run_id !== scope.runId
      || row.record_id !== row.execution_id || row.record_run_id !== scope.runId || row.record_node_id !== row.execution_node_id
      || row.slot_node_id !== row.execution_node_id || row.record_agent_id !== row.execution_agent_id
      || row.record_attempt !== row.execution_attempt || row.technical_attempt !== row.execution_attempt
      || row.execution_occurrence_id !== row.occurrence_id || row.slot_occurrence_id !== row.occurrence_id
      || (occurrence && (!sameCanonicalGraphScope(occurrence.scope, scope) || occurrence.occurrenceId !== row.occurrence_id))
      || !equal(row.identity, occurrence ? identity : bare)
      || (row.work_activation_id ?? null) !== (row.slot_work_activation_id ?? null)
      || (row.work_activation_id ?? null) !== (row.native_work_activation_id ?? null)
      || row.slot_id !== (row.tick_index ? tickSlotId(scope.runId, identity.workflowNodeId, row.tick_index)
        : row.work_activation_id ? workActivationSlotId(scope.runId, row.work_activation_id)
          : repeatSlotId(scope.runId, { nodeId: identity.workflowNodeId, occurrence }))) return conflict()
    return RepeatGraphExecutionV3Schema.parse({ identity, inputDigest: row.input_digest,
      ...(row.continued_from_execution_id ? { continuedFromExecutionId: row.continued_from_execution_id } : {}),
      ...(row.work_activation_id ? { workActivationId: row.work_activation_id } : {}),
      ...(row.tick_index ? { tickIndex: row.tick_index } : {}),
      previousExecutionId: row.previous_execution_id, state: row.state, resultOutcome: row.result_outcome })
  })
  const agentIds = new Set(parsed.map(execution => execution.identity.executionId))
  const jobIds = executionIds?.filter(id => !agentIds.has(id))
  let jobs: RepeatGraphExecutionV3[] = []
  if (!jobIds || jobIds.length) {
    const version = options.version ?? (await readRecordedRepeatGraphPinsLocked(sql, scope)).version
    if (version.definition.nodes.some(node => node.kind === 'job')) {
      jobs = await readWorkflowJobGraphExecutionsLocked(sql, scope, jobIds)
    }
  }
  const executions = boundedRepeatRows([...parsed, ...jobs], REPEAT_GRAPH_LIMITS.executions)
    .sort((left, right) => left.identity.executionId.localeCompare(right.identity.executionId))
  if (executionIds && (new Set(executionIds).size !== executions.length
    || executions.some((item) => !executionIds.includes(item.identity.executionId)))) return conflict()
  return executions
}

interface BindingRow {
  binding_id: string; recipient_execution_id: string; source_execution_id: string; source_result_digest: string;
  input_digest: string; ordinal: number; kind: string; relationship_id: string | null; decision_id: string | null;
}
export async function readRepeatGraphBindingsLocked(sql: GraphTransactionSql, scope: RepeatGraphScopeV3,
  recipientIds?: readonly string[], suppliedExecutions?: readonly RepeatGraphExecutionV3[]): Promise<RepeatGraphBindingV3[]> {
  const rows = boundedRepeatRows((await sql.query<BindingRow>(`select binding_id,recipient_execution_id,source_execution_id,
      source_result_digest,input_digest,ordinal,record->>'kind' as kind,
      record #>> '{source,relationshipId}' as relationship_id,record #>> '{source,decisionId}' as decision_id
    from run_repeat_bindings where run_id=$1 and ($2::text[] is null or recipient_execution_id=any($2::text[]))
    order by recipient_execution_id,ordinal,binding_id limit $3`,
  [scope.runId, recipientIds ? [...recipientIds] : null, REPEAT_GRAPH_LIMITS.bindings + 1])).rows, REPEAT_GRAPH_LIMITS.bindings)
  const identities = [...new Set(rows.flatMap((row) => [row.recipient_execution_id, row.source_execution_id]))]
  const executions = suppliedExecutions ?? (identities.length
    ? await readRepeatGraphExecutionsLocked(sql, scope, { executionIds: identities }) : [])
  const byId = new Map(executions.map((execution) => [execution.identity.executionId, execution]))
  return rows.map((row) => {
    const recipient = byId.get(row.recipient_execution_id), sender = byId.get(row.source_execution_id)
    if (!recipient || !sender || recipient.inputDigest !== row.input_digest) return conflict()
    return RepeatGraphBindingV3Schema.parse({ bindingId: row.binding_id, recipient: recipient.identity, sender: sender.identity,
      acceptedResultDigest: row.source_result_digest, inputDigest: row.input_digest, ordinal: row.ordinal,
      kind: row.kind, relationshipId: row.relationship_id, decisionId: row.decision_id })
  })
}
export async function readRepeatGraphOccurrencesLocked(sql: GraphTransactionSql, scope: RepeatGraphScopeV3) {
  const rows = boundedRepeatRows((await sql.query<{ occurrence_id: string; workspace_id: string; workflow_id: string;
    workflow_version_id: string; block_id: string; occurrence_index: number; binding_id: string; input_digest: string; record: unknown }>(
    `select occurrence_id,workspace_id,workflow_id,workflow_version_id,block_id,occurrence_index,binding_id,input_digest,record
     from run_repeat_occurrences where run_id=$1 order by occurrence_id limit $2`,
    [scope.runId, REPEAT_GRAPH_LIMITS.occurrences + 1])).rows, REPEAT_GRAPH_LIMITS.occurrences)
  return rows.map((row) => {
    const value = RepeatOccurrenceV1Schema.parse(row.record), { identity } = value
    if (!sameCanonicalGraphScope(identity.scope, scope) || row.occurrence_id !== identity.occurrenceId
      || row.workspace_id !== scope.workspaceId || row.workflow_id !== scope.workflowId || row.workflow_version_id !== scope.workflowVersionId
      || row.block_id !== identity.blockId || row.occurrence_index !== identity.occurrenceIndex
      || row.binding_id !== value.input.bindingId || row.input_digest !== value.input.inputDigest) return conflict()
    return value
  })
}
export async function readRepeatGraphResolutionsLocked(sql: GraphTransactionSql, scope: RepeatGraphScopeV3): Promise<RepeatGraphResolutionV3[]> {
  const rows = boundedRepeatRows((await sql.query<{ occurrence_key: string; workflow_node_id: string;
    source_occurrence_id: string | null; execution_id: string | null; record: Record<string, unknown> }>(
    `select occurrence_key,workflow_node_id,source_occurrence_id,execution_id,record from run_repeat_resolutions
     where run_id=$1 order by occurrence_key,workflow_node_id limit $2`,
    [scope.runId, REPEAT_GRAPH_LIMITS.resolutions + 1])).rows, REPEAT_GRAPH_LIMITS.resolutions)
  return rows.map((row) => {
    const value = RepeatGraphResolutionV3Schema.parse({ ...row.record, outside: row.occurrence_key === '' })
    if (value.ref.nodeId !== row.workflow_node_id || row.source_occurrence_id !== (value.ref.occurrence?.occurrenceId ?? null)
      || row.execution_id !== (value.value.execution?.executionId ?? null)
      || row.occurrence_key !== (value.outside ? '' : value.ref.occurrence?.occurrenceId)) return conflict()
    return value
  })
}
export async function readRepeatGraphDecisionsLocked(sql: GraphTransactionSql, scope: RepeatGraphScopeV3) {
  // resultData is private. Do not even load it into this reader.
  const rows = boundedRepeatRows((await sql.query<{ decision_id: string; occurrence_id: string; exit_execution_id: string;
    result_digest: string; metadata: unknown }>(`select decision_id,occurrence_id,exit_execution_id,result_digest,record-'resultData' as metadata
      from run_repeat_decisions where run_id=$1 order by decision_id limit $2`,
    [scope.runId, REPEAT_GRAPH_LIMITS.decisions + 1])).rows, REPEAT_GRAPH_LIMITS.decisions)
  return rows.map((row) => {
    const value = RepeatDecisionMetadataV1Schema.parse(row.metadata)
    if (row.decision_id !== value.decisionId || row.occurrence_id !== value.occurrence.identity.occurrenceId
      || row.exit_execution_id !== value.exitExecution.executionId || row.result_digest !== value.acceptedResultDigest) return conflict()
    return value
  })
}
export async function readRepeatGraphResultsLocked(sql: GraphTransactionSql, scope: RepeatGraphScopeV3,
  executions: readonly RepeatGraphExecutionV3[]): Promise<Extract<RepeatGraphFactV3, { type: 'repeat.result.accepted' }>['result'][]> {
  const byId = new Map(executions.map((execution) => [execution.identity.executionId, execution]))
  const rows = boundedRepeatRows((await sql.query<{ execution_id: string; occurrence_id: string | null; result_digest: string }>(
    'select execution_id,occurrence_id,result_digest from run_repeat_results where run_id=$1 order by execution_id limit $2',
    [scope.runId, REPEAT_GRAPH_LIMITS.executions + 1])).rows, REPEAT_GRAPH_LIMITS.executions)
  return rows.map((row) => {
    const execution = byId.get(row.execution_id)
    if (!execution || row.occurrence_id !== (execution.identity.occurrence?.occurrenceId ?? null)) return conflict()
    return { execution: execution.identity, resultDigest: row.result_digest }
  })
}
