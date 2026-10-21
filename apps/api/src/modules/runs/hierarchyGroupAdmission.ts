import { HarnessExecutionSchema } from '@foreman-code/contracts'
import {
  AcceptedCurrentNodeResultSchema, HierarchyWorkGroupSchema, HierarchyWorkTaskSchema,
  WorkActivationIdentitySchema, WorkActivationInputSchema, WorkRequestSchema, canonicalGraphJson, workConnectionForRequest,
  type HierarchyWorkGroup, type HierarchyWorkTask, type WorkRequest, type WorkflowVersionV3, type WorkflowRunV3,
} from '@foreman-code/contracts/wave25'
import { assertGraphTransaction, type GraphTransactionSql } from '../run-graph/connection.js'
import type { RepeatLockedHooks } from './repeatPostgres.js'
import { repeatConflict, repeatDigest, repeatId, sameRepeatValue, type RepeatScope } from './repeatResolution.js'
import { hasWorkflowExecutionCapacityLocked } from './workflowExecutionBudget.js'
import { readParentWorkRequestLocked } from './workReturnValidation.js'
import { parseHierarchyWorkResult, type HierarchyWorkResult } from './hierarchyResults.js'
import { hasHierarchyParentInputCapacity } from './hierarchyInputCapacity.js'
import { workflowLifecycleLocked } from './workflowCollaborationRuntime.js'

export interface HierarchyGroupContext {
  sql: GraphTransactionSql; scope: RepeatScope; version: WorkflowVersionV3
  hooks: RepeatLockedHooks & { run: RepeatLockedHooks['run'] & Pick<WorkflowRunV3, 'resultProtocol'> }
  now: string; assertActive(): void
}
interface RequestedWork {
  relationshipId: string; destinationNodeId: string; outcome: string
  data: HierarchyWorkTask['data']; maximum: number | null
}
type HierarchyAdmissionRefusalCode = 'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED' | 'WORK_ROUTE_LIMIT_EXHAUSTED'
  | 'HIERARCHY_INPUT_TOO_LARGE'
export type HierarchyGroupAdmission = {
  kind: 'accepted'; group: HierarchyWorkGroup; requests: WorkRequest[]; replayed: boolean
} | {
  kind: 'refused'; refusalId: string; code: HierarchyAdmissionRefusalCode
  relationshipId?: string; replayed: boolean
}

/** Selection never follows unselected routes or dispatches a second DAG path. */
export function hierarchyRequestedWork(version: WorkflowVersionV3, parentNodeId: string,
  result: HierarchyWorkResult): RequestedWork[] {
  const definition = version.definition
  const hierarchy = definition.hierarchy
  const node = definition.nodes.find(item => item.id === parentNodeId)
  if (!hierarchy || !definition.handoffs || !node || node.kind === 'job') return repeatConflict('HIERARCHY_REQUIRED')
  const routing = result.routing
  if (routing.kind !== 'delegate' && routing.kind !== 'request') return repeatConflict('HIERARCHY_REQUEST_REQUIRED')
  const selections = routing.kind === 'delegate' ? routing.requests : [{ outcome: routing.outcome, data: result.data }]
  const children = new Set(hierarchy.parents.filter(item => item.parentNodeId === parentNodeId).map(item => item.workflowNodeId))
  const seen = new Set<string>()
  return selections.map(selection => {
    const choices = node.choice?.outcomes.filter(item => item.outcome === selection.outcome) ?? []
    const target = choices[0]?.target
    const edge = target?.kind === 'edge' ? definition.edges.find(item => item.id === target.relationshipId) : undefined
    const destination = edge?.source === parentNodeId ? edge.target
      : edge?.target === parentNodeId && edge.workRequestDirection === 'both' ? edge.source : undefined
    if (choices.length !== 1 || !edge || !destination || edge.kind !== 'execution'
      || workConnectionForRequest(definition, parentNodeId, destination)?.id !== edge.id
      || seen.has(destination) || routing.kind === 'delegate' && !children.has(destination)) {
      return repeatConflict('HIERARCHY_REQUEST_ROUTE_FORBIDDEN')
    }
    seen.add(destination)
    return { relationshipId: edge.id, destinationNodeId: destination, outcome: selection.outcome,
      data: selection.data, maximum: edge.maxWorkHandoffsPerRun ?? null }
  })
}

