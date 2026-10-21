import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
import type { ChannelScope } from '../workflow-chat/model.js'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'

/** Scoped Agent chat uses its own saved subject; it never enters the Operator policy. */
export function requireChatAuthorization(principal: ManagementPrincipal, action: ManagementAction, scope?: ChannelScope) {
  if (principal.audience === 'operator') return requireAuthorization(principal, action, scope)
  if (principal.audience !== 'worker' || !scope || !principal.agentId || principal.revokedAt
    || Date.parse(principal.expiresAt) <= Date.now()
    || !principal.grants.some(grant => grant.actions.includes(action)
      && grant.scope.workspaceIds?.includes(scope.workspaceId)
      && grant.scope.workflowIds?.includes(scope.workflowId)
      && !grant.scope.runIds && !grant.scope.mainIds && !grant.scope.deviceIds
      && !grant.scope.applicationInstallationIds && !grant.scope.providerAccountIds)) {
    throw new DomainError('ACCESS_DENIED', 'The scoped Agent cannot perform this chat operation.', 403)
  }
}
