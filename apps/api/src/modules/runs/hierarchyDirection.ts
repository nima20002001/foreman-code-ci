import { HarnessExecutionSchema, type HarnessExecution } from '@foreman-code/contracts'
import { ZodError } from 'zod'
import { HierarchyDirectionSchema, WorkActivationIdentitySchema, WorkActivationInputSchema,
  canonicalGraphJson, type HierarchyDirection, type WorkActivationInput } from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { assertGraphTransaction } from '../run-graph/connection.js'
import type { HierarchyGroupContext } from './hierarchyGroupAdmission.js'
import { hasWorkflowExecutionCapacityLocked } from './workflowExecutionBudget.js'
import { parseHierarchyWorkResult } from './hierarchyResults.js'
import { repeatConflict, repeatDigest, repeatId, sameRepeatValue } from './repeatResolution.js'
import { readParentWorkRequestLocked } from './workReturnValidation.js'
import { workflowLifecycleLocked } from './workflowCollaborationRuntime.js'

export type HierarchyDirectionReservation = { kind: 'reserved'; direction: HierarchyDirection; input: WorkActivationInput;
  replayed: boolean } | { kind: 'refused'; code: string; replayed: boolean }

/** Reads only the existing held boundary. Incoming text belongs to the durable delivery queue. */
export async function readHierarchyDirectionInputLocked(context: HierarchyGroupContext,
  activationId: string): Promise<WorkActivationInput> {
  const row = (await context.sql.query<{ record: unknown; activation: unknown }>(
    `select d.record,a.record as activation from run_hierarchy_direction_waits d
      join run_work_activations a on a.run_id=d.run_id and a.activation_id=d.held_activation_id
      where d.run_id=$1 and d.held_activation_id=$2 for share of d,a`,
    [context.scope.runId, activationId])).rows[0]
  if (!row) return repeatConflict('HIERARCHY_DIRECTION_NOT_FOUND')
  return directionInput(context, HierarchyDirectionSchema.parse(row.record), WorkActivationIdentitySchema.parse(row.activation))
}

function directionInput(context: HierarchyGroupContext, direction: HierarchyDirection,
  activation: ReturnType<typeof WorkActivationIdentitySchema.parse>): WorkActivationInput {
  return WorkActivationInputSchema.parse({ executionSemanticsVersion: 3, runInput: context.hooks.run.input,
    occurrence: null, entry: null, predecessors: [], work: { kind: 'hierarchy_direction', activation, direction } })
}

export async function readHierarchyDirectionForSourceLocked(context: HierarchyGroupContext,
  executionId: string): Promise<HierarchyDirection | undefined> {
  const row = (await context.sql.query<{ record: unknown }>(`select record from run_hierarchy_direction_waits
    where run_id=$1 and source_execution_id=$2`, [context.scope.runId, executionId])).rows[0]
  return row ? HierarchyDirectionSchema.parse(row.record) : undefined
}

