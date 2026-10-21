import { AgentConfigurationVersionSchema, AgentIdentitySchema, ExecutionRefSchema, HarnessExecutionSchema,
  sameAgentNode, sameExecution, type AgentIdentity, type EngineChatReadback, type ExecutionRef,
  type HarnessExecution } from '@foreman-code/contracts'
import type { WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { IMMUTABLE_WORKFLOW_VERSION_COLUMNS, readImmutableWorkflowVersion,
  type ImmutableWorkflowVersionRow } from '../workflows/immutableRead.js'
import { workflowTargetRunId } from './workflowControlRecords.js'
import type { WorkflowChatTarget } from './workflowControlTypes.js'

export interface WorkflowChatRunRow {
  id: string; workspace_id: string; workflow_id: string; workflow_version_id: string
  execution_state: string; stopped: boolean
}
export interface WorkflowChatExecutionRow {
  record: unknown; accepted: boolean; work_activation_id: string | null
}
export interface WorkflowChatIdentity {
  run: WorkflowChatRunRow; version: WorkflowVersionV3; agent: AgentIdentity
  state: EngineChatReadback['state']; execution?: HarnessExecution; reference?: ExecutionRef
}

export async function readWorkflowChatVersion(sql: GraphSqlClient, scope: {
  workspaceId: string; workflowId: string; workflowVersionId: string
}): Promise<WorkflowVersionV3> {
  const row = (await sql.query<ImmutableWorkflowVersionRow>(`select ${IMMUTABLE_WORKFLOW_VERSION_COLUMNS}
    from workflow_versions where workspace_id=$1 and workflow_id=$2 and id=$3`,
  [scope.workspaceId, scope.workflowId, scope.workflowVersionId])).rows[0]
  if (!row) throw new DomainError('WORKFLOW_VERSION_NOT_FOUND', 'The exact saved workflow version is unavailable.', 404)
  return readImmutableWorkflowVersion(row, { id: scope.workflowVersionId, workspaceId: scope.workspaceId, workflowId: scope.workflowId })
}

export async function readWorkflowChatAgent(sql: GraphSqlClient, version: WorkflowVersionV3,
  workflowNodeId: string): Promise<AgentIdentity> {
  const node = version.definition.nodes.find(item => item.id === workflowNodeId)
  if (!node || node.kind === 'job') throw new DomainError('CHAT_NODE_UNAVAILABLE', 'Select an Agent in this saved workflow.', 404)
  const configurationId = version.agentConfigurationVersionIds[node.agentId]
  const row = (await sql.query<{ record: unknown }>('select record from agent_configuration_versions where id=$1 and workspace_id=$2 and agent_id=$3',
    [configurationId, version.workspaceId, node.agentId])).rows[0]
  if (!row) throw new DomainError('AGENT_CONFIGURATION_NOT_FOUND', 'The pinned Agent configuration is unavailable.', 404)
  const configuration = AgentConfigurationVersionSchema.parse(row.record)
  if (configuration.id !== configurationId || configuration.workspaceId !== version.workspaceId || configuration.agentId !== node.agentId) {
    throw new DomainError('AGENT_CONFIGURATION_PIN_MISMATCH', 'The immutable Agent configuration does not match this node.', 409)
  }
  if (!configuration.productRole) throw new DomainError('CHAT_AGENT_ROLE_UNAVAILABLE', 'This historical configuration has no collaboration identity.', 409)
  return AgentIdentitySchema.parse({ workspaceId: version.workspaceId, workflowId: version.workflowId,
    workflowNodeId, agentId: node.agentId, productRole: configuration.productRole,
    configurationVersionId: configuration.id, displayName: node.name ?? node.label ?? node.id })
}

export function workflowChatExecutionRef(run: WorkflowChatRunRow, row: WorkflowChatExecutionRow): ExecutionRef {
  const execution = HarnessExecutionSchema.parse(row.record)
  if (execution.runId !== run.id) throw new DomainError('EXECUTION_PIN_MISMATCH', 'The execution belongs to another Run.', 409)
  return ExecutionRefSchema.parse({ runId: run.id, workflowVersionId: run.workflow_version_id,
    executionId: execution.id, attempt: execution.attempt,
    ...(row.work_activation_id ? { activationId: row.work_activation_id } : {}) })
}
export function workflowChatState(execution: HarnessExecution, accepted: boolean): EngineChatReadback['state'] {
  if (accepted) return 'idle'
  if (execution.state === 'queued') return 'queued'
  if (execution.state === 'starting') return 'starting'
  if (execution.state === 'running' || execution.state === 'waiting') return 'active'
  return 'settling'
}

/** Read-only exact pins. This never acquires a Run owner, starts a session or chooses another attempt. */
export async function readWorkflowChatIdentity(sql: GraphSqlClient, target: WorkflowChatTarget): Promise<WorkflowChatIdentity> {
  const run = (await sql.query<WorkflowChatRunRow>(`select id,workspace_id,workflow_id,workflow_version_id,execution_state,
    stop_requested_at is not null as stopped from runs where id=$1 and workspace_id=$2 and workflow_id=$3`,
  [workflowTargetRunId(target), target.agent.workspaceId, target.agent.workflowId])).rows[0]
  if (!run) throw new DomainError('RUN_NOT_FOUND', 'The selected Run is unavailable in this workflow.', 404)
  const version = await readWorkflowChatVersion(sql, { workspaceId: run.workspace_id, workflowId: run.workflow_id,
    workflowVersionId: run.workflow_version_id })
  const agent = await readWorkflowChatAgent(sql, version, target.agent.workflowNodeId)
  if (!sameAgentNode(agent, target.agent)) throw new DomainError('CHAT_TARGET_MISMATCH', 'The selected Agent is not the pinned Run node.', 409)
  if (target.kind === 'workflow_execution') {
    const row = (await sql.query<WorkflowChatExecutionRow>(`select record,accepted,work_activation_id from harness_executions
      where id=$1 and run_id=$2 and workflow_node_id=$3`, [target.execution.executionId, run.id, agent.workflowNodeId])).rows[0]
    if (!row) throw new DomainError('EXECUTION_NOT_FOUND', 'The exact selected execution is unavailable.', 404)
    const execution = HarnessExecutionSchema.parse(row.record), reference = workflowChatExecutionRef(run, row)
    if (!sameExecution(reference, target.execution) || execution.agentId !== agent.agentId
      || execution.agentConfigurationVersionId !== agent.configurationVersionId) {
      throw new DomainError('EXECUTION_PIN_MISMATCH', 'The execution selection no longer matches its immutable pins.', 409)
    }
    const disposition = (await sql.query<{ continuation_state: string | null; stopping: boolean; direction_source: boolean }>(
      `select (select state from run_control_continuations where run_id=$1 and previous_execution_id=$2) as continuation_state,
        exists(select 1 from run_chat_commands where run_id=$1 and kind='stop'
          and target #>> '{execution,executionId}'=$2 and state in ('recorded','settling','unknown')) as stopping,
        exists(select 1 from run_hierarchy_direction_waits where run_id=$1 and source_execution_id=$2) as direction_source`,
    [run.id, execution.id])).rows[0]!
    const pending = disposition.continuation_state && ['reserved','waiting_settlement','unknown'].includes(disposition.continuation_state)
    const state = run.execution_state === 'completed' ? 'idle' : run.stopped || pending || disposition.stopping ? 'settling'
      : disposition.continuation_state || disposition.direction_source ? 'idle' : workflowChatState(execution, row.accepted)
    return { run, version, agent, execution, reference, state }
  }
  const group = (await sql.query<{ state: string }>(`select state from run_hierarchy_groups where run_id=$1
    and parent_activation_id=$2 and parent_node_id=$3`, [run.id, target.waitingActivationId, agent.workflowNodeId])).rows[0]
  if (!group || agent.productRole === 'coder') throw new DomainError('COORDINATOR_UNAVAILABLE', 'This target has no recorded coordinator barrier.', 409)
  const mailbox = (await sql.query<{ state: string; turn_state: string | null }>(`select m.state,c.state as turn_state
    from run_coordinator_mailboxes m left join run_coordinator_consultations c on c.id=m.active_consultation_id
    where m.run_id=$1 and m.waiting_activation_id=$2`, [run.id, target.waitingActivationId])).rows[0]
  const state = run.execution_state === 'completed' ? 'idle' : run.stopped ? 'settling'
    : ['continued', 'canceled'].includes(group.state) || mailbox?.state === 'graph' ? 'idle'
    : mailbox?.turn_state === 'settling' || mailbox?.turn_state === 'unknown' ? 'settling'
      : mailbox?.state === 'consultation' ? mailbox.turn_state === 'active' ? 'active' : 'starting' : 'waiting_children'
  return { run, version, agent, state }
}
