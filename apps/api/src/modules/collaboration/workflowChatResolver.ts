import { AgentNodeRefSchema, HarnessExecutionSchema, WorkflowExecutionChatResolutionSchema,
  WorkflowExecutionChatSelectionSchema, type WorkflowExecutionChatResolution,
  type WorkflowExecutionChatSelection } from '@foreman-code/contracts'
import { z } from 'zod'
import { isAuthorized, requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import type { GraphSqlClient } from '../run-graph/connection.js'
import type { Principal } from './ports.js'
import { controlDigest } from './workflowControlRecords.js'
import { readWorkflowChatAgent, readWorkflowChatIdentity, readWorkflowChatVersion, workflowChatExecutionRef, workflowChatState,
  type WorkflowChatExecutionRow, type WorkflowChatRunRow } from './workflowChatIdentity.js'

type Choice = Extract<WorkflowExecutionChatResolution, { kind: 'selected' }>
const Cursor = z.object({ scope: z.string(), before: z.string() }).strict()
function selectionScope(input: WorkflowExecutionChatSelection) {
  return controlDigest({ workspaceId: input.workspaceId, workflowId: input.workflowId,
    workflowNodeId: input.workflowNodeId, runId: input.runId, workflowVersionId: input.workflowVersionId,
    executionId: input.executionId, waitingActivationId: input.waitingActivationId })
}
function selectionCursor(input: WorkflowExecutionChatSelection): string | undefined {
  if (!input.cursor) return undefined
  try {
    const cursor = Cursor.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString()))
    if (cursor.scope !== selectionScope(input)) throw new Error('scope')
    return cursor.before
  } catch { throw new DomainError('INVALID_CURSOR', 'Use this selection cursor with its original workflow and node.', 400) }
}
function nextCursor(input: WorkflowExecutionChatSelection, before: string) {
  return Buffer.from(JSON.stringify({ scope: selectionScope(input), before })).toString('base64url')
}

/** Resolve only actual Run facts. An absent Run is an explicit outside-run choice;
 * a historical or ambiguous execution never silently becomes another target. */
export async function resolveWorkflowChatTarget(sql: GraphSqlClient, principal: Principal,
  raw: unknown, action: 'agent_chat:read' | 'workflows:read' = 'agent_chat:read'): Promise<WorkflowExecutionChatResolution> {
  const input = WorkflowExecutionChatSelectionSchema.parse(raw), before = selectionCursor(input)
  if (input.runId) {
    requireAuthorization(principal, action, { workspaceId: input.workspaceId,
      workflowId: input.workflowId, ...(input.runId ? { runId: input.runId } : {}) })
    const run = (await sql.query<WorkflowChatRunRow>(`select id,workspace_id,workflow_id,workflow_version_id,execution_state,
      stop_requested_at is not null as stopped from runs where id=$1 and workspace_id=$2 and workflow_id=$3`,
    [input.runId, input.workspaceId, input.workflowId])).rows[0]
    if (!run) throw new DomainError('RUN_NOT_FOUND', 'The selected Run is unavailable in this workflow.', 404)
    if (input.workflowVersionId && input.workflowVersionId !== run.workflow_version_id) {
      throw new DomainError('WORKFLOW_VERSION_PIN_MISMATCH', 'The selected version does not belong to this Run.', 409)
    }
    return resolveRunNode(sql, input, run, before)
  }
  const unrestricted = isAuthorized(principal, action, { workspaceId: input.workspaceId, workflowId: input.workflowId })
  const authorizedRunIds = unrestricted ? null : [...new Set(principal.grants.flatMap(grant => grant.scope.runIds ?? []))]
    .filter(runId => isAuthorized(principal, action, { ...input, runId }))
  if (authorizedRunIds && !authorizedRunIds.length) {
    throw new DomainError('ACCESS_DENIED', 'The caller cannot read Agent chat in this workflow.', 403)
  }
  const runs = (await sql.query<WorkflowChatRunRow>(`select id,workspace_id,workflow_id,workflow_version_id,execution_state,
    stop_requested_at is not null as stopped from runs where workspace_id=$1 and workflow_id=$2
      and execution_state in ('queued','running','waiting') and ($3::text is null or workflow_version_id=$3)
      and ($4::text is null or id<$4) and ($6::text[] is null or id=any($6)) order by id desc limit $5`,
  [input.workspaceId, input.workflowId, input.workflowVersionId ?? null, before ?? null, input.limit + 1, authorizedRunIds])).rows
  if (!runs.length && !input.cursor) return unrestricted ? outsideRun(sql, principal, input, action)
    : { kind: 'unavailable', reason: 'NO_EXECUTION' }
  if (runs.length === 1 && !input.cursor) {
    const resolved = await resolveRunNode(sql, { ...input, runId: runs[0]!.id, cursor: undefined }, runs[0]!)
    // Pin the Run before offering paginated execution history. A cursor must
    // never be reinterpreted as a different live-Run page after a restart.
    if (resolved.kind !== 'selection_required') return resolved
    return { kind:'run_selection_required',items:[{runId:runs[0]!.id,workflowVersionId:runs[0]!.workflow_version_id}],
      nextCursor:null,hasMore:false,revision:resolved.revision }
  }
  const hasMore = runs.length > input.limit
  return WorkflowExecutionChatResolutionSchema.parse({ kind: 'run_selection_required',
    items: runs.slice(0, input.limit).map(run => ({ runId: run.id, workflowVersionId: run.workflow_version_id })), hasMore,
    nextCursor: hasMore ? nextCursor(input, runs[input.limit - 1]!.id) : null, revision: 0 })
}

