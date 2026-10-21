import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { withAdvancedDefaults } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { WorkerConversationProfileFactsSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { createInstalledConversationNativeReader } from './installedNativeProfile.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import type { InstalledHarnessInspection } from '../harnesses/installedCodexInspection.js'
import { QUALIFICATION_TARGET_PROFILE } from '../harnesses/qualification/profiles.js'

/** Protocol fixtures test admission checks; they do not qualify any native installation. */
function fixture() {
  const f = workerConversationFixture('agent')
  const { target } = f.binding.profile
  const installation = { hostRef: target.hostRef, harnessInstallationId: target.harnessInstallationId,
    installationFingerprint: target.installationFingerprint, driverId: 'codex', driverRevision: '1',
    protocolRevision: 'codex-native-adapter-v1', environmentGeneration: 'environment-fixture', connectionGeneration: 'channel-fixture',
    launcher: { requested: '/fixture/codex', resolvedLauncher: '/fixture/codex', fingerprint: target.installationFingerprint,
      status: 'installed' as const, interpreter: null, diagnostics: [], checkedAt: '2026-10-05T00:00:00.000Z',
      payloadFingerprints: [{ path: '/fixture/codex', fingerprint: 'a'.repeat(64) }],
      environment: { generation: 'environment-fixture', provenance: 'worker' as const, cwd: '/fixture', path: '/fixture' } },
    observedVersion: '0.154.0', installed: true, authenticated: true, compatible: true, qualified: true }
  const configurationFingerprint = commandInputHash(withAdvancedDefaults(f.configuration.harness))
  const facts = WorkerConversationProfileFactsSchema.parse({ installation,
    override: { instanceId: f.binding.profile.instanceId, instanceRevision: f.binding.profile.instanceRevision,
      revision: 1, presetId: 'codex', enabled: true, driverId: 'codex', target,
      configuration: f.configuration.harness, configurationFingerprint, qualification: 'qualified' },
    profile: { target, instanceRevision: f.binding.profile.instanceRevision, configurationFingerprint,
      driverId: 'codex', driverRevision: '1', protocolRevision: installation.protocolRevision,
      suiteRevision: 'codex-profile-check-v1', environmentGeneration: installation.environmentGeneration,
      connectionGeneration: installation.connectionGeneration, authenticated: true, compatible: true, qualified: true,
      checkedAt: '2026-10-05T00:00:00.000Z' },
    qualification: { harness: 'codex', version: '0.154.0', binarySha256: 'a'.repeat(64), suiteRevision: 'suite-fixture',
      status: 'qualified', profile: QUALIFICATION_TARGET_PROFILE.codex, checks: [{ id: 'fixture-only', passed: true, detail: null }],
      failureReason: null, startedAt: '2026-10-05T00:00:00.000Z', checkedAt: '2026-10-05T00:00:00.000Z' } })
  let connection = f.connection
  let installed = structuredClone(installation)
  const reader = createInstalledConversationNativeReader({ ...f, current: () => connection,
    suiteRevision: 'suite-fixture', signal: () => AbortSignal.timeout(1000), readFacts: async () => facts,
    inspect: async (): Promise<InstalledHarnessInspection> => ({ inventory: { instances: [], installations: [installed] },
      currentTarget: { binding: connection, target, installation: installed, binarySha256: 'a'.repeat(64), expectedVersion: '0.154.0' } }) })
  return { ...f, facts, reader, replace: () => { installed = { ...installed, installationFingerprint: 'replacement' } },
    revokeInstallation: () => { connection = { ...connection, workerInstallationId: randomUUID() } } }
}

it('reads the selected native profile through conversation ownership without dispatch facts', async () => {
  const f = fixture()
  expect((await f.reader.capture()).qualification.version).toBe('0.154.0')
  expect(await f.reader.repository.find('codex', '0.154.0', 'a'.repeat(64), 'suite-fixture')).toEqual(f.facts.qualification)
  expect(await f.reader.repository.find('codex', '0.154.0', 'b'.repeat(64), 'suite-fixture')).toBeNull()
})

it.each(['qualification', 'profile', 'installation', 'connection'] as const)('rejects changed %s before native admission', async kind => {
  const f = fixture()
  if (kind === 'qualification') f.facts.qualification = null
  if (kind === 'profile') f.facts.profile.authenticated = false
  if (kind === 'installation') f.replace()
  if (kind === 'connection') f.revokeInstallation()
  await expect(f.reader.capture()).rejects.toMatchObject({ code: 'HARNESS_UNQUALIFIED' })
})
