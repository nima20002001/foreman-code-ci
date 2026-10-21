import type pg from 'pg'
import type { ChatSendRequest } from '@foreman-code/contracts'
import { fileStateAt } from '@foreman-code/contracts/files'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { PostgresFileRepository } from '../files/postgres.js'
import { PostgresFileReferenceAuthorization } from '../files/references/authorization.js'
import { validateMessageAttachments } from '../conversations/messageAttachments.js'
import { DomainError } from '../errors.js'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { authorizeWorkflowChat } from './workflowChatRead.js'
import { asWorkflowChatTarget, workflowTargetRunId } from './workflowControlRecords.js'

export function workflowChatAttachmentAuthorization(pool: pg.Pool) {
  const files = new PostgresFileRepository(pool)
  return async (sql: GraphSqlClient, principalId: string, request: ChatSendRequest) => {
    if (!request.attachments.length) return
    const target = asWorkflowChatTarget(request.target)
    const principal = await readLiveManagementPrincipal(sql, principalId)
    authorizeWorkflowChat(principal, target, 'agent_chat:write')
    const runId = workflowTargetRunId(target)
    const executionId = target.kind === 'workflow_execution' ? target.execution.executionId
      : (await sql.query<{ parent_execution_id: string }>(`select parent_execution_id from run_hierarchy_groups
          where run_id=$1 and parent_activation_id=$2 and parent_node_id=$3`,
      [runId, target.waitingActivationId, target.agent.workflowNodeId])).rows[0]?.parent_execution_id
    await sql.query('select file_id from files where file_id=any($1::text[]) order by file_id for share',
      [request.attachments.map(file => file.fileId)])
    const readAt = (await sql.query<{ now: Date }>('select clock_timestamp() as now')).rows[0]!.now.toISOString()
    for (const pin of request.attachments) {
      const stored = await files.read(pin.fileId, pin.revisionId, sql)
      if (!stored) throw new DomainError('MESSAGE_ATTACHMENT_NOT_FOUND', 'The attachment revision is unavailable.', 404)
      const scope = stored.value.file.scope
      if (scope.kind === 'temporary') {
        const chat = scope.chat
        if (chat.kind !== 'agent' || chat.workspaceId !== target.agent.workspaceId
          || chat.workflowId !== target.agent.workflowId || chat.agentId !== target.agent.agentId
          || chat.runId !== runId || chat.executionId !== executionId) throw new DomainError(
          'MESSAGE_ATTACHMENT_NOT_FOUND', 'The attachment does not belong to this selected execution.', 404)
        await validateMessageAttachments(sql, chat.conversationId, [pin])
      } else {
        if (scope.kind === 'job_execution' || scope.workspaceId !== target.agent.workspaceId
          || scope.kind === 'workflow_reference' && scope.workflowId !== target.agent.workflowId) throw new DomainError(
          'MESSAGE_ATTACHMENT_NOT_FOUND', 'The reference does not belong to this workflow.', 404)
        await new PostgresFileReferenceAuthorization(sql).resolve(principal, scope, 'read', sql)
      }
      const state = fileStateAt(stored.value.file, readAt)
      if (state !== 'ready') throw new DomainError('MESSAGE_ATTACHMENT_UNAVAILABLE',
        'The attachment is not ready or is no longer available.', state === 'pending' ? 409 : 410)
    }
  }
}
