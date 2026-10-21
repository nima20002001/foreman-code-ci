import type pg from 'pg'
import type { AgentFileReadInput } from '@foreman-code/contracts/files'
import { ManagementPrincipalSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { readLiveManagementPrincipal } from '../../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../../access/policy.js'
import { assertWave25WorkerBinding } from '../../interactions/wave25/credentialAuthority.js'
import type { FileQuery } from '../repository.js'
import { conversationReferenceContext, referenceIdentityDenied,
  type ReferenceConversationIdentity, type ReferenceExecutionIdentity } from './agentLineage.js'
import type { AgentReferenceAuthorization, AgentReferenceContext, AgentReferenceSubject } from './agentTypes.js'

interface ConversationRow extends ReferenceConversationIdentity { owner_principal_id: string | null }

/** Existing authentication supplies the principal; persisted binding/lineage supplies *all* scope.
 * No new credential, management grant, current-board lookup, or agent-ID-only session lookup. */
export class PostgresAgentReferenceAuthorization implements AgentReferenceAuthorization {
  constructor(private readonly pool: pg.Pool) {}

  private async execution(principal: ManagementPrincipal, query: FileQuery): Promise<AgentReferenceContext> {
    if (principal.audience !== 'worker' || !principal.agentId) return referenceIdentityDenied()
    // Materialize the Run lock first in the same statement, including autocommit list/read calls.
    const result = await query.query<ReferenceExecutionIdentity>(`with locked_run as materialized (
        select r.id,r.workspace_id,r.workflow_id from runs r join worker_credential_bindings b on b.run_id=r.id
        where b.principal_id=$1 for share of r
      ) select b.workspace_id,b.workflow_id,b.agent_id,b.run_id,b.execution_id,b.consultation_id
      from worker_credential_bindings b
      join management_principals p on p.id=b.principal_id and p.audience='worker' and p.agent_id=b.agent_id
      join harness_executions e on e.id=b.execution_id and e.run_id=b.run_id and e.agent_id=b.agent_id
      join locked_run r on r.id=e.run_id and r.workspace_id=b.workspace_id and r.workflow_id=b.workflow_id
      where b.principal_id=$1 and b.agent_id=$2 and b.revoked_at is null
        and p.revoked_at is null and p.expires_at>clock_timestamp()
      for share of b,p,e`, [principal.id, principal.agentId])
    if (result.rows.length !== 1) return referenceIdentityDenied()
    // Preserve the existing current engine's purpose, Run, execution, session/generation and revocation checks.
    // In complete(), these checks run on the same transaction that commits the provenance fact.
    await assertWave25WorkerBinding(query, principal.id)
    const row = result.rows[0]!
    return { workspaceId: row.workspace_id, workflowId: row.workflow_id, agentId: row.agent_id,
      runId: row.run_id, executionId: row.execution_id,
      ...(row.consultation_id ? { consultationId: row.consultation_id } : {}) }
  }

  async attachment(principal: ManagementPrincipal, subject: AgentReferenceSubject, context: AgentReferenceContext,
    ref: Pick<AgentFileReadInput, 'fileId' | 'revisionId'>, query: FileQuery = this.pool): Promise<boolean> {
    if (principal.audience !== 'worker' || subject.kind !== 'execution' || !context.runId) return false
    const result = await query.query(`select 1 from run_chat_commands c join files f on f.file_id=$2
      where c.run_id=$1 and c.request->'attachments' @> $4::jsonb and c.kind='delivery'
        and c.target#>>'{agent,agentId}'=$5 and c.target#>>'{agent,workspaceId}'=$6
        and c.target#>>'{agent,workflowId}'=$7
        and f.scope_kind='temporary' and f.chat_kind='agent' and f.run_id=$1
        and f.agent_id=$5 and f.workspace_id=$6 and f.workflow_id=$7
        and (($8::text is null and c.consultation_id is null and c.delivered_execution->>'executionId'=$3
          and f.execution_id=c.target#>>'{execution,executionId}')
          or ($8::text is not null and c.consultation_id=$8 and f.execution_id=$3))
        and c.state in ('submitting','accepted','completed','unknown') limit 1`,
    [context.runId, ref.fileId, context.executionId, JSON.stringify([ref]), context.agentId,
      context.workspaceId, context.workflowId, context.consultationId ?? null])
    return result.rowCount === 1
  }

  async resolve(rawPrincipal: ManagementPrincipal, subject: AgentReferenceSubject,
    query: FileQuery = this.pool): Promise<AgentReferenceContext | null> {
    const principal = ManagementPrincipalSchema.parse(rawPrincipal)
    if (principal.revokedAt || Date.parse(principal.expiresAt) <= Date.now()) return referenceIdentityDenied()
    if (subject.kind === 'execution') {
      if (principal.audience === 'operator') {
        await readLiveManagementPrincipal(query, principal.id)
        return null // A global Operator does not inherit the currently open Board's references.
      }
      return this.execution(principal, query)
    }

    const worker = principal.audience === 'worker' ? await this.execution(principal, query) : undefined
    const live = worker ? undefined : await readLiveManagementPrincipal(query, principal.id)
    const result = await query.query<ConversationRow>(`select id,kind,owner_principal_id,workspace_id,workflow_id,
      agent_id,origin_run_id,origin_execution_id from operator_conversations
      where id=$1 and deleted_at is null for share`, [subject.conversationId])
    const conversation = result.rows[0]
    if (!conversation) return referenceIdentityDenied()
    if (conversation.kind === 'operator') {
      if (worker || conversation.owner_principal_id !== principal.id || !live) return referenceIdentityDenied()
      requireAuthorization(principal, 'operator_chat:read')
      requireAuthorization(live, 'operator_chat:read')
      return null
    }
    let origin: ReferenceExecutionIdentity | undefined
    if (conversation.origin_run_id !== null && conversation.origin_execution_id !== null) {
      origin = (await query.query<ReferenceExecutionIdentity>(`select r.workspace_id,r.workflow_id,e.agent_id,e.run_id,e.id as execution_id
        from harness_executions e join runs r on r.id=e.run_id
        where e.id=$1 and e.run_id=$2 for share of e,r`,
      [conversation.origin_execution_id, conversation.origin_run_id])).rows[0]
    }
    const context = conversationReferenceContext(conversation, origin)
    if (!context) return referenceIdentityDenied()
    if (worker) {
      // A worker may use only the conversation of its *exact execution*, not another use of the same Agent.
      if (context.workspaceId !== worker.workspaceId || context.workflowId !== worker.workflowId
        || context.agentId !== worker.agentId || context.runId !== worker.runId || context.executionId !== worker.executionId) {
        return referenceIdentityDenied()
      }
    } else {
      if (!live) return referenceIdentityDenied()
      const resource = { workspaceId: context.workspaceId, workflowId: context.workflowId,
        ...(context.runId ? { runId: context.runId } : {}) }
      requireAuthorization(principal, 'agent_chat:read', resource)
      requireAuthorization(live, 'agent_chat:read', resource)
    }
    return context
  }
}
