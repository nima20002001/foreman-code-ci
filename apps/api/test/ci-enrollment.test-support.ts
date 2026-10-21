import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { BuildComputerPrepareStatusSchema, type BuildComputerPrepareInput, type BuildComputerPrepareStatus } from '@foreman-code/contracts'
import { ApprovedSourceSchema, type SourceRootRecord } from '@foreman-code/contracts/source-admission'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { type ManagementPrincipal } from '@foreman-code/contracts/management'
import { afterEach, beforeEach, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { CI_ENROLLMENT_ACTIONS, CiEnrollment } from '../src/modules/jobs/ciEnrollment.js'
import type { CiEnrollmentInventory, CiEnrollmentTarget } from '../src/modules/jobs/ciEnrollmentInventory.js'
import { ciEnrollmentProfileInput } from '../src/modules/jobs/ciEnrollmentProfiles.js'
import { JobRuntimeProfiles } from '../src/modules/jobs/runtimeProfiles.js'
import { DomainError } from '../src/modules/errors.js'
import { BuildComputerSettings, buildComputerKey } from '../src/modules/settings/buildComputers.js'
import { createSourceManifest } from '../src/modules/sources/manifest.js'
import { createProductionSources } from '../src/modules/sources/production.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { buildComputerFixture } from './helpers/buildComputerFixture.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { verificationCapacityFixture } from './helpers/verificationCapacityFixture.js'

export function ciEnrollmentFixture() {
  let database: Awaited<ReturnType<typeof currentDatabase>>
  // Reconciliation scans all workspaces; immutable history requires a fresh schema for each case.
  beforeEach(async () => {
    database = await currentDatabase()
  }, 120_000)
  afterEach(async () => {
    await database?.close()
  }, 120_000)
  return () => createFixture(database)
}

// Persistence, authorization and MCP are real; source hosts and runtime preparation are bounded fixtures.
async function createFixture(db: Awaited<ReturnType<typeof currentDatabase>>) {
  const clients: Client[] = []
  let closeEnrollment: (() => Promise<void>) | undefined
  let closeApp: (() => Promise<void>) | undefined
  async function close() {
    await closeEnrollment?.()
    await Promise.allSettled(clients.map(client => client.close()))
    await closeApp?.()
  }
  try {
    const access = new PostgresAccessService(db.pool)
    const commands = new PostgresCommandCoordinator(db.pool)
    const workspaceId = randomUUID()
    const mainId = (await db.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    const owner = await access.issue({ name: 'CI enrollment owner', audience: 'operator',
      grants: [{ actions: [...CI_ENROLLMENT_ACTIONS, 'jobs:read', 'jobs:cancel',
        'settings:read', 'settings:update', 'capabilities:read'], scope: {} }],
      expiresAt: new Date(Date.now() + 3_600_000) })
    await db.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
      [workspaceId, JSON.stringify({ id: workspaceId, name: 'CI enrollment' })])
    const template = verificationCapacityFixture('device')
    const manifest = createSourceManifest({ version: 1, approvedSourceId: randomUUID(), snapshotId: randomUUID(),
      capturePolicy: 'git-tree-v1', executablePolicy: 'strip', entries: [], deletions: [],
      git: { commit: template.sourceCommit!, tree: '3'.repeat(40), objectFormat: 'sha1' } })
    const source = { approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId,
      manifestDigest: manifest.manifestDigest }
    const approved = ApprovedSourceSchema.parse({ version: 1, workspaceId, mainId, locationRevision: 1,
      ownerPrincipalId: owner.principal.id, approvedByPrincipalId: owner.principal.id,
      originIdentityHash: `sha256:${manifest.manifestDigest}`, manifest,
      approvedAt: new Date().toISOString(), availability: 'retained' })
    await db.pool.query(`insert into source_approvals
      (approved_source_id,snapshot_id,workspace_id,owner_principal_id,requested_by,command_id,input_hash,state,origin,request)
      values($1,$2,$3,$4,$4,$5,$6,'approved','{}','{}')`,
    [source.approvedSourceId, source.snapshotId, workspaceId, owner.principal.id, randomUUID(), source.manifestDigest])
    await db.pool.query(`insert into source_snapshots(snapshot_id,approved_source_id,workspace_id,manifest_digest,record)
      values($1,$2,$3,$4,$5::jsonb)`,
    [source.snapshotId, source.approvedSourceId, workspaceId, source.manifestDigest, JSON.stringify(approved)])

    const workers = [buildComputerFixture(mainId, workspaceId), buildComputerFixture(mainId, workspaceId)]
    const computers: CiEnrollmentTarget[] = workers.map(worker => ({
      target: worker.target, buildEnabled: true, connected: true,
    }))
    computers.push({ target: { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
      keyRevision: null, authorizationRevision: null }, buildEnabled: true, connected: true })
    const roots: SourceRootRecord[] = workers.map(worker => worker.candidate.profile.root)
    const mainRoot = structuredClone(roots[0]!)
    mainRoot.selection.hostRef = { kind: 'main', mainId }
    mainRoot.selection.rootPolicyId = randomUUID()
    mainRoot.binding = { ...mainRoot.binding, rootId: randomUUID(), deviceId: null, workerInstallationId: null }
    mainRoot.registration = null
    roots.push(mainRoot)
    for (const worker of workers) {
      await db.pool.query(`insert into device_registrations
        (id,main_id,worker_installation_id,public_key,record) values($1,$2,$3,'fixture',$4::jsonb)`,
      [worker.registration.deviceId, mainId, worker.registration.workerInstallationId, JSON.stringify(worker.registration)])
    }
    for (const root of roots) {
      root.source = source
      root.ownerPrincipalId = owner.principal.id
      root.authorizedByPrincipalId = owner.principal.id
      root.binding.snapshotId = source.snapshotId
      root.binding.manifestDigest = source.manifestDigest
      await db.pool.query(`insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision)
        values($1,$2,$3,1)`, [root.binding.rootId, workspaceId, randomUUID()])
      await db.pool.query(`insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record)
        values($1,1,$2,$3,$4::jsonb)`, [root.binding.rootId, workspaceId, source.snapshotId, JSON.stringify(root)])
    }
    const noCarrier = (): never => { throw new Error('Enrollment fixture has no physical source carrier') }
    const sourceRuntime = await createProductionSources({ pool: db.pool, commands,
      locations: new WorkspaceLocationService(db.pool, commands), mainId, runtimeRoot: db.directory,
      endpoint: noCarrier, dispatch: noCarrier })
    vi.spyOn(sourceRuntime.sources, 'resolveRootBinding').mockImplementation(async (_sql, _principal, input) => {
      const root = roots.find(row => row.binding.rootId === input.rootId)
      if (!root) throw new Error('Fixture root is missing')
      return root
    })
    const producer = {
      capture: async (): Promise<never> => { throw new Error('No physical qualification in enrollment fixture') },
      run: async (): Promise<never> => { throw new Error('No physical qualification in enrollment fixture') },
      revalidate: async () => ({ ready: false, reasons: ['runtime_setup_required'] }),
    }
    const profiles = new JobRuntimeProfiles(db.pool, commands, sourceRuntime.sources, producer)
    const stored = await profiles.save(owner.principal, 'mcp', workspaceId,
      ciEnrollmentProfileInput(template, roots[0]!, { diskBytes: template.spec.resources.limits.diskBytes,
        mutableInodes: template.spec.resources.mutableInodes }, randomUUID()))
    const preparations = new Map<string, BuildComputerPrepareStatus>()
    const preparation = {
      get: vi.fn(async (_principal: ManagementPrincipal, input: { workspaceId: string; profileId: string }) =>
        preparations.get(input.profileId) ?? BuildComputerPrepareStatusSchema.parse({ profileId: input.profileId,
          deviceId: null, state: 'idle', commit: null, stage: null, message: null, profiles: [],
          startedAt: null, updatedAt: null })),
      start: vi.fn(async (_principal: ManagementPrincipal, _source: 'http' | 'mcp', input: BuildComputerPrepareInput) => {
        const state = BuildComputerPrepareStatusSchema.parse({ profileId: input.profileId, deviceId: null,
          state: 'preparing', commit: input.commit, stage: 'fetch-source', message: null, profiles: [],
          startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        preparations.set(input.profileId, state)
        return state
      }),
    } satisfies ConstructorParameters<typeof CiEnrollment>[3]
    const resources = template.spec.resources
    const inventory: CiEnrollmentInventory = {
      computers: async () => computers,
      storage: vi.fn(async (target: DeviceProvisioningTarget) => ({
        diskBytes: target.hostRef.kind === 'main' ? resources.limits.diskBytes
        : resources.limits.diskBytes * 2, mutableInodes: resources.mutableInodes * 2 })),
      root: vi.fn(async (_principal: ManagementPrincipal, _workspaceId: string, _template: SourceRootRecord,
        target: DeviceProvisioningTarget) => {
        const root = roots.find(row => buildComputerKey({ hostRef: row.selection.hostRef }) === buildComputerKey(target))
        if (!root) throw new DomainError('CI_ENROLLMENT_ROOT_REQUIRED', 'Approved writable root required.', 409)
        return root
      }),
    }
    const enrollment = new CiEnrollment(db.pool, commands, profiles, preparation, inventory)
    closeEnrollment = () => enrollment.close()
    const settings = new BuildComputerSettings(db.pool, commands,
      async () => ({ state: 'ready', reasons: [], remoteExecutionEnabled: true }))
    for (const computer of computers) {
      await settings.update(owner.principal, 'mcp', { target: computer.target, commandId: randomUUID(),
        expectedRevision: 0, buildEnabled: true, buildPriority: 50 })
    }
    const services = { commands, jobRuntimeProfiles: profiles, ciEnrollment: enrollment } as OperatorServices
    const app = buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services } })
    closeApp = () => app.close()
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    async function connect(token = owner.token) {
      const client = new Client({ name: 'CI enrollment parity', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    return { db, access, commands, workspaceId, owner, computers, roots, inventory, profiles, stored,
      enrollment, preparations, preparation, settings, connect, close }
  } catch (error) {
    await close()
    throw error
  }
}
