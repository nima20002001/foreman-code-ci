import { ExecutionResultSchema, HarnessExecutionSchema } from '@foreman-code/contracts'
import { AcceptedCurrentNodeResultSchema, HierarchyWorkGroupSchema, HierarchyWorkReturnInputSchema,
  HierarchyWorkFailureInputSchema, WorkActivationIdentitySchema,
  WorkActivationInputSchema, WorkRequestSchema, WorkReturnSchema, canonicalGraphJson,
  type HierarchyWorkGroup, type WorkActivationInput, type WorkRequest,
} from '@foreman-code/contracts/wave25'
import type { HierarchyGroupContext } from './hierarchyGroupAdmission.js'
import { repeatConflict, repeatDigest, sameRepeatValue } from './repeatResolution.js'
import { readParentWorkRequestLocked } from './workReturnValidation.js'
import { parseHierarchyWorkResult } from './hierarchyResults.js'
import { readWorkflowControlDispositionLocked } from '../collaboration/workflowControlDisposition.js'
import { closeWorkflowControlInputLocked } from '../collaboration/workflowControlQueue.js'
import { workflowControlFailure } from './workflowControlFailure.js'
import { workflowLifecycleLocked } from './workflowCollaborationRuntime.js'

interface MemberRow {
  request: unknown; returned: unknown | null; result_json: string | null; result_digest: string | null
  failure_execution_id: string | null; failure_result: unknown | null
}

async function readGroup(context: HierarchyGroupContext, groupId: string) {
  const row = (await context.sql.query<{ record: unknown; state: string; ready_source_activation_id: string | null }>(
    `select record,state,ready_source_activation_id from run_hierarchy_groups
      where run_id=$1 and group_id=$2 for update`, [context.scope.runId, groupId])).rows[0]
  if (!row) return repeatConflict('HIERARCHY_GROUP_NOT_FOUND')
  const group = HierarchyWorkGroupSchema.parse(row.record)
  if (!sameRepeatValue(group.scope, context.scope)) return repeatConflict('HIERARCHY_GROUP_SCOPE_CONFLICT')
  return { group, state: row.state, readySourceActivationId: row.ready_source_activation_id }
}

async function memberRows(context: HierarchyGroupContext, groupId: string): Promise<MemberRow[]> {
  return (await context.sql.query<MemberRow>(
    `select q.record as request,t.record as returned,x.result_json,x.result_digest,
      m.failure_execution_id,m.failure_result from run_hierarchy_group_members m
      join run_work_requests q on q.run_id=m.run_id and q.request_id=m.request_id
      left join run_work_returns t on t.run_id=q.run_id and t.request_id=q.request_id
      left join run_work_results x on x.run_id=t.run_id and x.execution_id=t.source_execution_id
      where m.run_id=$1 and m.group_id=$2 order by m.ordinal`, [context.scope.runId, groupId])).rows
}

async function recordTerminalFailure(context: HierarchyGroupContext, request: WorkRequest): Promise<boolean> {
  const row = (await context.sql.query<{ execution: unknown; failure_result: unknown | null;
    refusal_id: string | null; refusal_result: unknown | null }>(
    `select e.record as execution,b.failure_result,f.refusal_id,f.result as refusal_result from harness_executions e
      join run_work_activations a on a.run_id=e.run_id and a.activation_id=e.work_activation_id
      left join approval_execution_state b on b.execution_id=e.id
      left join run_hierarchy_refusals f on f.run_id=e.run_id and f.source_execution_id=e.id
      where e.run_id=$1 and (a.activation_id=$2 or work_parent_request(e.run_id,a.activation_id)=$3)
      order by a.activation_sequence desc,e.attempt desc limit 1 for share of e,a`,
    [context.scope.runId, request.destinationActivationId, request.requestId])).rows[0]
  if (!row) return false
  const execution = HarnessExecutionSchema.parse(row.execution)
  if (execution.workflowNodeId !== request.destinationNodeId || execution.state !== 'completed') return false
  const control = await readWorkflowControlDispositionLocked(context.sql, execution.runId, execution.id)
  if (control.kind === 'superseded' && !['failed', 'canceled'].includes(control.continuation.state)) return false
  const controlledFailure = workflowControlFailure(control)
  const raw = controlledFailure ?? row.refusal_result ?? row.failure_result ?? execution.result
  if (!raw) return false
  const result = ExecutionResultSchema.parse(raw)
  if (result.outcome !== 'failed' && result.outcome !== 'canceled') return false
  if (!controlledFailure && !row.refusal_id && await context.hooks.allowTechnicalRetryLocked(context.sql, execution)) return false
  await context.hooks.assertSettlementLocked(context.sql, [execution.id])
  await closeWorkflowControlInputLocked(context.sql, { runId: context.scope.runId, executionId: execution.id, now: context.now })
  if (controlledFailure) await workflowLifecycleLocked(context, execution,
    result.outcome === 'canceled' ? 'canceled' : 'failed', `workflow:${execution.id}:control-settled`,
    { reason: result.error!.message })
  await context.sql.query(`update run_hierarchy_group_members set failure_execution_id=$3,failure_result=$4::jsonb,
    failure_refusal_id=$5
    where run_id=$1 and request_id=$2 and failure_execution_id is null`,
  [context.scope.runId, request.requestId, execution.id, canonicalGraphJson(result, 64 * 1024), row.refusal_id])
  return true
}

