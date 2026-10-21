import { useQuery } from '@tanstack/react-query'
import type { ProviderAccountBinding, ProviderAccountTarget } from '@foreman-code/contracts/provider-accounts'
import { sameDeviceProvisioningTarget, type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { ApiError } from '../../shared/api/client'
import { useBlockingReadError } from '../../shared/api/readFailure'
import { assertSession, sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { useRuntimeInstallationId } from '../../shared/api/runtimeIdentity'
import { providerAccountsClient } from './providerAccountsClient'
import { providerAccountKey, providerAccountsKey, providerTargetsKey, type ProviderAccountScope } from './providerAccountsKeys'

export function assertAccountTarget(actual: DeviceProvisioningTarget | undefined, expected: DeviceProvisioningTarget) {
  if (!actual || !sameDeviceProvisioningTarget(actual, expected)) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Account readback belongs to another computer or installation.' })
  }
}
export function useProviderAccountTargets() {
  const epoch = useHarnessSessionEpoch()
  return useQuery({ queryKey: providerTargetsKey(), enabled: !sessionIsSwitching(), retry: false,
    refetchOnReconnect: 'always', refetchInterval: 30_000,
    queryFn: async ({ signal }) => {
      const result = await providerAccountsClient.targets({ signal })
      assertSession(epoch)
      return result
    } })
}
export function useProviderAccountScope(scope: ProviderAccountScope = {}): ProviderAccountScope {
  const installationId = useRuntimeInstallationId()
  const discovery = useProviderAccountTargets()
  const blocked = useBlockingReadError(discovery)
  const targets = !blocked ? discovery.data?.targets : undefined
  const selected = findTarget(targets, scope, installationId)
  if (!selected) return scope
  return { ...scope, target: selected.target, generation: selected.generation }
}
function findTarget(targets: ProviderAccountTarget[] | undefined, scope: ProviderAccountScope, installationId?: string) {
  if (scope.target) return targets?.find(item => sameDeviceProvisioningTarget(item.target, scope.target!))
  if (scope.hostRef) return targets?.find(item => {
    const actual = item.target.hostRef
    const expected = scope.hostRef!
    return actual.mainId === expected.mainId && actual.kind === expected.kind
      && (actual.kind !== 'device' || expected.kind === 'device' && actual.deviceId === expected.deviceId)
  })
  return targets?.find(item => item.target.hostRef.kind === 'main'
    && (!installationId || item.target.applicationInstallationId === installationId))
}
export function useProviderAccountProfiles(requestedScope: ProviderAccountScope, enabled = true) {
  const epoch = useHarnessSessionEpoch()
  const scope = useProviderAccountScope(requestedScope)
  return useQuery({ queryKey: [...providerAccountsKey(scope), 'profiles'],
    enabled: enabled && Boolean(scope.target) && !sessionIsSwitching(), retry: false, refetchOnReconnect: 'always',
    queryFn: async ({ signal }) => {
      const { target, provider } = scope
      const result = await providerAccountsClient.profiles({ ...(target ? { target } : {}),
        ...(provider ? { provider } : {}) }, { signal })
      assertSession(epoch)
      assertAccountTarget(result.target, target!)
      if (provider && result.profiles.some(profile => profile.provider !== provider)) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Profile choices belong to another provider.' })
      }
      return result
    } })
}
export function useProviderAccountEligibility(binding?: ProviderAccountBinding) {
  const epoch = useHarnessSessionEpoch()
  const scope = useProviderAccountScope(binding ? { target: binding.target, provider: binding.provider } : {})
  return useQuery({ queryKey: [...providerAccountKey(binding), 'eligibility', scope.generation ?? null],
    enabled: Boolean(binding) && !sessionIsSwitching(), retry: false, refetchOnReconnect: 'always',
    queryFn: async ({ signal }) => {
      const result = await providerAccountsClient.eligibility({ accountId: binding!.accountId, target: binding!.target }, { signal })
      assertSession(epoch)
      assertAccountTarget(result.target, binding!.target)
      if (result.accountId !== binding!.accountId) throw new Error('Eligibility belongs to another account.')
      return result
    } })
}
