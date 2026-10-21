import type pg from 'pg'
import { canonicalJson } from '@foreman-code/contracts'
import { NON_EXPIRING_CREDENTIAL_TIMESTAMP } from '@foreman-code/contracts/management'
import { withTransaction } from '../../infrastructure/transaction.js'
import { PostgresAgentChatRepository } from '../conversations/agentChatRepository.js'
import { conversationFeatureContext, type ConversationFeatureContext } from '../conversations/conversationFeatureSubject.js'
import { DomainError } from '../errors.js'
import { PostgresAccessService } from './postgres.js'
import { conversationChatTools } from './conversationCredentials.js'

export class ConversationCredentials {
  private readonly access: PostgresAccessService
  constructor(private readonly pool: pg.Pool) { this.access = new PostgresAccessService(pool) }

  async revoke(conversationId: string, keepPrincipalId?: string): Promise<void> {
    await this.pool.query(`update management_principals set revoked_at=now()
      where revoked_at is null and id in (select principal_id from agent_conversation_credentials
        where conversation_id=$1 and ($2::text is null or principal_id<>$2))`, [conversationId, keepPrincipalId ?? null])
  }

  async issue(context: ConversationFeatureContext) {
    return withTransaction(this.pool, async sql => {
      const repository = new PostgresAgentChatRepository(this.pool)
      const row = await repository.get(context.subject.conversationId, sql)
      if (!row || row.record.archived) throw new DomainError('AUTH_REVOKED', 'The conversation is unavailable.', 401)
      const current = await conversationFeatureContext(sql, row, context.configuration, context.workflowVersionId)
      if (canonicalJson(current.subject) !== canonicalJson(context.subject)) throw new DomainError('CHAT_SCOPE_MISMATCH',
        'The native conversation changed before credential issuance.', 409)
      const tools = conversationChatTools(current)
      if (!tools.length) throw new DomainError('TOOL_NOT_ENABLED', 'This conversation has no enabled Group chat tools.', 403)
      const actions: Array<'agent_chat:read' | 'agent_chat:write' | 'agent_chat:cancel'> = ['agent_chat:read']
      if (tools.includes('workflow_chat_post')) actions.push('agent_chat:write')
      const { workspaceId, workflowId, agentId } = current.subject.agent
      const issued = await this.access.issue({ name: `Agent conversation ${row.id}`, audience: 'worker', agentId,
        expiresAt: new Date(NON_EXPIRING_CREDENTIAL_TIMESTAMP),
        grants: [{ actions, scope: { workspaceIds: [workspaceId], workflowIds: [workflowId] } }] }, sql)
      await sql.query(`insert into agent_conversation_credentials(principal_id,conversation_id,subject,workflow_version_id)
        values($1,$2,$3::jsonb,$4)`, [issued.principal.id, row.id, canonicalJson(current.subject), current.workflowVersionId])
      return { ...issued, subject: current.subject,
        environment: { agentId, variables: { FOREMAN_CODE_MCP_TOKEN: issued.token, GRAPHQL_MCP_TOKEN: issued.token } } }
    })
  }
}
