import { HarnessExecutionSchema } from '@foreman-code/contracts'
import {
  AcceptedCurrentNodeResultSchema, WorkActivationIdentitySchema, WorkHandoffResultSchema,
  WorkActivationInputSchema, WorkLimitDenialSchema, WorkRequestSchema, WorkReturnSchema,
  canonicalGraphJson, parseWorkHandoffResult, workConnectionForRequest,
  type WorkActivationInput, type WorkHandoffResult, type WorkLimitDenial, type WorkNotice,
  type WorkRequest, type WorkReturn, type WorkflowVersionV3,
} from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { RepeatLockedHooks } from './repeatPostgres.js'
import { repeatConflict, repeatDigest, repeatId, sameRepeatValue, type RepeatScope } from './repeatResolution.js'
import { frozenWorkNotice, persistWorkLimitNoticeLocked, readWorkLimitNoticeLocked } from './workHandoffNotice.js'
import { assertWorkflowExecutionCapacityLocked } from './workflowExecutionBudget.js'
import { parseWorkResultLocked, readParentWorkRequestLocked, readWorkReturnRequestLocked } from './workReturnValidation.js'
import {
  ensureWorkReturnContinuationLocked, resolveWaitingWorkReturnsLocked, workRequestSettlementsLocked,
} from './workReturnContinuation.js'
import { readWorkReturnFeedbackLocked } from './workReturnInput.js'
import { selectedWorkHandoffRoutes } from './workHandoffRouting.js'

async function assertAcceptedWorkResult(sql: GraphTransactionSql, scope: RepeatScope,
  execution: ReturnType<typeof HarnessExecutionSchema.parse>, activationId: string): Promise<void> {
  const result = AcceptedCurrentNodeResultSchema.parse(execution.result)
  const row = (await sql.query<{ result_json: string; result_digest: string }>(
    `select result_json,result_digest from run_work_results
      where run_id=$1 and execution_id=$2 and activation_id=$3 for share`,
    [scope.runId, execution.id, activationId])).rows[0]
  if (!row || row.result_digest !== repeatDigest(result, 64 * 1024)
    || row.result_json !== canonicalGraphJson(result, 64 * 1024)) return repeatConflict('WORK_RESULT_RECEIPT_MISSING')
}

export type WorkRequestAdmission = { kind: 'accepted'; request: WorkRequest; replayed: boolean; destinationReady: boolean }
  | { kind: 'limit_reached'; denial: WorkLimitDenial; notice: WorkNotice; replayed: boolean }
  | { kind: 'needs_direction'; unresolvedId: string; replayed: boolean }
export interface WorkReturnReceipt { value: WorkReturn; replayed: boolean; destinations?: string[] }

