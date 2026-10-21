import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { ManagementPrincipalSchema } from '@foreman-code/contracts/management'
import { HostHarnessOverrideSchema } from '@foreman-code/contracts/harness-registry'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { WorkspaceRootPolicySchema } from '@foreman-code/contracts/workspace-root-policies'
import type { WorkspaceRootPolicyPort } from '../sources/rootPolicyPorts.js'
import type { SourceAdmissionPort } from '../sources/admissionPorts.js'
import type { HarnessInstanceSettingsRepository } from '../harnesses/instanceSettings/repository.js'
import type { ProductionHarnessRegistry } from '../harnesses/productionRegistry.js'
import { DomainError } from '../errors.js'
import { ProductionPlacementChoiceDiscovery } from './choiceDiscovery.js'

function fixture(options: { driver?: 'codex' | 'claude'; host?: 'main' | 'device'
  ensureProfileReady?: (profile: unknown) => Promise<void> } = {}) {
  const workflow = makeCurrentWorkflowFixture('computer-choices', 'single')
  const configuration = workflow.configurations[0]!
  const driver = options.driver ?? 'codex'
  if (driver === 'claude') {
    configuration.harness = { harness: 'claude', model: 'claude-haiku-4-5', authMode: 'subscription',
      configDirectory: '/home/operator/.claude', permissionMode: 'default', sandbox: 'danger-full-access',
      tools: ['Read', 'Write'], permissionRules: [], instructions: '', mcpServers: {} }
  }
  const mainId = randomUUID()
  const deviceId = randomUUID()
  const registration = options.host === 'device'
    ? { workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1 } : null
  const hostRef = options.host === 'device'
    ? { kind: 'device' as const, mainId, deviceId } : { kind: 'main' as const, mainId }
  const applicationInstallationId = registration?.workerInstallationId ?? mainId
  const rootId = randomUUID()
  const digest = 'a'.repeat(64)
  const principal = ManagementPrincipalSchema.parse({ id: 'owner', name: 'Owner', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, grants: [] })
  const policy = WorkspaceRootPolicySchema.parse({ schemaVersion: 1, rootPolicyId: randomUUID(),
    rootPolicyRevision: '1', workspaceId: configuration.workspaceId, hostRef,
    applicationInstallationId, registration, locationRevision: '1', ownerPrincipalId: principal.id,
    allowedBaseId: randomUUID(), configurationRevision: '1', relativePath: 'project', accessMode: 'read-write',
    canonicalProjectRoot: '/approved/project', filesystem: { device: '1', inode: '2', mountId: '3' },
    directoryIdentityHash: digest, managedRuntimeRoot: '/runtime',
    runtimeFilesystem: { device: '1', inode: '2', mountId: '3' }, attestationId: randomUUID(), attestationDigest: digest })
  const root = SourceRootRecordSchema.parse({ version: 1,
    source: { approvedSourceId: rootId, snapshotId: rootId, manifestDigest: digest },
    selection: { hostRef: policy.hostRef, rootPolicyId: policy.rootPolicyId,
      rootPolicyRevision: policy.rootPolicyRevision, locationRevision: policy.locationRevision },
    binding: { version: 1, mainId, deviceId: registration ? deviceId : null,
      workerInstallationId: registration?.workerInstallationId ?? null, workspaceId: configuration.workspaceId,
      rootId, bindingRevision: 2, locationRevision: 1, canonicalPath: '/source/namespace',
      filesystem: policy.filesystem, accessMode: 'exclusive-write', snapshotId: rootId, manifestDigest: digest },
    ownerPrincipalId: principal.id, authorizedByPrincipalId: principal.id, registration,
    attestationId: randomUUID(), attestationDigest: digest, boundAt: '2030-01-01T00:00:00.000Z' })
  const profile = HostHarnessOverrideSchema.parse({ instanceId: randomUUID(), revision: 3, instanceRevision: 'profile-3',
    target: { hostRef: policy.hostRef, applicationInstallationId,
      harnessInstallationId: `installed-${driver}`, installationFingerprint: digest },
    presetId: `${driver}-default`, enabled: true, driverId: driver, configuration: configuration.harness,
    configurationFingerprint: digest, qualification: 'qualified' })
  const sourceRoots = vi.fn(async () => [root])
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('from agent_configuration_versions')) return { rows: [{ record: configuration }] }
    if (sql.includes('from source_root_catalog')) return { rows: (await sourceRoots()).map(record => ({ record })) }
    return { rows: [] }
  })
  const pool = { connect: async () => ({ query, release: vi.fn() }) } as unknown as pg.Pool
  const readRoots = vi.fn(async () => [policy])
  const resolve = vi.fn(async () => policy)
  const resolveSource = vi.fn(async () => root)
  const profiles = vi.fn(async () => [profile])
  const evidence = vi.fn(async () => ({ qualified: true }))
  const installations = vi.fn(() => [{ hostRef: policy.hostRef, installed: true,
    harnessInstallationId: profile.target.harnessInstallationId, installationFingerprint: digest }])
  const services = {
    roots: { read: readRoots, resolve } as unknown as WorkspaceRootPolicyPort,
    sources: { resolveRootBinding: resolveSource } as unknown as SourceAdmissionPort,
    profiles: { list: profiles } as unknown as HarnessInstanceSettingsRepository,
    registry: { installations: { list: installations }, profileEvidence: evidence } as unknown as
      Pick<ProductionHarnessRegistry, 'installations' | 'profileEvidence'>,
    ...(options.ensureProfileReady ? { ensureProfileReady: options.ensureProfileReady } : {}),
  }
  const input = { workspaceId: configuration.workspaceId, workflowId: workflow.scope.workflowId,
    nodeId: workflow.version.definition.nodes[0]!.id, agentConfigurationVersionId: configuration.id }
  return { service: new ProductionPlacementChoiceDiscovery(pool, () => services), input, principal,
    policy, root, profile, configuration, readRoots, resolve, resolveSource, sourceRoots, profiles, evidence, installations }
}

