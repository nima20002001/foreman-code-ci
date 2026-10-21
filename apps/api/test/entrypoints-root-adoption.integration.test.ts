import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { removeFixtureDirectory } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import Fastify from 'fastify'
import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import type { ApprovedRootAllowlist } from '@foreman-code/contracts/workspace-root-policies'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { workspaceRootDirectory } from './helpers/workspaceRootDirectory.js'
import { PostgresAccessService, bearerToken } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { registerOperatorHttpSecurity, requireLocalRequest } from '../src/modules/access/http.js'
import { WorkspaceBoundLocationService } from '../src/modules/workspace-roots/service.js'
import { registerWorkspaceRootRoutes, registerWorkspaceRootTools } from '../src/modules/workspace-roots/transports.js'
import { openPrivateRoot, identity } from '../src/modules/sources/privateFilesystem.js'
import { createProductionSources } from '../src/modules/sources/production.js'
import { createWorkspaceRootWorkerHandler } from '../src/modules/sources/rootAttestation.js'
import type { DeviceEndpoint } from '../src/modules/devices/deviceEndpoint.js'
import type { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import type { PostgresJobDispatch } from '../src/modules/jobs/dispatch.js'
import { DomainError } from '../src/modules/errors.js'

/** Actual Postgres/main installation/grants/native component-safe temporary FS.
 * Synthetic human-approved main configuration; no laptop/provider acceptance. */
describe.skipIf(!postgresEnabled)('production approved-root adoption HTTP/MCP', () => {
  it('adds a device root without configuring the primary location, replays its receipt and denies a scoped caller', async () => {
    const db = await currentDatabase(), app = Fastify(), clients: Client[] = []
    let rootDirectory: string | undefined
    try {
      const workspaceId = randomUUID(), foreignId = randomUUID()
      for (const id of [workspaceId, foreignId]) await db.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [id, JSON.stringify({ id, name: 'Independent root fixture' })])
      const deviceId = randomUUID(), workerInstallationId = randomUUID()
      const mainId = (await db.pool.query<{ id: string }>('select id from application_installation where singleton=true')).rows[0]!.id
      rootDirectory = await workspaceRootDirectory()
      const basePath = join(rootDirectory, 'approved-base'), runtimePath = join(rootDirectory, 'root-runtime')
      await mkdir(basePath, { mode: 0o700 }); await mkdir(runtimePath, { mode: 0o700 }); await mkdir(join(basePath, 'project'), { mode: 0o700 })
      const base = await openPrivateRoot(basePath), runtime = await openPrivateRoot(runtimePath)
      let allowlist: ApprovedRootAllowlist
      try { allowlist = { schemaVersion: 1, hostRef: { kind: 'device', mainId, deviceId }, applicationInstallationId: workerInstallationId, configurationRevision: '1',
        bases: [{ baseId: randomUUID(), canonicalPath: basePath, filesystem: await identity(base), accessModes: ['read-only', 'read-write'] }],
        managedRuntimeRoot: runtimePath, runtimeFilesystem: await identity(runtime) } } finally { await base.close(); await runtime.close() }
      const access = new PostgresAccessService(db.pool), commands = new PostgresCommandCoordinator(db.pool)
      const owner = await access.issue({ name: 'Root fixture owner', audience: 'operator', expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ManagementActionSchema.options, scope: {} }] })
      const denied = await access.issue({ name: 'Foreign workspace reader', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: ['source_roots:read', 'workspace_locations:read'], scope: { workspaceIds: [foreignId] } }] })
      const registration = { mainId, deviceId, workerInstallationId, keyRevision: 1, authorizationRevision: 1,
        publicKeyFingerprint: 'a'.repeat(64), status: 'paired', scopes: ['connect', 'heartbeat'] }
      await db.pool.query('insert into device_registrations(id,main_id,worker_installation_id,public_key,record) values($1,$2,$3,$4,$5::jsonb)',
        [deviceId,mainId,workerInstallationId,'fixture key',JSON.stringify(registration)])
      const binding = { mainId,deviceId,workerInstallationId,keyRevision:1,authorizationRevision:1,bootId:randomUUID(),connectionEpoch:randomUUID(),connectionGeneration:1 }
      let workerReads = 0
      const worker = createWorkspaceRootWorkerHandler(async () => { workerReads++; return allowlist }, async () => {})
      const endpoint = { currentBinding: () => binding, captureRequest: () => ({ binding, request: async (raw: unknown) => ({payload:await worker(raw)}) }),
        request: async (_device: string,_namespace: string,raw: unknown) => ({payload:await worker(raw)}) } as unknown as DeviceEndpoint
      const factory = await createProductionSources({pool:db.pool,commands,locations:{} as WorkspaceLocationService,mainId,runtimeRoot:runtimePath,
        endpoint:()=>endpoint,dispatch:()=>({} as PostgresJobDispatch)})
      const policies = factory.policies
      const service = new WorkspaceBoundLocationService(db.pool, commands, policies)
      registerOperatorHttpSecurity(app, access); registerWorkspaceRootRoutes(app, service)
      app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500).send({ error: { code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR' } }))
      app.post('/mcp', async (request, reply) => {
        requireLocalRequest(request); const principal = await access.authenticate(bearerToken(request.headers.authorization), 'operator')
        const server = new McpServer({ name: 'independent-root-auth-fixture', version: '1' })
        registerWorkspaceRootTools(server, service, principal, commands)
        const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        reply.raw.once('close', () => { void Promise.allSettled([transport.close(), server.close()]) })
        await server.connect(transport); reply.hijack(); await transport.handleRequest(request.raw, reply.raw, request.body)
      })
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => { const client = new Client({ name: 'independent-root-readback', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } })); return client }
      const client = await connect(owner.token), deniedClient = await connect(denied.token), auth = { authorization: `Bearer ${owner.token}` }
      const baseUrl = `/api/management/workspaces/${workspaceId}`
      const adoption = { workspaceId,commandId:randomUUID(),hostRef:allowlist.hostRef }
      expect((await deniedClient.callTool({name:'workspace_root_configuration_adopt',arguments:adoption})).isError).toBe(true)
      expect(workerReads).toBe(0)
      expect((await db.pool.query('select count(*)::int as count from workspace_root_host_configuration_heads')).rows[0]?.count).toBe(0)
      const imported = await app.inject({method:'POST',url:`${baseUrl}/root-configurations/adopt`,headers:auth,payload:adoption})
      expect(imported.statusCode).toBe(200);expect(imported.json().value).toEqual(allowlist)
      expect(decodeMcpToolResult((await client.callTool({name:'workspace_root_configuration_adopt',arguments:adoption})))).toEqual({...imported.json(),replayed:true})
      expect(workerReads).toBe(1)
      expect((await db.pool.query('select record from workspace_root_host_configurations')).rows[0]?.record).toEqual(allowlist)
      expect((await db.pool.query("select count(*)::int as count from management_audit where action='workspace.root.configuration.adopt' and outcome='succeeded'")).rows[0]?.count).toBe(1)

      const choices = await app.inject({ method: 'GET', url: `${baseUrl}/root-policies`, headers: auth })
      expect(choices.statusCode).toBe(200); expect(choices.json().allowlists[0]).toEqual(allowlist)
      expect(decodeMcpToolResult((await client.callTool({ name: 'workspace_root_choices_list', arguments: { workspaceId } })))).toEqual(choices.json())
      const selection = { workspaceId, hostRef: allowlist.hostRef, allowedBaseId: allowlist.bases[0]!.baseId, configurationRevision: '1',
        relativePath: 'project', accessMode: 'read-only', expectedLocationRevision: 0, expectedRootPolicyRevision: 0 }
      const validation = await client.callTool({ name: 'workspace_root_location_validate', arguments: selection })
      expect(validation.isError).not.toBe(true)
      expect((decodeMcpToolResult(validation) as { attestation: { canonicalProjectRoot: string } }).attestation.canonicalProjectRoot).toBe(join(basePath, 'project'))
      const input = { ...selection, commandId: randomUUID() }
      const saved = await app.inject({ method: 'PUT', url: `${baseUrl}/root-location`, headers: auth, payload: input })
      expect(saved.statusCode).toBe(200); expect(saved.json().value).toMatchObject({ evidence: 'bound', workspaceId, locationRevision: 0,
        executionLocation: { runnerId: workerInstallationId, rootPath: join(basePath, 'project') } })
      const replay = await client.callTool({ name: 'workspace_root_location_set', arguments: input })
      expect(replay.isError).not.toBe(true); expect(decodeMcpToolResult(replay)).toEqual({ ...saved.json(), replayed: true })
      const primary = { evidence: 'unconfigured', workspaceId, locationRevision: 0, executionLocation: null }
      expect(await service.get(owner.principal, { workspaceId })).toEqual(primary)
      expect((await service.choices(owner.principal, { workspaceId })).policies).toEqual([saved.json().value.binding])
      const freshCommands = new PostgresCommandCoordinator(db.pool)
      const freshFactory = await createProductionSources({pool:db.pool,commands:freshCommands,locations:{} as WorkspaceLocationService,mainId,runtimeRoot:runtimePath,endpoint:()=>endpoint,dispatch:()=>({} as PostgresJobDispatch)})
      const fresh = new WorkspaceBoundLocationService(db.pool, freshCommands, freshFactory.policies)
      expect(await fresh.get(owner.principal, { workspaceId })).toEqual(primary)
      expect((await app.inject({ method: 'GET', url: `${baseUrl}/root-policies`, headers: { authorization: `Bearer ${denied.token}` } })).statusCode).toBe(403)
      expect((await deniedClient.callTool({ name: 'workspace_root_choices_list', arguments: { workspaceId } })).isError).toBe(true)
      expect((await deniedClient.callTool({ name: 'workspace_root_location_set', arguments: input })).isError).toBe(true)
      const stale = await app.inject({ method: 'PUT', url: `${baseUrl}/root-location`, headers: auth, payload: { ...input, commandId: randomUUID() } })
      expect(stale.statusCode).toBe(409)
      const receipts = (await db.pool.query('select result from management_command_receipts where principal_id=$1 and command_id=$2', [owner.principal.id, input.commandId])).rows
      expect(receipts).toHaveLength(1); expect(receipts[0]?.result).toEqual(saved.json().value)
      expect((await db.pool.query('select count(*)::int as count from workflows')).rows[0]?.count).toBe(0)
      expect((await db.pool.query('select count(*)::int as count from agents')).rows[0]?.count).toBe(0)
    } finally {
      try { await Promise.allSettled(clients.map(client => client.close())); await app.close(); await db.close() }
      finally { if (rootDirectory) await removeFixtureDirectory(rootDirectory) }
    }
  }, 120_000)
})
