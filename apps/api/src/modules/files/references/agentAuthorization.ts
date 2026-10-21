import type pg from 'pg'
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
    const result = await query.query<ReferenceExecutionIdentity>(`select b.workspace_id,b.workflow_id,b.agent_id,b.run_id,b.execution_id
      from worker_credential_bindings b
      join management_principals p on p.id=b.principal_id and p.audience='worker' and p.agent_id=b.agent_id
      join harness_executions e on e.id=b.execution_id and e.run_id=b.run_id and e.agent_id=b.agent_id
      join runs r on r.id=e.run_id and r.workspace_id=b.workspace_id and r.workflow_id=b.workflow_id
      where b.principal_id=$1 and b.agent_id=$2 and b.revoked_at is null
        and p.revoked_at is null and p.expires_at>clock_timestamp()
      for share of b,p,e,r`, [principal.id, principal.agentId])
    if (result.rows.length !== 1) return referenceIdentityDenied()
    // Preserve the existing current engine's purpose, Run, execution, session/generation and revocation checks.
    // In complete(), these checks run on the same transaction that commits the provenance fact.
    await assertWave25WorkerBinding(query, principal.id)
    const row = result.rows[0]!
    return { workspaceId: row.workspace_id, workflowId: row.workflow_id, agentId: row.agent_id,
      runId: row.run_id, executionId: row.execution_id }
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
