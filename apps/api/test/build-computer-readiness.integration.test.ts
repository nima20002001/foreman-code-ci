import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CI_HOST_NAMESPACE } from '@foreman-code/contracts'
import { workerBundleErrorMessage } from '../src/modules/computers/workerBundleReadiness.js'
import { workerBundleReadinessFixture } from './helpers/workerBundleReadinessFixture.js'
import { JobVerificationProfileSchema } from '@foreman-code/contracts/job-verification-runtime'
import { jobDigest } from '../src/modules/jobs/service.js'
import { BuildComputerStatusSchema } from '@foreman-code/contracts/build-computers'
import type { DeviceEndpoint } from '../src/modules/devices/deviceEndpoint.js'
import type { JobRuntimeProfiles } from '../src/modules/jobs/runtimeProfiles.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { BuildComputerSettings, buildComputerTarget } from '../src/modules/settings/buildComputers.js'
import { buildComputerReadiness } from '../src/modules/settings/buildComputerReadiness.js'
import { WorkerExecutionPolicy } from '../src/modules/settings/workerExecution.js'
import { jobComputerCapacityDecision } from '../src/modules/jobs/computerSelection.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { verificationCapacityFixture } from './helpers/verificationCapacityFixture.js'

// Qualification I/O is supplied; settings, authorization and capacity use PostgreSQL and authenticated transports.
describe.skipIf(!postgresEnabled)('build readiness matches admission through HTTP and Operator MCP', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  const apps: ReturnType<typeof buildApp>[] = []
  const clients: Client[] = []
  beforeAll(async () => { database = await agent3Database() }, 60000)
  afterAll(async () => {
    await Promise.allSettled(clients.map(client => client.close()))
    await Promise.allSettled(apps.map(app => app.close()))
    await database?.close()
  })
  it('uses remote memory and persisted allowance, preserves failure reasons and denies an ungranted caller', async () => {
    const mainId = (await database.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    const workspaceId = randomUUID()
    const access = new PostgresAccessService(database.pool)
    const writer = await access.issue({ name: 'Readiness owner', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000),
      grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }] })
    const denied = await access.issue({ name: 'No settings grant', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000), grants: [{ actions: ['jobs:read'], scope: {} }] })
    const profile = verificationCapacityFixture('device')
    profile.measurement!.fingerprint.deviceLimits!.cpuLimit = 4
    profile.id = randomUUID()
    profile.workspaceId = workspaceId
    profile.root.binding.mainId = mainId
    profile.root.binding.workspaceId = workspaceId
    profile.root.selection.hostRef.mainId = mainId
    const root = profile.root
    const target = buildComputerTarget({ hostRef: root.selection.hostRef,
      registration: root.registration, mainInstallationId: mainId })
    const measurement = profile.measurement!
    const fingerprint = measurement.fingerprint
    profile.specDigest = jobDigest({ workspaceId, id: profile.id, revision: profile.revision,
      root, sourceCommit: profile.sourceCommit, spec: profile.spec, approvalConfig: profile.approvalConfig })
    fingerprint.specDigest = profile.specDigest
    fingerprint.profileId = profile.id
    fingerprint.root = structuredClone(root)
    fingerprint.hostRef = target.hostRef
    fingerprint.mainInstallationId = mainId
    measurement.identity.profileId = profile.id
    measurement.identity.fingerprintDigest = jobDigest(fingerprint)
    JobVerificationProfileSchema.parse(profile)
    const registration = { mainId, deviceId: root.binding.deviceId,
      workerInstallationId: target.applicationInstallationId, keyRevision: target.keyRevision,
      authorizationRevision: target.authorizationRevision, status: 'paired', scopes: ['connect', 'heartbeat'],
      publicKeyFingerprint: 'a'.repeat(64) }
    await database.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
      [workspaceId, JSON.stringify({ id: workspaceId, name: 'Readiness' })])
    await database.pool.query(`insert into device_registrations
      (id,main_id,worker_installation_id,public_key,record) values($1,$2,$3,'fixture',$4::jsonb)`,
    [registration.deviceId, mainId, registration.workerInstallationId, JSON.stringify(registration)])
    await database.pool.query(`insert into source_approvals
      (approved_source_id,snapshot_id,workspace_id,owner_principal_id,requested_by,command_id,input_hash,state,origin,request)
      values($1,$2,$3,$4,$4,$5,$6,'approved','{}','{}')`,
    [root.source.approvedSourceId, root.source.snapshotId, workspaceId, writer.principal.id,
      randomUUID(), root.source.manifestDigest])
    await database.pool.query(`insert into source_snapshots(snapshot_id,approved_source_id,workspace_id,manifest_digest,record)
      values($1,$2,$3,$4,'{}')`,
    [root.source.snapshotId, root.source.approvedSourceId, workspaceId, root.source.manifestDigest])
    await database.pool.query(`insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision)
      values($1,$2,$3,1)`, [root.binding.rootId, workspaceId, randomUUID()])
    await database.pool.query(`insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record)
      values($1,1,$2,$3,$4::jsonb)`, [root.binding.rootId, workspaceId, root.source.snapshotId, JSON.stringify(root)])
    await database.pool.query(`insert into job_runtime_profiles(id,workspace_id,revision,root_id,binding_revision,record)
      values($1,$2,1,$3,1,$4::jsonb)`, [profile.id, workspaceId, root.binding.rootId, JSON.stringify(profile)])
    const bundle = workerBundleReadinessFixture()
    let clockReason: string | null = null
    const endpoint = { clockReason: () => clockReason, currentBinding: () => ({ workerInstallationId: target.applicationInstallationId,
      keyRevision: target.keyRevision, authorizationRevision: target.authorizationRevision }),
    captureRequest: () => ({}), capabilities: () => [], workerBundleReadiness: async () => bundle.read() } as unknown as DeviceEndpoint
    let memory: number | null = 14 * 2 ** 30
    const availableMemory = async () => memory
    const commands = new PostgresCommandCoordinator(database.pool)
    const readiness = buildComputerReadiness({ endpoint: () => endpoint, localExecutor: true,
      workerExecution: new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }), availableMemory,
      profiles: { readiness: async () => ({ ready: true, reasons: [] }) } as unknown as JobRuntimeProfiles })
    const settings = new BuildComputerSettings(database.pool, commands, readiness)
    const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { buildComputers: settings, commands } as unknown as OperatorServices } })
    apps.push(app)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    async function connect(token: string) {
      const client = new Client({ name: 'readiness-test', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
      return client
    }
    const client = await connect(writer.token)
    const input = { target, commandId: randomUUID(), expectedRevision: 0,
      buildEnabled: true, buildPriority: 50, buildAllowancePercent: 100 }
    const saved = BuildComputerStatusSchema.parse(decodeMcpToolResult((await client.callTool({
      name: 'build_computer_update', arguments: input }))))
    expect(saved.state).toBe('ready')
    async function readback() {
      const mcp = BuildComputerStatusSchema.parse(decodeMcpToolResult((await client.callTool({
        name: 'build_computer_get', arguments: { target } }))))
      const http = await app.inject({ method: 'POST', url: '/api/management/settings/build-computers/read',
        headers: { authorization: `Bearer ${writer.token}` }, payload: { target } })
      expect(http.statusCode, http.body).toBe(200)
      expect(http.json()).toEqual(mcp)
      return mcp
    }
    expect(await readback()).toEqual(saved)
    for (const mode of ['protected', 'host'] as const) {
      endpoint.capabilities = () => mode === 'host' ? [{ namespace: CI_HOST_NAMESPACE, version: 1,
        mainCanRequest: true, workerCanRequest: false, maxJsonBytes: 1_048_576, maxBinaryBytes: 0 }] : []
      endpoint.captureRequest = () => ({ binding: endpoint.currentBinding(registration.deviceId!)!,
        request: async () => ({ payload: { operation: 'status', ready: true, reasons: [],
          cpuCount: 8, memoryBytes: 16 * 2 ** 30, runs: [] } }) }) as ReturnType<DeviceEndpoint['captureRequest']>
      for (const phase of ['current', 'installing'] as const) {
        bundle.worker.contentSha256 = 'c'.repeat(64)
        bundle.worker.state = phase
        expect(await readback()).toMatchObject({ state: 'setup-required',
          reasons: [workerBundleErrorMessage(bundle.read())], preference: saved.preference })
      }
      bundle.worker.contentSha256 = bundle.expected.contentSha256
      bundle.worker.state = 'current'
      expect(await readback()).toMatchObject({ state: 'ready', reasons: [], preference: saved.preference })
    }
    endpoint.capabilities = () => []
    clockReason = 'Worker clock differs from Main by more than 2 minutes. Synchronize the Worker clock.'
    expect(await readback()).toMatchObject({ state: 'setup-required', reasons: [clockReason],
      preference: saved.preference })
    const clockReadDenied = await connect(denied.token)
    expect((await clockReadDenied.callTool({ name: 'build_computer_get', arguments: { target } })).isError).toBe(true)
    clockReason = null
    memory = null
    expect(await readback()).toMatchObject({ state: 'setup-required', reasons: ['Available memory could not be read.'] })
    expect(await jobComputerCapacityDecision(database.pool, { mainId, hostRef: target.hostRef },
      profile, availableMemory)).toEqual({ fits: false, reason: 'memory_unavailable' })
    memory = 0
    expect(await readback()).toMatchObject({ state: 'busy',
      reasons: ['More available memory is required before another build can start.'] })
    memory = 14 * 2 ** 30
    const reduced = BuildComputerStatusSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'build_computer_update',
      arguments: { ...input, commandId: randomUUID(), expectedRevision: 1, buildAllowancePercent: 10 } }))))
    expect(reduced).toMatchObject({ preference: { buildAllowancePercent: 10, revision: 2 },
      state: 'setup-required', reasons: ['The build allowance is too small for this runtime. Increase the allowance.'] })
    expect(await readback()).toEqual(reduced)
    const restarted = new BuildComputerSettings(database.pool, commands, readiness)
    expect(await restarted.read(writer.principal, { target })).toEqual(reduced)
    const ungranted = await connect(denied.token)
    expect((await ungranted.callTool({ name: 'build_computer_get', arguments: { target } })).isError).toBe(true)
    const forbidden = await app.inject({ method: 'POST', url: '/api/management/settings/build-computers/read',
      headers: { authorization: `Bearer ${denied.token}` }, payload: { target } })
    expect(forbidden.statusCode).toBe(403)
  })
})
