import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { sameDeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { ProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import { useProviderAccountEligibility, useProviderAccountTargets } from './providerAccountDiscovery'
import { useBlockingReadError } from '../../shared/api/readFailure'

export function useProviderAccountAccess(target?: DeviceProvisioningTarget, binding?: ProviderAccountBinding) {
  const discovery = useProviderAccountTargets()
  const eligibility = useProviderAccountEligibility(binding)
  const blocked = useBlockingReadError(discovery)
  const selected = !blocked ? discovery.data?.targets.find(item => target
    && sameDeviceProvisioningTarget(item.target, target)) : undefined
  const canManage = binding ? !eligibility.isError && eligibility.data?.canManage === true
    : !discovery.isError && selected?.canManage === true
  return { canManage, target: selected, eligibility, discovery }
}
