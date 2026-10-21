import type { SqlQuery } from '../../infrastructure/transaction.js'
import { AgentSubjectSchema, type AgentConfigurationVersion, type AgentSubject } from '@foreman-code/contracts'
import { PostgresWorkflowRepository } from '../workflows/postgres.js'
import { DomainError } from '../errors.js'
import type { AgentConversationRow } from './agentChatRepository.js'

/** Accepted conversation facts for D's shared scoped-credential resolver. Never an Operator or fabricated Run. */
export async function conversationFeatureContext(sql: SqlQuery,
  row: AgentConversationRow, configuration: AgentConfigurationVersion, acceptedWorkflowVersionId?: string) {
  if (configuration.workspaceId !== row.workspace_id || configuration.agentId !== row.agent_id) {
    throw new DomainError('CHAT_SUBJECT_CONFIGURATION_MISMATCH', 'The accepted configuration belongs to another Agent.', 409)
  }
  const workflows = new PostgresWorkflowRepository(sql)
  const origin = row.origin_run_id ? (await sql.query<{ workflow_version_id: string }>(
    'select workflow_version_id from runs where id=$1 and workspace_id=$2 and workflow_id=$3',
    [row.origin_run_id, row.workspace_id, row.workflow_id])).rows[0] : undefined
  const version = acceptedWorkflowVersionId ? await workflows.getSavedVersion(acceptedWorkflowVersionId) : row.origin_run_id
    ? origin && await workflows.getSavedVersion(origin.workflow_version_id)
    : await workflows.getCurrentSavedVersion(row.workspace_id, row.workflow_id)
  const node = version?.definition.nodes.find(item => item.id === row.workflow_node_id)
  if (!version || version.workspaceId !== row.workspace_id || version.workflowId !== row.workflow_id
    || !node || node.kind === 'job' || node.agentId !== row.agent_id) {
    throw new DomainError('CHAT_SUBJECT_NODE_UNAVAILABLE', 'The exact saved conversation node is unavailable.', 409)
  }
  const subject = AgentSubjectSchema.parse({ kind: 'conversation', conversationId: row.id, agent: {
    workspaceId: row.workspace_id, workflowId: row.workflow_id, workflowNodeId: row.workflow_node_id,
    agentId: row.agent_id, configurationVersionId: configuration.id,
    productRole: configuration.productRole ?? 'coder', displayName: node.name ?? node.label ?? row.agent_id,
  } }) as Extract<AgentSubject, { kind: 'conversation' }>
  return { subject, workflowVersionId: version.id, configuration, node,
    workingDirectory: row.record.workingDirectory }
}

export type ConversationFeatureContext = Awaited<ReturnType<typeof conversationFeatureContext>>
