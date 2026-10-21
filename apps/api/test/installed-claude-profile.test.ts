import { persistentFixtureRoot } from './helpers/fixtureStorage.js'
import { RemoteOperationJournal } from '../src/modules/runs/remote/operationJournal.js'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeHarnessConfigurationSchema } from '@foreman-code/contracts/claude'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { HostHarnessOverride, HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import { installedClaudeSdkEntrypoint } from '../src/modules/harnesses/claudeSdk/currentPin.js'
import { installedClaudeProfilePin } from '../src/modules/harnesses/claudeSdk/installedProfilePin.js'
import { createInstalledClaudeConversationProfile } from '../src/modules/conversations/installedClaudeConversationProfile.js'
import { AgentConfigurationVersionSchema, OperatorConfigurationVersionSchema } from '@foreman-code/contracts'
import { CLAUDE_QUALIFICATION_CHECKS } from '@foreman-code/contracts/claude-qualification'
import { ApprovedRootAllowlistSchema } from '@foreman-code/contracts/workspace-root-policies'
import { WorkerConversationBindingSchema, type WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import { inspectInstalledClaude } from '../src/modules/harnesses/installedClaudeInspection.js'
import type { RegistryHarnessSelection } from '../src/modules/harnesses/installationRegistry.js'
import { allocateInstalledWorkerClaude } from '../src/modules/conversations/installedWorkerClaude.js'
import { workerConversationCallbacks } from '../src/modules/conversations/workerCallbacks.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { identity, openPrivateRoot } from '../src/modules/sources/privateFilesystem.js'
import { CLAUDE_PROFILE_CHECK_REVISION } from '../src/modules/harnesses/claudeSdk/profileRevision.js'

const journals: RemoteOperationJournal[] = []
const directories: string[] = []
afterEach(async () => {
  try { await Promise.all(journals.splice(0).map(journal => journal.close())) }
  finally { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'installed-claude-profile-'))
  directories.push(root)
  const binary = join(root, 'claude')
  // Passive byte fixture only; neither it nor an SDK query runs in these tests.
  await writeFile(binary, 'passive CLI fixture', { mode: 0o700 })
  const lock = join(root, 'lock.yaml')
  const sdk = installedClaudeSdkEntrypoint(lock, binary)
  const manifest = JSON.parse(await readFile(join(dirname(sdk.entrypoint), 'package.json'), 'utf8'))
  const lockText = `packages:\n  '@anthropic-ai/claude-agent-sdk@${manifest.version}':\n    resolution: {integrity: sha512-aGVsbG8=}\n`
  await writeFile(lock, lockText)
  const path = join(root, 'workflow-runtime.json')
  const selected = { schemaVersion: 1, codexBinary: '/installed/codex', appMcpLauncher: '/installed/foreman-code-mcp',
    expectedVersion: '0.154.0', payloadPaths: [], claude: { binary, installedLockPath: lock } }
  await writeFile(path, JSON.stringify(selected), { mode: 0o600 })
  const binding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1,
    authorizationRevision: 1, bootId: randomUUID(), connectionGeneration: 1, connectionEpoch: randomUUID() }
  const input = { binding, configuration: { path, ownerUid: process.getuid!() },
    environment: { PATH: '/usr/bin' }, cwd: root, signal: new AbortController().signal }
  return { root, binary, lock, lockText, selected, path, input }
}

describe('installed worker Claude metadata and saved profile admission', () => {
  it('keeps an unchanged admitted policy after a current proof is refreshed, and refuses changed native pins or policy', async () => {
    const f = await fixture()
    const root = await mkdtemp(join(persistentFixtureRoot, 'worker-claude-policy-'))
    directories.push(root)
    const project = join(root, 'project')
    const runtime = join(root, 'runtime')
    await mkdir(project, { mode: 0o700 })
    await mkdir(runtime, { mode: 0o700 })
    const target = (await inspectInstalledClaude({ ...f.input, environment: process.env })).currentTarget!
    const harness = ClaudeHarnessConfigurationSchema.parse({ harness: 'claude', model: 'recorded-model',
      authMode: 'subscription', configDirectory: join(f.root, 'profile'), permissionMode: 'default',
      sandbox: 'danger-full-access', tools: [], permissionRules: [], instructions: '', mcpServers: {} })
    const override: HostHarnessOverride = { instanceId: randomUUID(), revision: 1, instanceRevision: 'profile-1',
      target: target.target, presetId: 'claude', enabled: true, driverId: 'claude', configuration: harness,
      configurationFingerprint: commandInputHash(harness), qualification: 'qualified' }
    const selector = { instanceId: override.instanceId, instanceRevision: override.instanceRevision, target: override.target }
    const configuration = AgentConfigurationVersionSchema.parse({ id: randomUUID(), agentId: 'agent',
      workspaceId: 'workspace', version: 1, harness, harnessProfileSelection: selector, prompt: {}, assignedSkills: [],
      contentHash: `sha256:${'a'.repeat(64)}`, createdAt: new Date().toISOString() })
    const binding = WorkerConversationBindingSchema.parse({ harness: 'claude', profile: selector,
      appMcpAccess: 'none', workingDirectory: project, owner: { kind: 'agent', agentId: configuration.agentId,
        workspaceId: configuration.workspaceId, workflowId: 'workflow', workflowNodeId: 'node',
        conversationId: randomUUID(), configurationVersionId: configuration.id,
        configurationHash: commandInputHash(configuration) } })
    // Recorded Main proof only. This tests pre-input admission; no SDK query or CLI is run.
    const proof: HostHarnessProfileEvidence = { target: override.target, instanceRevision: override.instanceRevision,
      configurationFingerprint: override.configurationFingerprint, driverId: 'claude', driverRevision: '1',
      protocolRevision: target.installation.protocolRevision, suiteRevision: CLAUDE_PROFILE_CHECK_REVISION,
      environmentGeneration: target.installation.environmentGeneration,
      connectionGeneration: target.installation.connectionGeneration, authenticated: true, compatible: true,
      qualified: true, checkedAt: '2026-10-05T00:00:00.000Z', claudeProof: { pin: {
        sdkVersion: target.installation.claudeSdk!.version, sdkIntegrity: target.installation.claudeSdk!.integrity,
        cliVersion: '2.1.284', configRevision: override.instanceRevision, profilePath: harness.configDirectory,
        executableSha256: target.installation.launcher.payloadFingerprints!
          .find(value => value.path === target.installation.launcher.resolvedLauncher)!.fingerprint,
      }, checks: Object.fromEntries(CLAUDE_QUALIFICATION_CHECKS.map(name => [name, {
        state: 'passed', source: 'native_scenario', evidenceId: 'recorded-admission', evidenceSha256: 'a'.repeat(64),
      }])) } }
    const baseHandle = await openPrivateRoot(project)
    const runtimeHandle = await openPrivateRoot(runtime)
    let roots
    try {
      roots = ApprovedRootAllowlistSchema.parse({ schemaVersion: 1, hostRef: target.target.hostRef,
        applicationInstallationId: target.target.applicationInstallationId, configurationRevision: '1',
        bases: [{ baseId: randomUUID(), canonicalPath: project, filesystem: await identity(baseHandle), accessModes: ['read-only', 'read-write'] }],
        managedRuntimeRoot: runtime, runtimeFilesystem: await identity(runtimeHandle) })
    } finally { await baseHandle.close(); await runtimeHandle.close() }
    const source: WorkerConversationRpcRequest = { method: 'conversation.initial-turn', binding, configuration,
      operationId: 'initial', correlationId: 'initial', prompt: 'Recorded admission only', admissionId: randomUUID() }
    const callbacks = workerConversationCallbacks({ currentBinding: () => f.input.binding, capture: () => undefined })
    const registry = new NativeProcessRegistry(join(root, 'processes'))
    const journal = await RemoteOperationJournal.open(join(root, 'operations.json'), { initializeNewInstallation: true })
    journals.push(journal)
    const allocation = await allocateInstalledWorkerClaude({ binding, configuration, connection: f.input.binding,
      purpose: 'chat', stateDirectory: f.root, selection: f.input.configuration, launcher: f.selected.appMcpLauncher,
      current: () => f.input.binding, source: () => source, callbacks: { ...callbacks,
        profile: async () => ({ installation: target.installation, override, profile: proof, qualification: null }) },
      approvedRoots: async () => roots, registry, journal: journal.conversations,
      request: async () => { throw new Error('No native application request is expected') }, signal: f.input.signal })
    const originalHint = process.env.NATIVE_PROFILE_FIXTURE_HINT
    try {
      process.env.NATIVE_PROFILE_FIXTURE_HINT = 'changed after allocation'
      const start = { correlationId: 'initial', instructionsDelivered: true }
      const starting = allocation.start(start)
      await expect(starting).resolves.toMatchObject({ kind: 'agent-chat', configuration })
      const before = await starting
      proof.checkedAt = '2026-10-05T01:00:00.000Z'
      expect(await allocation.start(start)).toEqual(before)
      proof.claudeProof!.pin.cliVersion = '2.1.286'
      await expect(allocation.start(start)).rejects.toMatchObject({ code: 'HARNESS_PROFILE_UNAVAILABLE' })
      proof.claudeProof!.pin.cliVersion = '2.1.284'
      proof.claudeProof!.checks.fullAccessPolicy!.state = 'failed'
      await expect(allocation.start(start)).rejects.toMatchObject({ result: { error: { code: 'CLAUDE_POLICY_UNQUALIFIED' } } })
    } finally {
      if (originalHint === undefined) delete process.env.NATIVE_PROFILE_FIXTURE_HINT
      else process.env.NATIVE_PROFILE_FIXTURE_HINT = originalHint
      await allocation.close()
    }
  })
  it('publishes SDK metadata without inventing CLI version, authentication or qualification', async () => {
    const f = await fixture()
    const result = await inspectInstalledClaude(f.input)
    expect(result.inventory.installations).toHaveLength(1)
    expect(result.currentTarget?.installation).toMatchObject({ driverId: 'claude',
      observedVersion: null, installed: true, authenticated: null, compatible: null, qualified: false,
      claudeSdk: { version: '0.3.284', integrity: 'sha512-aGVsbG8=' } })
    const missing = await inspectInstalledClaude({ ...f.input, configuration: null })
    expect(missing.currentTarget).toBeNull()
    expect(missing.inventory.installations).toHaveLength(0)
  })

  it('rejects missing lock integrity, unavailable selected executable and public installer configuration', async () => {
    const f = await fixture()
    await writeFile(f.lock, 'unrelated lock')
    await expect(inspectInstalledClaude(f.input)).rejects.toThrow('integrity')
    await writeFile(f.lock, f.lockText)
    await writeFile(f.path, JSON.stringify({ ...f.selected, claude: { ...f.selected.claude, binary: '/missing-selection' } }), { mode: 0o600 })
    await expect(inspectInstalledClaude(f.input)).rejects.toMatchObject({ code: 'ENOENT' })
    await chmod(f.path, 0o644)
    await expect(inspectInstalledClaude(f.input)).rejects.toMatchObject({ code: 'WORKER_WORKFLOW_UNAVAILABLE' })
  })

  it('requires the saved native check to match SDK, executable, profile, host and connection', async () => {
    const f = await fixture()
    const target = (await inspectInstalledClaude(f.input)).currentTarget!
    const configuration = ClaudeHarnessConfigurationSchema.parse({ harness: 'claude', model: 'qualified-model',
      authMode: 'subscription', configDirectory: join(f.root, 'profile'), permissionMode: 'default', sandbox: 'danger-full-access',
      tools: [], permissionRules: [], instructions: '', mcpServers: {} })
    const value: HostHarnessOverride = { instanceId: randomUUID(), revision: 1, instanceRevision: 'profile-1',
      target: target.target, presetId: 'claude', enabled: true, driverId: 'claude', configuration,
      configurationFingerprint: commandInputHash(configuration), qualification: 'qualified' }
    const pin = { sdkVersion: target.installation.claudeSdk!.version, sdkIntegrity: target.installation.claudeSdk!.integrity,
      cliVersion: '2.1.284', executableSha256: target.installation.launcher.payloadFingerprints!
        .find(payload => payload.path === target.installation.launcher.resolvedLauncher)!.fingerprint,
      profilePath: configuration.configDirectory, configRevision: value.instanceRevision }
    // This record exercises admission matching, not native qualification.
    const proof: HostHarnessProfileEvidence = { target: value.target, instanceRevision: value.instanceRevision,
      configurationFingerprint: value.configurationFingerprint, driverId: 'claude', driverRevision: '1',
      protocolRevision: target.installation.protocolRevision, suiteRevision: CLAUDE_PROFILE_CHECK_REVISION,
      environmentGeneration: target.installation.environmentGeneration,
      connectionGeneration: target.installation.connectionGeneration,
      authenticated: true, compatible: true, qualified: true, checkedAt: new Date().toISOString(),
      claudeProof: { pin, checks: {} } }
    const binding: RegistryHarnessSelection = { inventoryRevision: 1,
      installation: target.installation, instance: { instanceId: value.instanceId, instanceRevision: value.instanceRevision,
        driverId: 'claude', enabled: true, configuration, availability: 'available' },
      selection: { instanceId: value.instanceId, instanceRevision: value.instanceRevision, driverId: 'claude',
        hostRef: value.target.hostRef, harnessInstallationId: value.target.harnessInstallationId,
        installationFingerprint: value.target.installationFingerprint } }
    expect(installedClaudeProfilePin(value, binding, proof)).toEqual(pin)
    for (const change of [
      (record: HostHarnessProfileEvidence) => { record.suiteRevision = 'claude-profile-check-v1' },
      (record: HostHarnessProfileEvidence) => { record.suiteRevision = 'claude-profile-check-v2' },
      (record: HostHarnessProfileEvidence) => { record.qualified = false },
      (record: HostHarnessProfileEvidence) => { record.connectionGeneration = 'another-channel' },
      (record: HostHarnessProfileEvidence) => { record.claudeProof!.pin.sdkIntegrity = 'changed' },
      (record: HostHarnessProfileEvidence) => { record.claudeProof!.pin.executableSha256 = 'a'.repeat(64) },
      (record: HostHarnessProfileEvidence) => { record.claudeProof!.pin.profilePath = '/another-profile' },
      (record: HostHarnessProfileEvidence) => { record.target.applicationInstallationId = randomUUID() },
    ]) {
      const changed = structuredClone(proof)
      change(changed)
      expect(() => installedClaudeProfilePin(value, binding, changed)).toThrow('current native check')
    }
    expect(() => installedClaudeProfilePin(value, binding, null)).toThrow('current native check')
    const operator = OperatorConfigurationVersionSchema.parse({ id: 'configuration', operatorId: 'operator', version: 1,
      harness: configuration, harnessProfileSelection: { instanceId: value.instanceId,
        instanceRevision: value.instanceRevision, target: value.target },
      contentHash: `sha256:${'0'.repeat(64)}`, createdAt: new Date().toISOString() })
    const facts = { installation: target.installation, override: value, profile: proof, qualification: null }
    let current = f.input.binding
    const reader = createInstalledClaudeConversationProfile({ configuration: operator, connection: current,
      binding: { harness: 'claude', profile: operator.harnessProfileSelection!, workingDirectory: f.root, appMcpAccess: 'none',
        owner: { kind: 'operator', operatorId: operator.operatorId, conversationId: randomUUID(),
          configurationVersionId: operator.id, configurationHash: commandInputHash(operator) } },
      current: () => current, signal: f.input.signal,
      inspect: signal => inspectInstalledClaude({ ...f.input, binding: current, signal }), readFacts: async () => facts })
    expect((await reader.capture()).accepted.currentBinding.pin).toEqual(pin)
    current = { ...current, authorizationRevision: 2 }
    await expect(reader.capture()).rejects.toMatchObject({ code: 'HARNESS_PROFILE_UNAVAILABLE' })
  })
})
