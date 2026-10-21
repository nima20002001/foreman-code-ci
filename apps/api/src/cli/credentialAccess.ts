import { DEFAULT_MANAGEMENT_ACTIONS, type ManagementAction } from '@foreman-code/contracts/management'

/** Read-only credentials retain the narrow read preset. */
export function credentialActions(
  access: 'manage' | 'read-only' = 'manage',
  grant?: ManagementAction,
): ManagementAction[] {
  const actions = access === 'manage'
    ? [...DEFAULT_MANAGEMENT_ACTIONS]
    : DEFAULT_MANAGEMENT_ACTIONS.filter(action => action.endsWith(':read')
      && action !== 'devices:metrics:read' && action !== 'provider_accounts:read')
  if (grant && !actions.includes(grant)) actions.push(grant)
  return actions
}
