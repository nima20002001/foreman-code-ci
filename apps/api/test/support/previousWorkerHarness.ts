import { createHash } from 'node:crypto'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { HarnessRegistryReadback } from '@foreman-code/contracts/harness-registry'

// Protocol 1 Workers before boot-scoped qualification report this session-scoped hash.
export function previousWorkerHarnessGeneration(binding: Readonly<DeviceSessionBinding>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify([
    binding.mainId, binding.deviceId, binding.workerInstallationId, binding.keyRevision, binding.authorizationRevision,
    binding.bootId, binding.connectionEpoch, binding.connectionGeneration,
  ])).digest('hex')}`
}

export function previousWorkerInventory(binding: Readonly<DeviceSessionBinding>): HarnessRegistryReadback {
  const hostRef = { kind: 'device' as const, mainId: binding.mainId, deviceId: binding.deviceId }
  return { instances: [], hostMetadata: { hostRef, applicationInstallationId: binding.workerInstallationId,
    connection: null, platform: { platform: 'linux', architecture: 'x64' }, workspaceRoots: null },
  installations: [{ hostRef, harnessInstallationId: 'worker-codex', installationFingerprint: 'worker-payload',
    driverId: 'codex', driverRevision: '1', protocolRevision: 'codex-native-adapter-v1',
    environmentGeneration: 'worker-environment', connectionGeneration: previousWorkerHarnessGeneration(binding),
    observedVersion: null, installed: true, authenticated: null, compatible: null, qualified: null,
    launcher: { requested: '/worker/bin/codex', resolvedLauncher: '/worker/bin/codex', fingerprint: 'worker-payload',
      status: 'installed', interpreter: null, diagnostics: [], checkedAt: new Date().toISOString(),
      environment: { generation: 'worker-environment', provenance: 'worker', cwd: '/worker', path: '/usr/bin' } },
  }] }
}
