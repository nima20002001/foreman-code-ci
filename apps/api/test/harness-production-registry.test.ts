import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { DEFAULT_HARNESS_DEFAULTS, withAdvancedDefaults } from '@foreman-code/contracts'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { HostHarnessOverride, HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import { expect, it, vi } from 'vitest'
import { ProductionHarnessRegistry } from '../src/modules/harnesses/productionRegistry.js'
import { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { passiveDriverPayloads } from '../src/modules/harnesses/payloadDiscovery.js'
import { discoverLauncher } from '../src/modules/harnesses/hostDiscovery.js'
import { inspectInstalledCodex } from '../src/modules/harnesses/installedCodexInspection.js'
import { commandInputHash } from '../src/modules/commands/postgres.js'
import { CLAUDE_PROFILE_CHECK_REVISION } from '../src/modules/harnesses/claudeSdk/profileRevision.js'
import { qualificationIdentity } from '../src/modules/harnesses/qualification/identity.js'

it('distinguishes unavailable and stale remote snapshots from a current empty installation inventory', async () => {
  const pool = new pg.Pool({ connectionString: 'postgresql://unused@127.0.0.1:1/unused' })
  let binding: DeviceSessionBinding = { mainId: randomUUID(), deviceId: randomUUID(),
    workerInstallationId: randomUUID(), bootId: randomUUID(), connectionEpoch: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 }
  const registry = new ProductionHarnessRegistry(pool, { codexBinary: 'codex',  },
    async () => ({ revision: 1, defaults: DEFAULT_HARNESS_DEFAULTS }),
    new HostHarnessProfileEvidenceRepository(pool), () => binding)
  const profile: HostHarnessOverride = { instanceId: randomUUID(), instanceRevision: '1', revision: 1,
    driverId: 'codex', presetId: 'local-default:codex', enabled: true, qualification: 'unqualified',
    configuration: DEFAULT_HARNESS_DEFAULTS.codex, configurationFingerprint: 'saved-configuration', target: {
      hostRef: { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId },
      applicationInstallationId: binding.workerInstallationId,
      harnessInstallationId: 'saved-installation', installationFingerprint: 'saved-payload',
    } }
  const collect = async () => {
    const inspected = await inspectInstalledCodex({ binding, configuration: null, environment: process.env,
      cwd: process.cwd(), signal: new AbortController().signal })
    registry.acceptRemoteSnapshot(binding, inspected.inventory)
  }
  try {
    expect(() => registry.pinOverride(profile))
      .toThrow(expect.objectContaining({ code: 'HARNESS_INVENTORY_UNAVAILABLE' }))
    await collect()
    binding = { ...binding, connectionEpoch: randomUUID(), connectionGeneration: 2 }
    expect(() => registry.pinOverride(profile))
      .toThrow(expect.objectContaining({ code: 'HARNESS_INVENTORY_STALE' }))
    await collect()
    expect(() => registry.pinOverride(profile))
      .toThrow(expect.objectContaining({ code: 'HARNESS_INSTALLATION_CHANGED' }))
  } finally { registry.stop(); await pool.end() }
})

it('pins actual main installation payloads and invalidates selections after passive refresh', async () => {
  const pool = new pg.Pool({ connectionString: 'postgresql://unused@127.0.0.1:1/unused' })
  let payload = 'payload-A'
  const reads: string[] = []
  const launcher: typeof discoverLauncher = async (requested, environment, paths = []) => {
    reads.push(requested)
    return { requested, resolvedLauncher: `/recorded/${requested}`, fingerprint: payload,
      payloadFingerprints: paths.map((path) => ({ path, fingerprint: payload })), status: 'installed',
      interpreter: null, diagnostics: [], environment, checkedAt: '2026-10-01T00:00:00.000Z' }
  }
  const payloads: typeof passiveDriverPayloads = async () => ({ complete: true, paths: ['/recorded/provider-payload'] })
  const registry = new ProductionHarnessRegistry(pool, { codexBinary: 'codex',  },
    async () => ({ revision: 8, defaults: { codex: { harness: 'codex', model: 'recorded-model', reasoningEffort: 'medium', serviceTier: 'standard', sandbox: 'read-only' } } }), new HostHarnessProfileEvidenceRepository(pool), () => null, { PATH: '/recorded' }, { launcher, payloads })
  try {
    await registry.initialize('d46e2a2b-130f-46de-a93b-78a2352b9c9d')
    const selection = registry.pinDefault('codex')
    expect(selection.selection.hostRef).toEqual({ kind: 'main', mainId: 'd46e2a2b-130f-46de-a93b-78a2352b9c9d' })
    expect(selection.installation.installationFingerprint).toBe('payload-A')
    expect(selection.installation.qualified).toBeNull()
    expect(reads).toEqual(['codex', 'codex'])
    expect(registry.installations.list().find(value => value.driverId === 'claude')).toMatchObject({
      installed: false, installationFingerprint: null, authenticated: null, qualified: null,
    })
    await registry.refreshMain()
    expect(() => registry.installations.assertCurrent(selection)).not.toThrow()
    payload = 'payload-B'
    await registry.refreshMain()
    expect(() => registry.installations.assertCurrent(selection)).toThrow()
    expect(registry.pinDefault('codex').installation.installationFingerprint).toBe('payload-B')
    const configuration = { id: 'accepted-configuration', agentId: 'recorded-agent',
      harness: { harness: 'codex', model: 'recorded-model', reasoningEffort: 'medium', serviceTier: 'standard', sandbox: 'read-only' } }
    const launching = registry.pinAccepted(configuration)
    registry.stop()
    expect(() => registry.pinDefault('codex')).toThrow('shutting down')
    expect(() => registry.refreshMain()).toThrow(expect.objectContaining({ code: 'HARNESS_REGISTRY_CLOSING' }))
    // Application shutdown changes no installation: an in-flight launch keeps and revalidates its original binding.
    expect(() => registry.installations.assertCurrent(launching)).not.toThrow()
    await expect(registry.installations.metadata(launching, 'suite', async () => 'loaded')).resolves.toBe('loaded')
    const revalidated = registry.pinAccepted(configuration)
    expect(revalidated.inventoryRevision).toBe(launching.inventoryRevision)
    expect(() => registry.installations.assertCurrent(revalidated)).not.toThrow()
  } finally { await pool.end() }
})

it('retains Main installation qualification identity across API restarts and invalidates changed environments', async () => {
  const pool = new pg.Pool({ connectionString: 'postgresql://unused@127.0.0.1:1/unused' })
  const mainId = randomUUID()
  let fingerprint = 'provider-payload'
  const launcher: typeof discoverLauncher = async (requested, environment) => ({
    requested, resolvedLauncher: '/recorded/codex', fingerprint,
    status: 'installed', interpreter: null, diagnostics: [], environment,
    checkedAt: new Date().toISOString(),
  })
  const payloads: typeof passiveDriverPayloads = async () => ({ complete: true, paths: [] })
  const registries: ProductionHarnessRegistry[] = []
  const create = async (path: string, hostId = mainId) => {
    const registry = new ProductionHarnessRegistry(pool, { codexBinary: 'codex' },
      async () => ({ revision: 1, defaults: DEFAULT_HARNESS_DEFAULTS }),
      new HostHarnessProfileEvidenceRepository(pool), () => null, { PATH: path }, { launcher, payloads })
    registries.push(registry)
    await registry.initialize(hostId)
    return registry
  }
  try {
    const original = await create('/recorded')
    const accepted = original.pinDefault('codex')
    const identity = qualificationIdentity(accepted, 'native-suite')
    const restarted = await create('/recorded')
    expect(qualificationIdentity(restarted.pinDefault('codex'), 'native-suite')).toEqual(identity)
    const changedEnvironment = await create('/different')
    expect(qualificationIdentity(changedEnvironment.pinDefault('codex'), 'native-suite')).not.toEqual(identity)
    const differentMain = await create('/recorded', randomUUID())
    expect(qualificationIdentity(differentMain.pinDefault('codex'), 'native-suite')).not.toEqual(identity)
    fingerprint = 'replacement-payload'
    const changedBinary = await create('/recorded')
    expect(qualificationIdentity(changedBinary.pinDefault('codex'), 'native-suite')).not.toEqual(identity)
  } finally {
    for (const registry of registries) registry.stop()
    await pool.end()
  }
})

it('consumes the explicit passive Claude SDK declaration without inventing default profiles', async () => {
  const { DEFAULT_HARNESS_DEFAULTS } = await import('@foreman-code/contracts')
  const pool = new pg.Pool({ connectionString: 'postgresql://unused@127.0.0.1:1/unused' })
  const launcher: typeof discoverLauncher = vi.fn<typeof discoverLauncher>(async (requested, environment) => ({ requested,
    resolvedLauncher: `/recorded/${requested}`, fingerprint: 'generic', status: 'installed', interpreter: null,
    diagnostics: [], environment, checkedAt: '2026-10-01T00:00:00.000Z' }))
  const claude = vi.fn<NonNullable<NonNullable<ConstructorParameters<typeof ProductionHarnessRegistry>[6]>['claude']>>(async (_host, environment) => ({ sdkVersion: '0.3.284', sdkIntegrity: 'recorded-installed-integrity',
    launcher: { requested: '/recorded/sdk-native', resolvedLauncher: '/recorded/sdk-native', fingerprint: 'sdk-and-cli-payloads',
      status: 'installed' as const, interpreter: null, diagnostics: [], environment, checkedAt: '2026-10-01T00:00:00.000Z' },
    declaration: { harnessInstallationId: 'sdk-installation', requestedLauncher: '/recorded/sdk-native',
      payloadPaths: ['/recorded/sdk.mjs'], driverId: 'claude', driverRevision: '1', protocolRevision: 'claude-sdk-0.3.284' },
  }))
  const profiles = new HostHarnessProfileEvidenceRepository(pool)
  const registry = new ProductionHarnessRegistry(pool, { codexBinary: 'codex',  },
    async () => ({ revision: 1, defaults: DEFAULT_HARNESS_DEFAULTS }), profiles, () => null,
    { PATH: '/recorded' }, { launcher, payloads: async () => ({ complete: true, paths: [] }), claude })
  try {
    await registry.initialize('d46e2a2b-130f-46de-a93b-78a2352b9c9d')
    expect(registry.installations.list().find(value => value.driverId === 'claude')).toMatchObject({
      harnessInstallationId: 'sdk-installation', installationFingerprint: 'sdk-and-cli-payloads', installed: true,
      observedVersion: null, authenticated: null, compatible: null, qualified: null, protocolRevision: 'claude-sdk-0.3.284',
    })
    expect(claude).toHaveBeenCalledOnce()
    expect(vi.mocked(launcher).mock.calls.map(([requested]) => requested)).toEqual(['codex', 'codex'])
    expect(registry.instances.list().some(value => value.driverId === 'claude')).toBe(false)
    const installed = registry.installations.list().find(value => value.driverId === 'claude')!
    const configuration = withAdvancedDefaults({ harness: 'claude', model: 'recorded-model', authMode: 'subscription',
      configDirectory: '/recorded/profile', permissionMode: 'default', sandbox: 'read-only',
      tools: ['Read', 'Bash'], permissionRules: [], instructions: '', mcpServers: {} })
    const value: HostHarnessOverride = { instanceId: randomUUID(), instanceRevision: '1', revision: 1, enabled: true,
      driverId: 'claude', presetId: 'recorded-profile', qualification: 'unqualified', configuration,
      configurationFingerprint: commandInputHash(configuration), target: { hostRef: installed.hostRef,
        applicationInstallationId: installed.hostRef.mainId, harnessInstallationId: installed.harnessInstallationId,
        installationFingerprint: installed.installationFingerprint! } }
    const proof: HostHarnessProfileEvidence = { target: value.target, instanceRevision: value.instanceRevision,
      configurationFingerprint: value.configurationFingerprint, driverId: installed.driverId,
      driverRevision: installed.driverRevision, protocolRevision: installed.protocolRevision,
      environmentGeneration: installed.environmentGeneration, connectionGeneration: installed.connectionGeneration,
      authenticated: true, compatible: true, qualified: true, suiteRevision: 'claude-profile-check-v1',
      checkedAt: '2026-10-01T00:00:00.000Z' }
    vi.spyOn(profiles, 'latest').mockResolvedValue(proof)
    expect(await registry.profileEvidence(value)).toBeNull()
    proof.suiteRevision = CLAUDE_PROFILE_CHECK_REVISION
    expect(await registry.profileEvidence(value)).toEqual(proof)
    proof.connectionGeneration = 'previous-worker-boot'
    proof.environmentGeneration = 'previous-worker-environment'
    expect(await registry.profileEvidence(value)).toBeNull()
    const observation = { purpose: 'observation' as const }
    expect(await registry.profileEvidence(value, undefined, observation)).toEqual(proof)
    for (const changed of [
      { authenticated: false }, { compatible: false }, { qualified: false },
      { instanceRevision: 'other-revision' }, { configurationFingerprint: 'other-configuration' },
      { driverRevision: 'other-driver' }, { protocolRevision: 'other-protocol' },
      { suiteRevision: 'other-suite' },
      { target: { ...value.target, installationFingerprint: 'other-installation' } },
    ]) {
      vi.mocked(profiles.latest).mockResolvedValue({ ...proof, ...changed })
      expect(await registry.profileEvidence(value, undefined, observation)).toBeNull()
    }
  } finally { registry.stop(); await pool.end() }
})