/** Reconstruct only from the exact saved cause and accepted result receipt. */
export async function readWorkActivationInputLocked(context: AdmissionContext, activationId: string): Promise<WorkActivationInput> {
  const { sql, scope, version } = context
  if (!version.definition.handoffs || version.definition.repeat
    || version.definition.nodes.some((node) => node.kind === 'job')) return repeatConflict('WORK_POLICY_PIN_CONFLICT')
  const row = (await sql.query<{ record: unknown; workflow_node_id: string; cause_kind: string; cause_id: string }>(
    `select record,workflow_node_id,cause_kind,cause_id from run_work_activations
      where activation_id=$1 and run_id=$2 for share`, [activationId, scope.runId])).rows[0]
  if (!row) return repeatConflict('WORK_ACTIVATION_MISSING')
  const activation = WorkActivationIdentitySchema.parse(row.record)
  if (!sameRepeatValue(activation.scope, scope) || activation.activationId !== activationId
    || activation.workflowNodeId !== row.workflow_node_id || activation.cause.kind !== row.cause_kind) {
    return repeatConflict('WORK_ACTIVATION_PIN_CONFLICT')
  }
  const parentRequest = activation.cause.kind === 'work_return' || activation.cause.kind === 'limit_denial'
    ? await readParentWorkRequestLocked(context, activationId) : undefined
  const base = { executionSemanticsVersion: 3, runInput: context.hooks.run.input,
    occurrence: null, entry: null, predecessors: [], ...(parentRequest ? { parentRequest } : {}) }
  if (activation.cause.kind === 'entry') {
    if (activation.workflowNodeId !== version.entryNodeId || row.cause_id !== scope.runId
      || activation.lineageId !== scope.runId) return repeatConflict('WORK_ENTRY_PIN_CONFLICT')
    return WorkActivationInputSchema.parse({ ...base, work: { kind: 'entry', activation } })
  }
  if (activation.cause.kind === 'work_request') {
    const requestRow = (await sql.query<{ record: unknown }>(
      'select record from run_work_requests where run_id=$1 and request_id=$2 for share',
      [scope.runId, row.cause_id])).rows[0]
    if (!requestRow) return repeatConflict('WORK_REQUEST_MISSING')
    const request = WorkRequestSchema.parse(requestRow.record)
    if (request.destinationActivationId !== activationId || request.destinationNodeId !== activation.workflowNodeId
      || !sameRepeatValue(request.scope, scope)) return repeatConflict('WORK_REQUEST_ANCESTRY_CONFLICT')
    const accepted = (await sql.query<{ result_json: string; result_digest: string }>(
      'select result_json,result_digest from run_work_results where run_id=$1 and execution_id=$2 for share',
      [scope.runId, request.requesterExecutionId])).rows[0]
    if (!accepted || accepted.result_digest !== request.payloadDigest) return repeatConflict('WORK_SOURCE_RESULT_CONFLICT')
    const acceptedSourceResult = AcceptedCurrentNodeResultSchema.parse(JSON.parse(accepted.result_json))
    if (repeatDigest(acceptedSourceResult, 64 * 1024) !== accepted.result_digest) return repeatConflict('WORK_SOURCE_RESULT_CONFLICT')
    return WorkActivationInputSchema.parse({ ...base, work: { kind: 'work_request', activation, request, acceptedSourceResult } })
  }
  if (activation.cause.kind === 'work_return') {
    const returnedRow = (await sql.query<{ record: unknown }>(
      'select record from run_work_returns where run_id=$1 and return_id=$2 for share',
      [scope.runId, row.cause_id])).rows[0]
    if (!returnedRow) return repeatConflict('WORK_RETURN_MISSING')
    const returned = WorkReturnSchema.parse(returnedRow.record)
    if (returned.continuationActivationId !== activationId
      || !sameRepeatValue(returned.scope, scope)) return repeatConflict('WORK_RETURN_ANCESTRY_CONFLICT')
    const feedback = await readWorkReturnFeedbackLocked(context, returned, activation.workflowNodeId)
    return WorkActivationInputSchema.parse({ ...base, work: { kind: 'work_return', activation, ...feedback } })
  }
  if (activation.cause.kind === 'limit_denial') {
    const denialRow = (await sql.query<{ record: unknown }>(
      'select record from run_work_denials where run_id=$1 and denial_id=$2 for share',
      [scope.runId, row.cause_id])).rows[0]
    if (!denialRow) return repeatConflict('WORK_DENIAL_MISSING')
    const denial = WorkLimitDenialSchema.parse(denialRow.record)
    if (!sameRepeatValue(denial.scope, scope) || denial.requesterActivationId === activationId) {
      return repeatConflict('WORK_DENIAL_ANCESTRY_CONFLICT')
    }
    const notice = frozenWorkNotice(await readWorkLimitNoticeLocked(context,
      { kind: 'limit_denial', denialId: denial.denialId }))
    if (notice.continuationActivationId !== activationId) return repeatConflict('WORK_NOTICE_PIN_CONFLICT')
    const accepted = (await sql.query<{ result_json: string; result_digest: string }>(
      'select result_json,result_digest from run_work_results where run_id=$1 and execution_id=$2 for share',
      [scope.runId, denial.requesterExecutionId])).rows[0]
    if (!accepted || accepted.result_digest !== denial.payloadDigest) return repeatConflict('WORK_SOURCE_RESULT_CONFLICT')
    const acceptedSourceResult = AcceptedCurrentNodeResultSchema.parse(JSON.parse(accepted.result_json))
    if (repeatDigest(acceptedSourceResult, 64 * 1024) !== accepted.result_digest) return repeatConflict('WORK_SOURCE_RESULT_CONFLICT')
    return WorkActivationInputSchema.parse({ ...base, work: { kind: 'limit_denial', activation,
      denial, acceptedSourceResult, notice } })
  }
  if (activation.cause.kind === 'join') {
    const incoming = version.definition.edges.filter((edge) => edge.kind === 'execution'
      && edge.target === activation.workflowNodeId)
    if (incoming.length < 2 || version.definition.nodes.find((node) => node.id === activation.workflowNodeId)?.join?.mode !== 'all') {
      return repeatConflict('WORK_JOIN_TOPOLOGY_CONFLICT')
    }
    const rows = (await sql.query<{ record: unknown; result_json: string; result_digest: string }>(
      `select r.record,x.result_json,x.result_digest from run_work_requests r
        join run_work_results x on x.run_id=r.run_id and x.execution_id=r.requester_execution_id
        where r.run_id=$1 and r.destination_activation_id=$2 order by r.relationship_id`,
      [scope.runId, activationId])).rows
    const required = await readRequiredWorkJoinEdgesLocked(context, activationId, activation.workflowNodeId)
    if (!required.length || rows.length !== required.length) return repeatConflict('WORK_JOIN_INCOMPLETE')
    const sources = rows.map((item) => {
      const request = WorkRequestSchema.parse(item.record)
      const acceptedSourceResult = AcceptedCurrentNodeResultSchema.parse(JSON.parse(item.result_json))
      if (request.payloadDigest !== item.result_digest || request.destinationNodeId !== activation.workflowNodeId
        || !sameRepeatValue(request.scope, scope)
        || repeatDigest(acceptedSourceResult, 64 * 1024) !== item.result_digest) return repeatConflict('WORK_JOIN_SOURCE_CONFLICT')
      return { request, acceptedSourceResult }
    })
    if (new Set(sources.map((item) => item.request.relationshipId)).size !== required.length
      || required.some((id) => !sources.some((item) => item.request.relationshipId === id))) {
      return repeatConflict('WORK_JOIN_SOURCE_CONFLICT')
    }
    return WorkActivationInputSchema.parse({ ...base, work: { kind: 'join', activation, sources } })
  }
  return repeatConflict('WORK_ACTIVATION_CAUSE_UNSUPPORTED')
}

interface AdmissionContext {
  sql: GraphTransactionSql; scope: RepeatScope; version: WorkflowVersionV3
  hooks: RepeatLockedHooks; now: string
  assertActive(): void
}

async function readRequiredWorkJoinEdgesLocked(context: AdmissionContext,
  activationId: string, nodeId: string): Promise<string[]> {
  const row = (await context.sql.query<{ required: string[] }>(
    'select work_join_required_edges($1,work_round_id($1,$2),$3) as required',
    [context.scope.runId, activationId, nodeId])).rows[0]
  if (!row) return repeatConflict('WORK_JOIN_ROUND_CONFLICT')
  return row.required
}

async function resolveWorkJoinLocked(context: AdmissionContext, activationId: string, nodeId: string): Promise<boolean> {
  const required = await readRequiredWorkJoinEdgesLocked(context, activationId, nodeId)
  const selected = (await context.sql.query<{ relationship_id: string }>(
    'select relationship_id from run_work_requests where run_id=$1 and destination_activation_id=$2',
    [context.scope.runId, activationId])).rows.map((item) => item.relationship_id)
  if (new Set(selected).size !== selected.length || selected.some((id) => !required.includes(id))) {
    return repeatConflict('WORK_JOIN_SOURCE_CONFLICT')
  }
  if (selected.length !== required.length) return false
  context.assertActive()
  await context.sql.query(`update run_work_activations set state=$3
    where run_id=$1 and activation_id=$2 and state='waiting'`,
    [context.scope.runId, activationId, required.length ? 'queued' : 'completed'])
  return required.length > 0
}