async function outsideRun(sql: GraphSqlClient, principal: Principal,
  input: WorkflowExecutionChatSelection, action: 'agent_chat:read' | 'workflows:read'): Promise<WorkflowExecutionChatResolution> {
  requireAuthorization(principal, action, { workspaceId: input.workspaceId,
      workflowId: input.workflowId, ...(input.runId ? { runId: input.runId } : {}) })
  const workflow = (await sql.query<{ current_version_id: string | null }>(
    'select current_version_id from workflows where id=$1 and workspace_id=$2', [input.workflowId, input.workspaceId])).rows[0]
  const id = input.workflowVersionId ?? workflow?.current_version_id
  if (!id) return { kind: 'unavailable', reason: 'WORKFLOW_UNAVAILABLE' }
  const version = await readWorkflowChatVersion(sql, { ...input, workflowVersionId: id })
  const node = version.definition.nodes.find(item => item.id === input.workflowNodeId)
  if (!node || node.kind === 'job') return { kind: 'unavailable', reason: 'NODE_UNAVAILABLE' }
  return { kind: 'outside_run', reason: 'NO_LIVE_RUN', workflowVersionId: version.id,
    agent: AgentNodeRefSchema.parse({ agentId: node.agentId,
      workspaceId: input.workspaceId, workflowId: input.workflowId, workflowNodeId: node.id }) }
}

