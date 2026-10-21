import type { ManagementAction, ManagementGrant } from '@foreman-code/contracts/management'
/** UI affordance only. The shared service rechecks grants and native authority. */
export function canUseBoardAction(grants: readonly ManagementGrant[], action: ManagementAction,
  scope: { workspaceId: string; workflowId: string; runId?: string }): boolean {
  return grants.some((grant) => grant.actions.includes(action)
    && (!grant.scope.workspaceIds || grant.scope.workspaceIds.includes(scope.workspaceId))
    && (!grant.scope.workflowIds || grant.scope.workflowIds.includes(scope.workflowId))
    && (!grant.scope.runIds || !!scope.runId && grant.scope.runIds.includes(scope.runId)))
}