async function acceptedSource(context: HierarchyGroupContext, sourceExecutionId: string) {
  const row = (await context.sql.query<{ record: unknown; accepted: boolean; work_activation_id: string;
    result_json: string; result_digest: string; activation: unknown }>(
    `select e.record,e.accepted,e.work_activation_id,x.result_json,x.result_digest,a.record as activation
      from harness_executions e
      join run_work_results x on x.run_id=e.run_id and x.execution_id=e.id
      join run_work_activations a on a.run_id=e.run_id and a.activation_id=e.work_activation_id
      where e.run_id=$1 and e.id=$2 for share of e,x,a`, [context.scope.runId, sourceExecutionId])).rows[0]
  if (!row?.accepted) return repeatConflict('WORK_SOURCE_NOT_ACCEPTED')
  const execution = HarnessExecutionSchema.parse(row.record)
  const activation = WorkActivationIdentitySchema.parse(row.activation)
  const result = AcceptedCurrentNodeResultSchema.parse(execution.result)
  if (execution.id !== sourceExecutionId || execution.runId !== context.scope.runId || execution.state !== 'completed'
    || activation.activationId !== row.work_activation_id || activation.workflowNodeId !== execution.workflowNodeId
    || !sameRepeatValue(activation.scope, context.scope)
    || execution.agentConfigurationVersionId !== context.version.agentConfigurationVersionIds[execution.agentId]
    || row.result_json !== canonicalGraphJson(result, 64 * 1024)
    || row.result_digest !== repeatDigest(result, 64 * 1024)) return repeatConflict('WORK_SOURCE_RESULT_CONFLICT')
  return { execution, activation, acceptedResult: result, sourceResultDigest: row.result_digest,
    result: parseHierarchyWorkResult(result, context.version, execution.workflowNodeId, context.hooks.run.resultProtocol) }
}

async function priorGroup(context: HierarchyGroupContext, sourceExecutionId: string,
  digest: string): Promise<HierarchyGroupAdmission | undefined> {
  const previous = (await context.sql.query<{ record: unknown }>(
    'select record from run_hierarchy_groups where run_id=$1 and parent_execution_id=$2 for update',
    [context.scope.runId, sourceExecutionId])).rows[0]
  if (previous) {
    const group = HierarchyWorkGroupSchema.parse(previous.record)
    if (group.sourceResultDigest !== digest || !sameRepeatValue(group.scope, context.scope)) {
      return repeatConflict('HIERARCHY_GROUP_REPLAY_CONFLICT')
    }
    const rows = (await context.sql.query<{ record: unknown }>(
      `select q.record from run_work_requests q join run_hierarchy_group_members m
        on m.run_id=q.run_id and m.request_id=q.request_id
        where m.run_id=$1 and m.group_id=$2 order by m.ordinal`, [context.scope.runId, group.groupId])).rows
    const requests = rows.map(row => WorkRequestSchema.parse(row.record))
    if (!sameRepeatValue(requests.map(request => request.requestId), group.memberRequestIds)) {
      return repeatConflict('HIERARCHY_GROUP_MEMBERSHIP_CONFLICT')
    }
    return { kind: 'accepted', group, requests, replayed: true }
  }
  const refusal = (await context.sql.query<{ refusal_id: string; source_result_digest: string;
    code: HierarchyAdmissionRefusalCode; relationship_id: string | null }>(
    `select refusal_id,source_result_digest,code,relationship_id from run_hierarchy_refusals
      where run_id=$1 and source_execution_id=$2`, [context.scope.runId, sourceExecutionId])).rows[0]
  if (!refusal) return undefined
  if (refusal.source_result_digest !== digest) return repeatConflict('HIERARCHY_GROUP_REPLAY_CONFLICT')
  return { kind: 'refused', refusalId: refusal.refusal_id, code: refusal.code,
    ...(refusal.relationship_id ? { relationshipId: refusal.relationship_id } : {}), replayed: true }
}

