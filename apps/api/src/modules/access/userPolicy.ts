import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { AuthorizedResource } from './policy.js'

/** Human approval credentials have no Operator or board-Agent authority. */
export function canUserInteract(principal: ManagementPrincipal, action: 'interactions:read' | 'interactions:respond', resource: AuthorizedResource): boolean {
  return principal.audience === 'user' && !principal.revokedAt && Date.parse(principal.expiresAt) > Date.now()
    && principal.grants.some((grant) => grant.actions.includes(action)
      && (!grant.scope.workspaceIds || !!resource.workspaceId && grant.scope.workspaceIds.includes(resource.workspaceId))
      && (!grant.scope.workflowIds || !!resource.workflowId && grant.scope.workflowIds.includes(resource.workflowId))
      && (!grant.scope.runIds || !!resource.runId && grant.scope.runIds.includes(resource.runId)))
}
