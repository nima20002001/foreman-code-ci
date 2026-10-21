import { AgentConfigurationVersionSchema, effectiveGraphqlTools } from '@foreman-code/contracts'
import { WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import type { ManagementGrant } from '@foreman-code/contracts/management'
import type { SqlQuery } from '../../infrastructure/transaction.js'
import { DomainError } from '../errors.js'

export async function workflowChatGrants(sql: SqlQuery, executionId: string): Promise<ManagementGrant[]> {
  const row = (await sql.query<{ configuration: unknown; version: unknown; node_id: string }>(`select
    c.record as configuration,v.record as version,e.workflow_node_id as node_id from harness_executions e
    join runs r on r.id=e.run_id join workflow_versions v on v.id=r.workflow_version_id
    join agent_configuration_versions c on c.id=e.record->>'agentConfigurationVersionId' where e.id=$1`, [executionId])).rows[0]
  if (!row) throw new DomainError('WORKER_EXECUTION_NOT_FOUND', 'The chat credential requires its saved execution.', 409)
  const configuration = AgentConfigurationVersionSchema.parse(row.configuration)
  const version = WorkflowVersionV3Schema.parse(row.version)
  const node = version.definition.nodes.find(item => item.id === row.node_id)
  if (!node || node.kind === 'job') throw new DomainError('WORKER_EXECUTION_NOT_FOUND', 'The saved Agent node is unavailable.', 409)
  const tools = effectiveGraphqlTools(configuration.productRole ?? 'coder', configuration.graphqlTools, node.graphqlTools, Boolean(node.interval), ['workflow_chat_read', 'workflow_chat_post'])
  const readOnly = configuration.harness.harness === 'opencode' || configuration.harness.sandbox === 'read-only'
  const actions: ManagementGrant['actions'] = []
  if (tools.includes('workflow_chat_read')) actions.push('agent_chat:read')
  if (tools.includes('workflow_chat_post') && !readOnly) actions.push('agent_chat:read', 'agent_chat:write')
  return actions.length ? [{ actions: [...new Set(actions)], scope: {
    workspaceIds: [version.workspaceId], workflowIds: [version.workflowId],
  } }] : []
}
