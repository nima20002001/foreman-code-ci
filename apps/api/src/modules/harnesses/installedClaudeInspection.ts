import { errorMessage } from '../../shared/errorMessage.js'
import { componentLogger } from '../diagnostics/logger.js'
import type { PayloadFingerprintCache } from './payloadFingerprintCache.js'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { DeviceSessionBindingSchema, type DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { HarnessRegistryReadbackSchema, type HostHarnessInstallationDto,
  type HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import { DomainError } from '../errors.js'
import { readInstalledWorkflowConfiguration,
  type InstalledWorkflowConfigurationLocation } from '../runs/remote/installedWorkflowConfiguration.js'
import { discoverInstalledClaudeSdk, installedClaudeSdkEntrypoint } from './claudeSdk/currentPin.js'
import { harnessConnectionGeneration } from './hostConnectionGeneration.js'
import type { TargetEnvironment, LauncherEvidence } from './hostDiscovery.js'

export interface InstalledClaudeTarget {
  binding: DeviceSessionBinding
  target: HostHarnessOverride['target']
  installation: HostHarnessInstallationDto & { launcher: LauncherEvidence }
  sdk: ReturnType<typeof installedClaudeSdkEntrypoint>
}

/** File inspection publishes SDK identity; it does not execute the CLI or qualify a profile. */
interface InstalledClaudeInspectionInput {
  binding: Readonly<DeviceSessionBinding>
  configuration: InstalledWorkflowConfigurationLocation | null
  environment: NodeJS.ProcessEnv
  cwd: string
  signal: AbortSignal
  fingerprintCache?: PayloadFingerprintCache
}

/** Execution and qualification require a readable selected installation. */
export function inspectInstalledClaude(input: InstalledClaudeInspectionInput) {
  return inspectClaudeInstallation(input, { failure: 'throw' })
}

/** Inventory reports an unavailable selection without hiding other installed harnesses. */
export function inspectInstalledClaudeInventory(input: InstalledClaudeInspectionInput) {
  return inspectClaudeInstallation(input, { failure: 'report' })
}

async function inspectClaudeInstallation(input: InstalledClaudeInspectionInput, options: { failure: 'throw' | 'report' }) {
  input.signal.throwIfAborted()
  if (!isAbsolute(input.cwd)) throw new DomainError('HARNESS_INVENTORY_STALE', 'Worker directory is invalid.', 409)
  const binding = DeviceSessionBindingSchema.parse(input.binding)
  const hostRef = { kind: 'device' as const, mainId: binding.mainId, deviceId: binding.deviceId }
  const inventory = HarnessRegistryReadbackSchema.parse({ instances: [], installations: [], hostMetadata: {
    hostRef, applicationInstallationId: binding.workerInstallationId, connection: null,
    platform: { platform: process.platform, architecture: process.arch }, workspaceRoots: null,
  } })
  const configuration = await readInstalledWorkflowConfiguration(input.configuration)
  if (!configuration?.claude) return { inventory, currentTarget: null }
  const selected = configuration.claude
  const generation = () => commandInputHash({ path: input.environment.PATH ?? '', cwd: input.cwd, node: process.execPath,
    platform: process.platform, architecture: process.arch, nodeOptions: input.environment.NODE_OPTIONS ?? '' })
  const environment: TargetEnvironment = { path: input.environment.PATH ?? '', cwd: input.cwd,
    provenance: 'worker', generation: generation() }
  const harnessInstallationId = commandInputHash({ hostRef, driverId: 'claude', launcher: selected.binary })
  const context = { harnessInstallationId, environment }
  const inspected = await (async () => {
    try {
      const sdk = installedClaudeSdkEntrypoint(selected.installedLockPath, selected.binary,
        selected.sdkEntrypoint)
      const before = await discoverInstalledClaudeSdk(sdk, context, input.signal, input.fingerprintCache)
      const after = await discoverInstalledClaudeSdk(sdk, context, input.signal, input.fingerprintCache)
      return { status: 'available' as const, sdk, before, after }
    } catch (error) {
      input.signal.throwIfAborted()
      if (options.failure === 'throw') throw error
      return { status: 'unavailable' as const, error }
    }
  })()
  const current = await readInstalledWorkflowConfiguration(input.configuration)
  input.signal.throwIfAborted()
  if (!isDeepStrictEqual(configuration, current)
    || !isDeepStrictEqual(binding, input.binding) || environment.generation !== generation()) {
    throw new DomainError('HARNESS_INVENTORY_STALE', 'The installed Claude SDK changed during inspection.', 409)
  }
  if (inspected.status === 'unavailable') {
    componentLogger('harness').warn({ err: inspected.error }, 'Installed Claude SDK inspection failed')
    inventory.installations.push({ hostRef, harnessInstallationId, installationFingerprint: null,
      driverId: 'claude', driverRevision: '1', protocolRevision: 'claude-sdk-unavailable',
      environmentGeneration: environment.generation, connectionGeneration: harnessConnectionGeneration(binding),
      launcher: { requested: selected.binary, resolvedLauncher: null, fingerprint: null,
        status: 'unreadable', interpreter: null,
        diagnostics: [errorMessage(inspected.error, 'The selected Claude SDK is unavailable.')],
        environment, checkedAt: new Date().toISOString() },
      observedVersion: null, installed: false, authenticated: null, compatible: null, qualified: false })
    return { inventory: HarnessRegistryReadbackSchema.parse(inventory), currentTarget: null }
  }
  const { sdk, before, after } = inspected
  if (before.launcher.fingerprint !== after.launcher.fingerprint || before.sdkVersion !== after.sdkVersion
    || before.sdkIntegrity !== after.sdkIntegrity) {
    throw new DomainError('HARNESS_INVENTORY_STALE', 'The installed Claude SDK changed during inspection.', 409)
  }
  const installation: InstalledClaudeTarget['installation'] = {
    hostRef, harnessInstallationId, installationFingerprint: after.launcher.fingerprint,
    driverId: 'claude', driverRevision: '1', protocolRevision: after.declaration.protocolRevision,
    environmentGeneration: environment.generation, connectionGeneration: harnessConnectionGeneration(binding),
    launcher: after.launcher, claudeSdk: { version: after.sdkVersion, integrity: after.sdkIntegrity },
    observedVersion: null, installed: true, authenticated: null, compatible: null, qualified: false,
  }
  inventory.installations.push(installation)
  const currentTarget: InstalledClaudeTarget = { binding, installation, sdk, target: {
    hostRef, applicationInstallationId: binding.workerInstallationId,
    harnessInstallationId, installationFingerprint: installation.installationFingerprint!,
  } }
  return { inventory: HarnessRegistryReadbackSchema.parse(inventory), currentTarget }
}
