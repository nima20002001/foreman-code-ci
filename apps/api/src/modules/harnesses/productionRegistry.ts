import type { discoverInstalledClaudeSdk } from './claudeSdk/currentPin.js'
import { ev } from '../../diagTemp.js'
import { withTransaction } from '../../infrastructure/transaction.js'
import { harnessConnectionGeneration, harnessSessionConnectionGeneration, matchesHarnessConnectionGeneration } from './hostConnectionGeneration.js'
import type pg from 'pg'
import { HarnessConfigurationSchema, RETIRED_OPENCODE_MESSAGE, withAdvancedDefaults, type HarnessDefaults } from '@foreman-code/contracts'
import { HarnessHostReferenceSchema, HarnessRegistryReadbackSchema, type HarnessRegistryReadback,
  type HostHarnessOverride, type HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { DevicePresence, DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { commandInputHash } from '../commands/postgres.js'
import { authorizeDeviceHost, assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { DomainError } from '../errors.js'
import { CLAUDE_PROFILE_CHECK_REVISION } from './claudeSdk/profileRevision.js'
import { discoverInventoryLauncher, type discoverLauncher, type TargetEnvironment } from './hostDiscovery.js'
import { inventoryDriverPayloads, type passiveDriverPayloads } from './payloadDiscovery.js'
import { HarnessInstanceRegistry, localHarnessDrivers, localDefaultInstances, type ConfiguredHarnessInstance } from './instanceRegistry.js'
import { HarnessInstallationRegistry, type HarnessInstallationRecord, type RegistryHarnessSelection } from './installationRegistry.js'
import { projectHarnessRegistry, projectHarnessInstance } from './registryProjection.js'
import { harnessHostKey } from './instanceSettings/repository.js'
import type { HostHarnessProfileEvidenceRepository } from './instanceSettings/profileRepository.js'

/** Runtime inventory is a projection, not another host, process or authority
 * registry. Collectors run on lifecycle/explicit refresh; settings GET never probes. */
export class ProductionHarnessRegistry {
  readonly instances = new HarnessInstanceRegistry(localHarnessDrivers)
  readonly installations = new HarnessInstallationRegistry(this.instances)
  private mainId: string | undefined
  private get mainGeneration(): string {
    // Local inventory has no transport connection to replace on an API restart.
    return commandInputHash({ host: this.host(), environmentGeneration: this.targetEnvironment().generation })
  }
  private readonly snapshots = new Map<string, {
    value: HarnessRegistryReadback
    connectionGeneration: string
    connectionScope: 'boot' | 'session'
    environmentGeneration: string | null
  }>()
  private readonly accepted = new Map<string, ConfiguredHarnessInstance>()
  private defaults: ConfiguredHarnessInstance[] = []
  private stopped = false
  private refreshGeneration = 0
  private refreshTask: Promise<void> | undefined
  private inventoryIdentity = ''
  private inventoryListener: ((host: CanonicalMachineReference, applicationInstallationId: string) => void) | undefined
  observeInstallations(listener: ((host: CanonicalMachineReference,
    applicationInstallationId: string) => void) | undefined): void { this.inventoryListener = listener }
  currentInstallation(value: HostHarnessOverride): HarnessInstallationRecord | undefined {
    return this.installations.list().find(record => harnessHostKey(record.hostRef) === harnessHostKey(value.target.hostRef)
      && record.driverId === value.driverId)
  }
  constructor(private readonly pool: pg.Pool, private readonly binaries: { codexBinary: string },
    private readonly managedDefaults: (client?: pg.ClientBase) => Promise<{ revision: number; defaults: HarnessDefaults; retiredDefaults?: ConfiguredHarnessInstance[] }>,
    private readonly profiles: HostHarnessProfileEvidenceRepository,
    private readonly currentRemoteBinding: (deviceId: string) => DeviceSessionBinding | null,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly discovery: { launcher: typeof discoverLauncher; payloads: typeof passiveDriverPayloads;
      claude?: (host: Extract<CanonicalMachineReference, { kind: 'main' }>, environment: TargetEnvironment, signal?: AbortSignal) => Promise<Awaited<ReturnType<typeof discoverInstalledClaudeSdk>> | null> }
      = { launcher: discoverInventoryLauncher, payloads: inventoryDriverPayloads },
    private readonly collectingBinding: (deviceId: string) => DeviceSessionBinding | null = currentRemoteBinding,
    private readonly connection: (deviceId: string) => DevicePresence | null = () => null) {}

  async initialize(mainId: string): Promise<void> {
    this.mainId = mainId
    const managed = await this.managedDefaults()
    this.assertOpen()
    this.defaults = [...localDefaultInstances(managed.defaults, managed.revision), ...(managed.retiredDefaults ?? [])]
    this.reloadInstances()
    await this.refreshMain()
  }
  get initialized(): boolean { return Boolean(this.mainId && this.snapshots.size) }
  // Stopping admission does not change any installation. Bindings already pinned by in-flight
  // launches stay current, so an application restart detaches them instead of failing them as stale.
  stop(): void { this.stopped = true; this.refreshGeneration++ }
  private assertOpen(): void {
    if (this.stopped) throw new DomainError('HARNESS_REGISTRY_CLOSING', 'Harness inventory is shutting down.', 503)
  }
  private host(): Extract<CanonicalMachineReference, { kind: 'main' }> {
    if (!this.mainId) throw new DomainError('HARNESS_REGISTRY_UNAVAILABLE', 'The canonical main inventory has not initialized.', 503)
    return { kind: 'main', mainId: this.mainId }
  }
  private targetEnvironment(): TargetEnvironment {
    const path = this.environment.PATH ?? ''
    const cwd = process.cwd()
    const provenance = this.environment.INVOCATION_ID ? 'systemd' : this.environment.SSH_CONNECTION ? 'ssh'
      : this.environment.DISPLAY || this.environment.WAYLAND_DISPLAY ? 'gui' : 'terminal'
    // A deploy installs each release in its own folder; the folder name alone must not invalidate qualified profiles,
    // or every running Agent would be interrupted by an update. The Node version still distinguishes runtimes.
    const stable = (value: string) => value.replace(/\/releases\/release-[A-Za-z0-9_-]+/gu, '/releases/current')
    return { generation: commandInputHash({ path: stable(path), cwd: stable(cwd), node: process.version, platform: process.platform,
      architecture: process.arch, nodeOptions: this.environment.NODE_OPTIONS ?? '' }), path, cwd, provenance }
  }
  refreshMain(signal?: AbortSignal): Promise<void> {
    this.assertOpen(); signal?.throwIfAborted()
    if (this.refreshTask) return this.refreshTask.then(() => { signal?.throwIfAborted() })
    const task = this.collectMain(signal)
    this.refreshTask = task
    void task.then(() => { if (this.refreshTask === task) this.refreshTask = undefined },
      () => { if (this.refreshTask === task) this.refreshTask = undefined })
    return task
  }
  private async collectMain(signal?: AbortSignal): Promise<void> {
    ev('collectMain begin')
    try { await this.collectMain2(signal) } finally { ev('collectMain end') }
  }
  private async collectMain2(signal?: AbortSignal): Promise<void> {
    this.assertOpen(); signal?.throwIfAborted()
    const generation = ++this.refreshGeneration
    const managed = await this.managedDefaults()
    const defaults = [...localDefaultInstances(managed.defaults, managed.revision), ...(managed.retiredDefaults ?? [])]
    if (commandInputHash(defaults) !== commandInputHash(this.defaults)) { this.defaults = defaults; this.reloadInstances() }
    this.assertOpen(); signal?.throwIfAborted()
    const hostRef = this.host()
    const environment = this.targetEnvironment()
    const records: HarnessInstallationRecord[] = []
    for (const driver of localHarnessDrivers) {
      if (driver.driverId === 'claude') {
        const discovered = await this.discovery.claude?.(hostRef, environment, signal)
        this.assertOpen(); signal?.throwIfAborted()
        const launcher = discovered?.launcher ?? { requested: 'installed Claude SDK native executable', resolvedLauncher: null,
          fingerprint: null, status: 'missing' as const, interpreter: null, diagnostics: ['The actual installed Claude SDK native declaration is unavailable.'],
          environment, checkedAt: new Date().toISOString() }
        records.push({ hostRef, harnessInstallationId: discovered?.declaration.harnessInstallationId
          ?? commandInputHash({ hostRef, driverId: driver.driverId, unavailable: 'sdk-native-declaration' }),
          installationFingerprint: discovered ? launcher.fingerprint : null, driverId: driver.driverId, driverRevision: driver.driverRevision,
          protocolRevision: discovered?.declaration.protocolRevision ?? 'claude-sdk-unavailable', environmentGeneration: environment.generation,
          connectionGeneration: this.mainGeneration, launcher, observedVersion: null,
          installed: Boolean(discovered), authenticated: null, compatible: null, qualified: null })
        continue
      }
      const requested = this.binaries.codexBinary
      let launcher = await this.discovery.launcher(requested, environment, [], signal)
      let complete = false
      if (launcher.resolvedLauncher && launcher.status === 'installed') {
        const payload = await this.discovery.payloads(driver.driverId, launcher.resolvedLauncher)
        complete = payload.complete
        launcher = await this.discovery.launcher(requested, environment,
          [...payload.paths, ...(launcher.interpreter ? [launcher.interpreter] : [])], signal)
        if (!complete) launcher.diagnostics.push('The launcher payload cannot be resolved passively; exact-installation qualification is unavailable.')
      }
      records.push({ hostRef, harnessInstallationId: commandInputHash({ hostRef, driverId: driver.driverId,
        launcher: launcher.resolvedLauncher ?? requested }), installationFingerprint: complete ? launcher.fingerprint : null,
        driverId: driver.driverId, driverRevision: driver.driverRevision,
        protocolRevision: `${driver.driverId}-native-adapter-v1`, environmentGeneration: environment.generation,
        connectionGeneration: this.mainGeneration, launcher, observedVersion: null,
        installed: launcher.status === 'installed', authenticated: null, compatible: null, qualified: null })
    }
    this.assertOpen(); signal?.throwIfAborted()
    if (generation !== this.refreshGeneration || this.targetEnvironment().generation !== environment.generation) {
      throw new DomainError('HARNESS_INVENTORY_STALE', 'The host environment changed while discovering installations.', 409)
    }
    const view = projectHarnessRegistry(this.instances.list(), records)
    view.hostMetadata = { hostRef, applicationInstallationId: hostRef.mainId,
      platform: { platform: process.platform, architecture: process.arch }, workspaceRoots: null, connection: null }
    this.snapshots.set(harnessHostKey(hostRef), { value: HarnessRegistryReadbackSchema.parse(view),
      connectionGeneration: this.mainGeneration, connectionScope: 'boot', environmentGeneration: environment.generation })
    this.reloadInstallations()
    this.inventoryListener?.(hostRef, hostRef.mainId)
  }
  private reloadInstances(): void { this.instances.reload([...this.defaults, ...this.accepted.values()]) }
  private reloadInstallations(): void {
    const records = [...this.snapshots.values()].flatMap((snapshot) => snapshot.value.installations.map((installation) => ({ ...installation,
      launcher: { ...installation.launcher, payloadFingerprints: installation.launcher.payloadFingerprints ?? [] } })))
    const identity = commandInputHash(records.map((record) => ({ ...record,
      launcher: { ...record.launcher, checkedAt: undefined, diagnostics: undefined } })))
    if (identity === this.inventoryIdentity) return
    this.installations.refresh(records)
    this.inventoryIdentity = identity
  }
  // Session pins read the last collected inventory and stay available while the application shuts down:
  // in-flight launches revalidate their original selection until the engine detaches them for restart.
  pinAccepted(configuration: { id: string; agentId: string; harness: unknown }): RegistryHarnessSelection {
    const value = HarnessConfigurationSchema.parse(configuration.harness)
    if (value.harness === 'opencode') throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
    const instance: ConfiguredHarnessInstance = { instanceId: configuration.id, instanceRevision: configuration.id,
      driverId: value.harness, enabled: true, configuration: value }
    const prior = this.accepted.get(instance.instanceId)
    if (prior && commandInputHash(prior) !== commandInputHash(instance)) throw new DomainError(
      'HARNESS_CONFIGURATION_MISMATCH', 'The accepted configuration version is immutable.', 409)
    if (!prior) { this.accepted.set(instance.instanceId, instance); this.reloadInstances() }
    const hostRef = this.host()
    const installation = this.snapshots.get(harnessHostKey(hostRef))?.value.installations.find((record) => record.driverId === value.harness)
    if (!installation) throw new DomainError('HARNESS_INSTALLATION_UNAVAILABLE', 'The accepted driver has no local installation inventory.', 409)
    return this.installations.pin({ instanceId: instance.instanceId, hostRef, harnessInstallationId: installation.harnessInstallationId,
      connectionGeneration: this.mainGeneration, environmentGeneration: this.targetEnvironment().generation })
  }
  pinDefault(harness: 'codex'): RegistryHarnessSelection {
    this.assertOpen()
    const hostRef = this.host()
    const installation = this.snapshots.get(harnessHostKey(hostRef))?.value.installations.find((record) => record.driverId === harness)
    if (!installation) throw new DomainError('HARNESS_INSTALLATION_UNAVAILABLE', 'Default qualification requires current host inventory.', 409)
    return this.installations.pin({ instanceId: `local-default:${harness}`, hostRef,
      harnessInstallationId: installation.harnessInstallationId, connectionGeneration: this.mainGeneration,
      environmentGeneration: this.targetEnvironment().generation })
  }
  pinOverride(value: HostHarnessOverride): RegistryHarnessSelection {
    if (value.driverId === 'opencode' || value.configuration.harness === 'opencode') throw new DomainError(
      'HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
    const instance: ConfiguredHarnessInstance = { instanceId: value.instanceId, instanceRevision: value.instanceRevision,
      driverId: value.driverId, enabled: value.enabled, configuration: value.configuration }
    const hostRef = value.target.hostRef
    const cached = this.snapshots.get(harnessHostKey(hostRef))
    if (!cached) {
      throw new DomainError('HARNESS_INVENTORY_UNAVAILABLE', 'The selected host installation inventory is unavailable.', 503)
    }
    const generation = hostRef.kind === 'main' ? this.mainGeneration : this.remoteGeneration(hostRef.deviceId)
    if (cached.connectionGeneration !== generation
      || hostRef.kind === 'main' && cached.environmentGeneration !== this.targetEnvironment().generation) {
      throw new DomainError('HARNESS_INVENTORY_STALE', 'The selected host inventory needs to be refreshed.', 409)
    }
    const snapshot = cached.value
    const installation = snapshot.installations.find((record) => record.harnessInstallationId === value.target.harnessInstallationId)
    if (!installation) {
      throw new DomainError('HARNESS_INSTALLATION_CHANGED', 'The selected harness installation is no longer present.', 409)
    }
    if (!installation.installed || !installation.installationFingerprint) {
      throw new DomainError('HARNESS_INSTALLATION_INVALID', 'The selected host has no usable harness installation.', 409)
    }
    if (snapshot.hostMetadata?.applicationInstallationId !== value.target.applicationInstallationId
      || installation.installationFingerprint !== value.target.installationFingerprint) {
      throw new DomainError('HARNESS_INSTALLATION_CHANGED', 'The selected installation changed.', 409)
    }
    this.accepted.set(instance.instanceId, instance); this.reloadInstances()
    return this.installations.pin({ instanceId: value.instanceId, hostRef: value.target.hostRef,
      harnessInstallationId: value.target.harnessInstallationId, connectionGeneration: generation,
      environmentGeneration: value.target.hostRef.kind === 'main' ? this.targetEnvironment().generation : installation.environmentGeneration })
  }
  acceptRemoteSnapshot(binding: DeviceSessionBinding, input: unknown): void {
    this.assertOpen()
    const current = this.collectingBinding(binding.deviceId)
    if (!current || commandInputHash(current) !== commandInputHash(binding)) throw new DomainError(
      'HARNESS_INVENTORY_STALE', 'Worker inventory belongs to an unavailable connection generation.', 409)
    const view = HarnessRegistryReadbackSchema.parse(input)
    const hostRef = { kind: 'device' as const, mainId: binding.mainId, deviceId: binding.deviceId }
    // The reported hash identifies the peer's scope; empty inventory advertises no boot-scoped facts.
    const generation = view.installations[0]?.connectionGeneration ?? harnessSessionConnectionGeneration(binding)
    if (view.hostMetadata?.applicationInstallationId !== binding.workerInstallationId
      || harnessHostKey(view.hostMetadata.hostRef) !== harnessHostKey(hostRef)
      || !matchesHarnessConnectionGeneration(binding, generation)
      || view.installations.some((record) => harnessHostKey(record.hostRef) !== harnessHostKey(hostRef)
        || record.connectionGeneration !== generation)) {
      throw new DomainError('HARNESS_INVENTORY_STALE', 'Worker inventory does not match its canonical authenticated host.', 409)
    }
    this.snapshots.set(harnessHostKey(hostRef), { value: structuredClone(view),
      connectionGeneration: generation,
      connectionScope: generation === harnessConnectionGeneration(binding) ? 'boot' : 'session', environmentGeneration: null })
    this.reloadInstallations()
    this.inventoryListener?.(hostRef, binding.workerInstallationId)
  }
  async get(principal: ManagementPrincipal, raw: CanonicalMachineReference): Promise<HarnessRegistryReadback> {
    this.assertOpen()
    const hostRef = HarnessHostReferenceSchema.parse(raw)
    return withTransaction(this.pool, async (client) => {
      const applicationInstallationId = await this.applicationInstallationId(client, hostRef)
      await authorizeDeviceHost(client, principal, 'harnesses:read', hostRef, applicationInstallationId)
      const managed = await this.managedDefaults(client)
      const defaults = [...localDefaultInstances(managed.defaults, managed.revision), ...(managed.retiredDefaults ?? [])]
      if (commandInputHash(defaults) !== commandInputHash(this.defaults)) { this.defaults = defaults; this.reloadInstances() }
      const cached = this.snapshots.get(harnessHostKey(hostRef))?.value
      const snapshot = cached?.hostMetadata?.applicationInstallationId === applicationInstallationId ? cached : undefined
      const registration = await assertDeviceHostInstallation(client, hostRef, applicationInstallationId)
      const observed = hostRef.kind === 'device' ? this.connection(hostRef.deviceId) : null
      const connection = observed && registration && observed.binding.workerInstallationId === registration.workerInstallationId
        && observed.binding.keyRevision === registration.keyRevision
        && observed.binding.authorizationRevision === registration.authorizationRevision ? observed : null
      const defaultIds = new Set(this.defaults.map(value => value.instanceId))
      const instances = this.instances.list().filter(value => defaultIds.has(value.instanceId)).map(projectHarnessInstance)
      const result = snapshot ? { ...structuredClone(snapshot),
        ...(snapshot.hostMetadata ? { hostMetadata: { ...snapshot.hostMetadata, connection } } : {}), instances } : { instances,
        installations: [], hostMetadata: { hostRef, applicationInstallationId, platform: null, workspaceRoots: null, connection } }
      return HarnessRegistryReadbackSchema.parse(result)
    })
  }
  private async applicationInstallationId(client: pg.PoolClient, host: CanonicalMachineReference): Promise<string> {
    if (host.kind === 'main') return host.mainId
    const result = await client.query<{ id: string }>("select worker_installation_id::text as id from device_registrations where id=$1 and main_id=$2", [host.deviceId, host.mainId])
    if (!result.rows[0]) throw new DomainError('DEVICE_HOST_UNAVAILABLE', 'The selected registered device is unavailable.', 403)
    return result.rows[0].id
  }
  private remoteGeneration(deviceId: string): string {
    const binding = this.currentRemoteBinding(deviceId)
    if (!binding) return ''
    const snapshot = this.snapshots.get(harnessHostKey({ kind: 'device', mainId: binding.mainId, deviceId }))
    return snapshot?.connectionScope === 'session'
      ? harnessSessionConnectionGeneration(binding) : harnessConnectionGeneration(binding)
  }
  async profileEvidence(value: HostHarnessOverride, client?: pg.PoolClient,
    options?: { includeFailed?: true; purpose?: 'execution' | 'observation' }): Promise<HostHarnessProfileEvidence | null> {
    if (value.target.hostRef.kind === 'device') {
      if (!options?.includeFailed && this.connection(value.target.hostRef.deviceId)?.clockReason) return null
      const binding = this.currentRemoteBinding(value.target.hostRef.deviceId)
      if (!binding) return null
      const registration = await assertDeviceHostInstallation(client ?? this.pool, value.target.hostRef, value.target.applicationInstallationId)
      if (!registration || binding.workerInstallationId !== registration.workerInstallationId
        || binding.keyRevision !== registration.keyRevision || binding.authorizationRevision !== registration.authorizationRevision) return null
    }
    const proof = await this.profiles.latest(value.instanceId, value.revision, client)
    const snapshot = this.snapshots.get(harnessHostKey(value.target.hostRef))?.value
    const installation = snapshot?.installations.find((record) => record.harnessInstallationId === value.target.harnessInstallationId)
    if (snapshot?.hostMetadata?.applicationInstallationId !== value.target.applicationInstallationId || !proof || !installation || !installation.installed || !installation.installationFingerprint) return null
    const target = { ...value.target, installationFingerprint: installation.installationFingerprint }
    const connectionGeneration = value.target.hostRef.kind === 'main' ? this.mainGeneration
      : this.remoteGeneration(value.target.hostRef.deviceId)
    const suiteRevision = value.driverId === 'claude' ? CLAUDE_PROFILE_CHECK_REVISION : `${value.driverId}-profile-check-v1`
    if (commandInputHash(proof.target) !== commandInputHash(target) || proof.instanceRevision !== value.instanceRevision
      || proof.configurationFingerprint !== commandInputHash(withAdvancedDefaults(value.configuration))
      || proof.driverId !== value.driverId || proof.driverRevision !== installation.driverRevision
      || proof.protocolRevision !== installation.protocolRevision || proof.suiteRevision !== suiteRevision
      || options?.purpose !== 'observation'
        && (proof.environmentGeneration !== installation.environmentGeneration || proof.connectionGeneration !== connectionGeneration)
      || (!options?.includeFailed && (!proof.authenticated || !proof.compatible || !proof.qualified))) return null
    return proof
  }
}