/** Only committed returns or proven terminal negatives close an obligation.
 * Offline/unknown and native success without logical return remain pending. */
export async function resolveHierarchyGroupsLocked(context: HierarchyGroupContext,
  sourceActivationId: string): Promise<string[]> {
  await context.hooks.assertAuthorityLocked(context.sql)
  const ids = (await context.sql.query<{ group_id: string }>(
    `select distinct g.group_id from run_hierarchy_groups g
      join run_hierarchy_group_members m on m.run_id=g.run_id and m.group_id=g.group_id
      join run_work_requests q on q.run_id=m.run_id and q.request_id=m.request_id
      where g.run_id=$1 and (q.destination_activation_id=$2 or q.request_id=work_parent_request($1,$2)
        or g.ready_source_activation_id=$2) and g.state<>'canceled' order by g.group_id`,
    [context.scope.runId, sourceActivationId])).rows
  const ready: string[] = []
  for (const { group_id: groupId } of ids) {
    const current = await readGroup(context, groupId)
    if (current.state === 'waiting') {
      let pending = false
      const rows = await memberRows(context, groupId)
      if (!sameRepeatValue(rows.map(row => WorkRequestSchema.parse(row.request).requestId), current.group.memberRequestIds)) {
        return repeatConflict('HIERARCHY_GROUP_MEMBERSHIP_CONFLICT')
      }
      for (const row of rows) {
        if (row.returned) {
          if (row.failure_execution_id) return repeatConflict('HIERARCHY_MEMBER_SETTLEMENT_CONFLICT')
          assertReturnedMember(context, row, current.group)
        } else if (!row.failure_execution_id && !await recordTerminalFailure(context, WorkRequestSchema.parse(row.request))) {
          pending = true
        }
      }
      if (pending) continue
      context.assertActive()
      await context.sql.query(`update run_hierarchy_groups set state='ready',ready_source_activation_id=$3
        where run_id=$1 and group_id=$2 and state='waiting'`, [context.scope.runId, groupId, sourceActivationId])
      const queued = await context.sql.query(`update run_work_activations set state='queued'
        where run_id=$1 and activation_id=$2 and state='waiting'`,
      [context.scope.runId, current.group.continuationActivationId])
      if (queued.rowCount !== 1) return repeatConflict('HIERARCHY_CONTINUATION_STATE_CONFLICT')
      ready.push(current.group.continuationActivationId)
    } else if (current.readySourceActivationId === sourceActivationId) {
      ready.push(current.group.continuationActivationId)
    }
  }
  return ready
}

function assertReturnedMember(context: HierarchyGroupContext, row: MemberRow, group: HierarchyWorkGroup) {
  const request = WorkRequestSchema.parse(row.request)
  const returned = WorkReturnSchema.parse(row.returned)
  if (!row.result_json || !row.result_digest || returned.requestId !== request.requestId
    || request.requesterActivationId !== group.parentActivationId
    || request.requesterExecutionId !== group.parentExecutionId
    || returned.requesterActivationId !== group.parentActivationId
    || returned.outcome === 'needs_changes' && returned.continuationActivationId !== group.continuationActivationId
    || returned.acceptedResultDigest !== row.result_digest) return repeatConflict('HIERARCHY_RETURN_PIN_CONFLICT')
  const acceptedSourceResult = AcceptedCurrentNodeResultSchema.parse(JSON.parse(row.result_json))
  if (repeatDigest(acceptedSourceResult, 64 * 1024) !== row.result_digest) return repeatConflict('WORK_SOURCE_RESULT_CONFLICT')
  const result = parseHierarchyWorkResult(acceptedSourceResult, context.version, request.destinationNodeId,
    context.hooks.run.resultProtocol)
  return HierarchyWorkReturnInputSchema.parse({ requestId: request.requestId, destinationNodeId: request.destinationNodeId,
    returnId: returned.returnId, sourceActivationId: returned.sourceActivationId, sourceExecutionId: returned.sourceExecutionId,
    resultDigest: row.result_digest, outcome: returned.outcome,
    ...(returned.continuationActivationId ? { continuationActivationId: returned.continuationActivationId } : {}),
    summary: [...result.summary].slice(0, 300).join(''), remainingFindingsCount: returned.remainingFindings.length,
    latestDeliverable: returned.latestDeliverable, remainingFindings: returned.remainingFindings })
}

