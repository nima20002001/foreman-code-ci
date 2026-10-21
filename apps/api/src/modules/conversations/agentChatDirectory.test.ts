import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ClaudeFullAccessConfigurationSchema } from '@foreman-code/contracts/claude'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import { ApprovedRootAllowlistSchema, WorkspaceRootPolicySchema } from '@foreman-code/contracts/workspace-root-policies'
import { SavedNodePlacementSchema } from '@foreman-code/contracts/node-placement'
import { assertAgentChatDirectoryAvailable, resolveAgentChatDirectory, revalidateAgentChatDirectory } from './agentChatDirectory.js'
import { freezePlacement } from '../placement/binding.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'

function fixture() {
  const f = workerConversationFixture('agent')
  if (!('agentId' in f.configuration)) throw new Error('Agent fixture required')
  const baseId = randomUUID()
  const filesystem = { device: '1', inode: '2', mountId: '3' }
  const approved = ApprovedRootAllowlistSchema.parse({ schemaVersion: 1, hostRef: f.binding.profile.target.hostRef,
    applicationInstallationId: f.connection.workerInstallationId, configurationRevision: '1',
    bases: [{ baseId, canonicalPath: '/worker', filesystem, accessModes: ['read-only'] }],
    managedRuntimeRoot: '/worker/runtime', runtimeFilesystem: filesystem })
  const policy = WorkspaceRootPolicySchema.parse({ schemaVersion: 1, rootPolicyId: randomUUID(), rootPolicyRevision: '1',
    workspaceId: f.configuration.workspaceId, hostRef: approved.hostRef, applicationInstallationId: approved.applicationInstallationId,
    registration: { workerInstallationId: f.connection.workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    locationRevision: '1', ownerPrincipalId: 'original-owner', allowedBaseId: baseId, configurationRevision: '1',
    relativePath: 'project', accessMode: 'read-only', canonicalProjectRoot: '/worker/project', filesystem,
    directoryIdentityHash: 'a'.repeat(64), managedRuntimeRoot: approved.managedRuntimeRoot, runtimeFilesystem: filesystem,
    attestationId: randomUUID(), attestationDigest: 'b'.repeat(64) })
  const placement = SavedNodePlacementSchema.parse({ schemaVersion: 1, hostRef: approved.hostRef,
    rootPolicyId: policy.rootPolicyId, rootPolicyRevision: '1', locationRevision: '1', projectRoot: policy.canonicalProjectRoot,
    cwdPolicy: 'project-subdirectory', relativeCwd: 'src', instanceId: f.binding.profile.instanceId,
    instanceRevision: f.binding.profile.instanceRevision, harnessInstallationId: f.binding.profile.target.harnessInstallationId })
  const row = { policy, configuration: approved, revoked_at: null as Date | null }
  const query = vi.fn(async () => ({ rows: [row] }))
  const sql = { query } as unknown as Pick<pg.Pool, 'query'>
  return { ...f, configuration: f.configuration, approved, policy, placement, row, sql, query,
    input: { sql, configuration: f.configuration, placement, workflowVersionId: 'saved-version',
      location: { runnerId: 'runner-local', rootPath: '/main/workspace' } } }
}

it('selects the saved node folder on its worker and retains the root facts for later controls', async () => {
  const f = fixture()
  const result = await resolveAgentChatDirectory(f.input)
  expect(result.workingDirectory).toBe('/worker/project/src')
  expect(result.directoryBinding).toMatchObject({ workflowVersionId: 'saved-version', policy: f.policy, placement: f.placement })
  await revalidateAgentChatDirectory(f.sql, f.configuration, result.directoryBinding!, result.workingDirectory)
  f.row.revoked_at = new Date()
  await expect(revalidateAgentChatDirectory(f.sql, f.configuration, result.directoryBinding!, result.workingDirectory))
    .rejects.toThrow('missing or revoked')
})

it('rejects a foreign profile, unsafe subdirectory, changed approved roots and unapproved write access', async () => {
  const f = fixture()
  await expect(resolveAgentChatDirectory({ ...f.input, placement: { ...f.placement, instanceRevision: 'another-profile' } }))
    .rejects.toThrow('differs from its Agent profile')
  await expect(resolveAgentChatDirectory({ ...f.input, placement: { ...f.placement, relativeCwd: '../outside' } }))
    .rejects.toThrow('folder is invalid')
  f.approved.configurationRevision = '2'
  await expect(resolveAgentChatDirectory(f.input)).rejects.toThrow('approved host settings')
  f.approved.configurationRevision = '1'
  if (f.configuration.harness.harness !== 'codex') throw new Error('Codex fixture required')
  await expect(resolveAgentChatDirectory({ ...f.input, configuration: { ...f.configuration,
    harness: { ...f.configuration.harness, sandbox: 'workspace-write' } } })).rejects.toThrow('approved host settings')
})

it('preserves an unplaced local chat folder and uses the device workspace folder for a selected device profile', async () => {
  const f = fixture()
  const local = { ...f.configuration }
  delete local.harnessProfileSelection
  const input = { sql: f.sql, configuration: local, workflowVersionId: 'saved-version',
    location: { runnerId: 'runner-local', rootPath: '/main/workspace' } }
  expect(await resolveAgentChatDirectory(input)).toEqual({ workingDirectory: '/main/workspace' })
  const device = await resolveAgentChatDirectory({ ...input, configuration: f.configuration })
  expect(device.workingDirectory).toBe('/worker/project')
  expect(device.directoryBinding?.placement).toMatchObject({ hostRef: f.approved.hostRef, cwdPolicy: 'project-root', relativeCwd: '' })
  f.query.mockResolvedValueOnce({ rows: [] })
  await expect(resolveAgentChatDirectory({ ...input, configuration: f.configuration })).rejects.toThrow('no workspace folder')
})

it('requires an explicitly approved read-write root for the Claude profile', async () => {
  const f = fixture()
  const configuration = { ...f.configuration, harness: ClaudeFullAccessConfigurationSchema.parse({ harness: 'claude', model: 'profile-model',
      authMode: 'subscription', configDirectory: '/profile', permissionMode: 'default',
      sandbox: 'danger-full-access', tools: ['Write'], permissionRules: [], instructions: '', mcpServers: {} }) }
  const input = { ...f.input, configuration }
  await expect(resolveAgentChatDirectory(input)).rejects.toThrow('approved host settings')
  f.policy.accessMode = 'read-write'
  await expect(resolveAgentChatDirectory(input)).rejects.toThrow('approved host settings')
  f.approved.bases[0]!.accessModes.push('read-write')
  const result = await resolveAgentChatDirectory(input)
  expect(result.workingDirectory).toBe('/worker/project/src')
  expect(result.directoryBinding?.policy.accessMode).toBe('read-write')
  f.policy.accessMode = 'read-only'
  await expect(resolveAgentChatDirectory(input)).rejects.toThrow('approved host settings')
})

it.each(['codex', 'claude'] as const)(
  'checks a first %s Run follow-up on its accepted Worker without a saved profile selector', async harness => {
    const sql = runDirectorySql(harness, 'device', 'main')
    await expect(assertAgentChatDirectoryAvailable(sql, 'conversation')).resolves.toBeUndefined()
  },
)

it('uses the accepted Main placement even when a saved profile selects a Worker', async () => {
  const sql = runDirectorySql('codex', 'main', 'device')
  await expect(assertAgentChatDirectoryAvailable(sql, 'conversation'))
    .rejects.toMatchObject({ code: 'AGENT_CHAT_DIRECTORY_UNAVAILABLE' })
})

function runDirectorySql(harness: 'codex' | 'claude', hostKind: 'main' | 'device', profileHostKind: 'main' | 'device') {
  const mainId = randomUUID()
  const path = join(homedir(), '.cache', 'foreman-tmp', randomUUID(), 'worker-project')
  const digest = 'a'.repeat(64)
  const placement = freezePlacement({ schemaVersion: 1, mainId, mainInstallationId: mainId,
    runId: 'run', nodeId: 'node',
    hostRef: hostKind === 'device' ? { kind: 'device', mainId, deviceId: randomUUID() } : { kind: 'main', mainId },
    registration: hostKind === 'device'
      ? { workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1 } : null,
    destination: { canonicalProjectRoot: path, canonicalCwd: path, managedRuntimeRoot: '/runtime',
      directoryIdentityHash: digest, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1',
      attestationId: 'attestation', attestationHash: digest },
    source: { revisionId: 'source', manifestDigest: digest, materializationId: 'materialization', materializationDigest: digest },
    payload: { kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'configuration', driverId: harness,
      driverRevision: '1', instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'harness',
      installationFingerprint: digest, runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [],
      artifactOutputs: { version: 1, outputKeys: ['result'] } },
  })
  const query = async (text: string, values: unknown[]) => {
    if (text.includes('from run_node_placements')) {
      return { rows: values[0] === placement.runId && values[1] === placement.nodeId ? [{ record: placement }] : [] }
    }
    if (text.includes('from operator_conversations')) {
      return { rows: [{ path, host_kind: profileHostKind, origin_run_id: 'run', workflow_node_id: 'node' }] }
    }
    return { rows: [] }
  }
  return { query } as unknown as Pick<pg.Pool, 'query'>
}
