import type { AccountProvider, ProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { sessionGeneration } from '../../shared/api/sessionBoundary'

export type ProviderAccountScope = {
  provider?: AccountProvider; target?: DeviceProvisioningTarget; generation?: number; includeRemoved?: boolean
  hostRef?: DeviceProvisioningTarget['hostRef']
}
export const providerTargetsKey = () => ['provider-accounts', sessionGeneration(), 'targets'] as const
export const providerAccountsKey = (scope: ProviderAccountScope = {}) =>
  ['provider-accounts', sessionGeneration(), scope.target ?? scope.hostRef ?? null, scope.provider ?? null,
    scope.generation ?? null, scope.includeRemoved ?? false] as const
export const providerAccountKey = (binding: ProviderAccountBinding | undefined) =>
  [...providerAccountsKey(binding ? { target: binding.target, provider: binding.provider } : {}),
    'account', binding?.accountId ?? null, binding?.profileRef ?? null, binding?.bindingRevision ?? null,
    binding?.subject?.subject ?? null, binding?.subject?.qualificationId ?? null] as const
export const providerAuthenticationKey = (binding: ProviderAccountBinding | undefined, operationId?: string) =>
  [...providerAccountKey(binding), 'authentication', operationId ?? null] as const
