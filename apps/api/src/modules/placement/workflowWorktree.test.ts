import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { beforeEach, expect, it, vi } from 'vitest'
import type { HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { canonicalGraphJson, makeCurrentWorkflowFixture, RunStartV3InputSchema } from '@foreman-code/contracts/wave25'
import type { ProductionHarnessRegistry } from '../harnesses/productionRegistry.js'
import type { SourceAdmissionPort } from '../sources/admissionPorts.js'
import type { WorkspaceRootPolicyPort } from '../sources/rootPolicyPorts.js'
import { createSourceManifest } from '../sources/manifest.js'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import { AgentPlacementProducer } from './agentProducer.js'
import { readPlacement } from './binding.js'
import { readPlacementHarnessFacts } from './harnessFacts.js'
import { DomainError } from '../errors.js'

vi.mock('./harnessFacts.js', () => ({ readPlacementHarnessFacts: vi.fn() }))
beforeEach(() => {
  vi.mocked(readPlacementHarnessFacts).mockImplementation(async () => ({ profileProof: { qualified: true } }) as never)
})

function fixture(options: { repository?: boolean } = {}) {
  const seed = makeCurrentWorkflowFixture('workflow-worktree', 'single')
  const version = structuredClone(seed.version)
  const node = version.definition.nodes[0]!
  const configuration = seed.configurations[0]!
  const mainId = randomUUID()
  const deviceId = randomUUID()
  const workerInstallationId = randomUUID()
  const digest = 'a'.repeat(64)
  const hostRef = { kind: 'device' as const, mainId, deviceId }
  const manifest = createSourceManifest({ version: 1, approvedSourceId: randomUUID(), snapshotId: randomUUID(),
    capturePolicy: 'git-tree-v1', executablePolicy: 'strip', entries: [], deletions: [],
    git: { commit: 'b'.repeat(40), tree: 'c'.repeat(40), objectFormat: 'sha1', repository: 'octo/site' } })
  const root = SourceRootRecordSchema.parse({ version: 1,
    source: { approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId,
      manifestDigest: manifest.manifestDigest },
    selection: { hostRef, rootPolicyId: randomUUID(), rootPolicyRevision: '1', locationRevision: '1' },
    binding: { version: 1, mainId, deviceId, workerInstallationId, workspaceId: version.workspaceId,
      rootId: randomUUID(), bindingRevision: 1, locationRevision: 1, canonicalPath: '/worker/runtime/source',
      filesystem: { device: '1', inode: '2', mountId: '3' }, accessMode: 'exclusive-write',
      snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest },
    registration: { workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    ownerPrincipalId: 'operator', authorizedByPrincipalId: 'operator',
    attestationId: randomUUID(), attestationDigest: digest, boundAt: seed.createdAt })
  version.definition.defaultWorktree = { rootBinding: { rootId: root.binding.rootId, bindingRevision: 1 },
    branchPrefix: 'foreman/site/default' }
  const target = { hostRef, applicationInstallationId: workerInstallationId,
    harnessInstallationId: 'installed-codex', installationFingerprint: digest }
  const profile: HostHarnessOverride = { instanceId: randomUUID(), revision: 1, instanceRevision: '1', target,
    presetId: 'codex', enabled: true, driverId: 'codex', configuration: configuration.harness,
    configurationFingerprint: digest, qualification: 'qualified' }
  const profiles = [profile]
  const catalog = { root }
  const sources = { resolveRootBinding: vi.fn(async (_sql: unknown, _principal: unknown,
    input: { bindingRevision: number }) => {
    if (input.bindingRevision !== root.binding.bindingRevision) {
      throw new DomainError('SOURCE_ROOT_NOT_FOUND', 'Source binding revision not found.', 404)
    }
    return root
  }),
    resolveApprovedSource: vi.fn(async () => ({ manifest })) } as unknown as SourceAdmissionPort
  const policy = { ...root.selection, canonicalProjectRoot: '/worker/project', managedRuntimeRoot: '/worker/runtime',
    registration: root.registration, applicationInstallationId: workerInstallationId }
  const roots = { resolve: vi.fn(async () => policy), read: vi.fn(async () => [policy]) } as unknown as WorkspaceRootPolicyPort
  const installations = { list: () => [{ ...target, installed: true,
    driverRevision: '1', protocolRevision: 'native-v1' }], assertCurrent: vi.fn() }
  const registry = { installations, pinOverride: (value: HostHarnessOverride) => ({
    selection: { driverId: 'codex', instanceId: value.instanceId, instanceRevision: value.instanceRevision,
      harnessInstallationId: value.target.harnessInstallationId, installationFingerprint: digest },
    installation: { driverRevision: '1', protocolRevision: 'native-v1' },
  }) } as unknown as Pick<ProductionHarnessRegistry, 'installations' | 'pinOverride'>
  const client = { query: async (text: string, values?: unknown[]) => {
    let rows: unknown[] = []
    if (text.includes('from workflow_versions')) {
      rows = [{ id: version.id, workspace_id: version.workspaceId, workflow_id: version.workflowId,
        version: version.version, entry_node_id: version.entryNodeId, execution_semantics_version: 3, record: version }]
    } else if (text.includes('from agent_configuration_versions')) {
      rows = [{ id: configuration.id, agent_id: configuration.agentId, record: configuration }]
    }
    else if (text.includes('from workspaces') && options.repository) rows = [{ record: {
      id: version.workspaceId, name: 'GitHub workspace',
      repository: { provider: 'github', owner: 'octo', name: 'site', defaultBranch: 'main' },
    } }]
    else if (text.includes('from source_root_bindings')) rows = [{ record: catalog.root }]
    else if (text.includes('from harness_instance_settings')) {
      const selected = text.includes('where instance_id=$1')
        ? profiles.filter(profile => profile.instanceId === values?.[0]) : profiles
      rows = selected.map(record => ({ record }))
    }
    return { rows, rowCount: rows.length }
  }, on: () => {}, removeListener: () => {}, release: () => {} }
  const refresh = vi.fn(async () => {})
  const producer = new AgentPlacementProducer({ connect: async () => client } as unknown as pg.Pool, mainId,
    sources, roots, registry, { codex: 'suite' }, new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }),
    undefined, refresh)
  const principal = { id: 'operator', name: 'Operator', audience: 'operator' as const,
    grants: [], expiresAt: '2099-01-01T00:00:00Z', revokedAt: null }
  async function prepare() {
    version.contentHash = `sha256:${createHash('sha256').update(canonicalGraphJson({ definition: version.definition,
      configurations: version.agentConfigurationVersionIds, entryNodeId: version.entryNodeId })).digest('hex')}`
    return producer.prepare(RunStartV3InputSchema.parse({ workspaceId: version.workspaceId,
      workflowId: version.workflowId, workflowVersionId: version.id,
      expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds,
      commandId: randomUUID(), executionSemanticsVersion: 3, expectedWorkflowRevision: 1,
      expectedLocationRevision: 1, input: {} }), principal)
  }
  return { prepare, node, version, root, profile, profiles, policy, refresh, configuration, sources, catalog }
}

