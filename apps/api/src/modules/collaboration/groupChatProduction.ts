import type { SqlQuery } from '../../infrastructure/transaction.js'
import { readChatPrincipal, readConversationCredential } from '../access/conversationCredentials.js'
import type pg from 'pg'
import { AgentConfigurationVersionSchema, AgentSubjectSchema, HarnessExecutionSchema, effectiveGraphqlTools } from '@foreman-code/contracts'
import { requireChatAuthorization } from './chatAuthorization.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { readConsultationCredentialSubject } from '../access/consultationAuthority.js'
import { WORKER_BINDING_ELIGIBLE } from '../access/workerEligibility.js'
import { DomainError } from '../errors.js'
import { createWorkflowChatFeature, type SharedChatAccess } from '../workflow-chat/feature.js'
import type { AgentChatService, ConversationFeatureBinder } from '../conversations/agentChat.js'
import type { OperatorChatService } from '../conversations/operatorChat.js'
import type { PostgresAgentChatRepository } from '../conversations/agentChatRepository.js'
import type { WorkflowExecutionChatService } from './workflowChatService.js'
import { authorizeWorkflowChat, withWorkflowChatRead } from './workflowChatRead.js'
import { readWorkflowChatIdentity, readWorkflowChatVersion, readWorkflowChatAgent } from './workflowChatIdentity.js'
import { asWorkflowChatTarget } from './workflowControlRecords.js'
import { workflowGroupReplies } from './workflowGroupProjection.js'

export function productionChatAccess(pool: pg.Pool): SharedChatAccess {
  return {
    restore: id => readChatPrincipal(pool, id),
    async resolve(principal, action, scope, transaction) {
      const sql: SqlQuery = transaction ?? pool
      const live = await readChatPrincipal(sql, principal.id)
      requireChatAuthorization(live, action, scope)
      if (scope && !(await sql.query('select id from workflows where id=$1 and workspace_id=$2',
        [scope.workflowId, scope.workspaceId])).rowCount) {
        throw new DomainError('WORKFLOW_NOT_FOUND', 'The chat workflow is unavailable.', 404)
      }
      if (live.audience !== 'worker') return { principal: live }
      const conversation = await readConversationCredential(sql, live.id)
      if (conversation) {
        const tool = action === 'agent_chat:read' ? 'workflow_chat_read' : 'workflow_chat_post'
        if (action === 'agent_chat:cancel' || !conversation.tools.includes(tool)) throw new DomainError('ACCESS_DENIED',
          'This Agent cannot use the requested Group chat operation.', 403)
        if (!scope || scope.workspaceId !== conversation.subject.agent.workspaceId
          || scope.workflowId !== conversation.subject.agent.workflowId) throw new DomainError(
          'ACCESS_DENIED', 'This credential belongs to another conversation workflow.', 403)
        return { principal: live, subject: conversation.subject }
      }
      const row = (await sql.query<{ purpose: string; execution: unknown; version_id: string; node_id: string;
        configuration: unknown; run_id: string; activation_id: string | null }>(`select b.purpose,
          he.record as execution,r.workflow_version_id as version_id,he.workflow_node_id as node_id,
          c.record as configuration,r.id as run_id,he.work_activation_id as activation_id
        from worker_credential_bindings b join management_principals p on p.id=b.principal_id
        join harness_executions he on he.id=b.execution_id join runs r on r.id=b.run_id
        join agent_configuration_versions c on c.id=he.record->>'agentConfigurationVersionId'
        where b.principal_id=$1 and ${WORKER_BINDING_ELIGIBLE}`, [live.id])).rows[0]
      if (!row || !scope) throw new DomainError('ACCESS_DENIED', 'A live scoped Agent is required for Group chat.', 403)
      const version = await readWorkflowChatVersion(sql, { ...scope, workflowVersionId: row.version_id })
      const agent = await readWorkflowChatAgent(sql, version, row.node_id)
      const configuration = AgentConfigurationVersionSchema.parse(row.configuration)
      const node = version.definition.nodes.find(candidate => candidate.id === row.node_id)
      if (action === 'agent_chat:cancel') throw new DomainError('ACCESS_DENIED', 'Agents cannot cancel Group deliveries.', 403)
      const tool = action === 'agent_chat:read' ? 'workflow_chat_read' : 'workflow_chat_post'
      const enabled = effectiveGraphqlTools(agent.productRole, configuration.graphqlTools,
        node?.kind === 'job' ? undefined : node?.graphqlTools, Boolean(node && 'interval' in node && node.interval), ['workflow_chat_read', 'workflow_chat_post'])
      const readOnly = configuration.harness.harness === 'opencode' || configuration.harness.sandbox === 'read-only'
      if (!enabled.includes(tool) || readOnly && action !== 'agent_chat:read') {
        throw new DomainError('ACCESS_DENIED', 'This Agent cannot use the requested Group chat operation.', 403)
      }
      const execution = HarnessExecutionSchema.parse(row.execution)
      const subject = row.purpose === 'consultation' ? await readConsultationCredentialSubject(sql, live.id)
        : AgentSubjectSchema.parse({ kind: 'execution', agent, execution: { runId: row.run_id,
          workflowVersionId: row.version_id, executionId: execution.id, attempt: execution.attempt,
          ...(row.activation_id ? { activationId: row.activation_id } : {}) } })
      return { principal: live, subject }
    },
  }
}

