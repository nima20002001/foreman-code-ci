import { browserAgentTools } from '../collaboration/browserTools.js'
import { AgentConfigurationVersionSchema, AgentSubjectSchema, canonicalJson, effectiveGraphqlTools,
  COLLABORATION_AGENT_TOOLS, type GraphqlAgentTool } from '@foreman-code/contracts'
import { ManagementPrincipalSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import type { SqlQuery } from '../../infrastructure/transaction.js'
import type { AgentConversationRow } from '../conversations/agentChatRepository.js'
import { conversationFeatureContext, type ConversationFeatureContext } from '../conversations/conversationFeatureSubject.js'
import { DomainError } from '../errors.js'
import { readLiveManagementPrincipal } from './liveManagementPrincipal.js'

const groupTools = new Set<GraphqlAgentTool>([
  'workflow_chat_read', 'workflow_chat_post',
])
export function conversationChatTools(context: ConversationFeatureContext): GraphqlAgentTool[] {
  const configuration = context.configuration
  const readOnly = configuration.harness.harness === 'opencode' || configuration.harness.sandbox === 'read-only'
  const implemented = [...groupTools, ...(context.node.browser?.enabled ? browserAgentTools : [])]
  return effectiveGraphqlTools(context.subject.agent.productRole, configuration.graphqlTools,
    context.node.graphqlTools, false, implemented)
    .filter(tool => implemented.includes(tool) && (!readOnly || COLLABORATION_AGENT_TOOLS[tool as keyof typeof COLLABORATION_AGENT_TOOLS].readOnly))
}

export async function readConversationCredential(sql: SqlQuery, principalId: string) {
  const credential = (await sql.query<{ subject: unknown; conversation_id: string; workflow_version_id: string }>(
    'select subject,conversation_id,workflow_version_id from agent_conversation_credentials where principal_id=$1', [principalId])).rows[0]
  if (!credential) return undefined
  const subject = AgentSubjectSchema.parse(credential.subject)
  if (subject.kind !== 'conversation') throw new DomainError('AUTH_REVOKED', 'The credential has no conversation subject.', 401)
  const principal = await readChatPrincipal(sql, principalId)
  const row = (await sql.query<AgentConversationRow>(
    `select * from operator_conversations where id=$1 and kind='agent' and deleted_at is null`,
    [credential.conversation_id])).rows[0]
  if (!row || row.record.archived || row.agent_id !== principal.agentId
    || row.agent_configuration_version_id !== subject.agent.configurationVersionId) {
    throw new DomainError('AUTH_REVOKED', 'The scoped conversation is no longer active.', 401)
  }
  const config = (await sql.query<{ record: unknown }>('select record from agent_configuration_versions where id=$1',
    [row.agent_configuration_version_id])).rows[0]
  const context = await conversationFeatureContext(sql, row, AgentConfigurationVersionSchema.parse(config?.record), credential.workflow_version_id)
  if (canonicalJson(context.subject) !== canonicalJson(subject)) throw new DomainError('AUTH_REVOKED',
    'The saved conversation no longer matches its credential.', 401)
  return { principal, subject, context, tools: conversationChatTools(context) }
}

export async function readChatPrincipal(sql: SqlQuery, id: string): Promise<ManagementPrincipal> {
  const row = (await sql.query<{ id: string; name: string; audience: string; agent_id: string | null;
    grants: unknown; expires_at: Date; revoked_at: Date | null }>(
    'select id,name,audience,agent_id,grants,expires_at,revoked_at from management_principals where id=$1', [id])).rows[0]
  if (!row || row.revoked_at || row.expires_at.getTime() <= Date.now()) throw new DomainError('AUTH_REVOKED',
    'The chat credential is no longer active.', 401)
  if (row.audience === 'operator') return readLiveManagementPrincipal(sql, id)
  return ManagementPrincipalSchema.parse({ id: row.id, name: row.name, audience: row.audience,
    agentId: row.agent_id, grants: row.grants, expiresAt: row.expires_at.toISOString(), revokedAt: null })
}