it('refreshes the inherited computer and freezes the workflow root and Agent prefix override', async () => {
  const f = fixture()
  f.node.worktree = { branchPrefix: 'foreman/site/reviewer' }
  const prepared = await f.prepare()
  const placement = prepared!.bind('run-one')[0]!
  expect(f.refresh).toHaveBeenCalledWith([f.root.selection.hostRef], undefined)
  expect(placement).toMatchObject({ labelAtAcceptance: 'Workflow default', hostRef: f.root.selection.hostRef,
    source: { snapshotId: f.root.source.snapshotId, rootId: f.root.binding.rootId },
    payload: { worktree: { repository: 'octo/site', branch: 'foreman/site/reviewer' } } })
  f.node.worktree.branchPrefix = 'foreman/changed'
  f.version.definition.defaultWorktree!.branchPrefix = 'foreman/changed-default'
  expect(prepared!.bind('run-one')).toEqual([placement])
  const substituted = structuredClone(placement)
  if (substituted.payload.kind !== 'agent') throw new Error('Expected Agent placement')
  substituted.payload.worktree!.branch = 'foreman/substituted'
  expect(() => readPlacement(substituted)).toThrow('Accepted placement hash')
})

it('binds a GitHub Run to its freshly approved root without changing the saved workflow reference', async () => {
  const f = fixture({ repository: true })
  const freshRoot = structuredClone(f.root)
  freshRoot.source.snapshotId = randomUUID()
  freshRoot.source.approvedSourceId = randomUUID()
  freshRoot.binding.snapshotId = freshRoot.source.snapshotId
  freshRoot.binding.bindingRevision = 2
  const prepare = vi.fn(async () => {
    f.catalog.root = freshRoot
    return [freshRoot]
  })
  f.sources.prepareRunSources = prepare
  vi.mocked(f.sources.resolveRootBinding).mockImplementation(async (_sql, _principal, input) =>
    input.bindingRevision === 2 ? freshRoot : f.root)
  const original = structuredClone(f.version.definition)
  const accepted = (await f.prepare())!.bind('run-fresh')[0]!
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(accepted.source).toMatchObject({ snapshotId: freshRoot.source.snapshotId,
    rootId: freshRoot.binding.rootId, bindingRevision: 2 })
  expect(f.version.definition).toEqual(original)
})