export function createProductionWorkflowChat(input: {
  pool: pg.Pool; agent: AgentChatService; operator: OperatorChatService; agentRepository: PostgresAgentChatRepository
  execution: WorkflowExecutionChatService; bindConversationScope: ConversationFeatureBinder
}) {
  const { pool, execution, agent } = input
  return createWorkflowChatFeature({ ...input, access: productionChatAccess(pool), runReplies: workflowGroupReplies,
    targets: { async resolve(principal, workspaceId, query) {
      if (query.runId) {
        const selected = await execution.resolve(principal, { workspaceId, workflowId: query.workflowId,
          workflowNodeId: query.workflowNodeId, runId: query.runId })
        if (selected.kind !== 'selected') throw new DomainError(
          'CHAT_TARGET_SELECTION_REQUIRED', 'Choose the exact Run chat target before sending.', 409)
        if (selected.agent.agentId !== query.agentId) throw new DomainError(
          'CHAT_TARGET_CHANGED', 'The selected Agent does not match this Run node.', 409)
        if (selected.state === 'idle' && selected.target.kind === 'workflow_execution') return {
          kind: 'historical_execution', selection: { workspaceId, workflowId: query.workflowId,
            workflowNodeId: query.workflowNodeId, runId: query.runId, executionId: selected.target.execution.executionId },
        }
        return selected.target
      }
      const read = await agent.read(principal, workspaceId, query)
      if (!read.deliveryTarget) throw new DomainError('CHAT_TARGET_UNAVAILABLE', 'Read the selected Agent before sending.', 409)
      return read.deliveryTarget
    } },
    qualifyExecutionLocked: (_tx, principal, request, channelContext) => execution.qualify(principal, request, channelContext),
    async authorizeExecutionTarget(principal, target, action, sql) {
      if (sql) {
        authorizeWorkflowChat(await readLiveManagementPrincipal(sql, principal.id), target, `agent_chat:${action}`)
        await readWorkflowChatIdentity(sql, target)
      } else await withWorkflowChatRead(pool, principal, asWorkflowChatTarget(target), `agent_chat:${action}`,
        query => readWorkflowChatIdentity(query, target))
    },
    async assertCardLinksLocked(sql, principal, scope, cardIds) {
      requireChatAuthorization(principal, 'agent_chat:read', scope)
      const rows = await sql.query<{ id: string }>(`select c.id from memory_cards c join memory_boards b on b.id=c.board_id
        where c.id=any($1::text[]) and b.scope->>'workspaceId'=$2 and (b.scope->>'workflowId'=$3 or b.scope->>'kind'='workspace')`,
      [cardIds, scope.workspaceId, scope.workflowId])
      if (rows.rowCount !== new Set(cardIds).size) throw new DomainError('CHAT_CARD_NOT_FOUND',
        'A linked card is unavailable in this workflow or its workspace.', 404)
    },
  })
}