async function claimWorkJoinDispatchLocked(context: AdmissionContext,
  activationId: string, sourceActivationId: string): Promise<boolean> {
  context.assertActive()
  await context.sql.query(`insert into run_work_join_dispatches(run_id,activation_id,source_activation_id)
    values($1,$2,$3) on conflict do nothing`, [context.scope.runId, activationId, sourceActivationId])
  const row = (await context.sql.query<{ source_activation_id: string }>(
    'select source_activation_id from run_work_join_dispatches where run_id=$1 and activation_id=$2',
    [context.scope.runId, activationId])).rows[0]
  return row?.source_activation_id === sourceActivationId
}

export async function resolveWaitingWorkJoinsLocked(context: AdmissionContext,
  sourceActivationId: string): Promise<string[]> {
  await context.hooks.assertAuthorityLocked(context.sql)
  const ready = await reconcileAcceptedWorkReturnsLocked(context, sourceActivationId)
  const rows = (await context.sql.query<{ activation_id: string; workflow_node_id: string; state: string }>(
    `select a.activation_id,a.workflow_node_id,a.state from run_work_activations a
      left join run_work_join_dispatches d on d.run_id=a.run_id and d.activation_id=a.activation_id
      where a.run_id=$1 and a.cause_kind='join' and (d.source_activation_id=$2 or d.activation_id is null
        and (a.state='waiting' or a.state='queued'
        and not exists(select 1 from harness_executions e where e.run_id=a.run_id
          and e.work_activation_id=a.activation_id))) order by a.activation_id for update of a`,
    [context.scope.runId, sourceActivationId])).rows
  for (const row of rows) {
    const owned = (await context.sql.query(`select 1 from run_work_join_dispatches
      where run_id=$1 and activation_id=$2 and source_activation_id=$3`,
    [context.scope.runId, row.activation_id, sourceActivationId])).rowCount === 1
    if (owned || (row.state === 'queued' || await resolveWorkJoinLocked(context, row.activation_id, row.workflow_node_id))
      && await claimWorkJoinDispatchLocked(context, row.activation_id, sourceActivationId)) {
      ready.push(row.activation_id)
    }
  }
  return [...new Set([...ready, ...await resolveWaitingWorkReturnsLocked(context, sourceActivationId)])]
}

/** Preserve the accepted native decision when no lawful continuation remains.
 * Independent graph branches still finish; Run settlement reports this work as
 * unresolved instead of silently approving it or waking the same Agent again. */
export async function recordUnresolvedWorkLocked(context: AdmissionContext,
  sourceExecutionId: string, reason: 'finish_with_findings' | 'repeated_exhausted_route',
  relationshipId?: string): Promise<{ unresolvedId: string; replayed: boolean }> {
  const { sql, scope, version } = context
  await context.hooks.assertAuthorityLocked(sql)
  const row = (await sql.query<{ record: unknown; accepted: boolean; work_activation_id: string | null }>(
    'select record,accepted,work_activation_id from harness_executions where id=$1 and run_id=$2 for share',
    [sourceExecutionId, scope.runId])).rows[0]
  if (!row?.accepted || !row.work_activation_id) return repeatConflict('WORK_SOURCE_NOT_ACCEPTED')
  const execution = HarnessExecutionSchema.parse(row.record)
  await assertAcceptedWorkResult(sql, scope, execution, row.work_activation_id)
  const result = await parseWorkResultLocked(context, execution, row.work_activation_id)
  const node = version.definition.nodes.find((item) => item.id === execution.workflowNodeId)
  if (!node) return repeatConflict('WORKFLOW_NODE_NOT_FOUND')
  if (node.kind === 'job') return repeatConflict('WORK_POLICY_PIN_CONFLICT')
  if (reason === 'finish_with_findings') {
    const acceptedReturn = result.routing.kind === 'return' && result.routing.outcome === 'accepted'
    if (relationshipId || result.routing.kind !== 'finish' && !acceptedReturn || !result.data.remainingFindings.length) {
      return repeatConflict('WORK_UNRESOLVED_CAUSE_CONFLICT')
    }
    if (acceptedReturn) {
      const returned = (await sql.query<{ record: unknown }>(
        'select record from run_work_returns where run_id=$1 and source_execution_id=$2',
        [scope.runId, sourceExecutionId])).rows[0]
      if (!returned) return repeatConflict('WORK_RETURN_RESULT_CONFLICT')
      const value = WorkReturnSchema.parse(returned.record)
      if (result.routing.kind !== 'return' || value.requestId !== result.routing.requestId
        || value.outcome !== 'accepted' || value.acceptedResultDigest !== repeatDigest(execution.result, 64 * 1024)) {
        return repeatConflict('WORK_RETURN_RESULT_CONFLICT')
      }
    }
    const route = result.routing.kind === 'finish'
      ? node.choice?.outcomes.find((item) => item.outcome === result.routing.outcome)?.target : undefined
    if (route?.kind === 'edge') return repeatConflict('WORK_UNRESOLVED_ROUTE_EXISTS')
  } else {
    const selected = (await sql.query<{ routes: string[] }>(
      'select work_saved_routes(repeat_pinned_version($1),$2::jsonb,$3::jsonb) as routes',
      [scope.runId, canonicalGraphJson(node), canonicalGraphJson(result)])).rows[0]
    if (!relationshipId || !selected?.routes.includes(relationshipId)) {
      return repeatConflict('WORK_UNRESOLVED_CAUSE_CONFLICT')
    }
    const activation = (await sql.query<{ lineage_id: string }>(
      'select lineage_id from run_work_activations where run_id=$1 and activation_id=$2 for share',
      [scope.runId, row.work_activation_id])).rows[0]
    if (!activation || !(await sql.query(`select 1 from run_work_denials d
      join run_work_activations a on a.run_id=d.run_id and a.activation_id=d.requester_activation_id
      where d.run_id=$1 and d.relationship_id=$2 and a.lineage_id=$3 limit 1`,
    [scope.runId, relationshipId, activation.lineage_id])).rowCount) return repeatConflict('WORK_UNRESOLVED_DENIAL_MISSING')
  }
  const prior = (await sql.query<{ unresolved_id: string; reason: string; result_digest: string }>(
    `select unresolved_id,reason,result_digest from run_work_unresolved
      where run_id=$1 and execution_id=$2 and relationship_id is not distinct from $3`,
    [scope.runId, sourceExecutionId, relationshipId ?? null])).rows[0]
  const unresolvedId = prior?.unresolved_id ?? (relationshipId
    ? repeatId('work-unresolved', scope.runId, sourceExecutionId, relationshipId)
    : repeatId('work-unresolved', scope.runId, sourceExecutionId))
  const resultDigest = repeatDigest(execution.result, 64 * 1024)
  if (prior) {
    if (prior.reason !== reason || prior.result_digest !== resultDigest) {
      return repeatConflict('WORK_UNRESOLVED_REPLAY_CONFLICT')
    }
    return { unresolvedId, replayed: true }
  }
  context.assertActive()
  await context.hooks.assertSettlementLocked(sql, [sourceExecutionId])
  await sql.query(`insert into run_work_unresolved(unresolved_id,run_id,activation_id,execution_id,
    result_digest,reason,relationship_id,created_at) values($1,$2,$3,$4,$5,$6,$7,$8)`,
  [unresolvedId, scope.runId, row.work_activation_id, sourceExecutionId,
    resultDigest, reason, relationshipId ?? null, context.now])
  await sql.query(`insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
    values($1,'backend','work_needs_direction',$2,$3,$4::jsonb)`,
  [scope.runId, sourceExecutionId, context.now, canonicalGraphJson({ unresolvedId,
    activationId: row.work_activation_id, workflowNodeId: node.id, reason,
    relationshipId: relationshipId ?? null })])
  return { unresolvedId, replayed: false }
}

