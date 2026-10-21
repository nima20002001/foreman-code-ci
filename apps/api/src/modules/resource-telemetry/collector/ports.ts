import { statfs } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { ResourceCollector, TelemetryIdentity } from '@foreman-code/contracts/resource-telemetry'
import { boundedReader } from './io.js'
import { qualifyHostConstants, type HostConstants } from './linuxProcfs.js'
import { createResourceCollector, type CollectorClock } from './lifecycle.js'
import type { OwnershipReader } from './ownership.js'
import { passiveRegistryOwnershipReader, type PassiveNativeRegistry, type TrustedNativeScopes } from './registryAdapter.js'

/** Mount the existing passive registry and exact owner projection on either host. */
export function createPassiveLinuxResourceCollector(input: Omit<Parameters<typeof createLinuxResourceCollector>[0], 'ownership'> & {
  registry: PassiveNativeRegistry
  nativeScopes(identity: TelemetryIdentity): TrustedNativeScopes
}): Promise<ResourceCollector> {
  return createLinuxResourceCollector({ ...input,
    ownership: passiveRegistryOwnershipReader(input.registry, input.nativeScopes(structuredClone(input.identity))) })
}

/** Worker/main composition seam; no DB, bootstrap, provider acquisition or runtime-owner acquisition. */
export async function createLinuxResourceCollector(input: {
  identity: TelemetryIdentity
  ownership: OwnershipReader
  wholeHostVisible: boolean
  signal: AbortSignal
  constants?: HostConstants
  clock?: CollectorClock
}): Promise<ResourceCollector> {
  if (process.platform !== 'linux') throw new Error('Linux resource accounting is unavailable.')
  const hostConstants = input.constants ?? await qualifyHostConstants(input.signal)
  input.signal.throwIfAborted()
  if (hostConstants.clockTicksPerSecond <= 0n || hostConstants.pageSize <= 0n) throw new Error('invalid-counter')
  const io = boundedReader(8)
  return createResourceCollector({ identity: input.identity,
    ...(input.clock ? { clock: input.clock } : {}),
    ports: { ...io, ownership: input.ownership, wholeHostVisible: input.wholeHostVisible, constants: hostConstants, storage: readHomeStorage,
      now: input.clock?.now ?? (() => process.hrtime.bigint()) } })
}

async function readHomeStorage(signal: AbortSignal) {
  const stats = await statfs(homedir())
  signal.throwIfAborted()
  return { totalBytes: stats.blocks * stats.bsize, availableBytes: stats.bavail * stats.bsize }
}
