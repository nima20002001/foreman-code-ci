import type pg from 'pg'
import { TemporaryFileScopeSchema, type TemporaryFileScope } from '@foreman-code/contracts/files'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'

import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'

export type FileConversation = { kind: 'operator'; conversationId: string }
  | { kind: 'agent'; workspaceId: string; conversationId: string }
export type FileAccess = 'read' | 'write'
export interface FileConversationAuthorization {
  resolve(principal: ManagementPrincipal, conversation: FileConversation, access: FileAccess): Promise<TemporaryFileScope>
}
interface ConversationRow {
  kind: 'operator' | 'agent'
  id: string
  owner_principal_id: string | null
  operator_id: string | null
  workspace_id: string | null
  workflow_id: string | null
  agent_id: string | null
  origin_run_id: string | null
  origin_execution_id: string | null
}

/** Uses the same owner/grant distinction as the existing chat services.
 * Agent conversations have no owner column by design; their persisted resource grants are authoritative. */
export class PostgresFileConversationAuthorization implements FileConversationAuthorization {
  constructor(private readonly pool: pg.Pool) {}

  async resolve(principal: ManagementPrincipal, conversation: FileConversation, access: FileAccess): Promise<TemporaryFileScope> {
    const result = await this.pool.query<ConversationRow>(`select kind,id,owner_principal_id,operator_id,
      workspace_id,workflow_id,agent_id,origin_run_id,origin_execution_id from operator_conversations
      where id=$1 and kind=$2 and deleted_at is null`, [conversation.conversationId, conversation.kind])
    const row = result.rows[0]
    if (!row || (conversation.kind === 'agent' && row.workspace_id !== conversation.workspaceId)
      || (row.kind === 'operator' && row.owner_principal_id !== principal.id)) {
      throw new DomainError('FILE_CONVERSATION_NOT_FOUND', 'The conversation was not found.', 404)
    }
    if (row.kind === 'operator') {
      requireAuthorization(principal, 'operator_chat:read')
      if (access === 'write') requireAuthorization(principal, 'operator_chat:write')
      // No Board/navigation context can leak into an Operator file scope.
      return TemporaryFileScopeSchema.parse({ kind: 'temporary', chat: { kind: 'operator',
        ownerPrincipalId: row.owner_principal_id, operatorId: row.operator_id, conversationId: row.id } })
    }
    const resource = { workspaceId: row.workspace_id!, workflowId: row.workflow_id!,
      ...(row.origin_run_id ? { runId: row.origin_run_id } : {}) }
    requireAuthorization(principal, 'agent_chat:read', resource)
    if (access === 'write') requireAuthorization(principal, 'agent_chat:write', resource)
    return TemporaryFileScopeSchema.parse({ kind: 'temporary', chat: { kind: 'agent',
      conversationId: row.id, agentId: row.agent_id, workspaceId: row.workspace_id, workflowId: row.workflow_id,
      ...(row.origin_run_id ? { runId: row.origin_run_id, executionId: row.origin_execution_id } : {}) } })
  }
}