it('binds generated branch naming to the Run using immutable workflow and node names', async () => {
  const f = fixture()
  delete f.version.definition.defaultWorktree!.branchPrefix
  const prepared = await f.prepare()
  const first = prepared!.bind('run-first')[0]!
  const second = prepared!.bind('run-second')[0]!
  expect(first.payload).toMatchObject({ worktree: { branch: expect.stringContaining('-first') } })
  expect(second.payload).toMatchObject({ worktree: { branch: expect.stringContaining('-second') } })
  expect(first.bindingHash).not.toBe(second.bindingHash)
})

it('uses an explicit node placement without resolving the workflow default root', async () => {
  const f = fixture()
  f.node.placement = { schemaVersion: 1, ...f.root.selection, projectRoot: f.policy.canonicalProjectRoot,
    cwdPolicy: 'project-subdirectory', relativeCwd: 'src', instanceId: f.profile.instanceId,
    instanceRevision: f.profile.instanceRevision, harnessInstallationId: f.profile.target.harnessInstallationId,
    source: f.root.source, rootBinding: { rootId: f.root.binding.rootId, bindingRevision: 1 } }
  f.version.definition.defaultWorktree!.rootBinding.rootId = randomUUID()
  const prepared = await f.prepare()
  expect(prepared!.bind('run-one')[0]).toMatchObject({
    destination: { canonicalCwd: '/worker/project/src' }, payload: { instanceId: f.profile.instanceId } })
})

it('selects equivalent qualified profiles deterministically and rejects read-only branch requests', async () => {
  const f = fixture()
  f.profile.instanceId = '00000000-0000-4000-8000-000000000002'
  const selectedInstanceId = '00000000-0000-4000-8000-000000000001'
  f.profiles.push({ ...f.profile, instanceId: selectedInstanceId })
  const placement = (await f.prepare())!.bind('run-one')[0]!
  expect(placement).toMatchObject({ hostRef: f.root.selection.hostRef, payload: { instanceId: selectedInstanceId } })
  f.profiles.reverse()
  expect((await f.prepare())!.bind('run-one')[0]).toEqual(placement)
  f.profiles.pop()
  f.root.binding.accessMode = 'read-only'
  await expect(f.prepare()).rejects.toMatchObject({ code: 'WORKTREE_BRANCH_UNAVAILABLE' })
  delete f.version.definition.defaultWorktree!.branchPrefix
  expect((await f.prepare())!.bind('run-one')[0]?.payload).not.toHaveProperty('worktree')
})

