import type { PayloadFingerprintCache } from './payloadFingerprintCache.js'
import { isAbsolute } from 'node:path'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { DeviceSessionBindingSchema, type DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { HarnessRegistryReadbackSchema, type HarnessRegistryReadback, type HostHarnessInstallationDto,
  type HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import { HarnessQualificationSchema, type HarnessQualification } from '@foreman-code/contracts/harness-qualification'
import { installedHarnessSelection, readInstalledWorkflowConfiguration, type InstalledWorkflowConfigurationLocation } from '../runs/remote/installedWorkflowConfiguration.js'
import { DomainError } from '../errors.js'
import { discoverLauncher, type TargetEnvironment } from './hostDiscovery.js'
import { harnessConnectionGeneration } from './hostConnectionGeneration.js'
import { passiveDriverPayloads } from './payloadDiscovery.js'
import { normalizeHarnessVersion, QUALIFICATION_TARGET_PROFILE } from './qualification/profiles.js'
import type { HarnessQualificationRepository } from './qualification/repository.js'

export interface CurrentInstalledHarnessTarget {
  readonly binding: DeviceSessionBinding
  readonly target: HostHarnessOverride['target']
  readonly installation: HostHarnessInstallationDto
  /** Hash of the exact configured launcher, matching the existing qualification repository. */
  readonly binarySha256: string
  /** Installer selection, never an observed CLI version or qualification claim. */
  readonly expectedVersion: string
}
export interface InstalledHarnessInspection {
  readonly inventory: HarnessRegistryReadback
  readonly currentTarget: CurrentInstalledHarnessTarget | null
}
const unavailable = (reason: string): never => { throw new DomainError('HARNESS_INVENTORY_STALE', 'Installed native harness evidence changed or is unavailable.', 409, { reason }) }

/** Worker-safe file inspection only: no DB, version/login command, model turn,
 * installation, qualification run, or authority inferred from a config flag. */
export async function inspectInstalledCodex(input: {
  binding: Readonly<DeviceSessionBinding>
  configuration: InstalledWorkflowConfigurationLocation | null
  environment: NodeJS.ProcessEnv
  cwd: string
  signal: AbortSignal
  fingerprintCache?: PayloadFingerprintCache
}): Promise<InstalledHarnessInspection> {
  input.signal.throwIfAborted()
  if (!isAbsolute(input.cwd)) unavailable('worker_environment_invalid')
  const binding = DeviceSessionBindingSchema.parse(input.binding)
  const hostRef = { kind: 'device' as const, mainId: binding.mainId, deviceId: binding.deviceId }
  const inventory: HarnessRegistryReadback = { instances: [], installations: [], hostMetadata: {
    hostRef, applicationInstallationId: binding.workerInstallationId, connection: null,
    platform: { platform: process.platform, architecture: process.arch }, workspaceRoots: null,
  } }
  const configuration = await readInstalledWorkflowConfiguration(input.configuration)
  input.signal.throwIfAborted()
  const selection = configuration && installedHarnessSelection(configuration)
  if (!selection) return { inventory: HarnessRegistryReadbackSchema.parse(inventory), currentTarget: null }
  const generation = () => commandInputHash({ path: input.environment.PATH ?? '', cwd: input.cwd, node: process.execPath,
    platform: process.platform, architecture: process.arch, nodeOptions: input.environment.NODE_OPTIONS ?? '' })
  const environment: TargetEnvironment = { path: input.environment.PATH ?? '', cwd: input.cwd, provenance: 'worker',
    generation: generation() }
  let launcher = await discoverLauncher(selection.binary, environment, [], input.signal, input.fingerprintCache)
  let complete = false
  if (launcher.status === 'installed' && launcher.resolvedLauncher) {
    // A standalone worker may not contain this application's bundled npm launcher.
    const payload = await passiveDriverPayloads('codex', launcher.resolvedLauncher,
      process.platform, process.arch, input.fingerprintCache).catch(() => ({ complete: false, paths: [] }))
    complete = payload.complete
    const paths = [...new Set([...selection.payloadPaths, ...payload.paths, ...(launcher.interpreter ? [launcher.interpreter] : [])])]
    launcher = await discoverLauncher(selection.binary, environment, paths, input.signal, input.fingerprintCache)
    const checked = await discoverLauncher(selection.binary, environment, paths, input.signal, input.fingerprintCache)
    if (launcher.status !== checked.status || launcher.resolvedLauncher !== checked.resolvedLauncher || launcher.fingerprint !== checked.fingerprint) unavailable('launcher_changed')
    if (!complete) launcher.diagnostics.push('The configured launcher payload is not passively trusted; qualification remains unavailable.')
  }
  const current = await readInstalledWorkflowConfiguration(input.configuration)
  input.signal.throwIfAborted()
  if (commandInputHash(current) !== commandInputHash(configuration) || commandInputHash(binding) !== commandInputHash(input.binding) || environment.generation !== generation()) unavailable('installed_context_changed')
  const installation: HostHarnessInstallationDto = {
    hostRef, harnessInstallationId: commandInputHash({ hostRef, driverId: 'codex', launcher: launcher.resolvedLauncher ?? selection.binary }),
    installationFingerprint: complete && launcher.status === 'installed' ? launcher.fingerprint : null,
    driverId: 'codex', driverRevision: '1', protocolRevision: 'codex-native-adapter-v1',
    environmentGeneration: environment.generation, connectionGeneration: harnessConnectionGeneration(binding),
    launcher, observedVersion: null, installed: launcher.status === 'installed', authenticated: null, compatible: null, qualified: false,
  }
  inventory.installations.push(installation)
  const binarySha256 = launcher.payloadFingerprints?.find(value => value.path === launcher.resolvedLauncher)?.fingerprint
  const currentTarget = installation.installationFingerprint && binarySha256 ? {
    binding, target: { hostRef, applicationInstallationId: binding.workerInstallationId,
      harnessInstallationId: installation.harnessInstallationId, installationFingerprint: installation.installationFingerprint },
    installation, binarySha256, expectedVersion: normalizeHarnessVersion(selection.expectedVersion),
  } : null
  return { inventory: HarnessRegistryReadbackSchema.parse(inventory), currentTarget }
}

/** Main-side read port over the existing persisted exact-binary qualification.
 * The authenticated execution authority owns calling this after its live tuple
 * checks. Worker file inventory and known baselines do not create a proof. */
export async function readInstalledCodexQualification(repository: Pick<HarnessQualificationRepository, 'findInstalled'>,
  current: Pick<CurrentInstalledHarnessTarget, 'target' | 'binarySha256' | 'installation'>,
  suiteRevision: string): Promise<HarnessQualification | null> {
  const harness = current.installation.driverId
  if (harness !== 'codex') return null
  const records = await repository.findInstalled(current.target, current.binarySha256, suiteRevision)
  if (records.length !== 1) return null
  const record = records[0]
  if (!record) return null
  const proof = HarnessQualificationSchema.parse(record)
  if (proof.harness !== harness || proof.binarySha256 !== current.binarySha256
    || proof.suiteRevision !== suiteRevision || proof.status !== 'qualified' || proof.profile !== QUALIFICATION_TARGET_PROFILE[harness]
    || !proof.checkedAt || !proof.checks.length || proof.checks.some(check => !check.passed)) return null
  return proof
}

/** Main retains the existing authenticated inventory projection. Only its real
 * persisted suite record may supply an observed version/qualification; worker
 * flags and installer expectedVersion never supply either fact. */
export async function retainInstalledHarnessInventory(input: {
  registry: Pick<import('./productionRegistry.js').ProductionHarnessRegistry, 'acceptRemoteSnapshot'>
  qualifications: Pick<HarnessQualificationRepository, 'findInstalled'>
  binding: DeviceSessionBinding
  inventory: unknown
  suiteRevision: string
}): Promise<void> {
  const inventory = HarnessRegistryReadbackSchema.parse(input.inventory)
  for (const installation of inventory.installations) {
    const harness = installation.driverId
    if (harness !== 'codex') continue
    installation.observedVersion = null; installation.qualified = false
    installation.authenticated = null; installation.compatible = null
    const sha256 = installation.launcher.payloadFingerprints?.find(value => value.path === installation.launcher.resolvedLauncher)?.fingerprint
    const suiteRevision = input.suiteRevision
    if (!sha256 || !installation.installationFingerprint || !suiteRevision) continue
    const target = { hostRef: installation.hostRef, applicationInstallationId: input.binding.workerInstallationId,
      harnessInstallationId: installation.harnessInstallationId, installationFingerprint: installation.installationFingerprint }
    const records = (await input.qualifications.findInstalled(target, sha256, suiteRevision))
      .map(record => HarnessQualificationSchema.parse(record))
    const matching = records.filter(proof => installation.installed && installation.installationFingerprint
      && installation.launcher.fingerprint === installation.installationFingerprint && proof.harness === harness
      && proof.binarySha256 === sha256 && proof.suiteRevision === suiteRevision && proof.status === 'qualified'
      && proof.profile === QUALIFICATION_TARGET_PROFILE[harness] && proof.checkedAt && proof.checks.length
      && proof.checks.every(check => check.passed))
    if (matching.length === 1) { installation.observedVersion = matching[0]!.version; installation.qualified = true }
  }
  input.registry.acceptRemoteSnapshot(input.binding, inventory)
}

export type CurrentInstalledCodexTarget = CurrentInstalledHarnessTarget
export type InstalledCodexInspection = InstalledHarnessInspection