export async function ensureWorkEntryLocked(context: AdmissionContext): Promise<string> {
  const { sql, scope, version } = context
  if (!version.definition.handoffs || version.definition.repeat
    || version.definition.nodes.some((node) => node.kind === 'job')) return repeatConflict('WORK_POLICY_PIN_CONFLICT')
  await context.hooks.assertAuthorityLocked(sql)
  const activationId = repeatId('work-activation', scope.runId, 'entry')
  const prior = (await sql.query<{ record: unknown }>(
    `select record from run_work_activations where run_id=$1 and activation_id=$2`,
    [scope.runId, activationId])).rows[0]
  if (prior) {
    const value = WorkActivationIdentitySchema.parse(prior.record)
    if (!sameRepeatValue(value.scope, scope) || value.workflowNodeId !== version.entryNodeId
      || value.lineageId !== scope.runId || value.cause.kind !== 'entry') return repeatConflict('WORK_ENTRY_REPLAY_CONFLICT')
    return activationId
  }
  context.assertActive()
  await assertWorkflowExecutionCapacityLocked(sql, scope.runId, version)
  const value = WorkActivationIdentitySchema.parse({ scope, activationId,
    workflowNodeId: version.entryNodeId, lineageId: scope.runId, cause: { kind: 'entry' } })
  await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,
    cause_kind,cause_id,state,record) values($1,$2,$3,$4,'entry',$2,'queued',$5::jsonb)`,
  [activationId, scope.runId, scope.workflowVersionId, version.entryNodeId, canonicalGraphJson(value)])
  await sql.query(`insert into run_activity(run_id,source,kind,occurred_at,payload)
    values($1,'backend','work_activation_queued',$2,$3::jsonb)`,
  [scope.runId, context.now, canonicalGraphJson({ activationId, workflowNodeId: version.entryNodeId })])
  return activationId
}

async function readAcceptedWorkSourceLocked(context: AdmissionContext, sourceExecutionId: string) {
  const { sql, scope, version } = context
  const row = (await sql.query<{ record: unknown; accepted: boolean; work_activation_id: string | null }>(
    `select record,accepted,work_activation_id from harness_executions
      where id=$1 and run_id=$2 for share`, [sourceExecutionId, scope.runId])).rows[0]
  if (!row?.accepted || !row.work_activation_id) return repeatConflict('WORK_SOURCE_NOT_ACCEPTED')
  const execution = HarnessExecutionSchema.parse(row.record)
  if (execution.id !== sourceExecutionId || execution.runId !== scope.runId || execution.state !== 'completed'
    || execution.result?.outcome !== 'succeeded' || !execution.finishedAt
    || execution.agentConfigurationVersionId !== version.agentConfigurationVersionIds[execution.agentId]) {
    return repeatConflict('WORK_SOURCE_PIN_CONFLICT')
  }
  await assertAcceptedWorkResult(sql, scope, execution, row.work_activation_id)
  return { execution, activationId: row.work_activation_id }
}

/** Called only inside RepeatRunRepository's owner-fenced, Run-locked transaction.
 * This is an admission receipt; native launch still uses the original one-use
 * claim, authorization, session and possible-submission boundary. */
export async function admitWorkHandoffLocked(context: AdmissionContext, sourceExecutionId: string,
  selectedRelationshipId?: string, dispatchSourceActivationId?: string): Promise<WorkRequestAdmission> {
  const { sql, scope, version, hooks } = context
  if (!version.definition.handoffs || version.definition.repeat
    || version.definition.nodes.some((node) => node.kind === 'job')) return repeatConflict('WORK_POLICY_PIN_CONFLICT')
  await hooks.assertAuthorityLocked(sql)
  const { execution, activationId: sourceActivationId } = await readAcceptedWorkSourceLocked(context, sourceExecutionId)
  const source = (await sql.query<{ record: unknown; workflow_node_id: string }>(
    'select record,workflow_node_id from run_work_activations where activation_id=$1 and run_id=$2 for share',
    [sourceActivationId, scope.runId])).rows[0]
  if (!source || source.workflow_node_id !== execution.workflowNodeId) return repeatConflict('WORK_SOURCE_ACTIVATION_CONFLICT')
  const activation = WorkActivationIdentitySchema.parse(source.record)
  if (!sameRepeatValue(activation.scope, scope) || activation.activationId !== sourceActivationId) {
    return repeatConflict('WORK_SOURCE_ACTIVATION_CONFLICT')
  }
  const result = WorkHandoffResultSchema.parse(parseWorkHandoffResult(execution.result))
  const routing: WorkHandoffResult['routing'] = result.routing.kind === 'return' && result.routing.outcome === 'accepted'
    && !result.data.remainingFindings.length ? { kind: 'finish' as const } : result.routing
  const node = version.definition.nodes.find((item) => item.id === execution.workflowNodeId)
  if (!node || routing.kind === 'return') return repeatConflict('WORK_REQUEST_RESULT_REQUIRED')
  if (routing.kind === 'finish' && routing.outcome !== undefined && !node.choice) {
    return repeatConflict('WORK_REQUEST_OUTCOME_UNDECLARED')
  }
  const target = 'outcome' in routing && routing.outcome
    ? node.choice?.outcomes.find((item) => item.outcome === routing.outcome)?.target : undefined
  if (routing.kind === 'request' && (!target || target.kind !== 'edge')
    || routing.kind === 'finish' && node.choice && selectedRelationshipId && (!target || target.kind !== 'edge')) {
    return repeatConflict('WORK_REQUEST_OUTCOME_UNDECLARED')
  }
  const relationshipId = routing.kind === 'request' ? target!.kind === 'edge' ? target!.relationshipId : undefined
    : selectedRelationshipId
  if (!relationshipId || selectedRelationshipId && relationshipId !== selectedRelationshipId) {
    return repeatConflict('WORK_REQUEST_ROUTE_FORBIDDEN')
  }
  const relationship = version.definition.edges.find((item) => item.id === relationshipId)
  if (routing.kind === 'finish' && (node.choice ? target?.kind !== 'edge' || target.relationshipId !== relationshipId
    : relationship?.source !== node.id)) return repeatConflict('WORK_REQUEST_ROUTE_FORBIDDEN')
  const destinationNodeId = relationship?.source === node.id ? relationship.target
    : relationship?.workRequestDirection === 'both' && relationship.target === node.id ? relationship.source : undefined
  if (!relationship || !destinationNodeId || !node
    || workConnectionForRequest(version.definition, node.id, destinationNodeId)?.id !== relationship.id) {
    return repeatConflict('WORK_REQUEST_ROUTE_FORBIDDEN')
  }
  const requestId = repeatId('work-request', scope.runId, sourceExecutionId, relationship.id)
  const payloadDigest = repeatDigest(execution.result, 64 * 1024)
  const prior = (await sql.query<{ record: unknown; payload_digest: string }>(
    'select record,payload_digest from run_work_requests where request_id=$1 and run_id=$2',
    [requestId, scope.runId])).rows[0]
  if (prior) {
    const request = WorkRequestSchema.parse(prior.record)
    if (prior.payload_digest !== payloadDigest || request.requesterExecutionId !== sourceExecutionId
      || request.relationshipId !== relationship.id || !sameRepeatValue(request.scope, scope)) {
      return repeatConflict('WORK_REQUEST_REPLAY_CONFLICT')
    }
    const state = (await sql.query<{ state: string; cause_kind: string }>(
      'select state,cause_kind from run_work_activations where run_id=$1 and activation_id=$2',
      [scope.runId, request.destinationActivationId])).rows[0]
    if (!state) return repeatConflict('WORK_ACTIVATION_MISSING')
    const destinationReady = state.cause_kind === 'join'
      ? state.state !== 'waiting' && await claimWorkJoinDispatchLocked(context,
        request.destinationActivationId, dispatchSourceActivationId ?? activation.activationId)
      : state.state !== 'waiting'
    return { kind: 'accepted', request, replayed: true, destinationReady }
  }
  const denied = (await sql.query<{ record: unknown; payload_digest: string }>(
    'select record,payload_digest from run_work_denials where request_id=$1 and run_id=$2',
    [requestId, scope.runId])).rows[0]
  if (denied) {
    const denial = WorkLimitDenialSchema.parse(denied.record)
    if (denied.payload_digest !== payloadDigest || denial.relationshipId !== relationship.id
      || !sameRepeatValue(denial.scope, scope)) return repeatConflict('WORK_REQUEST_REPLAY_CONFLICT')
    const notice = await readWorkLimitNoticeLocked(context, { kind: 'limit_denial', denialId: denial.denialId })
    if (notice.requesterActivationId !== activation.activationId) return repeatConflict('WORK_NOTICE_PIN_CONFLICT')
    return { kind: 'limit_reached', denial, notice, replayed: true }
  }
  context.assertActive()
  await hooks.assertSettlementLocked(sql, [sourceExecutionId])
  const destination = version.definition.nodes.find((item) => item.id === destinationNodeId)!
  if (destination.kind === 'job') return repeatConflict('WORK_POLICY_PIN_CONFLICT')
  const candidate = HarnessExecutionSchema.parse({ id: repeatId('work-candidate', requestId),
    runId: scope.runId, workflowNodeId: destination.id, agentId: destination.agentId,
    agentConfigurationVersionId: version.agentConfigurationVersionIds[destination.agentId],
    attempt: 1, input: {}, state: 'queued', createdAt: context.now })
  await hooks.assertAdmissionLocked(sql, candidate, { nodeId: destination.id, occurrence: null })
  const maximum = relationship.maxWorkHandoffsPerRun ?? null
  await sql.query(`insert into run_work_connection_usage(run_id,workflow_version_id,relationship_id,maximum)
    values($1,$2,$3,$4) on conflict do nothing`, [scope.runId, scope.workflowVersionId, relationship.id, maximum])
  const usage = (await sql.query<{ used: number; maximum: number | null }>(`select used,maximum
    from run_work_connection_usage where run_id=$1 and workflow_version_id=$2 and relationship_id=$3 for update`,
  [scope.runId, scope.workflowVersionId, relationship.id])).rows[0]
  if (!usage || usage.maximum !== maximum) return repeatConflict('WORK_COUNTER_PIN_CONFLICT')
  if (maximum !== null && usage.used >= maximum) {
    const alreadyNotified = (await sql.query(`select 1 from run_work_denials d
      join run_work_activations a on a.run_id=d.run_id and a.activation_id=d.requester_activation_id
      where d.run_id=$1 and d.relationship_id=$2 and a.lineage_id=$3 limit 1`,
    [scope.runId, relationship.id, activation.lineageId])).rowCount === 1
    if (alreadyNotified) {
      const unresolved = await recordUnresolvedWorkLocked(context, sourceExecutionId,
        'repeated_exhausted_route', relationship.id)
      return { kind: 'needs_direction', ...unresolved }
    }
    const denial = WorkLimitDenialSchema.parse({ scope, denialId: repeatId('work-denial', requestId), requestId,
      relationshipId: relationship.id, requesterActivationId: activation.activationId,
      requesterExecutionId: sourceExecutionId,
      destinationNodeId, payloadDigest, used: usage.used, maxWorkHandoffsPerRun: maximum, deniedAt: context.now })
    await sql.query(`insert into run_work_denials(denial_id,run_id,request_id,workflow_version_id,relationship_id,
      requester_activation_id,requester_execution_id,payload_digest,record,denied_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
    [denial.denialId, scope.runId, requestId, scope.workflowVersionId, relationship.id,
      activation.activationId, sourceExecutionId, payloadDigest, canonicalGraphJson(denial), context.now])
    const continuationActivationId = repeatId('work-activation', denial.denialId)
    await assertWorkflowExecutionCapacityLocked(sql, scope.runId, version)
    const continuation = WorkActivationIdentitySchema.parse({ scope, activationId: continuationActivationId,
      workflowNodeId: node.id, lineageId: activation.lineageId,
      cause: { kind: 'limit_denial', denialId: denial.denialId } })
    await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,
      cause_kind,cause_id,state,record) values($1,$2,$3,$4,'limit_denial',$5,'queued',$6::jsonb)`,
    [continuationActivationId, scope.runId, scope.workflowVersionId, node.id,
      denial.denialId, canonicalGraphJson(continuation)])
    await sql.query(`insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
      values($1,'backend','work_handoff_denied',$2,$3,$4::jsonb)`, [scope.runId, sourceExecutionId,
      context.now, canonicalGraphJson({ denialId: denial.denialId, relationshipId: relationship.id,
        requesterNodeId: node.id, destinationNodeId, used: usage.used, maximum })])
    const notice = await persistWorkLimitNoticeLocked(context, { cause: { kind: 'limit_denial', denialId: denial.denialId },
      requesterActivationId: activation.activationId, requesterNodeId: node.id,
      continuationActivationId, relationshipId: relationship.id, destinationNodeId,
      used: usage.used, maximum, latestDeliverable: result.data.latestDeliverable,
      remainingFindings: result.data.remainingFindings })
    await sql.query(`insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
      values($1,'backend','work_requester_reactivated',$2,$3,$4::jsonb)`, [scope.runId, sourceExecutionId,
      context.now, canonicalGraphJson({ activationId: continuationActivationId, requesterNodeId: node.id,
        denialId: denial.denialId, noticeId: notice.noticeId,
        ...(dispatchSourceActivationId ? { sourceActivationId: dispatchSourceActivationId } : {}) })])
    return { kind: 'limit_reached', denial, notice, replayed: false }
  }
  const incoming = version.definition.edges.filter((edge) => edge.kind === 'execution' && edge.target === destinationNodeId)
  const join = relationship.target === destinationNodeId && destination.join?.mode === 'all' && incoming.length > 1
  const round = join ? (await sql.query<{ round_id: string }>(
    'select work_round_id($1,$2) as round_id', [scope.runId, activation.activationId])).rows[0] : undefined
  if (join && !round) return repeatConflict('WORK_JOIN_ROUND_CONFLICT')
  const activationId = join
    ? repeatId('work-join', scope.runId, round!.round_id, destinationNodeId)
    : repeatId('work-activation', requestId)
  const existingActivation = join ? (await sql.query<{ record: unknown; state: string }>(
    'select record,state from run_work_activations where run_id=$1 and activation_id=$2 for update',
    [scope.runId, activationId])).rows[0] : undefined
  if (existingActivation) {
    const current = WorkActivationIdentitySchema.parse(existingActivation.record)
    if (current.cause.kind !== 'join' || current.workflowNodeId !== destinationNodeId
      || current.lineageId !== activation.lineageId || existingActivation.state !== 'waiting') {
      return repeatConflict('WORK_JOIN_ACTIVATION_CONFLICT')
    }
  }
  if (!existingActivation) await assertWorkflowExecutionCapacityLocked(sql, scope.runId, version)
  const reserved = (await sql.query<{ used: number }>(`update run_work_connection_usage set used=used+1
    where run_id=$1 and workflow_version_id=$2 and relationship_id=$3
      and (maximum is null or used<maximum) returning used`,
  [scope.runId, scope.workflowVersionId, relationship.id])).rows[0]
  if (!reserved) return repeatConflict('WORK_COUNTER_RACE')
  const next = WorkActivationIdentitySchema.parse({ scope, activationId,
    workflowNodeId: destinationNodeId, lineageId: activation.lineageId,
    cause: join ? { kind: 'join', joinId: activationId } : { kind: 'work_request', requestId } })
  const request = WorkRequestSchema.parse({ scope, requestId, relationshipId: relationship.id,
    requesterActivationId: activation.activationId, requesterExecutionId: sourceExecutionId,
    destinationActivationId: activationId, requesterNodeId: node.id, destinationNodeId,
    payloadDigest, acceptedAt: context.now, ordinal: reserved.used })
  if (!existingActivation) await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,
    cause_kind,cause_id,state,record) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
  [activationId, scope.runId, scope.workflowVersionId, destinationNodeId,
    join ? 'join' : 'work_request', join ? activationId : requestId,
    join ? 'waiting' : 'queued', canonicalGraphJson(next)])
  await sql.query(`insert into run_work_requests(request_id,run_id,workflow_version_id,relationship_id,ordinal,
    requester_activation_id,requester_execution_id,destination_activation_id,requester_node_id,destination_node_id,
    payload_digest,record,accepted_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,
  [requestId, scope.runId, scope.workflowVersionId, relationship.id, reserved.used, activation.activationId,
    sourceExecutionId, activationId, node.id, destinationNodeId, payloadDigest, canonicalGraphJson(request), context.now])
  let destinationReady = !join
  if (join) destinationReady = await resolveWorkJoinLocked(context, activationId, destinationNodeId)
    && await claimWorkJoinDispatchLocked(context, activationId, dispatchSourceActivationId ?? activation.activationId)
  await sql.query(`insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
    values($1,'backend','work_handoff_accepted',$2,$3,$4::jsonb)`, [scope.runId, sourceExecutionId,
    context.now, canonicalGraphJson({ requestId, relationshipId: relationship.id, requesterNodeId: node.id,
      destinationNodeId, used: reserved.used, maximum })])
  const sourceNotices = (await sql.query<{ notice_id: string; relationship_id: string }>(
    `select notice_id,relationship_id from run_work_notices
      where run_id=$1 and continuation_activation_id=$2 order by notice_id`,
    [scope.runId, activation.activationId])).rows
  for (const sourceNotice of sourceNotices) {
    if (sourceNotice.relationship_id === relationship.id) continue
    await sql.query(`insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
      values($1,'backend','work_rerouted',$2,$3,$4::jsonb)`, [scope.runId, sourceExecutionId,
      context.now, canonicalGraphJson({ requestId, noticeId: sourceNotice.notice_id,
        fromRelationshipId: sourceNotice.relationship_id,
        relationshipId: relationship.id, destinationNodeId })])
  }
  return { kind: 'accepted', request, replayed: false, destinationReady }
}

