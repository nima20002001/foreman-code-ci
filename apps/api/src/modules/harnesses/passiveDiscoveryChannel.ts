import { HARNESS_DISCOVERY_NAMESPACE, HarnessDiscoveryRequestSchema, HarnessRegistryReadbackSchema, type HarnessRegistryReadback } from '@foreman-code/contracts/harness-registry'
import type { DeviceConnectionIdentity, CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import { harnessConnectionGeneration } from './hostConnectionGeneration.js'
import { discoverInventoryLauncher, type TargetEnvironment } from './hostDiscovery.js'

export interface PassiveDriverInstallationDeclaration {
  readonly driverId: string
  readonly driverRevision: string
  readonly protocolRevision: string
  readonly harnessInstallationId: string
  readonly requestedLauncher: string
  readonly payloadPaths?: readonly string[]
}
interface PassiveDiscoveryContext { binding: DeviceConnectionIdentity & { connectionEpoch: string }; signal: AbortSignal }

/** Register only this actual worker handler; no caller-supplied paths or commands are accepted. */
export function createPassiveHarnessDiscoveryExtension(options: {
  hostRef: Extract<CanonicalMachineReference, { kind: 'device' }>
  applicationInstallationId: string
  environment: TargetEnvironment
  platform: { platform: string; architecture: string }
  installations: readonly PassiveDriverInstallationDeclaration[]
}) {
  const target = structuredClone(options)
  return {
    namespace: HARNESS_DISCOVERY_NAMESPACE, version: 1, role: 'server' as const, maxJsonBytes: 1_048_576, maxBinaryBytes: 0,
    async handle(payload: unknown, { binding, signal }: PassiveDiscoveryContext): Promise<{ payload: HarnessRegistryReadback }> {
      HarnessDiscoveryRequestSchema.parse(payload)
      signal.throwIfAborted()
      if (binding.mainId !== target.hostRef.mainId || binding.deviceId !== target.hostRef.deviceId
        || binding.workerInstallationId !== target.applicationInstallationId) throw new Error('Passive discovery host binding mismatch.')
      const installations = []
      for (const declaration of target.installations) {
        const launcher = await discoverInventoryLauncher(declaration.requestedLauncher, target.environment,
          declaration.payloadPaths ?? [], signal)
        installations.push({ hostRef: target.hostRef, harnessInstallationId: declaration.harnessInstallationId,
          installationFingerprint: launcher.fingerprint, driverId: declaration.driverId, driverRevision: declaration.driverRevision,
          protocolRevision: declaration.protocolRevision, environmentGeneration: target.environment.generation,
          connectionGeneration: harnessConnectionGeneration(binding), launcher, observedVersion: null,
          installed: launcher.status === 'installed', authenticated: null, compatible: null, qualified: null })
      }
      signal.throwIfAborted()
      return { payload: HarnessRegistryReadbackSchema.parse({ instances: [], installations,
        hostMetadata: { hostRef: target.hostRef, applicationInstallationId: target.applicationInstallationId,
          connection: null, platform: target.platform, workspaceRoots: null } }) }
    },
  }
}
