import { timeRuntimeOperation } from '../../infrastructure/runtimeTiming.js'
import { z } from 'zod'
import { HarnessExecutionSchema, type HarnessExecution } from '@foreman-code/contracts'
import {
  AcceptedCurrentNodeResultSchema, GraphDigestSchema, GraphExecutionIdentitySchema, GraphIdSchema,
  RepeatExecutionIdentityV1Schema, RepeatOccurrenceIdentityV1Schema, RepeatOccurrenceV1Schema,
  type RepeatOccurrenceV1, type WorkflowVersionV3,
} from '@foreman-code/contracts/wave25'
import { assertGraphTransaction, isReadOnlyGraphTransaction, type GraphTransactionSql } from '../run-graph/connection.js'
import { canonicalRepeatEffectReceipt } from '../run-graph/repeatEffects.js'
import { assertRepeatCanonicalReceiptLocked, assertRepeatCanonicalReceiptsLocked,
  requireRepeatCanonicalReceiptBeforeCommit, type RepeatCanonicalReceipt } from '../run-graph/repeatReceipts.js'
import type { RepeatEffect } from './repeatPostgres.js'
import type { AcceptedRepeatRunSnapshot } from './repeatStartRead.js'
import {
  assertRepeatExecution, expectedRepeatSlotId, repeatConflict, repeatDigest, repeatExecutionIdentity,
  repeatTickIndex, sameRepeatValue, type RepeatEntryInput, type RepeatNodeInput, type RepeatNodeRef, type RepeatScope,
} from './repeatResolution.js'

export interface StoredOccurrence { occurrence: RepeatOccurrenceV1; input: RepeatEntryInput }
export interface StoredRepeatExecution {
  execution: HarnessExecution; ref: RepeatNodeRef; slotId: string; input: RepeatNodeInput; inputDigest: string; accepted: boolean
  workActivationId?: string | null
}
export const SourceSchema = z.object({ relationshipId: GraphIdSchema, execution: GraphExecutionIdentitySchema,
  occurrence: RepeatOccurrenceIdentityV1Schema.nullable(), acceptedResultDigest: GraphDigestSchema, acceptedResult: AcceptedCurrentNodeResultSchema }).strict()
export const EntrySchema = z.object({ runInput: z.unknown(), external: z.array(SourceSchema).max(8000), carry: z.object({
  decisionId: GraphIdSchema, execution: RepeatExecutionIdentityV1Schema,
  acceptedResultDigest: GraphDigestSchema, acceptedResult: AcceptedCurrentNodeResultSchema,
}).strict().nullable() }).strict()

export async function readStoredRepeatOccurrence(sql: GraphTransactionSql, scope: RepeatScope, id: string): Promise<StoredOccurrence> {
  const found = await sql.query<{ record: unknown; input_json: string; input_digest: string }>(
    'select record,input_json,input_digest from run_repeat_occurrences where occurrence_id=$1 and run_id=$2', [id, scope.runId])
  const row = found.rows[0]
  if (!row) return repeatConflict('REPEAT_OCCURRENCE_NOT_FOUND')
  const occurrence = RepeatOccurrenceV1Schema.parse(row.record)
  const input = EntrySchema.parse(JSON.parse(row.input_json)) as RepeatEntryInput
  if (!sameRepeatValue(occurrence.identity.scope, scope) || occurrence.identity.occurrenceId !== id
    || row.input_digest !== repeatDigest(input, 4 * 1024 * 1024) || occurrence.input.inputDigest !== row.input_digest) return repeatConflict('REPEAT_INPUT_DIGEST_CONFLICT')
  return { occurrence, input }
}

interface StoredExecutionRow { record: unknown; accepted: boolean; identity: unknown; slot_id: string;
    occurrence_id: string | null; work_activation_id: string | null; native_work_activation_id: string | null;
    attempt_work_activation_id: string | null; execution_run_id: string; execution_node_id: string;
    execution_agent_id: string; execution_attempt: number; execution_occurrence_id: string | null;
    identity_occurrence_id: string | null; technical_attempt: number; workflow_node_id: string; input_json: string; input_digest: string }
const storedExecutionColumns = `e.record,e.accepted,x.identity,s.slot_id,s.occurrence_id,s.work_activation_id,s.workflow_node_id,s.input_json,s.input_digest,
       e.work_activation_id as native_work_activation_id,x.work_activation_id as attempt_work_activation_id,
       e.repeat_occurrence_id as execution_occurrence_id,x.occurrence_id as identity_occurrence_id,x.technical_attempt,
       e.run_id as execution_run_id,e.workflow_node_id as execution_node_id,e.agent_id as execution_agent_id,e.attempt as execution_attempt`

