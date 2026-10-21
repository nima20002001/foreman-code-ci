import { sameComputer } from '../../shared/api/sameComputer'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import type { HarnessHostInventoryMetadata } from '@foreman-code/contracts/harness-registry'

/** Server observation only. A binding that is not this exact host/installation is treated as unavailable, never repaired. */
export function presentationFor(host: CanonicalMachineReference, applicationInstallationId: string, metadata: HarnessHostInventoryMetadata | undefined) {
  if (!metadata || !sameComputer(metadata.hostRef, host) || metadata.applicationInstallationId !== applicationInstallationId) return { kind: 'unavailable' as const }
  if (host.kind === 'main') return metadata.connection === null ? { kind: 'main' as const } : { kind: 'unavailable' as const }
  const connection = metadata.connection
  if (!connection) return { kind: 'unknown' as const }
  const binding = connection.binding
  if (binding.mainId !== host.mainId || binding.deviceId !== host.deviceId || binding.workerInstallationId !== applicationInstallationId) return { kind: 'unavailable' as const }
  return { kind: 'observed' as const, connection }
}
export function connectionSummary(host: CanonicalMachineReference, applicationInstallationId: string, metadata: HarnessHostInventoryMetadata | undefined) {
  const value = presentationFor(host, applicationInstallationId, metadata)
  if (value.kind === 'observed') return `${value.connection.phase === 'ready' ? 'Worker connected' : 'Worker offline'} · last seen ${value.connection.lastSeenAt}`
  if (value.kind === 'main') return 'Selected main · no worker connection'
  return value.kind === 'unknown' ? 'Worker connection not observed' : 'Worker connection unavailable'
}