async function reconcileAcceptedWorkReturnsLocked(context: AdmissionContext,
  sourceActivationId: string): Promise<string[]> {
  const requests = (await context.sql.query<{ record: unknown }>(
    `select distinct on (requester_activation_id) record from run_work_requests
      where run_id=$1 and (destination_activation_id=$2 or request_id=work_parent_request($1,$2))
      order by requester_activation_id,request_id`, [context.scope.runId, sourceActivationId])).rows
  const ready: string[] = []
  for (const row of requests) {
    ready.push(...await forwardAcceptedWorkReturnsLocked(context, WorkRequestSchema.parse(row.record), sourceActivationId))
  }
  return [...new Set(ready)]
}

async function forwardAcceptedWorkReturnsLocked(context: AdmissionContext,
  request: WorkRequest, sourceActivationId: string): Promise<string[]> {
  const settled = await workRequestSettlementsLocked(context, request.requesterActivationId)
  if (settled.pending || settled.failures.length) return []
  const rows = (await context.sql.query<{ record: unknown; node_id: string; result_json: string }>(
    `select t.record,q.destination_node_id as node_id,x.result_json from run_work_returns t
      join run_work_requests q on q.run_id=t.run_id and q.request_id=t.request_id
      join run_work_results x on x.run_id=t.run_id and x.execution_id=t.source_execution_id
      join run_activity a on a.run_id=t.run_id and a.kind='work_handoff_returned'
        and a.payload->>'returnId'=t.return_id
      where q.run_id=$1 and q.requester_activation_id=$2 order by a.sequence`,
    [context.scope.runId, request.requesterActivationId])).rows
  const returns = rows.map(row => ({ ...row, returned: WorkReturnSchema.parse(row.record) }))
  if (returns.some(row => row.returned.outcome !== 'accepted' || row.returned.remainingFindings.length)) return []
  const destinations: string[] = []
  for (const row of returns) {
    const result = parseWorkHandoffResult(AcceptedCurrentNodeResultSchema.parse(JSON.parse(row.result_json)))
    for (const relationshipId of selectedWorkHandoffRoutes(context.version.definition, row.node_id, result)) {
      const admitted = await admitWorkHandoffLocked(context, row.returned.sourceExecutionId,
        relationshipId, sourceActivationId)
      if (admitted.kind === 'accepted' && admitted.destinationReady) {
        destinations.push(admitted.request.destinationActivationId)
      } else if (admitted.kind === 'limit_reached') {
        const dispatch = (await context.sql.query<{ source_activation_id: string | null }>(
          `select payload->>'sourceActivationId' as source_activation_id from run_activity
            where run_id=$1 and kind='work_requester_reactivated' and payload->>'denialId'=$2`,
          [context.scope.runId, admitted.denial.denialId])).rows[0]
        if (!dispatch) return repeatConflict('WORK_DENIAL_CONTINUATION_UNRESOLVED')
        // Older denials were dispatched by the final returning task.
        const owner = dispatch.source_activation_id ?? returns.at(-1)!.returned.sourceActivationId
        if (owner === sourceActivationId) destinations.push(admitted.notice.continuationActivationId)
      }
    }
  }
  return [...new Set(destinations)]
}