export async function readStoredRepeatExecution(sql: GraphTransactionSql, scope: RepeatScope,
  version: WorkflowVersionV3, executionId: string, lock: 'share' | 'update'): Promise<StoredRepeatExecution> {
  const rowLock = isReadOnlyGraphTransaction(sql) ? '' : `for ${lock} of e`
  const rows = await sql.query<StoredExecutionRow>(
    `select ${storedExecutionColumns}
     from run_repeat_executions x join harness_executions e on e.id=x.execution_id
     join run_repeat_slots s on s.slot_id=x.slot_id where x.execution_id=$1 and x.run_id=$2 ${rowLock}`,
    [executionId, scope.runId])
  return validateStoredExecutionRow(sql, scope, version, executionId, rows.rows[0])
}

async function validateStoredExecutionRow(sql: GraphTransactionSql, scope: RepeatScope,
  version: WorkflowVersionV3, executionId: string, row: StoredExecutionRow | undefined,
  storedOccurrence?: RepeatOccurrenceV1): Promise<StoredRepeatExecution> {
  if (!row) return repeatConflict('EXECUTION_NOT_FOUND')
  const execution = HarnessExecutionSchema.parse(row.record)
  const occurrence = row.occurrence_id
    ? (storedOccurrence ?? (await readStoredRepeatOccurrence(sql, scope, row.occurrence_id)).occurrence).identity : null
  const ref = { nodeId: row.workflow_node_id, occurrence }
  assertRepeatExecution(version, scope, ref, execution)
  const identity = occurrence ? RepeatExecutionIdentityV1Schema.parse({ ...repeatExecutionIdentity(execution), occurrence }) : repeatExecutionIdentity(execution)
  const input = JSON.parse(row.input_json) as RepeatNodeInput
  const workActivationId = row.work_activation_id ?? null
  const tick = repeatTickIndex(input) !== undefined
  const expectedSlotId = expectedRepeatSlotId(scope.runId, ref, input, workActivationId)
  if (execution.id !== executionId || row.execution_run_id !== execution.runId
    || row.execution_node_id !== execution.workflowNodeId || row.execution_agent_id !== execution.agentId
    || row.execution_attempt !== execution.attempt || row.execution_occurrence_id !== row.occurrence_id
    || row.identity_occurrence_id !== row.occurrence_id || row.technical_attempt !== execution.attempt
    || workActivationId !== (row.native_work_activation_id ?? null)
    || workActivationId !== (row.attempt_work_activation_id ?? null)
    || (version.definition.handoffs && !tick ? !workActivationId
      || (input as RepeatNodeInput & { work?: { activation?: { activationId: string } } }).work?.activation?.activationId !== workActivationId
      : workActivationId !== null)
    || !sameRepeatValue(identity, row.identity)
    || row.slot_id !== expectedSlotId || repeatDigest(input, 4 * 1024 * 1024) !== row.input_digest
    || !sameRepeatValue(execution.input, input)) return repeatConflict('REPEAT_EXECUTION_INPUT_CONFLICT')
  return { execution, ref, slotId: row.slot_id, input, inputDigest: row.input_digest, accepted: row.accepted,
    ...(workActivationId ? { workActivationId } : {}) }
}

/** The same execution/input checks for a set of attempts, including their occurrence pins. */
export async function readRepeatExecutionsLocked(sql: GraphTransactionSql, snapshot: AcceptedRepeatRunSnapshot,
  ids: readonly string[]): Promise<StoredRepeatExecution[]> {
  assertGraphTransaction(sql)
  if (!ids.length) return []
  const { run, version } = snapshot
  const scope: RepeatScope = { workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id,
    workflowVersionId: run.workflowVersionId, executionSemanticsVersion: 3 }
  const headLock = isReadOnlyGraphTransaction(sql) ? '' : 'for share'
  const executionLock = isReadOnlyGraphTransaction(sql) ? '' : 'for share of e'
  const rows = await sql.query<StoredExecutionRow & { execution_id: string; protocol_version: number;
    payload_digest: string | null; occurrence_record: unknown; occurrence_input: string | null;
    occurrence_digest: string | null }>(`
    with head as materialized (select protocol_version from run_graph_heads where run_id=$1 ${headLock})
    select ${storedExecutionColumns},x.execution_id,h.protocol_version,f.payload_digest,
      o.record as occurrence_record,o.input_json as occurrence_input,o.input_digest as occurrence_digest
    from head h cross join harness_executions e join run_repeat_executions x on x.execution_id=e.id
    join run_repeat_slots s on s.slot_id=x.slot_id
    left join run_repeat_occurrences o on o.occurrence_id=s.occurrence_id and o.run_id=$1
    left join run_repeat_effects f on f.run_id=$1 and f.effect_kind='input.bind' and f.entity_id=e.id
    where e.run_id=$1 and x.run_id=$1 and e.id=any($2::text[]) order by e.id ${executionLock}`, [run.id, [...ids]])
  if (rows.rows.length !== new Set(ids).size) return repeatConflict('EXECUTION_NOT_FOUND')
  const stored = new Map<string, StoredRepeatExecution>()
  const receipts: RepeatCanonicalReceipt[] = []
  for (const row of rows.rows) {
    if (row.protocol_version !== 1) return repeatConflict('GRAPH_NOT_INITIALIZED')
    let occurrence: RepeatOccurrenceV1 | undefined
    if (row.occurrence_id) {
      if (!row.occurrence_record) return repeatConflict('REPEAT_OCCURRENCE_NOT_FOUND')
      occurrence = RepeatOccurrenceV1Schema.parse(row.occurrence_record)
      const input = EntrySchema.parse(JSON.parse(row.occurrence_input!))
      if (!sameRepeatValue(occurrence.identity.scope, scope) || occurrence.identity.occurrenceId !== row.occurrence_id
        || row.occurrence_digest !== repeatDigest(input, 4 * 1024 * 1024)
        || occurrence.input.inputDigest !== row.occurrence_digest) return repeatConflict('REPEAT_INPUT_DIGEST_CONFLICT')
    }
    stored.set(row.execution_id, await validateStoredExecutionRow(sql, scope, version, row.execution_id, row, occurrence))
    if (!GraphDigestSchema.safeParse(row.payload_digest).success) return repeatConflict('REPEAT_EFFECT_MISSING')
    receipts.push(canonicalRepeatEffectReceipt(scope, { kind: 'input.bind', entityId: row.execution_id,
      digest: row.payload_digest! }))
  }
  await assertRepeatCanonicalReceiptsLocked(sql, receipts)
  for (const receipt of receipts) requireRepeatCanonicalReceiptBeforeCommit(sql, receipt)
  return ids.map(id => stored.get(id)!)
}

