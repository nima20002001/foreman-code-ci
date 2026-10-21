import pg from 'pg'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { describe, expect, it } from 'vitest'
import { HarnessInstanceRegistry, localHarnessDrivers } from '../src/modules/harnesses/instanceRegistry.js'
import { HarnessInstallationRegistry, type HarnessInstallationRecord } from '../src/modules/harnesses/installationRegistry.js'
import { ProductionHarnessRegistry } from '../src/modules/harnesses/productionRegistry.js'
import { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { harnessConnectionGeneration } from '../src/modules/harnesses/hostConnectionGeneration.js'
import { projectHarnessRegistry } from '../src/modules/harnesses/registryProjection.js'

function fixture() {
  const instances = new HarnessInstanceRegistry(localHarnessDrivers)
  const profile = { instanceId: 'profile', instanceRevision: '1', driverId: 'codex', enabled: true,
    configuration: DEFAULT_HARNESS_DEFAULTS.codex }
  instances.reload([profile])
  const hostRef = { kind: 'main' as const, mainId: '11111111-1111-4111-8111-111111111111' }
  const record: HarnessInstallationRecord = { hostRef, harnessInstallationId: 'codex-install', installationFingerprint: 'payload-A',
    driverId: 'codex', driverRevision: '1', protocolRevision: 'protocol-1', environmentGeneration: 'env-1', connectionGeneration: 'connection-1',
    observedVersion: null, installed: true, authenticated: null, compatible: null, qualified: null,
    launcher: { requested: '/recorded/codex', resolvedLauncher: '/recorded/codex', fingerprint: 'payload-A', status: 'installed',
      interpreter: null, diagnostics: [], checkedAt: '2026-10-02T00:00:00.000Z',
      environment: { generation: 'env-1', provenance: 'terminal', cwd: '/', path: '/recorded' } } }
  const registry = new HarnessInstallationRegistry(instances)
  registry.refresh([record])
  const pin = () => registry.pin({ hostRef, instanceId: profile.instanceId, harnessInstallationId: record.harnessInstallationId,
    environmentGeneration: record.environmentGeneration, connectionGeneration: record.connectionGeneration })
  return { registry, instances, profile, record, pin }
}

describe('selected harness metadata invalidation', () => {
  it('retains Main default and accepted bindings and pending metadata across authenticated remote inventory updates', async () => {
    const pool = new pg.Pool({ connectionString: 'postgresql://unused@127.0.0.1:1/unused' })
    const binding: DeviceSessionBinding = { mainId: '11111111-1111-4111-8111-111111111111',
      deviceId: '22222222-2222-4222-8222-222222222222', workerInstallationId: '33333333-3333-4333-8333-333333333333',
      bootId: '44444444-4444-4444-8444-444444444444', connectionEpoch: '55555555-5555-4555-8555-555555555555',
      keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 }
    let mainPayload = 'payload-A'
    const registry = new ProductionHarnessRegistry(pool, { codexBinary: 'codex',  },
      async () => ({ revision: 1, defaults: DEFAULT_HARNESS_DEFAULTS }), new HostHarnessProfileEvidenceRepository(pool),
      () => binding, { PATH: '/recorded' }, {
        launcher: async (requested, environment) => ({ requested, resolvedLauncher: `/recorded/${requested}`,
          fingerprint: mainPayload, status: 'installed', interpreter: null, diagnostics: [], environment,
          checkedAt: '2026-10-02T00:00:00.000Z' }),
        payloads: async () => ({ complete: true, paths: [] }),
      })
    try {
      await registry.initialize(binding.mainId)
      const retained = [registry.pinDefault('codex'), registry.pinAccepted({ id: 'accepted-config', agentId: 'agent',
        harness: DEFAULT_HARNESS_DEFAULTS.codex })]
      let finish!: (value: string) => void
      const pending = registry.installations.metadata(retained[0]!, 'suite', () => new Promise<string>(resolve => { finish = resolve }))
      await Promise.resolve()
      const hostRef = { kind: 'device' as const, mainId: binding.mainId, deviceId: binding.deviceId }
      const remote = { ...retained[0]!.installation, hostRef, connectionGeneration: harnessConnectionGeneration(binding) }
      const report = (record: HarnessInstallationRecord) => ({ ...projectHarnessRegistry([], [record]),
        hostMetadata: { hostRef, applicationInstallationId: binding.workerInstallationId, platform: null, workspaceRoots: null, connection: null } })
      registry.acceptRemoteSnapshot(binding, report(remote))
      registry.acceptRemoteSnapshot(binding, report({ ...remote, installationFingerprint: 'remote-payload-B',
        launcher: { ...remote.launcher, fingerprint: 'remote-payload-B' } }))
      finish('Main evidence')
      await expect(pending).resolves.toBe('Main evidence')
      for (const selection of retained) expect(() => registry.installations.assertCurrent(selection)).not.toThrow()
      mainPayload = 'payload-B'
      await registry.refreshMain()
      for (const selection of retained) expect(() => registry.installations.assertCurrent(selection)).toThrow('stale')
    } finally { registry.stop(); await pool.end() }
  })

  it('retains unchanged installation metadata when observation timestamps and diagnostics change', async () => {
    const f = fixture(), binding = f.pin()
    f.registry.refresh([{ ...f.record, launcher: { ...f.record.launcher, checkedAt: '2026-10-02T01:00:00.000Z', diagnostics: ['new observation'] } }])
    expect(() => f.registry.assertCurrent(binding)).not.toThrow()
    await expect(f.registry.metadata(binding, 'suite', async () => 'evidence')).resolves.toBe('evidence')
  })

  it('retains a pending check while another check publishes qualification results for the same installation', async () => {
    const f = fixture()
    const binding = f.pin()
    let finish!: (value: string) => void
    const pending = f.registry.metadata(binding, 'suite', () => new Promise<string>(resolve => { finish = resolve }))
    await Promise.resolve()

    for (const observation of [
      { observedVersion: '0.154.0', qualified: true },
      { observedVersion: null, qualified: false },
    ]) {
      f.registry.refresh([{ ...f.record, ...observation }])
      expect(() => f.registry.assertCurrent(binding)).not.toThrow()
      expect(f.registry.list()[0]).toMatchObject(observation)
      expect(f.pin().installation).toMatchObject(observation)
    }

    finish('completed check')
    await expect(pending).resolves.toBe('completed check')
    expect(binding.installation).toMatchObject({ observedVersion: null, qualified: null })
  })

  it.each(['fingerprint', 'installation', 'protocol', 'environment', 'connection', 'driver', 'launcher', 'installed', 'profile'] as const)(
    'rejects a retained binding and pending evidence after its selected %s changes', async change => {
      const f = fixture(), binding = f.pin()
      let finish!: (value: string) => void
      const pending = f.registry.metadata(binding, 'suite', () => new Promise<string>(resolve => { finish = resolve }))
      await Promise.resolve()
      const record = structuredClone(f.record)
      if (change === 'fingerprint') Object.assign(record, { installationFingerprint: 'payload-B', launcher: { ...record.launcher, fingerprint: 'payload-B' } })
      if (change === 'installation') Object.assign(record, { harnessInstallationId: 'another-install' })
      if (change === 'protocol') Object.assign(record, { protocolRevision: 'protocol-2' })
      if (change === 'environment') Object.assign(record, { environmentGeneration: 'env-2' })
      if (change === 'connection') Object.assign(record, { connectionGeneration: 'connection-2' })
      if (change === 'driver') Object.assign(record, { driverRevision: '2' })
      if (change === 'launcher') record.launcher.resolvedLauncher = '/another/codex'
      if (change === 'installed') Object.assign(record, { installed: false })
      if (change === 'profile') f.instances.reload([{ ...f.profile, instanceRevision: '2' }])
      f.registry.refresh([record])
      finish('stale evidence')
      await expect(pending).rejects.toThrow('stale')
      expect(() => f.registry.assertCurrent(binding)).toThrow('stale')
    })

  it('rejects bindings after removal and reappearance of the same installation or explicit invalidation', async () => {
    const f = fixture(), removed = f.pin()
    f.registry.refresh([])
    f.registry.refresh([f.record])
    expect(() => f.registry.assertCurrent(removed)).toThrow('stale')
    const binding = f.pin()
    f.registry.invalidate()
    expect(() => f.registry.assertCurrent(binding)).toThrow('stale')
    await expect(f.registry.metadata(binding, 'suite', async () => 'evidence')).rejects.toThrow('stale')
  })
})
