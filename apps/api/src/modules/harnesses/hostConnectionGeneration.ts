import { createHash } from 'node:crypto'
import type { DeviceConnectionIdentity } from '@foreman-code/contracts/device-identity'

type HarnessBinding = Readonly<DeviceConnectionIdentity & { connectionEpoch: string }>

function generation(binding: HarnessBinding, scope: 'boot' | 'session'): string {
  const components: (string | number)[] = [
    binding.mainId, binding.deviceId, binding.workerInstallationId, binding.keyRevision, binding.authorizationRevision,
    binding.bootId,
  ]
  if (scope === 'session') components.push(binding.connectionEpoch, binding.connectionGeneration)
  return `sha256:${createHash('sha256').update(JSON.stringify(components)).digest('hex')}`
}

/** Harness facts survive transport reconnects within the same authenticated Worker boot. */
export function harnessConnectionGeneration(binding: HarnessBinding): string {
  return generation(binding, 'boot')
}

/** Previous protocol-1 Workers scope their reported facts to the transport session. */
export function harnessSessionConnectionGeneration(binding: HarnessBinding): string {
  return generation(binding, 'session')
}

export function matchesHarnessConnectionGeneration(binding: HarnessBinding, reported: string): boolean {
  return reported === harnessConnectionGeneration(binding) || reported === harnessSessionConnectionGeneration(binding)
}
