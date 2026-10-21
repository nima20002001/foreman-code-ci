import type { HarnessConfiguration } from '@foreman-code/contracts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { useNativeHarnessOptions } from '../../shared/api/harnessSettings'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { useProviderAccounts, useProviderAccountModels, useProviderAccountScope } from './providerAccountsQueries'
import { useProviderAccountAccess } from './providerAccountAccess'

export function useProviderHarnessModels(harness: HarnessConfiguration['harness'], accountId?: string,
  hostRef?: DeviceProvisioningTarget['hostRef']) {
  const scope = useProviderAccountScope({ ...(harness !== 'opencode' ? { provider: harness } : {}),
    ...(hostRef ? { hostRef } : {}) })
  const access = useProviderAccountAccess(scope.target)
  const accounts = useProviderAccounts(harness !== 'opencode' && access.target?.canRead === true, scope)
  const denied = useProtectedAccessError(accounts)
  const account = !denied && !accounts.isError ? accounts.data?.accounts.find(value =>
    (accountId ? value.id === accountId : harness === 'codex' && value.isDefault) && !value.removedAt) : undefined
  const capability = access.target?.providers.find(item => item.provider === harness)
  const accountAvailable = access.target?.connected && capability?.qualified && capability.actions.includes('models')
    && account?.observation?.generation === scope.generation
  const modelBinding = account?.binding ? { ...account.binding,
    subject: account.observation?.subject ?? account.binding.subject } : undefined
  const scoped = useProviderAccountModels(accountAvailable ? modelBinding : undefined,
    account?.observation?.generation, account?.observation?.sequence)
  const modelDenial = useProtectedAccessError(scoped)
  const localProfile = !accountId && !account && scope.target && access.target?.connected
    && accounts.isSuccess && !denied && !accounts.isError
  const native = useNativeHarnessOptions(harness, Boolean(localProfile), scope.target?.hostRef)
  if (localProfile) return native
  const unsupported = access.discovery.isSuccess && (!access.target?.canRead
    || !scope.target || accounts.isSuccess && (!account?.binding || !accountAvailable))
  const error = denied ?? modelDenial ?? access.discovery.error ?? accounts.error ?? scoped.error
    ?? (unsupported ? new Error('Model discovery is unavailable for the selected account and computer.') : null)
  return {
    data: accountAvailable && scoped.data && !modelDenial && !scoped.isError
      ? { ...scoped.data.options, models: scoped.data.models } : undefined,
    isSuccess: Boolean(accountAvailable && scoped.isSuccess && !modelDenial),
    isPending: !unsupported && (access.discovery.isPending || accounts.isPending || scoped.isPending),
    isError: Boolean(error), error,
    refetch: accounts.refetch,
  }
}
