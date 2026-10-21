import type { ManagementAction, ManagementPrincipal, ManagementScope } from '@foreman-code/contracts/management'
import { hasAction, isAuthorized, requireAuthorization, type AuthorizedResource } from '../access/policy.js'

type Requirement = { action: ManagementAction; scope: 'global' | 'workspace' | 'workflow' }
const reads: Requirement[] = [{ action: 'workflows:read', scope: 'workflow' }, { action: 'graph:read', scope: 'workflow' }]
const validation: Requirement[] = [...reads, { action: 'agents:read', scope: 'workflow' }, { action: 'workspace_locations:read', scope: 'workspace' }]
const writes: Requirement[] = [...validation, ...(['workflows:update', 'graph:edit', 'graph:save'] as const)
  .map((action) => ({ action, scope: 'workflow' as const }))]
export const currentWorkflowRequirements = {
  capabilities: [{ action: 'capabilities:read', scope: 'global' }] as Requirement[],
  saved: reads, validate: validation,
  save: writes, edits: writes, editRead: validation,
}
export type CurrentWorkflowOperation = keyof typeof currentWorkflowRequirements
export function requireCurrentWorkflowAccess(principal: ManagementPrincipal, operation: CurrentWorkflowOperation, resource: AuthorizedResource = {}) {
  for (const requirement of currentWorkflowRequirements[operation]) requireAuthorization(principal, requirement.action,
    project(resource, requirement.scope))
}

/** Discovery uses the same scope projections as execution, including intersected
 * grants. Having an edit grant in A and read grant in B is not callable Save. */
export function currentWorkflowAvailable(principal: ManagementPrincipal, operation: CurrentWorkflowOperation,
  resource?: AuthorizedResource) {
  if (resource && Object.keys(resource).length) return currentWorkflowRequirements[operation].every((item) =>
    isAuthorized(principal, item.action, project(resource, item.scope)))
  let candidates: ManagementScope[] = [{}]
  for (const requirement of currentWorkflowRequirements[operation]) {
    if (!hasAction(principal, requirement.action)) return false
    const grants = principal.grants.filter((grant) => grant.actions.includes(requirement.action)
      && !grant.scope.runIds && (requirement.scope === 'workflow' || !grant.scope.workflowIds)
      && (requirement.scope !== 'global' || !grant.scope.workspaceIds)
      && Object.values(grant.scope).every((ids) => ids === undefined || ids.length > 0))
    const next: ManagementScope[] = []
    for (const a of candidates) for (const { scope: b } of grants) {
      const scope: ManagementScope = {}
      let disjoint = false
      for (const key of ['workspaceIds', 'workflowIds'] as const) {
        const left = a[key], right = b[key]
        const ids = left && right ? left.filter((id) => right.includes(id)) : left ?? right
        if (ids?.length === 0) { disjoint = true; break }
        if (ids) scope[key] = ids
      }
      if (!disjoint) next.push(scope)
    }
    if (!next.length) return false
    // Equivalent grant combinations do not need duplicate candidate work.
    candidates = [...new Map(next.map((scope) => [JSON.stringify(scope), scope])).values()]
  }
  return true
}

function project(resource: AuthorizedResource, scope: Requirement['scope']): AuthorizedResource {
  if (scope === 'global') return {}
  return { ...(resource.workspaceId ? { workspaceId: resource.workspaceId } : {}),
    ...(scope === 'workflow' && resource.workflowId ? { workflowId: resource.workflowId } : {}) }
}
