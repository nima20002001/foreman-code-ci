import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { withAdvancedDefaults } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { WorkerConversationProfileFactsSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { createInstalledConversationNativeReader } from './installedNativeProfile.js'
import { createInstalledClaudeConversationProfile } from './installedClaudeConversationProfile.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { QUALIFICATION_TARGET_PROFILE } from '../harnesses/qualification/profiles.js'
import { CLAUDE_PROFILE_CHECK_REVISION } from '../harnesses/claudeSdk/profileRevision.js'

function fixture(harness: 'codex' | 'claude', kind: 'agent' | 'operator') {
  const f = workerConversationFixture(kind, harness)
  const target = { ...f.binding.profile.target, harnessInstallationId: 'updated-installation',
    installationFingerprint: 'updated-fingerprint' }
  const configurationFingerprint = commandInputHash(withAdvancedDefaults(f.configuration.harness))
  const installation = { hostRef: target.hostRef, harnessInstallationId: target.harnessInstallationId,
    installationFingerprint: target.installationFingerprint, driverId: harness, driverRevision: '1',
    protocolRevision: 'native-protocol', environmentGeneration: 'environment', connectionGeneration: 'connection',
    launcher: { requested: '/fixture/native', resolvedLauncher: '/fixture/native', fingerprint: target.installationFingerprint,
      status: 'installed' as const, interpreter: null, diagnostics: [], checkedAt: '2026-10-05T00:00:00.000Z',
      payloadFingerprints: [{ path: '/fixture/native', fingerprint: 'a'.repeat(64) }],
      environment: { generation: 'environment', provenance: 'worker' as const, cwd: '/fixture', path: '/fixture' } },
    ...(harness === 'claude' ? { claudeSdk: { version: '0.3.284', integrity: 'sha512-YQ==' } } : {}),
    observedVersion: '0.154.0', installed: true, authenticated: true, compatible: true, qualified: true }
  const facts = WorkerConversationProfileFactsSchema.parse({ installation,
    override: { ...f.binding.profile, target, revision: 2, presetId: harness, enabled: true, driverId: harness,
      configuration: f.configuration.harness, configurationFingerprint, qualification: 'qualified' },
    profile: { target, instanceRevision: f.binding.profile.instanceRevision, configurationFingerprint,
      driverId: harness, driverRevision: '1', protocolRevision: installation.protocolRevision,
      suiteRevision: harness === 'claude' ? CLAUDE_PROFILE_CHECK_REVISION : 'codex-profile-check-v1',
      environmentGeneration: installation.environmentGeneration, connectionGeneration: installation.connectionGeneration,
      authenticated: true, compatible: true, qualified: true, checkedAt: '2026-10-05T00:00:00.000Z',
      ...(harness === 'claude' ? { claudeProof: { checks: {}, pin: { sdkVersion: '0.3.284', sdkIntegrity: 'sha512-YQ==',
        cliVersion: '0.154.0', executableSha256: 'a'.repeat(64), profilePath: '/uncreated/profile-fixture',
        configRevision: f.binding.profile.instanceRevision } } } : {}) },
    qualification: harness === 'claude' ? null : { harness, version: '0.154.0', binarySha256: 'a'.repeat(64),
      suiteRevision: 'suite-fixture', status: 'qualified', profile: QUALIFICATION_TARGET_PROFILE.codex,
      checks: [{ id: 'fixture-only', passed: true, detail: null }], failureReason: null,
      startedAt: '2026-10-05T00:00:00.000Z', checkedAt: '2026-10-05T00:00:00.000Z' } })
  const inspect = async () => ({ currentTarget: { binding: f.connection, target, installation,
    binarySha256: 'a'.repeat(64), expectedVersion: '0.154.0',
    sdk: { entrypoint: '/fixture/sdk', installedLockPath: '/fixture/lock' } },
    inventory: { instances: [], installations: [installation] } })
  const common = { ...f, current: () => f.connection, inspect, readFacts: async () => facts }
  const reader = harness === 'claude'
    ? createInstalledClaudeConversationProfile({ ...common, signal: AbortSignal.timeout(1000) })
    : createInstalledConversationNativeReader({ ...common, suiteRevision: 'suite-fixture',
      signal: () => AbortSignal.timeout(1000) })
  return { ...f, target, facts, reader }
}

it.each(['codex', 'claude'] as const)('%s admits a qualified installation replacement for Agent and Operator chat', async harness => {
  for (const kind of ['agent', 'operator'] as const) {
    const f = fixture(harness, kind)
    const saved = structuredClone({ binding: f.binding, configuration: f.configuration })
    await expect(f.reader.capture()).resolves.toBeDefined()
    expect({ binding: f.binding, configuration: f.configuration }).toEqual(saved)
    expect(f.facts.override.target).toEqual(f.target)
  }
})

it.each(['codex', 'claude'] as const)('%s rejects unqualified and foreign replacement facts', async harness => {
  for (const change of ['proof', 'host', 'application', 'configuration', 'revision', 'target'] as const) {
    const f = fixture(harness, 'agent')
    if (change === 'proof') f.facts.profile.qualified = false
    if (change === 'host') f.facts.override.target.hostRef = { kind: 'main', mainId: randomUUID() }
    if (change === 'application') f.facts.override.target.applicationInstallationId = randomUUID()
    if (change === 'configuration') f.facts.override.configuration.model = 'another-model'
    if (change === 'revision') f.facts.override.instanceRevision = 'another-revision'
    if (change === 'target') f.facts.override.target.installationFingerprint = 'another-installation'
    await expect(f.reader.capture()).rejects.toThrow()
  }
})
