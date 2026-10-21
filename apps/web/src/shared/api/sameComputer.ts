import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'

export function sameComputer(left: CanonicalMachineReference, right: CanonicalMachineReference): boolean {
  return left.kind === right.kind && left.mainId === right.mainId
    && (left.kind === 'main' || right.kind === 'device' && left.deviceId === right.deviceId)
}
