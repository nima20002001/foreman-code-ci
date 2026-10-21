import { randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { BuildComputerPrepareStatusSchema, CI_HOST_NAMESPACE, CI_RUNTIME_NAMESPACE, CiEnrollmentStateSchema, CiRuntimeWorkerStateSchema,
  type BuildComputerPrepareInput } from '@foreman-code/contracts'
import { ManagementActionSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { ApprovedSourceSchema, SourceRootBindResultSchema } from '@foreman-code/contracts/source-admission'
import { describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { DeviceEndpoint } from '../src/modules/devices/deviceEndpoint.js'
import { PostgresDeviceAccessService } from '../src/modules/devices/access.js'
import { CI_PREPARATION_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { CiEnrollment } from '../src/modules/jobs/ciEnrollment.js'
import { ProductionCiEnrollmentInventory } from '../src/modules/jobs/ciEnrollmentInventory.js'
import { ciEnrollmentProfileInput } from '../src/modules/jobs/ciEnrollmentProfiles.js'
import { JobRuntimeProfiles } from '../src/modules/jobs/runtimeProfiles.js'
import { BuildComputerSettings } from '../src/modules/settings/buildComputers.js'
import { WorkerExecutionPolicy } from '../src/modules/settings/workerExecution.js'
import { createSourceManifest, sourceSha256 } from '../src/modules/sources/manifest.js'
import { createProductionSources } from '../src/modules/sources/production.js'
import { createWorkspaceRootWorkerHandler, qualifyApprovedRootAllowlist } from '../src/modules/sources/rootAttestation.js'
import { ManagedWorkspaceRootService } from '../src/modules/workspace-roots/managedRoot.js'
import { WorkspaceBoundLocationService } from '../src/modules/workspace-roots/service.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { buildComputerFixture } from './helpers/buildComputerFixture.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { deferred } from './helpers/deferred.js'
import { removeFixtureDirectory } from './helpers/testResources.js'
import { verificationCapacityFixture } from './helpers/verificationCapacityFixture.js'
import { workspaceRootDirectory } from './helpers/workspaceRootDirectory.js'

// PostgreSQL, source/root services, filesystem checks and authenticated MCP are real; CI preparation is bounded.
async function fixture(options: { managedStorage: boolean; hostCi?: boolean; beforePrepare?: () => Promise<void> }) {
  const db = await currentDatabase()
  const directory = await workspaceRootDirectory()
  const clients: Client[] = []
  let enrollment: CiEnrollment | undefined
  let app: ReturnType<typeof buildApp> | undefined
  const close = async () => {
    await enrollment?.close()
    await Promise.allSettled(clients.map(client => client.close()))
    await app?.close()
    await db.close()
    await removeFixtureDirectory(directory)
  }
  try {
    const workspaceId = randomUUID()
    const mainId = (await db.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    const access = new PostgresAccessService(db.pool)
    const commands = new PostgresCommandCoordinator(db.pool)
    const owner = await access.issue({ name: 'Managed CI owner', audience: 'operator',
      grants: [{ actions: ManagementActionSchema.options, scope: {} }],
      expiresAt: new Date(Date.now() + 600_000) })
    await db.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
      [workspaceId, JSON.stringify({ id: workspaceId, name: 'Managed CI enrollment' })])
    const worker = buildComputerFixture(mainId, workspaceId)
    await db.pool.query(`insert into device_registrations(id,main_id,worker_installation_id,public_key,record)
      values($1,$2,$3,'fixture',$4::jsonb)`,
    [worker.registration.deviceId, mainId, worker.registration.workerInstallationId, JSON.stringify(worker.registration)])
    const mainBase = join(directory, 'main-projects')
    const mainRuntime = join(directory, 'main-runtime')
    const arbitraryBase = join(directory, 'user-approved')
    const managedBase = join(directory, 'worker-managed')
    const workerRuntime = join(directory, 'worker-runtime')
    for (const path of [mainBase, mainRuntime, arbitraryBase, managedBase, workerRuntime]) {
      await mkdir(path, { mode: 0o700 })
    }
    for (const path of [mainBase, arbitraryBase]) await mkdir(join(path, 'project'), { mode: 0o700 })
    const mainAllowlist = await qualifyApprovedRootAllowlist({ schemaVersion: 1,
      hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId, configurationRevision: '1',
      bases: [{ baseId: randomUUID(), canonicalPath: mainBase, accessModes: ['read-only', 'read-write'] }],
      managedRuntimeRoot: mainRuntime })
    const workerAllowlist = await qualifyApprovedRootAllowlist({ schemaVersion: 1,
      hostRef: worker.target.hostRef, applicationInstallationId: worker.target.applicationInstallationId,
      configurationRevision: '1', managedRuntimeRoot: workerRuntime,
      bases: [
        { baseId: randomUUID(), canonicalPath: arbitraryBase, accessModes: ['read-only', 'read-write'] },
        { baseId: randomUUID(), canonicalPath: managedBase, accessModes: ['read-only', 'read-write'],
          ...(options.managedStorage ? { managedBy: 'worker-pairing' as const } : {}) },
      ] })
    const binding = { ...worker.registration, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1 }
    const rootRequests: string[] = []
    const rootHandler = createWorkspaceRootWorkerHandler(async () => workerAllowlist, async () => {})
    const template = verificationCapacityFixture('main')
    const storage = { diskBytes: template.spec.resources.limits.diskBytes * 2,
      mutableInodes: template.spec.resources.mutableInodes * 2 }
    const managedSetup = { state: 'ready' as const, migrated: true, message: null, updatedAt: new Date().toISOString() }
    const runtimeState = CiRuntimeWorkerStateSchema.parse({ operationId: null, state: 'idle', commit: null,
      stage: null, prepared: null, message: null, updatedAt: managedSetup.updatedAt, installedStorage: storage, managedSetup })
    const endpoint = { currentBinding: () => binding,
      capabilities: () => options.hostCi ? [{ namespace: CI_HOST_NAMESPACE, mainCanRequest: true }] : [],
      captureRequest: (_deviceId: string, namespace: string) => ({ binding, request: async (raw: unknown) => {
        if (namespace === CI_HOST_NAMESPACE) return { payload: { operation: 'status', ready: true,
          reasons: [], cpuCount: 8, memoryBytes: 16 * 2 ** 30, runs: [] } }
        if (namespace === CI_RUNTIME_NAMESPACE) return { payload: runtimeState }
        rootRequests.push((raw as { operation: string }).operation)
        return { payload: await rootHandler(raw) }
      } }),
      request: async (_deviceId: string, _namespace: string, raw: unknown) => {
        rootRequests.push((raw as { operation: string }).operation)
        return { payload: await rootHandler(raw) }
      } } as unknown as DeviceEndpoint
    const locations = new WorkspaceLocationService(db.pool, commands)
    const sources = await createProductionSources({ pool: db.pool, commands, mainId, runtimeRoot: mainRuntime,
      locations, endpoint: () => endpoint, dispatch: () => { throw new Error('Root enrollment cannot dispatch Jobs') } })
    await withTransaction(db.pool, async sql => {
      await sources.policies.publishApprovedHostConfiguration(sql, mainAllowlist,
        { mainId, hostRef: mainAllowlist.hostRef, applicationInstallationId: mainId, configurationRevision: '1',
          configurationDigest: sourceSha256(Buffer.from(JSON.stringify(mainAllowlist))) })
    })
    const roots = new WorkspaceBoundLocationService(db.pool, commands, sources.policies)
    const primary = (await roots.set(owner.principal, 'http', { workspaceId, commandId: randomUUID(),
      hostRef: mainAllowlist.hostRef, allowedBaseId: mainAllowlist.bases[0]!.baseId, configurationRevision: '1',
      relativePath: 'project', accessMode: 'read-write', expectedLocationRevision: 0, expectedRootPolicyRevision: 0 })).value
    if (primary.evidence !== 'bound') throw new Error('The template requires a bound Main folder')
    const manifest = createSourceManifest({ version: 1, approvedSourceId: randomUUID(), snapshotId: randomUUID(),
      capturePolicy: 'git-tree-v1', executablePolicy: 'strip', entries: [], deletions: [],
      git: { commit: template.sourceCommit!, tree: '3'.repeat(40), objectFormat: 'sha1' } })
    const approved = ApprovedSourceSchema.parse({ version: 1, workspaceId, mainId, locationRevision: 1,
      ownerPrincipalId: owner.principal.id, approvedByPrincipalId: owner.principal.id,
      originIdentityHash: `sha256:${manifest.manifestDigest}`, manifest, approvedAt: new Date().toISOString(),
      availability: 'retained' })
    await db.pool.query(`insert into source_approvals
      (approved_source_id,snapshot_id,workspace_id,owner_principal_id,requested_by,command_id,input_hash,state,origin,request)
      values($1,$2,$3,$4,$4,$5,$6,'approved','{}','{}')`,
    [manifest.approvedSourceId, manifest.snapshotId, workspaceId, owner.principal.id, randomUUID(), manifest.manifestDigest])
    await db.pool.query(`insert into source_snapshots(snapshot_id,approved_source_id,workspace_id,manifest_digest,record)
      values($1,$2,$3,$4,$5::jsonb)`,
    [manifest.snapshotId, manifest.approvedSourceId, workspaceId, manifest.manifestDigest, JSON.stringify(approved)])
    const sourceRoot = (await sources.sources.bindRoot(owner.principal, 'http', { workspaceId, commandId: randomUUID(),
      selection: { hostRef: primary.binding.hostRef, rootPolicyId: primary.binding.rootPolicyId,
        rootPolicyRevision: primary.binding.rootPolicyRevision, locationRevision: primary.binding.locationRevision },
      source: { approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId,
        manifestDigest: manifest.manifestDigest }, accessMode: 'exclusive-write', expectedBindingRevision: 0 })).value
    const producer = { capture: async (): Promise<never> => { throw new Error('No physical qualification in this fixture') },
      run: async (): Promise<never> => { throw new Error('No physical qualification in this fixture') },
      revalidate: async () => ({ ready: false, reasons: ['runtime_setup_required'] }) }
    const profiles = new JobRuntimeProfiles(db.pool, commands, sources.sources, producer)
    const saved = await profiles.save(owner.principal, 'mcp', workspaceId,
      ciEnrollmentProfileInput(template, sourceRoot, storage, randomUUID()))
    const preparations = new Map<string, ReturnType<typeof BuildComputerPrepareStatusSchema.parse>>()
    const preparation = {
      get: async (_principal: ManagementPrincipal, input: { profileId: string }) => preparations.get(input.profileId)
        ?? BuildComputerPrepareStatusSchema.parse({ profileId: input.profileId, deviceId: null, state: 'idle',
          commit: null, stage: null, message: null, profiles: [], startedAt: null, updatedAt: null }),
      start: async (_principal: ManagementPrincipal, _source: 'http' | 'mcp', input: BuildComputerPrepareInput) => {
        await options.beforePrepare?.()
        const state = BuildComputerPrepareStatusSchema.parse({ profileId: input.profileId, deviceId: worker.registration.deviceId,
          state: 'preparing', commit: input.commit, stage: 'fetch-source', message: null, profiles: [],
          startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        preparations.set(input.profileId, state)
        return state
      },
    }
    const createInventory = () => new ProductionCiEnrollmentInventory(db.pool, sources.sources,
      () => endpoint, () => undefined, new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }),
      new ManagedWorkspaceRootService(new PostgresCommandCoordinator(db.pool), roots, sources.policies))
    const reconciled = deferred()
    enrollment = new CiEnrollment(db.pool, commands, profiles, preparation, createInventory(), () => reconciled.resolve())
    const settings = new BuildComputerSettings(db.pool, commands,
      async () => ({ state: 'ready', reasons: [], remoteExecutionEnabled: true }))
    await settings.update(owner.principal, 'mcp', { commandId: randomUUID(), target: worker.target,
      expectedRevision: 0, buildEnabled: true, buildPriority: 50 })
    const services = { commands, sources: sources.sources, workspaceRoots: roots,
      jobRuntimeProfiles: profiles, ciEnrollment: enrollment } as OperatorServices
    app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'Managed root enrollment', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { authProvider: { token: async () => token } }))
      return client
    }
    const client = await connect(owner.token)
    const read = async () => {
      const result = await client.callTool({ name: 'ci_enrollment_get', arguments: { workspaceId } })
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
      return CiEnrollmentStateSchema.parse(decodeMcpToolResult(result))
    }
    const restart = async () => {
      await enrollment!.close()
      enrollment = new CiEnrollment(db.pool, new PostgresCommandCoordinator(db.pool), profiles, preparation, createInventory())
      services.ciEnrollment = enrollment
    }
    const setReadOnlyPrimary = async () => {
      await roots.adopt(owner.principal, 'mcp', { workspaceId, commandId: randomUUID(), hostRef: worker.target.hostRef })
      const primary = await roots.get(owner.principal, { workspaceId })
      const bound = (await roots.set(owner.principal, 'mcp', { workspaceId, commandId: randomUUID(),
        hostRef: worker.target.hostRef, allowedBaseId: workerAllowlist.bases[0]!.baseId,
        configurationRevision: '1', relativePath: 'project', accessMode: 'read-only',
        expectedLocationRevision: 1, expectedRootPolicyRevision: 0 })).value
      if (bound.evidence !== 'bound') throw new Error('Expected a bound device root')
      return { primary, binding: bound.binding }
    }
    const waitForPreparation = async () => {
      // Reconciliation signals only after preparation and its enrollment state have been persisted.
      await reconciled.promise
      expect((await read()).computers[0]!.state).toBe('preparing')
    }
    return { db, app, access, owner, workspaceId, worker, workerAllowlist, rootRequests, roots, primary,
      managedBase, arbitraryBase, managedSetup, runtimeState, saved, sources: sources.sources,
      client, connect, read, restart, createInventory, setReadOnlyPrimary, waitForPreparation, close }
  } catch (error) {
    await close()
    throw error
  }
}

describe.skipIf(!postgresEnabled)('pairing-managed CI root enrollment', () => {
  it('recognizes Host CI and reads runner readiness without creating protected roots or profiles', async () => {
    const f = await fixture({ managedStorage: false, hostCi: true })
    try {
      expect(await f.createInventory().computers()).toEqual([
        { target: f.worker.target, connected: true, buildEnabled: true, executionMode: 'host' },
      ])
      const updated = await f.client.callTool({ name: 'ci_enrollment_update', arguments: {
        workspaceId: f.workspaceId, target: f.worker.target, commandId: randomUUID(),
        expectedRevision: 0, enabled: true,
      } })
      expect(updated.isError).not.toBe(true)
      await vi.waitFor(async () => expect((await f.read()).computers[0]).toMatchObject({
        executionMode: 'host', state: 'ready', profileIds: [], templates: [],
      }))
      expect(f.rootRequests).toEqual([])
      const persisted = await f.read()
      await f.restart()
      expect(await f.read()).toEqual(persisted)
      expect((await f.db.pool.query('select count(*)::int as count from job_runtime_profiles')).rows[0]!.count).toBe(1)
    } finally { await f.close() }
  })

  it('lets a newly authorized Operator rebind a paired computer root created by another Operator', async () => {
    const f = await fixture({ managedStorage: true })
    try {
      const root = await f.createInventory().root(f.owner.principal, f.workspaceId, f.saved.root, f.worker.target)
      const operator = await f.access.issue({ name: 'Replacement CI Operator', audience: 'operator',
        grants: [{ actions: [...ManagementActionSchema.options], scope: { workspaceIds: [f.workspaceId] } }],
        expiresAt: new Date(Date.now() + 600_000) })
      const client = await f.connect(operator.token)
      const input = { workspaceId: f.workspaceId, commandId: randomUUID(), selection: root.selection,
        source: root.source, accessMode: root.binding.accessMode,
        expectedBindingRevision: root.binding.bindingRevision }
      const reader = await f.access.issue({ name: 'Root reader', audience: 'operator',
        grants: [{ actions: ['source_roots:read', 'sources:read', 'workspace_locations:read'],
          scope: { workspaceIds: [f.workspaceId] } }], expiresAt: new Date(Date.now() + 600_000) })
      const denied = await f.connect(reader.token)
      expect((await denied.callTool({ name: 'source_root_bind', arguments: input })).isError).toBe(true)
      const result = await client.callTool({ name: 'source_root_bind', arguments: input })
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
      const rebound = SourceRootBindResultSchema.parse(decodeMcpToolResult(result)).value
      expect(rebound).toMatchObject({ ownerPrincipalId: operator.principal.id,
        authorizedByPrincipalId: operator.principal.id, registration: root.registration,
        binding: { rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision + 1 } })
      expect(await f.sources.rootGet(operator.principal, 'mcp', { workspaceId: f.workspaceId,
        rootId: rebound.binding.rootId, bindingRevision: rebound.binding.bindingRevision })).toEqual(rebound)
      expect((await f.db.pool.query('select record from workspace_root_policies where root_policy_id=$1',
        [root.selection.rootPolicyId])).rows[0]!.record.ownerPrincipalId).toBe(f.owner.principal.id)
      const stale = await client.callTool({ name: 'source_root_bind', arguments: { ...input, commandId: randomUUID() } })
      expect(stale.isError).toBe(true)
      expect((await f.sources.rootList(operator.principal, 'mcp', { workspaceId: f.workspaceId })).items)
        .toContainEqual(rebound)
    } finally { await f.close() }
  }, 120_000)

  it('adopts and binds through authenticated MCP, denies missing grants and persists setup/root readback', async () => {
    const f = await fixture({ managedStorage: true })
    try {
      const denied = await f.access.issue({ name: 'CI caller without root writes', audience: 'operator',
        grants: [{ actions: CI_PREPARATION_ACTIONS, scope: { workspaceIds: [f.workspaceId] } }],
        expiresAt: new Date(Date.now() + 600_000) })
      const deniedClient = await f.connect(denied.token)
      const input = { workspaceId: f.workspaceId, commandId: randomUUID(), target: f.worker.target,
        expectedRevision: 0, enabled: true }
      expect((await deniedClient.callTool({ name: 'ci_enrollment_update', arguments: input })).isError).toBe(true)
      expect(f.rootRequests).toEqual([])
      expect((await f.db.pool.query('select count(*)::int as count from ci_enrollment_computers')).rows[0]?.count).toBe(0)
      expect((await f.client.callTool({ name: 'ci_enrollment_update', arguments: input })).isError).not.toBe(true)
      await vi.waitFor(async () => expect((await f.read()).computers[0]).toMatchObject({ state: 'preparing',
        managedSetup: f.managedSetup, templates: [{ templateId: f.saved.id, state: 'preparing' }] }), { timeout: 5000 })
      expect(f.rootRequests).toContain('workspace-roots.configuration')
      expect(f.rootRequests).toContain('workspace-roots.prepare-managed')
      const choices = decodeMcpToolResult(await f.client.callTool({ name: 'workspace_root_choices_list',
        arguments: { workspaceId: f.workspaceId } })) as Awaited<ReturnType<typeof f.roots.choices>>
      const approved = choices.allowlists.find(allowlist =>
        allowlist.applicationInstallationId === f.worker.target.applicationInstallationId)!
      expect(approved).toEqual(f.workerAllowlist)
      expect(approved.runtimeFilesystemId).toMatch(/^[a-f0-9]{1,16}$/)
      for (const base of approved.bases) expect(base.filesystemId).toMatch(/^[a-f0-9]{1,16}$/)
      const managed = choices.policies.find(policy => policy.bindingPurpose === 'ci-enrollment')!
      expect(managed).toMatchObject({ hostRef: f.worker.target.hostRef, accessMode: 'read-write',
        canonicalProjectRoot: join(f.managedBase, sourceSha256(Buffer.from(f.workspaceId))), locationRevision: '1' })
      expect((await stat(managed.canonicalProjectRoot)).mode & 0o777).toBe(0o700)
      expect(await f.roots.get(f.owner.principal, { workspaceId: f.workspaceId })).toEqual(f.primary)
      const roots = await f.db.pool.query<{ record: { binding: { canonicalPath: string; workerInstallationId: string } } }>(
        "select record from source_root_bindings where workspace_id=$1 and record->'binding'->>'deviceId'=$2",
        [f.workspaceId, f.worker.registration.deviceId])
      expect(roots.rows).toHaveLength(1)
      expect(roots.rows[0]!.record.binding.workerInstallationId).toBe(f.worker.target.applicationInstallationId)
      const persisted = await f.read()
      await f.restart()
      expect(await f.read()).toEqual(persisted)
      const http = await f.app.inject({ url: `/api/management/workspaces/${f.workspaceId}/root-policies`,
        headers: { authorization: `Bearer ${f.owner.token}` } })
      expect(http.statusCode).toBe(200)
      expect(http.json()).toEqual(choices)
      expect((await f.client.callTool({ name: 'ci_enrollment_update', arguments: input })).isError).not.toBe(true)
      await vi.waitFor(async () => expect((await f.read()).computers[0]!.state).toBe('preparing'), { timeout: 5000 })
      expect((await f.db.pool.query("select count(*)::int as count from management_audit where action='workspace.root.managed.bind' and outcome='succeeded'")).rows[0]?.count).toBe(1)
      expect((await f.db.pool.query("select count(*)::int as count from management_audit where action='ci_enrollment_update' and outcome='denied'")).rows[0]?.count).toBeGreaterThan(0)
      const inventory = f.createInventory()
      expect(await inventory.computers()).toHaveLength(1)
      const devices = new PostgresDeviceAccessService(f.db.pool, f.worker.registration.mainId)
      await devices.revoke(f.owner.principal, f.worker.registration.deviceId, 1, randomUUID(), 'mcp')
      expect(await inventory.computers()).toEqual([])
    } finally { await f.close() }
  }, 120_000)

  it('preserves a read-only primary root on the same computer while adding its managed CI root', async () => {
    const f = await fixture({ managedStorage: true })
    try {
      const primary = await f.setReadOnlyPrimary()
      const updated = await f.client.callTool({ name: 'ci_enrollment_update', arguments: { workspaceId: f.workspaceId,
        target: f.worker.target, commandId: randomUUID(), expectedRevision: 0, enabled: true } })
      expect(updated.isError, JSON.stringify(updated.content)).not.toBe(true)
      await f.waitForPreparation()
      expect(await f.roots.get(f.owner.principal, { workspaceId: f.workspaceId })).toEqual(primary.primary)
      const choices = await f.roots.choices(f.owner.principal, { workspaceId: f.workspaceId })
      const policies = choices.policies.filter(policy => policy.hostRef.kind === 'device')
      expect(policies).toHaveLength(2)
      expect(policies).toContainEqual(primary.binding)
      expect(policies.find(policy => policy.bindingPurpose === 'ci-enrollment')!.canonicalProjectRoot)
        .toBe(join(f.managedBase, sourceSha256(Buffer.from(f.workspaceId))))
    } finally { await f.close() }
  }, 120_000)

  it('waits for slow background preparation to persist before checking the read-only primary root', async () => {
    const entered = deferred()
    const release = deferred()
    const f = await fixture({ managedStorage: true, beforePrepare: async () => {
      entered.resolve()
      await release.promise
    } })
    try {
      const primary = await f.setReadOnlyPrimary()
      const updated = await f.client.callTool({ name: 'ci_enrollment_update', arguments: { workspaceId: f.workspaceId,
        target: f.worker.target, commandId: randomUUID(), expectedRevision: 0, enabled: true } })
      expect(updated.isError, JSON.stringify(updated.content)).not.toBe(true)
      await entered.promise
      await vi.waitFor(async () => expect((await f.read()).computers[0]!.state).toBe('pending'), { timeout: 5000 })
      const waiting = f.waitForPreparation()
      release.resolve()
      await waiting
      expect((await f.read()).computers[0]).toMatchObject({ state: 'preparing',
        templates: [{ templateId: f.saved.id, state: 'preparing' }] })
      expect(await f.roots.get(f.owner.principal, { workspaceId: f.workspaceId })).toEqual(primary.primary)
      const choices = await f.roots.choices(f.owner.principal, { workspaceId: f.workspaceId })
      expect(choices.policies.filter(policy => policy.hostRef.kind === 'device')).toHaveLength(2)
      await f.restart()
      expect((await f.read()).computers[0]!.state).toBe('preparing')
      expect(await f.roots.get(f.owner.principal, { workspaceId: f.workspaceId })).toEqual(primary.primary)
    } finally {
      release.resolve()
      await f.close()
    }
  }, 120_000)

  it('reports explicit root approval when the host provides only unmarked user bases', async () => {
    const f = await fixture({ managedStorage: false })
    try {
      await f.client.callTool({ name: 'ci_enrollment_update', arguments: { workspaceId: f.workspaceId,
        target: f.worker.target, commandId: randomUUID(), expectedRevision: 0, enabled: true } })
      await vi.waitFor(async () => expect((await f.read()).computers[0]!.state).toBe('root-required'), { timeout: 5000 })
      expect(f.rootRequests).not.toContain('workspace-roots.prepare-managed')
      expect((await f.roots.choices(f.owner.principal, { workspaceId: f.workspaceId })).policies)
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ bindingPurpose: 'ci-enrollment' })]))
      expect(await f.roots.get(f.owner.principal, { workspaceId: f.workspaceId })).toEqual(f.primary)
    } finally { await f.close() }
  }, 120_000)

  it('persists a managed setup failure for authenticated MCP readers without adopting or binding roots', async () => {
    const f = await fixture({ managedStorage: true })
    try {
      const setup = { state: 'failed' as const, migrated: false,
        message: 'The managed installation could not validate its filesystem.', updatedAt: new Date().toISOString() }
      f.runtimeState.installedStorage = null
      f.runtimeState.managedSetup = setup
      await f.client.callTool({ name: 'ci_enrollment_update', arguments: { workspaceId: f.workspaceId,
        target: f.worker.target, commandId: randomUUID(), expectedRevision: 0, enabled: true } })
      await vi.waitFor(async () => expect((await f.read()).computers[0]).toMatchObject({ state: 'runtime-required',
        managedSetup: setup, templates: [{ state: 'runtime-required', message: setup.message }] }), { timeout: 5000 })
      expect(f.rootRequests).toEqual([])
      const persisted = await f.read()
      await f.restart()
      expect(await f.read()).toEqual(persisted)
    } finally { await f.close() }
  }, 120_000)
})