/** The Run owner reserves this and binds its queued execution in ONE transaction. */
export async function reserveHierarchyDirectionLocked(context: HierarchyGroupContext,
  execution: HarnessExecution, activationId: string, heldExecutionId: string): Promise<HierarchyDirectionReservation> {
  assertGraphTransaction(context.sql)
  await context.hooks.assertAuthorityLocked(context.sql)
  const previous = await readHierarchyDirectionForSourceLocked(context, execution.id)
  if (previous) {
    if (previous.sourceResultDigest !== repeatDigest(execution.result, 64 * 1024)) {
      return repeatConflict('HIERARCHY_DIRECTION_REPLAY_CONFLICT')
    }
    return { kind: 'reserved', direction: previous,
      input: await readHierarchyDirectionInputLocked(context, previous.heldActivationId), replayed: true }
  }
  const refusal = (await context.sql.query<{ code: string; source_result_digest: string }>(
    `select code,source_result_digest from run_hierarchy_refusals where run_id=$1 and source_execution_id=$2`,
    [context.scope.runId, execution.id])).rows[0]
  if (refusal) {
    if (refusal.source_result_digest !== repeatDigest(execution.result, 64 * 1024)) return repeatConflict('HIERARCHY_DIRECTION_REPLAY_CONFLICT')
    return { kind: 'refused', code: refusal.code, replayed: true }
  }
  context.assertActive()
  const current = (await context.sql.query<{ record: unknown; activation: unknown; accepted: boolean }>(
    `select e.record,e.accepted,a.record as activation from harness_executions e
      join run_work_activations a on a.run_id=e.run_id and a.activation_id=e.work_activation_id
      where e.run_id=$1 and e.id=$2 and a.activation_id=$3 for update of e,a`,
    [context.scope.runId, execution.id, activationId])).rows[0]
  if (!current || current.accepted || !sameRepeatValue(HarnessExecutionSchema.parse(current.record), execution)
    || execution.state !== 'completed' || execution.result?.outcome !== 'succeeded') {
    return repeatConflict('HIERARCHY_DIRECTION_SOURCE_CONFLICT')
  }
  const activation = WorkActivationIdentitySchema.parse(current.activation)
  const result = parseHierarchyWorkResult(execution.result, context.version, execution.workflowNodeId,
    context.hooks.run.resultProtocol)
  if (context.version.definition.hierarchy?.masterNodeId !== execution.workflowNodeId
    || result.routing.kind !== 'finish' || !result.data.remainingFindings.length
    || await readParentWorkRequestLocked(context, activationId)) return repeatConflict('HIERARCHY_DIRECTION_SOURCE_CONFLICT')
  const pending = await context.sql.query(`select 1 from run_hierarchy_groups
    where run_id=$1 and state in ('waiting','ready') limit 1`, [context.scope.runId])
  if (pending.rowCount) return repeatConflict('HIERARCHY_WORK_UNRESOLVED')
  await context.hooks.assertSettlementLocked(context.sql, [execution.id])
  const directionId = repeatId('hierarchy-direction', context.scope.runId, execution.id)
  const heldActivationId = repeatId('work-activation', directionId)
  const direction = HierarchyDirectionSchema.parse({ scope: context.scope, directionId,
    workflowNodeId: execution.workflowNodeId, sourceActivationId: activationId, sourceExecutionId: execution.id,
    sourceResultDigest: repeatDigest(execution.result, 64 * 1024), heldActivationId, heldExecutionId,
    summary: result.summary, remainingFindingsCount: result.data.remainingFindings.length, createdAt: context.now })
  const held = WorkActivationIdentitySchema.parse({ ...activation, activationId: heldActivationId,
    cause: { kind: 'hierarchy_direction', directionId } })
  if (!await hasWorkflowExecutionCapacityLocked(context.sql, context.scope.runId, context.version)) {
    return refuseDirection(context, execution, activationId, 'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED')
  }
  let input: WorkActivationInput
  try { input = directionInput(context, direction, held) }
  catch (error) {
    if (!(error instanceof ZodError) || error.issues.some(issue => issue.message !== 'WORK_ACTIVATION_INPUT_TOO_LARGE')) throw error
    return refuseDirection(context, execution, activationId, 'HIERARCHY_INPUT_TOO_LARGE')
  }
  await context.sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,
    cause_kind,cause_id,state,record) values($1,$2,$3,$4,'hierarchy_direction',$5,'waiting',$6::jsonb)`,
  [heldActivationId, context.scope.runId, context.scope.workflowVersionId, execution.workflowNodeId,
    directionId, canonicalGraphJson(held)])
  await context.sql.query(`insert into run_hierarchy_direction_waits(direction_id,run_id,workflow_version_id,workflow_node_id,
    source_activation_id,source_execution_id,source_result_json,source_result_digest,held_activation_id,held_execution_id,
    state,record,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'waiting',$11::jsonb,$12)`,
  [directionId, context.scope.runId, context.scope.workflowVersionId, execution.workflowNodeId, activationId,
    execution.id, canonicalGraphJson(execution.result, 64 * 1024), direction.sourceResultDigest,
    heldActivationId, heldExecutionId, canonicalGraphJson(direction), context.now])
  await context.sql.query(`update run_work_activations set state='completed' where run_id=$1 and activation_id=$2`,
    [context.scope.runId, activationId])
  return { kind: 'reserved', direction, input, replayed: false }
}

async function refuseDirection(context: HierarchyGroupContext, execution: HarnessExecution,
  activationId: string, code: string): Promise<HierarchyDirectionReservation> {
  const result = { outcome: 'failed', error: { code, retryable: false,
    message: code === 'HIERARCHY_INPUT_TOO_LARGE' ? 'The Run input cannot hold the required direction continuation.'
      : 'The Run has no capacity for the required direction continuation.' } }
  await context.sql.query(`insert into run_hierarchy_refusals(refusal_id,run_id,source_activation_id,
    source_execution_id,source_result_digest,code,result,created_at,source_result_json) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
  [repeatId('hierarchy-refusal', context.scope.runId, execution.id), context.scope.runId, activationId,
    execution.id, repeatDigest(execution.result, 64 * 1024), code, canonicalGraphJson(result), context.now,
    canonicalGraphJson(execution.result, 64 * 1024)])
  await context.sql.query(`update run_work_activations set state='completed' where run_id=$1 and activation_id=$2`,
    [context.scope.runId, activationId])
  await workflowLifecycleLocked(context, execution, 'failed', `workflow:${execution.id}:admission-refused`,
    { reason: result.error.message })
  return { kind: 'refused', code, replayed: false }
}