/** The review returns to its exact request and costs no additional work slot. */
export async function returnWorkHandoffLocked(context: AdmissionContext, sourceExecutionId: string): Promise<WorkReturnReceipt> {
  const { sql, scope, version, hooks } = context
  if (!version.definition.handoffs || version.definition.repeat
    || version.definition.nodes.some((node) => node.kind === 'job')) return repeatConflict('WORK_POLICY_PIN_CONFLICT')
  await hooks.assertAuthorityLocked(sql)
  const row = (await sql.query<{ record: unknown; accepted: boolean; work_activation_id: string | null }>(
    `select record,accepted,work_activation_id from harness_executions
      where id=$1 and run_id=$2 for share`, [sourceExecutionId, scope.runId])).rows[0]
  if (!row?.accepted || !row.work_activation_id) return repeatConflict('WORK_RETURN_SOURCE_NOT_ACCEPTED')
  const execution = HarnessExecutionSchema.parse(row.record)
  if (execution.id !== sourceExecutionId || execution.runId !== scope.runId || execution.state !== 'completed'
    || execution.result?.outcome !== 'succeeded' || !execution.finishedAt
    || execution.agentConfigurationVersionId !== version.agentConfigurationVersionIds[execution.agentId]) {
    return repeatConflict('WORK_RETURN_SOURCE_PIN_CONFLICT')
  }
  await assertAcceptedWorkResult(sql, scope, execution, row.work_activation_id)
  const activationRow = (await sql.query<{ record: unknown; cause_kind: string; cause_id: string }>(
    'select record,cause_kind,cause_id from run_work_activations where activation_id=$1 and run_id=$2 for share',
    [row.work_activation_id, scope.runId])).rows[0]
  if (!activationRow) return repeatConflict('WORK_RETURN_REQUEST_MISSING')
  const activation = WorkActivationIdentitySchema.parse(activationRow.record)
  if (!sameRepeatValue(activation.scope, scope) || activation.workflowNodeId !== execution.workflowNodeId) {
    return repeatConflict('WORK_RETURN_SOURCE_PIN_CONFLICT')
  }
  const result = await parseWorkResultLocked(context, execution, activation.activationId)
  const routing = result.routing
  if (routing.kind !== 'return') return repeatConflict('WORK_RETURN_RESULT_CONFLICT')
  const request = await readWorkReturnRequestLocked(context, activation.activationId, routing.requestId)
  if (request.destinationNodeId !== execution.workflowNodeId) return repeatConflict('WORK_RETURN_ANCESTRY_CONFLICT')
  const resultDigest = repeatDigest(execution.result, 64 * 1024)
  const prior = (await sql.query<{ record: unknown }>(
    'select record from run_work_returns where run_id=$1 and request_id=$2', [scope.runId, request.requestId])).rows[0]
  if (prior) {
    const value = WorkReturnSchema.parse(prior.record)
    if (value.sourceExecutionId !== sourceExecutionId || value.acceptedResultDigest !== resultDigest
      || !sameRepeatValue(value.scope, scope)) return repeatConflict('WORK_RETURN_REPLAY_CONFLICT')
    if (value.outcome === 'accepted' && value.remainingFindings.length) {
      await recordUnresolvedWorkLocked(context, sourceExecutionId, 'finish_with_findings')
    }
    const destinations = await forwardAcceptedWorkReturnsLocked(context, request, activation.activationId)
    return { value, replayed: true, destinations }
  }
  context.assertActive()
  await hooks.assertSettlementLocked(sql, [sourceExecutionId])
  const returnId = repeatId('work-return', sourceExecutionId)
  const continuationActivationId = routing.outcome === 'needs_changes'
    ? await ensureWorkReturnContinuationLocked(context, request, returnId) : undefined
  const value = WorkReturnSchema.parse({ scope, returnId, requestId: request.requestId,
    sourceActivationId: activation.activationId, sourceExecutionId,
    requesterActivationId: request.requesterActivationId,
    ...(continuationActivationId ? { continuationActivationId } : {}),
    acceptedResultDigest: resultDigest, outcome: routing.outcome,
    latestDeliverable: result.data.latestDeliverable, remainingFindings: result.data.remainingFindings,
    returnedAt: context.now })
  await sql.query(`insert into run_work_returns(return_id,run_id,request_id,source_activation_id,source_execution_id,
    requester_continuation_activation_id,result_digest,outcome,record,returned_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
  [returnId, scope.runId, request.requestId, activation.activationId, sourceExecutionId,
    continuationActivationId ?? null, resultDigest, value.outcome, canonicalGraphJson(value), context.now])
  await sql.query(`insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
    values($1,'backend','work_handoff_returned',$2,$3,$4::jsonb)`, [scope.runId, sourceExecutionId,
    context.now, canonicalGraphJson({ returnId, requestId: request.requestId,
      relationshipId: request.relationshipId, outcome: value.outcome, continuationActivationId: continuationActivationId ?? null })])
  if (value.outcome === 'needs_changes') {
    const usage = (await sql.query<{ used: number; maximum: number | null }>(
      `select used,maximum from run_work_connection_usage
        where run_id=$1 and workflow_version_id=$2 and relationship_id=$3 for update`,
      [scope.runId, scope.workflowVersionId, request.relationshipId])).rows[0]
    if (!usage) return repeatConflict('WORK_COUNTER_PIN_CONFLICT')
    if (usage.maximum !== null && usage.used === usage.maximum) {
      await persistWorkLimitNoticeLocked(context, { cause: { kind: 'last_return', returnId },
        requesterActivationId: request.requesterActivationId, requesterNodeId: request.requesterNodeId,
        continuationActivationId: continuationActivationId!, relationshipId: request.relationshipId,
        destinationNodeId: request.destinationNodeId, used: usage.used, maximum: usage.maximum,
        latestDeliverable: value.latestDeliverable, remainingFindings: value.remainingFindings })
    }
  }
  await resolveWaitingWorkReturnsLocked(context, activation.activationId)
  if (value.outcome === 'accepted' && value.remainingFindings.length) {
    await recordUnresolvedWorkLocked(context, sourceExecutionId, 'finish_with_findings')
  }
  const destinations = await forwardAcceptedWorkReturnsLocked(context, request, activation.activationId)
  return { value, replayed: false, destinations }
}