it('selects the qualified profile when an identical installed profile is unqualified', async () => {
  const f = fixture()
  const unqualified = { ...f.profile, instanceId: randomUUID(), qualification: 'unqualified' as const }
  f.profiles.push(unqualified)
  vi.mocked(readPlacementHarnessFacts).mockImplementation(async (_sql, placement) => {
    if (placement.payload.kind === 'agent' && placement.payload.instanceId === unqualified.instanceId) {
      throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'Qualification has not completed.', 409)
    }
    return { profileProof: { qualified: true } } as never
  })
  expect((await f.prepare())!.bind('run-one')[0]?.payload)
    .toMatchObject({ instanceId: f.profile.instanceId })
})

it('preserves qualification denial when no compatible profile is qualified', async () => {
  const f = fixture()
  vi.mocked(readPlacementHarnessFacts).mockRejectedValue(
    new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'Qualification has not completed.', 409))
  await expect(f.prepare()).rejects.toMatchObject({ code: 'HARNESS_PROFILE_UNAVAILABLE' })
})

it('fails an unavailable inherited source before refreshing a replacement computer', async () => {
  const f = fixture()
  vi.mocked(f.sources.resolveRootBinding).mockRejectedValueOnce(new Error('Retained source unavailable'))
  await expect(f.prepare()).rejects.toThrow('Retained source unavailable')
  expect(f.refresh).not.toHaveBeenCalled()
})

it.each(['explicit', 'workflow-default'] as const)(
  'resolves saved %s placement against the latest policy, binding and enabled instance', async mode => {
    const f = fixture()
    if (mode === 'explicit') {
      f.node.placement = { schemaVersion: 1, ...f.root.selection, projectRoot: f.policy.canonicalProjectRoot,
        cwdPolicy: 'project-subdirectory', relativeCwd: 'src', instanceId: f.profile.instanceId,
        instanceRevision: f.profile.instanceRevision, harnessInstallationId: f.profile.target.harnessInstallationId,
        source: structuredClone(f.root.source), rootBinding: { rootId: f.root.binding.rootId, bindingRevision: 1 } }
    }
    const original = structuredClone(f.version.definition)
    f.policy.rootPolicyRevision = '3'
    f.policy.locationRevision = '6'
    f.policy.canonicalProjectRoot = '/worker/selected-project'
    f.root.selection = { ...f.root.selection, rootPolicyRevision: '3', locationRevision: '6' }
    f.root.binding.bindingRevision = 2
    f.root.binding.locationRevision = 6
    f.root.source.snapshotId = randomUUID()
    f.root.binding.snapshotId = f.root.source.snapshotId
    f.profile.instanceRevision = '2'
    f.profile.revision = 2
    const accepted = (await f.prepare())!.bind('run-latest')[0]!
    expect(accepted.destination).toMatchObject({ rootPolicyRevision: '3', locationRevision: '6',
      canonicalProjectRoot: '/worker/selected-project',
      canonicalCwd: mode === 'explicit' ? '/worker/selected-project/src' : '/worker/selected-project' })
    expect(accepted.source).toMatchObject({ snapshotId: f.root.source.snapshotId, bindingRevision: 2 })
    expect(accepted.payload).toMatchObject({ instanceId: f.profile.instanceId, instanceRevision: '2' })
    expect(f.version.definition).toEqual(original)
  },
)

it.each(['disabled-instance', 'different-host', 'missing-policy'] as const)(
  'rejects saved placement with a %s without selecting another computer or instance', async reason => {
    const f = fixture()
    f.node.placement = { schemaVersion: 1, ...f.root.selection, projectRoot: f.policy.canonicalProjectRoot,
      cwdPolicy: 'project-root', relativeCwd: '', instanceId: f.profile.instanceId,
      instanceRevision: f.profile.instanceRevision, harnessInstallationId: f.profile.target.harnessInstallationId,
      source: f.root.source, rootBinding: { rootId: f.root.binding.rootId, bindingRevision: 1 } }
    if (reason === 'disabled-instance') f.profile.enabled = false
    if (reason === 'different-host') {
      f.profile.target.hostRef = { kind: 'device', mainId: f.root.selection.hostRef.mainId, deviceId: randomUUID() }
    }
    if (reason === 'missing-policy') f.policy.rootPolicyId = randomUUID()
    await expect(f.prepare()).rejects.toMatchObject({ code: 'PLACEMENT_ADMISSION_CONFLICT' })
  },
)