export async function readHierarchyGroupInputLocked(context: HierarchyGroupContext,
  activationId: string): Promise<WorkActivationInput> {
  const row = (await context.sql.query<{ record: unknown; cause_id: string }>(
    `select record,cause_id from run_work_activations where run_id=$1
      and activation_id=$2 and cause_kind='hierarchy_group' for share`, [context.scope.runId, activationId])).rows[0]
  if (!row) return repeatConflict('HIERARCHY_CONTINUATION_NOT_FOUND')
  const activation = WorkActivationIdentitySchema.parse(row.record)
  const current = await readGroup(context, row.cause_id)
  if (!['ready', 'continued'].includes(current.state)) return repeatConflict('HIERARCHY_GROUP_NOT_READY')
  const pinned = (await context.sql.query<{ input_json: string }>(
    'select input_json from run_repeat_slots where run_id=$1 and work_activation_id=$2',
    [context.scope.runId, activationId])).rows[0]
  if (pinned) {
    const input = WorkActivationInputSchema.parse(JSON.parse(pinned.input_json))
    if (input.work.kind !== 'hierarchy_group' || !sameRepeatValue(input.work.activation, activation)
      || !sameRepeatValue(input.work.group, current.group)) return repeatConflict('HIERARCHY_CONTINUATION_INPUT_CONFLICT')
    return input
  }
  const rows = await memberRows(context, row.cause_id)
  const returns: ReturnType<typeof assertReturnedMember>[] = []
  const failures: ReturnType<typeof HierarchyWorkFailureInputSchema.parse>[] = []
  for (const member of rows) {
    if (member.returned && !member.failure_execution_id) returns.push(assertReturnedMember(context, member, current.group))
    else if (member.failure_execution_id && !member.returned && member.failure_result) {
      const request = WorkRequestSchema.parse(member.request)
      const result = ExecutionResultSchema.parse(member.failure_result)
      failures.push(HierarchyWorkFailureInputSchema.parse({ requestId: request.requestId,
        destinationNodeId: request.destinationNodeId, executionId: member.failure_execution_id, outcome: result.outcome,
        code: [...(result.error?.code || 'WORK_EXECUTION_FAILED')].slice(0, 80).join(''),
        summary: [...(result.error?.message || 'The child work did not complete.')].slice(0, 300).join('') }))
    }
    else return repeatConflict('HIERARCHY_MEMBER_NOT_SETTLED')
  }
  const parentRequest = await readParentWorkRequestLocked(context, activationId)
  return WorkActivationInputSchema.parse({ executionSemanticsVersion: 3, runInput: context.hooks.run.input,
    occurrence: null, entry: null, predecessors: [], ...(parentRequest ? { parentRequest } : {}),
    work: { kind: 'hierarchy_group', activation, group: current.group, returns, failures } })
}

/** Admission consumes the already reserved summary slot; it never mints a second one. */
export async function markHierarchyContinuationStartedLocked(context: HierarchyGroupContext,
  activationId: string): Promise<void> {
  await context.sql.query(`update run_hierarchy_groups set state='continued'
    where run_id=$1 and continuation_activation_id=$2 and state='ready'`, [context.scope.runId, activationId])
}

/** needs_changes alone carries the pre-reserved continuation in WorkReturn.
 * Accepted returns omit it; both still settle the same authoritative group. */
export async function hierarchyContinuationForRequestLocked(context: HierarchyGroupContext,
  request: WorkRequest): Promise<string> {
  const row = (await context.sql.query<{ record: unknown }>(
    `select g.record from run_hierarchy_groups g join run_hierarchy_group_members m
      on m.run_id=g.run_id and m.group_id=g.group_id where m.run_id=$1 and m.request_id=$2 for update of g`,
    [context.scope.runId, request.requestId])).rows[0]
  if (!row) return repeatConflict('HIERARCHY_GROUP_MEMBERSHIP_MISSING')
  const group = HierarchyWorkGroupSchema.parse(row.record)
  if (group.parentActivationId !== request.requesterActivationId || group.parentExecutionId !== request.requesterExecutionId
    || !group.memberRequestIds.includes(request.requestId) || !sameRepeatValue(group.scope, request.scope)) {
    return repeatConflict('HIERARCHY_GROUP_ANCESTRY_CONFLICT')
  }
  return group.continuationActivationId
}