it('discovers an authorized matching profile with the persisted root, source and revision pins', async () => {
  const f = fixture()
  const choices = (await f.service.list(f.principal, f.input)).choices
  expect(choices).toHaveLength(1)
  expect(choices[0]).toMatchObject({ availability: 'ready', reason: null, placement: {
    hostRef: f.policy.hostRef, projectRoot: f.policy.canonicalProjectRoot, rootPolicyId: f.policy.rootPolicyId,
    rootPolicyRevision: f.policy.rootPolicyRevision, locationRevision: f.policy.locationRevision,
    instanceId: f.profile.instanceId, instanceRevision: f.profile.instanceRevision,
    harnessInstallationId: f.profile.target.harnessInstallationId, source: f.root.source,
    rootBinding: { rootId: f.root.binding.rootId, bindingRevision: 2 },
  } })
  expect(f.resolveSource).toHaveBeenCalledOnce()
  expect(((await f.service.list(f.principal, f.input)).choices)[0]!.id).toBe(choices[0]!.id)
})

it.each(['main', 'device'] as const)('offers both identical qualified profiles on %s', async host => {
  const f = fixture({ host })
  const duplicate = { ...f.profile, instanceId: randomUUID() }
  const writable = { ...f.profile, instanceId: randomUUID(),
    configuration: { ...f.profile.configuration, sandbox: 'workspace-write' as const } }
  f.profiles.mockResolvedValue([duplicate, writable, f.profile])

  const result = await f.service.list(f.principal, f.input)

  expect(result.pending).toBe(false)
  expect(result.choices).toHaveLength(2)
  expect(result.choices.map(choice => choice.placement.instanceId).sort())
    .toEqual([f.profile.instanceId, duplicate.instanceId].sort())
  expect(result.choices.every(choice => choice.availability === 'ready' && choice.reason === null)).toBe(true)
  expect(new Set(result.choices.map(choice => choice.id)).size).toBe(2)
})

it.each([
  { driver: 'codex', host: 'main', availability: 'ready' },
  { driver: 'codex', host: 'device', availability: 'ready' },
  { driver: 'claude', host: 'main', availability: 'ready' },
  { driver: 'claude', host: 'device', availability: 'unavailable' },
] as const)('matches workflow driver support for $driver on $host', async ({ driver, host, availability }) => {
  const f = fixture({ driver, host })

  const choices = (await f.service.list(f.principal, f.input)).choices

  expect(choices).toHaveLength(1)
  expect(choices[0]).toMatchObject({ availability, placement: { hostRef: f.policy.hostRef } })
  if (availability === 'ready') {
    expect(choices[0]!.reason).toBeNull()
    expect(f.evidence).toHaveBeenCalledOnce()
  } else {
    expect(choices[0]!.reason).toBe('This harness does not support workflow execution on this computer.')
    expect(f.evidence).not.toHaveBeenCalled()
  }
})

it('omits disabled or incompatible profiles and respects a saved profile selection', async () => {
  const f = fixture()
  f.profiles.mockResolvedValue([{ ...f.profile, enabled: false },
    { ...f.profile, configuration: { ...f.configuration.harness, model: 'different-model' } }])
  expect((await f.service.list(f.principal, f.input)).choices).toEqual([])
  f.configuration.harnessProfileSelection = { target: f.profile.target,
    instanceId: randomUUID(), instanceRevision: f.profile.instanceRevision }
  f.profiles.mockResolvedValue([f.profile])
  expect((await f.service.list(f.principal, f.input)).choices).toEqual([])
})

it('uses the retained binding policy after the workspace selects a newer location policy', async () => {
  const f = fixture()
  f.readRoots.mockResolvedValue([{ ...f.policy, rootPolicyRevision: '2', locationRevision: '3' }])

  const choices = (await f.service.list(f.principal, f.input)).choices

  expect(choices).toHaveLength(1)
  expect(choices[0]).toMatchObject({ availability: 'ready', placement: {
    ...f.root.selection, rootBinding: { rootId: f.root.binding.rootId, bindingRevision: 2 },
  } })
  expect(f.resolve).toHaveBeenCalledWith(expect.anything(), f.principal, {
    workspaceId: f.input.workspaceId, ...f.root.selection,
  })
})

