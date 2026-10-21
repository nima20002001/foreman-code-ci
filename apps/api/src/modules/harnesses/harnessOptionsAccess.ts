import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { ProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import type { ProviderAccountsService } from '../provider-accounts/service.js'
import { DomainError } from '../errors.js'

/** Managed catalogs retain the account service's live, target-scoped read checks. */
export async function requireHarnessOptionsAccountAccess(principal: ManagementPrincipal,
  binding: ProviderAccountBinding | undefined, accounts?: Pick<ProviderAccountsService, 'get'>) {
  if (!binding) return
  if (!accounts) throw new DomainError('PROVIDER_ACCOUNTS_UNAVAILABLE', 'Provider account reads are unavailable.', 503)
  await accounts.get(principal, { accountId: binding.accountId, target: binding.target })
}