async function refuse(context: HierarchyGroupContext, source: Awaited<ReturnType<typeof acceptedSource>>,
  code: HierarchyAdmissionRefusalCode,
  relationshipId?: string): Promise<HierarchyGroupAdmission> {
  const refusalId = repeatId('hierarchy-refusal', context.scope.runId, source.execution.id)
  const result = { outcome: 'failed', error: { code, retryable: false,
    message: code === 'WORK_ROUTE_LIMIT_EXHAUSTED'
      ? `The saved route ${relationshipId} has no remaining work slots.`
      : code === 'HIERARCHY_INPUT_TOO_LARGE'
        ? 'The Run input leaves insufficient space for child tasks or their parent feedback.'
        : 'The Run has insufficient capacity for all child activations and their parent continuation.' } }
  await context.sql.query(`insert into run_hierarchy_refusals(refusal_id,run_id,source_activation_id,
    source_execution_id,source_result_digest,code,relationship_id,result,created_at) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
  [refusalId, context.scope.runId, source.activation.activationId, source.execution.id,
    source.sourceResultDigest, code, relationshipId ?? null, canonicalGraphJson(result), context.now])
  await workflowLifecycleLocked(context, source.execution, 'failed', `workflow:${source.execution.id}:admission-refused`,
    { reason: result.error.message })
  return { kind: 'refused', refusalId, code, ...(relationshipId ? { relationshipId } : {}), replayed: false }
}

async function checkRoutes(context: HierarchyGroupContext, requested: RequestedWork[]): Promise<string | undefined> {
  for (const item of [...requested].sort((left, right) => left.relationshipId.localeCompare(right.relationshipId))) {
    const usage = (await context.sql.query<{ used: number; maximum: number | null }>(
      `select used,maximum from run_work_connection_usage
        where run_id=$1 and workflow_version_id=$2 and relationship_id=$3 for update`,
      [context.scope.runId, context.scope.workflowVersionId, item.relationshipId])).rows[0]
    if (usage && usage.maximum !== item.maximum) return repeatConflict('WORK_COUNTER_PIN_CONFLICT')
    if (item.maximum !== null && (usage?.used ?? 0) >= item.maximum) return item.relationshipId
  }
  return undefined
}

/** The caller owns the existing Run transaction/fence. A refusal consumes no
 * route or activation, and never changes the completed native source. */
export async function admitHierarchyGroupLocked(context: HierarchyGroupContext,
  sourceExecutionId: string): Promise<HierarchyGroupAdmission> {
  assertGraphTransaction(context.sql)
  await context.hooks.assertAuthorityLocked(context.sql)
  const source = await acceptedSource(context, sourceExecutionId)
  const previous = await priorGroup(context, sourceExecutionId, source.sourceResultDigest)
  if (previous) return previous
  context.assertActive()
  await context.hooks.assertSettlementLocked(context.sql, [sourceExecutionId])
  const requested = hierarchyRequestedWork(context.version, source.execution.workflowNodeId, source.result)
  const exhausted = await checkRoutes(context, requested)
  if (exhausted) return refuse(context, source, 'WORK_ROUTE_LIMIT_EXHAUSTED', exhausted)
  if (!await hasWorkflowExecutionCapacityLocked(context.sql, context.scope.runId, context.version,
    null, requested.length + 1)) return refuse(context, source, 'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED')
  const groupId = repeatId('hierarchy-group', context.scope.runId, sourceExecutionId)
  const continuationActivationId = repeatId('work-activation', groupId)
  const parentRequest = await readParentWorkRequestLocked(context, source.activation.activationId)
  const group = HierarchyWorkGroupSchema.parse({ scope: context.scope, groupId,
    parentActivationId: source.activation.activationId, parentExecutionId: sourceExecutionId,
    parentNodeId: source.execution.workflowNodeId, continuationActivationId,
    sourceResultDigest: source.sourceResultDigest, ...(parentRequest ? { parentRequestId: parentRequest.requestId } : {}),
    memberRequestIds: requested.map(item => repeatId('work-request', context.scope.runId, sourceExecutionId, item.relationshipId)),
    createdAt: context.now })
  const continuation = WorkActivationIdentitySchema.parse({ scope: context.scope, activationId: continuationActivationId,
    workflowNodeId: group.parentNodeId, lineageId: source.activation.lineageId, cause: { kind: 'hierarchy_group', groupId } })
  const members = requested.map((item, index) => ({ requestId: group.memberRequestIds[index]!,
    destinationNodeId: item.destinationNodeId }))
  if (!hasHierarchyParentInputCapacity(group, continuation, context.hooks.run.input, members, parentRequest)) {
    return refuse(context, source, 'HIERARCHY_INPUT_TOO_LARGE')
  }
  for (const [index, item] of requested.entries()) {
    const child = childRecords(context, group, source.activation.lineageId, item, index, 2147483647)
    const input = WorkActivationInputSchema.safeParse({ executionSemanticsVersion: 3, runInput: context.hooks.run.input,
      occurrence: null, entry: null, predecessors: [], work: { kind: 'work_request', ...child,
        acceptedSourceResult: source.acceptedResult } })
    if (!input.success) return refuse(context, source, 'HIERARCHY_INPUT_TOO_LARGE')
  }
  for (const item of requested) await assertChildAdmission(context, item, groupId)
  await context.sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,
    cause_kind,cause_id,state,record) values($1,$2,$3,$4,'hierarchy_group',$5,'waiting',$6::jsonb)`,
  [continuationActivationId, context.scope.runId, context.scope.workflowVersionId, group.parentNodeId,
    groupId, canonicalGraphJson(continuation)])
  await context.sql.query(`insert into run_hierarchy_groups(group_id,run_id,workflow_version_id,parent_activation_id,
    parent_execution_id,parent_node_id,continuation_activation_id,source_result_digest,state,record,created_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,'waiting',$9::jsonb,$10)`,
  [groupId, context.scope.runId, context.scope.workflowVersionId, group.parentActivationId, sourceExecutionId,
    group.parentNodeId, continuationActivationId, source.sourceResultDigest, canonicalGraphJson(group), context.now])
  const requests: WorkRequest[] = []
  for (const [index, item] of requested.entries()) {
    requests.push(await insertChild(context, group, source.activation.lineageId, item, index))
  }
  await workflowLifecycleLocked(context, source.execution, 'waiting_children', `workflow:${sourceExecutionId}:waiting-children`,
    { requestGroupId: groupId, outstandingRequestIds: group.memberRequestIds, summary: source.result.summary })
  return { kind: 'accepted', group, requests, replayed: false }
}