export async function retainRepeatEffectReceipt(sql: GraphTransactionSql, scope: RepeatScope,
  kind: RepeatEffect['kind'], entityId: string, digest: unknown): Promise<void> {
  if (!GraphDigestSchema.safeParse(digest).success) return repeatConflict('REPEAT_EFFECT_MISSING')
  const receipt = canonicalRepeatEffectReceipt(scope, { kind, entityId, digest: GraphDigestSchema.parse(digest) })
  await assertRepeatCanonicalReceiptLocked(sql, receipt)
  requireRepeatCanonicalReceiptBeforeCommit(sql, receipt)
}

/** The caller must have read the exact accepted Run/version on THIS transaction
 * and authorized the requested detail. Never opens a native host or progresses. */
export function readRepeatExecutionLocked(sql: GraphTransactionSql, snapshot: AcceptedRepeatRunSnapshot,
  executionId: string): Promise<StoredRepeatExecution> {
  return timeRuntimeOperation('db', 'snapshot.read_execution', async () => {
    assertGraphTransaction(sql)
    const { run, version } = snapshot
    const headLock = isReadOnlyGraphTransaction(sql) ? '' : 'for share'
    const executionLock = isReadOnlyGraphTransaction(sql) ? '' : 'for share of e'
    const scope: RepeatScope = { workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id,
      workflowVersionId: run.workflowVersionId, executionSemanticsVersion: 3 }
    const related = (await sql.query<{ heads: { protocol_version: number }[];
      executions: StoredExecutionRow[]; effects: { payload_digest: string }[] }>(
      `with pinned_head as materialized (
        select protocol_version from run_graph_heads where run_id=$2 ${headLock}
      ), pinned_execution as materialized (
        select ${storedExecutionColumns}
        from run_repeat_executions x join harness_executions e on e.id=x.execution_id
        join run_repeat_slots s on s.slot_id=x.slot_id where x.execution_id=$1 and x.run_id=$2
          and exists(select 1 from pinned_head where protocol_version=1) ${executionLock}
      ), pinned_input as materialized (
        select payload_digest from run_repeat_effects where run_id=$2 and effect_kind='input.bind' and entity_id=$1
          and exists(select 1 from pinned_execution)
      ) select coalesce((select json_agg(h) from pinned_head h),'[]'::json) as heads,
        coalesce((select json_agg(e) from pinned_execution e),'[]'::json) as executions,
        coalesce((select json_agg(i) from pinned_input i),'[]'::json) as effects`,
      [executionId, run.id])).rows[0]!
    if (related.heads.length !== 1 || related.heads[0]?.protocol_version !== 1) return repeatConflict('GRAPH_NOT_INITIALIZED')
    const stored = await validateStoredExecutionRow(sql, scope, version, executionId, related.executions[0])
    if (related.effects.length !== 1) return repeatConflict('REPEAT_EFFECT_MISSING')
    await retainRepeatEffectReceipt(sql, scope, 'input.bind', executionId, related.effects[0]?.payload_digest)
    return stored
  }, { runId: snapshot.run.id, executionId })
}
