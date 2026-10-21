import type { ManagementGrant } from '@foreman-code/contracts/management'

/** Text-only handoff access is the native chat's narrowed form of chat read.
 * Use only for a database-bound Operator chat credential, never a general token.
 */
export function operatorChatGrants(grants: ManagementGrant[]): ManagementGrant[] {
  return grants.map((grant) => ({ ...grant, actions: [
    ...grant.actions.filter((action) => !action.startsWith('operator_chat:') && action !== 'operator_handoff:read'),
    ...(grant.actions.includes('operator_chat:read') ? ['operator_handoff:read' as const] : []),
  ] })).filter((grant) => grant.actions.length > 0)
}
