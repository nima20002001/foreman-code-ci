import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, withAdvancedDefaults } from '@foreman-code/contracts'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import { previousWorkerHarnessGeneration, previousWorkerInventory } from '../../../test/support/previousWorkerHarness.js'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import { createInstalledNativeQualificationRetention } from './installedNativeQualificationRetention.js'
import { completedNativeQualificationChecks } from './installedNativeQualification.js'
import { QUALIFICATION_TARGET_PROFILE } from './qualification/profiles.js'
import { harnessConnectionGeneration } from './hostConnectionGeneration.js'
import { ProductionHarnessRegistry } from './productionRegistry.js'
import { HostHarnessProfileEvidenceRepository } from './instanceSettings/profileRepository.js'

it.each(['session', 'boot'] as const)('keeps %s-scoped Worker inventory and fences it at its advertised lifetime', async scope => {
  let binding: DeviceSessionBinding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1, keyRevision: 1, authorizationRevision: 1 }
  const pool = new pg.Pool({ connectionString: 'postgresql://unused@127.0.0.1:1/unused' })
  const registry = new ProductionHarnessRegistry(pool, { codexBinary: 'codex' },
    async () => ({ revision: 1, defaults: DEFAULT_HARNESS_DEFAULTS }), new HostHarnessProfileEvidenceRepository(pool),
    () => binding)
  const inventory = previousWorkerInventory(binding)
  if (scope === 'boot') inventory.installations[0]!.connectionGeneration = harnessConnectionGeneration(binding)
  const override: HostHarnessOverride = { instanceId: randomUUID(), instanceRevision: '1', revision: 1,
    driverId: 'codex', presetId: 'worker-codex', enabled: true, qualification: 'unqualified',
    configuration: DEFAULT_HARNESS_DEFAULTS.codex, configurationFingerprint: 'profile-fingerprint',
    target: { hostRef: { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId },
      applicationInstallationId: binding.workerInstallationId, harnessInstallationId: 'worker-codex',
      installationFingerprint: 'worker-payload' } }
  try {
    registry.acceptRemoteSnapshot(binding, inventory)
    expect(registry.pinOverride(override).installation.connectionGeneration)
      .toBe(inventory.installations[0]!.connectionGeneration)
    binding = { ...binding, connectionEpoch: randomUUID(), connectionGeneration: 2 }
    if (scope === 'session') {
      expect(() => registry.pinOverride(override)).toThrow(expect.objectContaining({ code: 'HARNESS_INVENTORY_STALE' }))
      expect(() => registry.acceptRemoteSnapshot(binding, inventory))
        .toThrow(expect.objectContaining({ code: 'HARNESS_INVENTORY_STALE' }))
      registry.acceptRemoteSnapshot(binding, previousWorkerInventory(binding))
    }
    expect(() => registry.pinOverride(override)).not.toThrow()
    for (const field of ['mainId', 'deviceId', 'workerInstallationId', 'bootId', 'keyRevision', 'authorizationRevision'] as const) {
      const changed = { ...binding, [field]: typeof binding[field] === 'number' ? 2 : randomUUID() }
      expect(() => registry.acceptRemoteSnapshot(binding, previousWorkerInventory(changed)))
        .toThrow(expect.objectContaining({ code: 'HARNESS_INVENTORY_STALE' }))
    }
    binding = { ...binding, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 3 }
    expect(() => registry.pinOverride(override)).toThrow(expect.objectContaining({ code: 'HARNESS_INVENTORY_STALE' }))
  } finally { registry.stop(); await pool.end() }
})

it.each(['session', 'boot'] as const)('retains completed native qualification from a %s-scoped Worker', async scope => {
  let binding: DeviceSessionBinding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1, keyRevision: 1, authorizationRevision: 1 }
  const installation = previousWorkerInventory(binding).installations[0]!
  if (scope === 'boot') installation.connectionGeneration = harnessConnectionGeneration(binding)
  const binarySha256 = 'a'.repeat(64)
  installation.launcher.payloadFingerprints = [{ path: installation.launcher.resolvedLauncher!, fingerprint: binarySha256 }]
  const value: HostHarnessOverride = { instanceId: randomUUID(), instanceRevision: '1', revision: 1,
    driverId: 'codex', presetId: 'worker-codex', enabled: true, qualification: 'unqualified',
    configuration: DEFAULT_HARNESS_DEFAULTS.codex,
    configurationFingerprint: commandInputHash(withAdvancedDefaults(DEFAULT_HARNESS_DEFAULTS.codex)),
    target: { hostRef: installation.hostRef, applicationInstallationId: binding.workerInstallationId,
      harnessInstallationId: installation.harnessInstallationId, installationFingerprint: installation.installationFingerprint! } }
  const checkId = randomUUID()
  const checkedAt = new Date().toISOString()
  const record = { harness: 'codex' as const, version: '0.154.0', binarySha256, status: 'qualified' as const,
    profile: QUALIFICATION_TARGET_PROFILE.codex, suiteRevision: 'codex-native-suite',
    checks: completedNativeQualificationChecks().map(id => ({ id, passed: true, detail: null })),
    failureReason: null, startedAt: checkedAt, checkedAt }
  const proof: HostHarnessProfileEvidence = { target: value.target, instanceRevision: value.instanceRevision,
    configurationFingerprint: value.configurationFingerprint, driverId: 'codex', driverRevision: installation.driverRevision,
    protocolRevision: installation.protocolRevision, suiteRevision: 'codex-profile-check-v1',
    environmentGeneration: installation.environmentGeneration, connectionGeneration: installation.connectionGeneration,
    authenticated: true, compatible: true, qualified: true, checkedAt,
    completedNativeQualification: { purpose: 'explicit-host-qualification', checkId, binding: { ...binding },
      target: value.target, binarySha256, record } }
  const save = vi.fn(async () => {})
  const retention = createInstalledNativeQualificationRetention({ repository: { save }, currentBinding: () => binding,
    currentInstallation: () => installation, suiteRevision: record.suiteRevision, refreshInstallation: async () => {} })
  const client = {} as pg.PoolClient
  const fence = await retention.retain(client, value, proof, checkId, new AbortController().signal)
  expect(save).toHaveBeenCalledOnce()
  expect(save).toHaveBeenCalledWith(record, expect.objectContaining({ binding: proof.completedNativeQualification!.binding,
    profile: proof }), client)
  if (scope === 'session') expect(proof.connectionGeneration).toBe(previousWorkerHarnessGeneration(binding))
  binding = { ...binding, connectionEpoch: randomUUID(), connectionGeneration: 2 }
  await expect(fence()).rejects.toMatchObject({ code: 'HARNESS_PROFILE_EVIDENCE_MISMATCH' })
})