async function assertChildAdmission(context: HierarchyGroupContext, item: RequestedWork, groupId: string): Promise<void> {
  const node = context.version.definition.nodes.find(candidate => candidate.id === item.destinationNodeId)
  if (!node || node.kind === 'job') return repeatConflict('HIERARCHY_AGENT_REQUIRED')
  const candidate = HarnessExecutionSchema.parse({ id: repeatId('work-candidate', groupId, node.id),
    runId: context.scope.runId, workflowNodeId: node.id, agentId: node.agentId,
    agentConfigurationVersionId: context.version.agentConfigurationVersionIds[node.agentId],
    attempt: 1, input: {}, state: 'queued', createdAt: context.now })
  await context.hooks.assertAdmissionLocked(context.sql, candidate, { nodeId: node.id, occurrence: null })
}

function childRecords(context: HierarchyGroupContext, group: HierarchyWorkGroup,
  lineageId: string, item: RequestedWork, index: number, ordinal: number) {
  const { scope } = context
  const requestId = group.memberRequestIds[index]!
  const activationId = repeatId('work-activation', requestId)
  const activation = WorkActivationIdentitySchema.parse({ scope, activationId,
    workflowNodeId: item.destinationNodeId, lineageId, cause: { kind: 'work_request', requestId } })
  const request = WorkRequestSchema.parse({ scope, requestId, relationshipId: item.relationshipId,
    requesterActivationId: group.parentActivationId, requesterExecutionId: group.parentExecutionId,
    destinationActivationId: activationId, requesterNodeId: group.parentNodeId, destinationNodeId: item.destinationNodeId,
    payloadDigest: group.sourceResultDigest, acceptedAt: context.now, ordinal })
  const task = HierarchyWorkTaskSchema.parse({ groupId: group.groupId, outcome: item.outcome,
    data: item.data, digest: repeatDigest(item.data, 64 * 1024) })
  return { activation, request, task }
}

async function insertChild(context: HierarchyGroupContext, group: HierarchyWorkGroup,
  lineageId: string, item: RequestedWork, index: number): Promise<WorkRequest> {
  const { sql, scope } = context
  await sql.query(`insert into run_work_connection_usage(run_id,workflow_version_id,relationship_id,maximum)
    values($1,$2,$3,$4) on conflict do nothing`, [scope.runId, scope.workflowVersionId, item.relationshipId, item.maximum])
  const usage = (await sql.query<{ used: number }>(`update run_work_connection_usage set used=used+1
    where run_id=$1 and workflow_version_id=$2 and relationship_id=$3 and (maximum is null or used<maximum)
    returning used`, [scope.runId, scope.workflowVersionId, item.relationshipId])).rows[0]
  if (!usage) return repeatConflict('WORK_COUNTER_RACE')
  const { activation, request, task } = childRecords(context, group, lineageId, item, index, usage.used)
  const { requestId, destinationActivationId: activationId } = request
  await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,
    cause_kind,cause_id,state,record) values($1,$2,$3,$4,'work_request',$5,'queued',$6::jsonb)`,
  [activationId, scope.runId, scope.workflowVersionId, item.destinationNodeId, requestId, canonicalGraphJson(activation)])
  await sql.query(`insert into run_work_requests(request_id,run_id,workflow_version_id,relationship_id,ordinal,
    requester_activation_id,requester_execution_id,destination_activation_id,requester_node_id,destination_node_id,
    payload_digest,record,accepted_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,
  [requestId, scope.runId, scope.workflowVersionId, item.relationshipId, usage.used, group.parentActivationId,
    group.parentExecutionId, activationId, group.parentNodeId, item.destinationNodeId, group.sourceResultDigest,
    canonicalGraphJson(request), context.now])
  await sql.query(`insert into run_hierarchy_group_members(run_id,group_id,request_id,ordinal,task_json,task_data_json,task_digest)
    values($1,$2,$3,$4,$5,$6,$7)`, [scope.runId, group.groupId, requestId, index + 1,
    canonicalGraphJson(task), canonicalGraphJson(task.data, 64 * 1024), task.digest])
  return request
}
