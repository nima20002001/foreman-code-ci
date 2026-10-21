import { join } from 'node:path'
import { lstat } from 'node:fs/promises'
import type { CiInstalledStorage } from '@foreman-code/contracts'
import { DEVICE_RESOURCE_CONTROL_RESERVE } from '@foreman-code/contracts/device-resources'
import { InstalledVerificationRuntimeConfigurationSchema, MAX_VERIFICATION_CONFIGURATION_BYTES }
  from './installedVerificationConfiguration.js'
import type { InstalledVerificationRuntimeConfiguration } from './installedVerificationConfiguration.js'
import { readProtectedRuntimeFile } from './installedRuntimeConfiguration.js'
import { readCiRuntimeInstallation } from './ciRuntimeInstallation.js'

export async function readCiInstalledStorage(stateDirectory: string): Promise<CiInstalledStorage | null> {
  const path = join(stateDirectory, 'job-runtime.json')
  try {
    await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const installation = await readCiRuntimeInstallation(stateDirectory)
      return installation ? ciRuntimeStorage(installation.runtime) : null
    }
    throw error
  }
  const bytes = await readProtectedRuntimeFile({ path, ownerUid: process.getuid!() },
    MAX_VERIFICATION_CONFIGURATION_BYTES)
  const parsed = InstalledVerificationRuntimeConfigurationSchema.safeParse(JSON.parse(bytes.toString('utf8')))
  if (!parsed.success) return null
  return ciRuntimeStorage(parsed.data)
}

function ciRuntimeStorage({ descriptor, machine }: InstalledVerificationRuntimeConfiguration): CiInstalledStorage | null {
  const slots = descriptor.quotaPool?.slots ?? []
  if (!slots.length || !machine.deviceLimits) return null
  const diskBytes = Math.min(descriptor.volumeCapacityBytes,
    machine.deviceLimits.diskBytes - DEVICE_RESOURCE_CONTROL_RESERVE.diskBytes,
    Math.max(...slots.map(slot => slot.hardLimitBytes)))
  const mutableInodes = Math.max(...slots.filter(slot => slot.hardLimitBytes >= diskBytes).map(slot => slot.hardInodes))
  return diskBytes > 0 && mutableInodes > 0 ? { diskBytes, mutableInodes } : null
}
