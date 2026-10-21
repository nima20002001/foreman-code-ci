import type { DurableInteraction } from '@foreman-code/contracts'
import { ManagementPrincipalSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import type { GraphTransactionSql } from '../../run-graph/connection.js'
import { requireRespondableInteraction } from '../../access/appPolicy.js'
import { canUserInteract } from '../../access/userPolicy.js'
import { requireAuthorization } from '../../access/policy.js'
import { assertWave25WorkerBinding } from './credentialAuthority.js'
import { fail, type ApprovalContext } from './context.js'

/** Use durable grants and binding, including on an exact decision replay. */
export async function lockPrincipal(sql: GraphTransactionSql, snapshot: ManagementPrincipal,
  interaction: DurableInteraction, context: ApprovalContext, replay = false): Promise<ManagementPrincipal> {
  const row = (await sql.query<{
    id: string; name: string; audience: string; agent_id: string | null; grants: unknown;
    expires_at: Date; revoked_at: Date | null
  }>('select id,name,audience,agent_id,grants,expires_at,revoked_at from management_principals where id=$1 for share', [snapshot.id])).rows[0]
  if (!row || row.revoked_at || row.expires_at.getTime() <= Date.now()) return fail('AUTH_REVOKED')
  const principal = ManagementPrincipalSchema.parse({ id: row.id, name: row.name, audience: row.audience,
    ...(row.agent_id ? { agentId: row.agent_id } : {}), grants: row.grants, expiresAt: row.expires_at.toISOString(), revokedAt: null })
  if (interaction.approval.handler === 'user') {
    if (principal.audience === 'operator' && snapshot.audience === 'operator') {
      requireAuthorization(principal, 'interactions:read', interaction)
      requireAuthorization(principal, 'interactions:respond', interaction)
      return principal
    }
    // The implicit local human is an operator principal that the user-interaction
    // route projects as a User with interaction grants. Re-apply that same
    // projection to the freshly locked (live, unrevoked) row.
    const effective = principal.audience === 'operator' && snapshot.audience === 'user'
      ? { ...principal, audience: 'user' as const, grants: [{ actions: ['interactions:read', 'interactions:respond'], scope: {} }] }
      : principal
    if (!canUserInteract(effective as ManagementPrincipal, 'interactions:respond', interaction)) return fail('INTERACTION_ACCESS_DENIED')
    return effective as ManagementPrincipal
  }
  requireRespondableInteraction(principal, interaction)
  const reviewer = context.reviewer
  if (!reviewer || principal.agentId !== reviewer.agentId) return fail('INTERACTION_ACCESS_DENIED')
  const binding = (await sql.query<{
    execution_id: string; run_id: string; workspace_id: string; workflow_id: string; agent_id: string;
    purpose: string; approval_review_job_id: string | null; approval_review_lease_fence: string | null; revoked_at: Date | null; environment_variable: string;
    approval_native_session_id: string | null; approval_connection_generation: string | null
  }>('select * from worker_credential_bindings where principal_id=$1 for share', [principal.id])).rows[0]
  if (!binding || binding.revoked_at || binding.execution_id !== reviewer.id || binding.run_id !== context.scope.runId
    || binding.agent_id !== reviewer.agentId || binding.workspace_id !== context.scope.workspaceId
    || binding.workflow_id !== context.scope.workflowId || binding.purpose !== 'reviewer'
    || binding.environment_variable !== 'GRAPHQL_MCP_TOKEN'
    || binding.approval_native_session_id !== reviewer.nativeSessionId) return fail('AUTH_REVOKED')
  await assertWave25WorkerBinding(sql, principal.id)
  if (replay) return principal
  const active = await sql.query(`select 1 from review_jobs j join native_session_lanes l
      on l.harness=j.record->>'provider' and l.native_session_id=j.record->>'nativeSessionId'
    where j.interaction_id=$1 and j.execution_id=$2 and j.reviewer_agent_id=$3
      and j.id=$5 and j.lease_fence=$6::bigint
      and j.state in ('submitted','acknowledged','uncertain')
      and j.lease_expires_at>clock_timestamp() and j.lease_token is not null
      and j.approval_connection_generation=(l.record->>'connectionGeneration')::bigint
      and (l.record->>'connectionGeneration')::bigint=$4::bigint
      and l.record->>'correlationId'=j.record->>'correlationId'
      and (l.record->>'leaseExpiresAt')::timestamptz>clock_timestamp()
      and l.owner_agent_id=$3`, [interaction.id, reviewer.id, reviewer.agentId, binding.approval_connection_generation, binding.approval_review_job_id, binding.approval_review_lease_fence])
  if (active.rowCount !== 1) return fail('REVIEWER_AUTHORITY_LOST')
  return principal
}