/** Defense at the real dispatch boundary, independent of checkpoint scheduling. */
export async function assertHierarchyDirectionReleasedLocked(sql: GraphTransactionSql,
  runId: string, executionId: string): Promise<void> {
  const row = (await sql.query<{ state: string }>(`select state from run_hierarchy_direction_waits
    where run_id=$1 and held_execution_id=$2`, [runId, executionId])).rows[0]
  if (row && row.state !== 'released') return repeatConflict(row.state === 'waiting'
    ? 'HIERARCHY_DIRECTION_WAITING' : 'GRAPH_STOP_CONFLICT')
}

/** Caller must hold the authenticated Run lock and insert this exact durable receipt atomically. */
export async function releaseHierarchyDirectionLocked(sql: GraphTransactionSql,
  input: { runId: string; executionId: string; receiptId: string }): Promise<'released' | 'already_released' | 'not_direction'> {
  assertGraphTransaction(sql)
  const run = (await sql.query<{ stopped: boolean; state: string }>(`select stop_requested_at is not null as stopped,
    execution_state as state from runs where id=$1 for no key update`, [input.runId])).rows[0]
  if (!run || run.stopped || ['completed','interrupted'].includes(run.state)) return repeatConflict('TARGET_SETTLED')
  const row = (await sql.query<{ state: string; held_activation_id: string; released_receipt_id: string | null }>(
    `select state,held_activation_id,released_receipt_id from run_hierarchy_direction_waits
      where run_id=$1 and held_execution_id=$2 for update`, [input.runId, input.executionId])).rows[0]
  if (!row) return 'not_direction'
  if (row.state === 'canceled') return repeatConflict('TARGET_SETTLED')
  if (row.state === 'released') return 'already_released'
  await sql.query(`update run_hierarchy_direction_waits set state='released',released_receipt_id=$3
    where run_id=$1 and held_execution_id=$2 and state='waiting'`, [input.runId, input.executionId, input.receiptId])
  await sql.query(`update run_work_activations set state='queued' where run_id=$1 and activation_id=$2 and state='waiting'`,
    [input.runId, row.held_activation_id])
  return 'released'
}

/** Stop fences every reserved business continuation. Native execution cleanup
 * remains with the existing owner and its exact-session settlement path. */
export async function cancelHierarchyContinuationsLocked(sql: GraphTransactionSql, runId: string): Promise<void> {
  assertGraphTransaction(sql)
  await sql.query(`update run_hierarchy_direction_waits set state='canceled'
    where run_id=$1 and state in ('waiting','released')`, [runId])
  await sql.query(`update run_hierarchy_groups set state='canceled'
    where run_id=$1 and state in ('waiting','ready')`, [runId])
}
