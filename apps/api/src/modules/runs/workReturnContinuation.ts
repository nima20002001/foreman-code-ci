import { ExecutionResultSchema, HarnessExecutionSchema } from '@foreman-code/contracts'
import {
  AcceptedCurrentNodeResultSchema, WorkActivationIdentitySchema, WorkRequestSchema,
  canonicalGraphJson, type WorkRequest, type WorkflowVersionV3,
} from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { RepeatLockedHooks } from './repeatPostgres.js'
import { assertWorkflowExecutionCapacityLocked } from './workflowExecutionBudget.js'
import { repeatConflict, repeatId, sameRepeatValue, type RepeatScope } from './repeatResolution.js'
import { hierarchyContinuationForRequestLocked } from './hierarchyGroupSettlement.js'
import { parseWorkflowWorkResult } from './workflowCoordinationResult.js'

export interface WorkReturnContext {
  sql: GraphTransactionSql; scope: RepeatScope; version: WorkflowVersionV3
  hooks: RepeatLockedHooks; now: string
  assertActive(): void
}

export async function ensureWorkReturnContinuationLocked(context: WorkReturnContext,
  request: WorkRequest, returnId: string): Promise<string> {
  const { sql, scope } = context
  const group = await sql.query(`select 1 from run_hierarchy_group_members where run_id=$1 and request_id=$2`,
    [scope.runId, request.requestId])
  if (group.rowCount) return hierarchyContinuationForRequestLocked(context, request)
  const prior = (await sql.query<{ requester_continuation_activation_id: string; state: string }>(
    `select t.requester_continuation_activation_id,a.state from run_work_returns t
      join run_work_requests q on q.run_id=t.run_id and q.request_id=t.request_id
      join run_work_activations a on a.run_id=t.run_id and a.activation_id=t.requester_continuation_activation_id
      where q.run_id=$1 and q.requester_node_id=$2 and t.outcome='needs_changes'
        and (a.state<>'waiting' or work_parent_request($1,a.activation_id)
          is not distinct from work_parent_request($1,$3))
      order by a.activation_sequence desc`,
    [scope.runId, request.requesterNodeId, request.requesterActivationId])).rows
  const waiting = prior.find(row => row.state === 'waiting')
  if (waiting) return waiting.requester_continuation_activation_id
  context.assertActive()
  await assertWorkflowExecutionCapacityLocked(sql, scope.runId, context.version)
  const requester = (await sql.query<{ record: unknown }>(
    'select record from run_work_activations where run_id=$1 and activation_id=$2 for share',
    [scope.runId, request.requesterActivationId])).rows[0]
  if (!requester) return repeatConflict('WORK_RETURN_REQUESTER_MISSING')
  const original = WorkActivationIdentitySchema.parse(requester.record)
  if (original.workflowNodeId !== request.requesterNodeId || !sameRepeatValue(original.scope, scope)) {
    return repeatConflict('WORK_RETURN_REQUESTER_CONFLICT')
  }
  const activationId = prior.length
    ? repeatId('work-activation', 'returns', request.requesterActivationId, returnId)
    : repeatId('work-activation', 'returns', request.requesterActivationId)
  const next = WorkActivationIdentitySchema.parse({ scope, activationId,
    workflowNodeId: request.requesterNodeId, lineageId: original.lineageId,
    cause: { kind: 'work_return', returnId } })
  await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,
    cause_kind,cause_id,state,record) values($1,$2,$3,$4,'work_return',$5,'waiting',$6::jsonb)`,
  [activationId, scope.runId, scope.workflowVersionId, request.requesterNodeId, returnId, canonicalGraphJson(next)])
  return activationId
}

/** A completed native turn still owes its correlated return until routing commits it. */
export async function workRequestSettlementsLocked(context: WorkReturnContext, requesterActivationId: string) {
  const rows = (await context.sql.query<{ request: unknown; result_json: string | null;
    execution: unknown; failure_result: unknown }>(
    `select q.record as request,x.result_json,e.record as execution,b.failure_result
      from run_work_requests q
      left join run_work_returns t on t.run_id=q.run_id and t.request_id=q.request_id
      left join lateral (select h.* from harness_executions h
        where h.run_id=q.run_id and h.work_activation_id=q.destination_activation_id
        order by h.attempt desc limit 1) e on true
      left join run_work_results x on x.run_id=q.run_id and x.execution_id=e.id
      left join approval_execution_state b on b.execution_id=e.id
      where q.run_id=$1 and q.requester_activation_id=$2 and t.return_id is null order by q.request_id`,
    [context.scope.runId, requesterActivationId])).rows
  const failures: Array<{ request: WorkRequest; result: ReturnType<typeof ExecutionResultSchema.parse> }> = []
  let pending = false
  for (const row of rows) {
    const request = WorkRequestSchema.parse(row.request)
    if (row.result_json) {
      const result = AcceptedCurrentNodeResultSchema.parse(JSON.parse(row.result_json))
      if (parseWorkflowWorkResult(result, context.version, request.destinationNodeId,
        context.hooks.run.resultProtocol).routing.kind === 'finish') continue
    }
    const execution = row.execution ? HarnessExecutionSchema.parse(row.execution) : undefined
    const failure = row.failure_result ?? execution?.result
    if (execution && failure && (row.failure_result || execution.state === 'completed')) {
      const result = ExecutionResultSchema.parse(failure)
      if ((result.outcome === 'failed' || result.outcome === 'canceled')
        && !await context.hooks.allowTechnicalRetryLocked(context.sql, execution)) {
        failures.push({ request, result })
        continue
      }
    }
    pending = true
  }
  return { pending, failures }
}

export async function workReturnGroupSettlementsLocked(context: WorkReturnContext, activationId: string) {
  const requesters = (await context.sql.query<{ requester_activation_id: string }>(
    `select distinct q.requester_activation_id from run_work_returns t
      join run_work_requests q on q.run_id=t.run_id and q.request_id=t.request_id
      where t.run_id=$1 and t.requester_continuation_activation_id=$2 order by q.requester_activation_id`,
    [context.scope.runId, activationId])).rows
  if (!requesters.length) return repeatConflict('WORK_RETURN_MISSING')
  const failures: Awaited<ReturnType<typeof workRequestSettlementsLocked>>['failures'] = []
  let pending = false
  for (const requester of requesters) {
    const settled = await workRequestSettlementsLocked(context, requester.requester_activation_id)
    pending ||= settled.pending
    failures.push(...settled.failures)
  }
  return { pending, failures }
}

/** The reactivation event also records which graph task owns dispatch across replay. */
export async function resolveWaitingWorkReturnsLocked(context: WorkReturnContext,
  sourceActivationId: string): Promise<string[]> {
  const { sql, scope } = context
  const rows = (await sql.query<{ activation_id: string; workflow_node_id: string;
    return_id: string }>(
    `select a.activation_id,a.workflow_node_id,t.return_id from run_work_activations a
      join run_work_returns t on t.run_id=a.run_id and t.return_id=a.cause_id
      where a.run_id=$1 and a.cause_kind='work_return' and a.state='waiting'
      order by a.activation_sequence for update of a`,
    [scope.runId])).rows
  for (const row of rows) {
    const active = await sql.query(`select 1 from run_work_activations a
      where a.run_id=$1 and a.workflow_node_id=$2 and a.cause_kind='work_return'
        and a.state in ('queued','running') limit 1`, [scope.runId, row.workflow_node_id])
    if (active.rowCount) continue
    const settled = await workReturnGroupSettlementsLocked(context, row.activation_id)
    if (settled.pending) continue
    context.assertActive()
    await sql.query(`update run_work_activations set state='queued' where run_id=$1 and activation_id=$2`,
      [scope.runId, row.activation_id])
    await sql.query(`insert into run_activity(run_id,source,kind,occurred_at,payload)
      values($1,'backend','work_requester_reactivated',$2,$3::jsonb)`,
    [scope.runId, context.now, canonicalGraphJson({ activationId: row.activation_id,
      requesterNodeId: row.workflow_node_id, returnId: row.return_id, sourceActivationId })])
  }
  return (await sql.query<{ activation_id: string }>(
    `select payload->>'activationId' as activation_id from run_activity
      where run_id=$1 and kind='work_requester_reactivated' and payload->>'sourceActivationId'=$2
      union
      select t.requester_continuation_activation_id as activation_id from run_work_returns t
      join run_activity a on a.run_id=t.run_id and a.kind='work_requester_reactivated'
        and a.payload->>'activationId'=t.requester_continuation_activation_id
      where t.run_id=$1 and t.source_activation_id=$2 and t.outcome='needs_changes'
        and not (a.payload ? 'sourceActivationId')
      order by activation_id`, [scope.runId, sourceActivationId])).rows.map(row => row.activation_id)
}