it('keeps unqualified installations and revoked root authority unavailable with their reasons', async () => {
  const f = fixture()
  f.installations.mockReturnValue([])
  expect(((await f.service.list(f.principal, f.input)).choices)[0]).toMatchObject({ availability: 'unavailable',
    reason: 'The matching harness profile needs qualification on this computer.' })
  expect(f.evidence).not.toHaveBeenCalled()
  f.resolve.mockRejectedValue(new DomainError('ROOT_DEVICE_CONFLICT', 'Host was revoked.', 403))
  expect((await f.service.list(f.principal, f.input)).choices).toEqual([expect.objectContaining({
    availability: 'unavailable', reason: 'Host was revoked.', placement: expect.objectContaining({
      hostRef: f.root.selection.hostRef, projectRoot: f.root.binding.canonicalPath,
      source: f.root.source,
    }),
  })])
  expect(f.resolveSource).toHaveBeenCalledTimes(1)
  expect(f.evidence).not.toHaveBeenCalled()
})

it('propagates unexpected discovery failures', async () => {
  const f = fixture()
  f.resolve.mockRejectedValue(new Error('database unavailable'))
  await expect(f.service.list(f.principal, f.input)).rejects.toThrow('database unavailable')
})

it.each([403, 404, 409, 410])('keeps valid sibling sources when one binding returns %s', async status => {
  const f = fixture()
  const unavailable = structuredClone(f.root)
  unavailable.binding.rootId = randomUUID()
  unavailable.source.snapshotId = randomUUID()
  unavailable.binding.snapshotId = unavailable.source.snapshotId
  f.sourceRoots.mockResolvedValue([unavailable, f.root])
  f.resolveSource.mockRejectedValueOnce(new DomainError('SOURCE_UNAVAILABLE', 'Source is unavailable.', status))

  const choices = (await f.service.list(f.principal, f.input)).choices

  expect(choices).toHaveLength(2)
  expect(choices[0]).toMatchObject({ availability: 'unavailable',
    reason: 'The approved source was released. Approve and bind the source again.', placement: {
      source: unavailable.source,
      rootBinding: { rootId: unavailable.binding.rootId, bindingRevision: unavailable.binding.bindingRevision },
    } })
  expect(choices[1]).toMatchObject({ availability: 'ready', placement: {
    source: f.root.source,
    rootBinding: { rootId: f.root.binding.rootId, bindingRevision: f.root.binding.bindingRevision },
  } })
  expect(f.resolveSource).toHaveBeenCalledTimes(2)
  expect(f.evidence).toHaveBeenCalledOnce()
})

it('reports a missing binding without hiding its computer', async () => {
  const f = fixture({ host: 'device' })
  f.resolveSource.mockRejectedValue(new DomainError('SOURCE_ROOT_NOT_FOUND', 'The root binding was not found.', 404))

  expect((await f.service.list(f.principal, f.input)).choices).toEqual([expect.objectContaining({
    availability: 'unavailable', reason: 'The root binding was not found.',
    placement: expect.objectContaining({ hostRef: f.policy.hostRef }),
  })])
  expect(f.evidence).not.toHaveBeenCalled()
})


it('offers the current qualified installation for an unchanged saved profile revision', async () => {
  const f = fixture({ host: 'device' })
  f.configuration.harnessProfileSelection = { instanceId: f.profile.instanceId,
    instanceRevision: f.profile.instanceRevision,
    target: { ...f.profile.target, harnessInstallationId: 'previous', installationFingerprint: 'previous' } }
  expect((await f.service.list(f.principal, f.input)).choices).toEqual([expect.objectContaining({
    availability: 'ready', placement: expect.objectContaining({
      harnessInstallationId: f.profile.target.harnessInstallationId,
      instanceRevision: f.profile.instanceRevision,
    }),
  })])
  f.installations.mockReturnValue([])
  expect((await f.service.list(f.principal, f.input)).choices).toEqual([expect.objectContaining({ availability: 'unavailable' })])
  f.profile.instanceRevision = 'edited'
  expect((await f.service.list(f.principal, f.input)).choices).toEqual([])
})

it('reports discovery as pending while a matching profile check is running', async () => {
  const reason = 'The selected harness profile is being checked. Retry Run start shortly.'
  const ensureProfileReady = vi.fn(async (): Promise<void> => { throw new DomainError('HARNESS_PROFILE_CHECK_PENDING', reason, 503) })
  const f = fixture({ ensureProfileReady })
  const discovered = await f.service.list(f.principal, f.input)
  expect(discovered.pending).toBe(true)
  expect(discovered.choices).toEqual([expect.objectContaining({ availability: 'unavailable', reason })])
  ensureProfileReady.mockResolvedValue(undefined)
  const settled = await f.service.list(f.principal, f.input)
  expect(settled.pending).toBe(false)
  expect(settled.choices).toEqual([expect.objectContaining({ availability: 'ready' })])
})
