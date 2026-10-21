import { ManagementPrincipalSchema } from '@foreman-code/contracts/management'
import { workerScopesForAction } from '../access/appPolicy.js'
import { DomainError } from '../errors.js'
import type { GraphSqlClient } from '../run-graph/connection.js'

interface ReviewerCredentialScope {
  agentId: string
  workspaceId: string
  workflowId: string
  runId: string
}

export async function requireReviewerCredential(sql: GraphSqlClient, principalId: string,
  scope: ReviewerCredentialScope): Promise<void> {
  const row = (await sql.query<{
    id: string; name: string; audience: string; agent_id: string | null; grants: unknown
    expires_at: Date; revoked_at: Date | null
  }>(`select id,name,audience,agent_id,grants,expires_at,revoked_at
    from management_principals where id=$1 for share`, [principalId])).rows[0]
  if (!row || row.audience !== 'worker' || row.agent_id !== scope.agentId || row.revoked_at
    || row.expires_at.getTime() <= Date.now()) {
    throw new DomainError('REVIEWER_CREDENTIAL_LOST', 'The reviewer process credential is no longer active.', 409)
  }
  const principal = ManagementPrincipalSchema.parse({
    id: row.id, name: row.name, audience: row.audience, agentId: row.agent_id,
    grants: row.grants, expiresAt: row.expires_at.toISOString(), revokedAt: null,
  })
  for (const action of ['interactions:read', 'interactions:respond'] as const) {
    const allowed = workerScopesForAction(principal, action).some(grant =>
      grant.workspaceIds?.includes(scope.workspaceId) && grant.workflowIds?.includes(scope.workflowId)
      && grant.runIds?.includes(scope.runId))
    if (!allowed) {
      throw new DomainError('REVIEWER_CREDENTIAL_LOST', 'The reviewer credential does not cover this Run.', 409)
    }
  }
}