async function resolveRunNode(sql: GraphSqlClient, input: WorkflowExecutionChatSelection,
  run: WorkflowChatRunRow, before?: string): Promise<WorkflowExecutionChatResolution> {
  const version = await readWorkflowChatVersion(sql, { ...input, workflowVersionId: run.workflow_version_id })
  const agent = await readWorkflowChatAgent(sql, version, input.workflowNodeId)
  const targetAgent = AgentNodeRefSchema.parse({ workspaceId: agent.workspaceId, workflowId: agent.workflowId,
    workflowNodeId: agent.workflowNodeId, agentId: agent.agentId })
  if (input.waitingActivationId) {
    const target = { kind: 'workflow_coordinator' as const, agent: targetAgent, runId: run.id, waitingActivationId: input.waitingActivationId }
    const identity = await readWorkflowChatIdentity(sql, target)
    return { kind: 'selected', agent, target, workflowVersionId: version.id, source: 'consultation', state: identity.state }
  }
  if (input.executionId) {
    const row = (await sql.query<WorkflowChatExecutionRow>(`select record,accepted,work_activation_id from harness_executions
      where run_id=$1 and workflow_node_id=$2 and id=$3`, [run.id, input.workflowNodeId, input.executionId])).rows[0]
    if (!row) throw new DomainError('EXECUTION_NOT_FOUND', 'This exact execution is unavailable at the selected Run node.', 404)
    const choice = executionChoice(run, row, agent, targetAgent)
    return { ...choice, state: (await readWorkflowChatIdentity(sql, choice.target)).state }
  }
  const live = !run.stopped && run.execution_state !== 'completed'
  if (live && !before) {
    const direction = (await sql.query<WorkflowChatExecutionRow>(`select e.record,e.accepted,e.work_activation_id
      from run_hierarchy_direction_waits d join harness_executions e on e.id=d.held_execution_id and e.run_id=d.run_id
      where d.run_id=$1 and e.workflow_node_id=$2 and d.state in ('waiting','released')
      and not e.accepted order by d.created_at desc limit 1`, [run.id, input.workflowNodeId])).rows[0]
    if (direction) return { ...executionChoice(run, direction, agent, targetAgent), source: 'direction' }
    const waiting = (await sql.query<{ parent_activation_id: string }>(`select g.parent_activation_id from run_hierarchy_groups g
      join harness_executions e on e.id=g.parent_execution_id and e.run_id=g.run_id
      left join run_coordinator_mailboxes m on m.run_id=g.run_id and m.group_id=g.group_id
      where g.run_id=$1 and g.parent_node_id=$2 and (g.state='waiting' or m.state='consultation')
      and e.record->>'nativeSessionId' is not null order by g.created_at desc limit 1`, [run.id, input.workflowNodeId])).rows[0]
    if (waiting && agent.productRole !== 'coder') return { kind: 'selected', agent, workflowVersionId: version.id,
      source: 'consultation', state: 'waiting_children',
      target: { kind: 'workflow_coordinator', agent: targetAgent, runId: run.id, waitingActivationId: waiting.parent_activation_id } }
    const current = (await sql.query<WorkflowChatExecutionRow>(`select record,accepted,work_activation_id from harness_executions
      where run_id=$1 and workflow_node_id=$2 and not accepted and record->>'state'<>'completed'
      order by id desc limit 2`, [run.id, input.workflowNodeId])).rows
    if (current.length === 1) return executionChoice(run, current[0]!, agent, targetAgent)
  }
  const rows = (await sql.query<WorkflowChatExecutionRow & { id: string }>(`select id,record,accepted,work_activation_id from harness_executions
    where run_id=$1 and workflow_node_id=$2 and ($3::text is null or id<$3) order by id desc limit $4`,
  [run.id, input.workflowNodeId, before ?? null, input.limit + 1])).rows
  if (!rows.length) return { kind: 'unavailable', reason: 'NO_EXECUTION' }
  if (rows.length === 1 && !before) return executionChoice(run, rows[0]!, agent, targetAgent)
  const hasMore = rows.length > input.limit
  return WorkflowExecutionChatResolutionSchema.parse({ kind: 'selection_required', items: rows.slice(0, input.limit).map(row => {
    const choice = executionChoice(run, row, agent, targetAgent)
    return { target: choice.target, agent: choice.agent, workflowVersionId: choice.workflowVersionId,
      source: choice.source, state: choice.state }
  }), hasMore, nextCursor: hasMore ? nextCursor(input, rows[input.limit - 1]!.id) : null, revision: 0 })
}
function executionChoice(run: WorkflowChatRunRow, row: WorkflowChatExecutionRow,
  agent: Choice['agent'], targetAgent: Extract<Choice['target'], { kind: 'workflow_execution' }>['agent']): Choice {
  const execution = HarnessExecutionSchema.parse(row.record)
  if (execution.agentId !== agent.agentId || execution.agentConfigurationVersionId !== agent.configurationVersionId) {
    throw new DomainError('EXECUTION_PIN_MISMATCH', 'The execution does not match the pinned Agent configuration.', 409)
  }
  return { kind: 'selected', agent, workflowVersionId: run.workflow_version_id, source: 'execution',
    state: run.execution_state === 'completed' ? 'idle' : run.stopped ? 'settling' : workflowChatState(execution, row.accepted),
    target: { kind: 'workflow_execution', agent: targetAgent, execution: workflowChatExecutionRef(run, row) } }
}
