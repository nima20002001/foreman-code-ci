import { isDeepStrictEqual } from 'node:util'
import type { HostHarnessOverride } from '@foreman-code/contracts/harness-registry'

/** Main resolves replacements through saved profile history and current qualification. */
export function sameWorkerProfileHost(saved: HostHarnessOverride['target'], resolved: HostHarnessOverride['target']) {
  return isDeepStrictEqual(saved.hostRef, resolved.hostRef)
    && saved.applicationInstallationId === resolved.applicationInstallationId
}
