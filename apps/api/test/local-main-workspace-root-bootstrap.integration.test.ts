import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { removeFixtureDirectory } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rename, rm, stat, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import Fastify from 'fastify'
import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { WorkspaceBoundLocationSetResultSchema } from '@foreman-code/contracts/workspace-bound-location'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { workspaceRootDirectory } from './helpers/workspaceRootDirectory.js'
import { PostgresAccessService, bearerToken } from '../src/modules/access/postgres.js'
import { PostgresLocalHumanAccess } from '../src/modules/access/localHuman.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { registerOperatorHttpSecurity, requireLocalRequest } from '../src/modules/access/http.js'
import { WorkspaceBoundLocationService } from '../src/modules/workspace-roots/service.js'
import { registerWorkspaceRootRoutes, registerWorkspaceRootTools } from '../src/modules/workspace-roots/transports.js'
import { bootstrapLocalMainWorkspaceRoot } from '../src/modules/workspace-roots/localMainBootstrap.js'
import { createProductionSources } from '../src/modules/sources/production.js'
import { qualifyApprovedRootAllowlist } from '../src/modules/sources/rootAttestation.js'
import { sourceSha256 } from '../src/modules/sources/manifest.js'
import { workspaceStorageRoot } from '../src/modules/workspaces/storage.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { DomainError } from '../src/modules/errors.js'

const home = vi.hoisted(() => ({ path: '' }))
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), homedir: () => home.path }))

describe.skipIf(!postgresEnabled)('trusted local Main workspace storage bootstrap', () => {
  let fixtureHome: string

  beforeEach(async () => {
    fixtureHome = await workspaceRootDirectory()
    home.path = fixtureHome
  })

  afterEach(async () => {
    home.path = ''
    await removeFixtureDirectory(fixtureHome)
  })

  it('adopts actual app storage once and supports authenticated HTTP/MCP browse, bind and persisted replay without widening grants', async () => {
    const db = await currentDatabase(), app = Fastify(), clients: Client[] = [], directory = await workspaceRootDirectory()
    try {
      home.path = join(directory, 'home')
      const storageRoot = workspaceStorageRoot(), runtimeRoot = join(directory, 'runtime')
      await mkdir(storageRoot, { recursive: true, mode: 0o700 }); await chmod(storageRoot, 0o775)
      await mkdir(runtimeRoot, { mode: 0o700 })
      await mkdir(join(storageRoot, 'Project'), { mode: 0o700 })
      const outside = join(directory, 'external')
      await mkdir(outside, { mode: 0o700 }); await symlink(outside, join(storageRoot, 'escape'))
      const workspaceId = randomUUID()
      await db.pool.query('insert into workspaces(id,record,execution_location,location_revision) values($1,$2::jsonb,$3::jsonb,1)',
        [workspaceId, JSON.stringify({ id: workspaceId, name: 'Bootstrap fixture' }), JSON.stringify({ runnerId: 'runner-local', rootPath: join(storageRoot, 'Project') })])
      const mainId = (await db.pool.query<{ id: string }>('select id from application_installation where singleton=true')).rows[0]!.id
      const access = new PostgresAccessService(db.pool), commands = new PostgresCommandCoordinator(db.pool)
      const sources = await createProductionSources({ pool: db.pool, commands, mainId, runtimeRoot,
        locations: new WorkspaceLocationService(db.pool, commands, runtimeRoot),
        endpoint: () => { throw new Error('Main storage must not call a remote endpoint') },
        dispatch: () => { throw new Error('Independent workspace roots must not create Jobs') } })
      const bootstrap = () => bootstrapLocalMainWorkspaceRoot({ pool: db.pool, policies: sources.policies, mainId, runtimeRoot })
      const approved = await bootstrap()
      expect(approved).toMatchObject({ hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
        configurationRevision: '1', bases: [{ canonicalPath: storageRoot, accessModes: ['read-only', 'read-write'] }] })
      expect((await stat(storageRoot)).mode & 0o777).toBe(0o700)
      expect(await bootstrap()).toEqual(approved)
      expect((await db.pool.query('select count(*)::int as count from workspace_root_host_configurations')).rows[0]?.count).toBe(1)
      expect((await db.pool.query('select count(*)::int as count from workspace_root_policies')).rows[0]?.count).toBe(0)
      const owner = await access.issue({ name: 'Bootstrap owner', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: ManagementActionSchema.options, scope: {} }] })
      const readOnly = await access.issue({ name: 'Scoped read-only caller', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: ['source_roots:read', 'workspace_locations:read'], scope: { workspaceIds: [workspaceId] } }] })
      const service = new WorkspaceBoundLocationService(db.pool, commands, sources.policies)
      registerOperatorHttpSecurity(app, access, new PostgresLocalHumanAccess(db.pool, access))
      registerWorkspaceRootRoutes(app, service)
      app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500)
        .send({ error: { code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR' } }))
      app.post('/mcp', async (request, reply) => {
        requireLocalRequest(request)
        const principal = await access.authenticate(bearerToken(request.headers.authorization), 'operator')
        const server = new McpServer({ name: 'local-main-bootstrap', version: '1' })
        registerWorkspaceRootTools(server, service, principal, commands)
        const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        reply.raw.once('close', () => { void Promise.allSettled([transport.close(), server.close()]) })
        await server.connect(transport); reply.hijack(); await transport.handleRequest(request.raw, reply.raw, request.body)
      })
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => {
        const client = new Client({ name: 'bootstrap-proof', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
        return client
      }
      const client = await connect(owner.token), denied = await connect(readOnly.token)
      const auth = { authorization: `Bearer ${owner.token}` }, url = `/api/management/workspaces/${workspaceId}`
      const localAccess = await app.inject({ url: '/api/local-human' })
      expect(localAccess.statusCode, localAccess.body).toBe(200)
      expect(localAccess.json().principal.id).toBe('principal-local-human')
      const localLocation = await app.inject({ url: `${url}/root-location` })
      expect(localLocation.statusCode, localLocation.body).toBe(200)
      expect(localLocation.json()).toMatchObject({ workspaceId, evidence: 'legacy_missing', locationRevision: 1 })
      const localChoices = await app.inject({ url: `${url}/root-policies`,
        headers: { cookie: 'graphql_operator=obsolete' } })
      expect(localChoices.statusCode, localChoices.body).toBe(200)
      expect(localChoices.json()).toMatchObject({ workspaceId, allowlists: [approved], readiness: 'metadata-only' })
      expect(localChoices.headers['set-cookie']).toBeUndefined()
      expect(await service.get(owner.principal, { workspaceId })).toMatchObject({ evidence: 'legacy_missing', locationRevision: 1 })
      const choices = await client.callTool({ name: 'workspace_root_choices_list', arguments: { workspaceId } })
      expect(choices.isError).not.toBe(true)
      expect(decodeMcpToolResult(choices)).toEqual(localChoices.json())
      expect(decodeMcpToolResult(choices)).toEqual((await app.inject({ method: 'GET', url: `${url}/root-policies`, headers: auth })).json())
      for (const grants of [
        [{ actions: ['workspace_locations:read' as const], scope: { workspaceIds: [workspaceId] } }],
        [{ actions: ['source_roots:read' as const, 'workspace_locations:read' as const],
          scope: { workspaceIds: ['another-workspace'] } }],
      ]) {
        const restricted = await access.issue({ name: 'Restricted root reader', audience: 'operator', grants,
          expiresAt: new Date(Date.now() + 600_000) })
        const restrictedClient = await connect(restricted.token)
        for (const suffix of ['root-location', 'root-policies']) {
          const response = await app.inject({ url: `${url}/${suffix}`,
            headers: { authorization: `Bearer ${restricted.token}` } })
          expect(response.statusCode, response.body).toBe(403)
        }
        for (const name of ['workspace_root_location_get', 'workspace_root_choices_list']) {
          expect((await restrictedClient.callTool({ name, arguments: { workspaceId } })).isError).toBe(true)
        }
        expect(await access.authenticate(restricted.token)).toEqual(restricted.principal)
      }
      const selection = { workspaceId, hostRef: approved.hostRef, allowedBaseId: approved.bases[0]!.baseId, configurationRevision: '1',
        relativePath: '', accessMode: 'read-write', expectedLocationRevision: 1, expectedRootPolicyRevision: 0 }
      const browse = await client.callTool({ name: 'workspace_root_directories_list', arguments: selection })
      expect(browse.isError).not.toBe(true)
      expect(decodeMcpToolResult(browse)).toMatchObject({ browse: { directories: [{ name: 'Project', relativePath: 'Project' }] } })
      const input = { ...selection, relativePath: 'Project', commandId: randomUUID() }
      expect((await denied.callTool({ name: 'workspace_root_location_set', arguments: input })).isError).toBe(true)
      expect((await denied.callTool({ name: 'workspace_root_location_validate', arguments: { ...selection, relativePath: 'Project' } })).isError).toBe(true)
      const valid = await client.callTool({ name: 'workspace_root_location_validate', arguments: { ...selection, relativePath: 'Project' } })
      expect(valid.isError).not.toBe(true)
      const saved = await client.callTool({ name: 'workspace_root_location_set', arguments: input })
      expect(saved.isError).not.toBe(true)
      const accepted = WorkspaceBoundLocationSetResultSchema.parse(decodeMcpToolResult(saved))
      expect(decodeMcpToolResult(saved)).toMatchObject({ replayed: false, value: { evidence: 'bound', locationRevision: 2,
        executionLocation: { runnerId: 'runner-local', rootPath: join(storageRoot, 'Project') },
        binding: { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId, rootPolicyRevision: '1', configurationRevision: '1' } } })
      expect(decodeMcpToolResult((await client.callTool({ name: 'workspace_root_location_set', arguments: input })))).toEqual({ ...accepted, replayed: true })
      const get = await client.callTool({ name: 'workspace_root_location_get', arguments: { workspaceId } })
      expect(decodeMcpToolResult(get)).toEqual(accepted.value)
      expect((await app.inject({ method: 'GET', url: `${url}/root-location`, headers: auth })).json()).toEqual(decodeMcpToolResult(get))
      const persistedLocalLocation = await app.inject({ url: `${url}/root-location` })
      expect(persistedLocalLocation.statusCode, persistedLocalLocation.body).toBe(200)
      expect(persistedLocalLocation.json()).toEqual(accepted.value)
      const persistedLocalChoices = await app.inject({ url: `${url}/root-policies` })
      expect(persistedLocalChoices.statusCode, persistedLocalChoices.body).toBe(200)
      expect(persistedLocalChoices.json().policies).toEqual([persistedLocalLocation.json().binding])
      expect((await client.callTool({ name: 'workspace_root_location_set', arguments: { ...input, commandId: randomUUID() } })).isError).toBe(true)
      expect((await client.callTool({ name: 'workspace_root_location_set', arguments: { ...input, relativePath: '' } })).isError).toBe(true)
      const freshSelection = { ...selection, expectedLocationRevision: 2, expectedRootPolicyRevision: 1 }
      for (const hostile of [
        { ...freshSelection, relativePath: '../external' }, { ...freshSelection, relativePath: 'escape' },
        { ...freshSelection, allowedBaseId: randomUUID() }, { ...freshSelection, hostRef: { kind: 'main', mainId: randomUUID() } },
        { ...freshSelection, hostRef: { kind: 'device', mainId, deviceId: randomUUID() } },
      ]) expect((await client.callTool({ name: 'workspace_root_location_validate', arguments: hostile })).isError).toBe(true)
      expect((await db.pool.query('select grants from management_principals where id=$1', [readOnly.principal.id])).rows[0]?.grants).toEqual(readOnly.principal.grants)
      expect((await db.pool.query('select count(*)::int as count from workspace_root_policies')).rows[0]?.count).toBe(1)
      expect((await db.pool.query('select count(*)::int as count from workflows')).rows[0]?.count).toBe(0)
      await rename(runtimeRoot, `${runtimeRoot}-original`); await mkdir(runtimeRoot, { mode: 0o700 })
      await expect(bootstrap()).rejects.toMatchObject({ code: 'ROOT_RUNTIME_CHANGED' })
      await removeFixtureDirectory(runtimeRoot, { force: false }); await rename(`${runtimeRoot}-original`, runtimeRoot)
      expect(await bootstrap()).toEqual(approved)
      await rename(storageRoot, `${storageRoot}-original`); await mkdir(storageRoot, { mode: 0o700 })
      await expect(bootstrap()).rejects.toMatchObject({ code: 'ROOT_BASE_CHANGED' })
    } finally {
      await Promise.allSettled(clients.map(client => client.close())); await app.close(); await db.close()
      await removeFixtureDirectory(directory)
    }
  }, 120_000)

  it('rejects bootstrap symlinks, runtime overlap and foreign Main; preserves explicit external configuration', async () => {
    const db = await currentDatabase(), directory = await workspaceRootDirectory()
    try {
      home.path = join(directory, 'home')
      const storageRoot = workspaceStorageRoot(), runtimeRoot = join(directory, 'runtime'), external = join(directory, 'external')
      await mkdir(join(home.path, '.local', 'share', 'graphql'), { recursive: true, mode: 0o700 })
      await mkdir(runtimeRoot, { mode: 0o700 }); await mkdir(external, { mode: 0o700 })
      const mainId = (await db.pool.query<{ id: string }>('select id from application_installation where singleton=true')).rows[0]!.id
      const commands = new PostgresCommandCoordinator(db.pool)
      const sources = await createProductionSources({ pool: db.pool, commands, mainId, runtimeRoot,
        locations: new WorkspaceLocationService(db.pool, commands, runtimeRoot),
        endpoint: () => { throw new Error('No remote roots') }, dispatch: () => { throw new Error('No jobs') } })
      const input = { pool: db.pool, policies: sources.policies, mainId, runtimeRoot }
      await expect(bootstrapLocalMainWorkspaceRoot({ ...input, mainId: randomUUID() })).rejects.toMatchObject({ code: 'ROOT_WRONG_MAIN' })
      await expect(bootstrapLocalMainWorkspaceRoot({ ...input, runtimeRoot: storageRoot })).rejects.toMatchObject({ code: 'ROOT_CONFIGURATION_CONFLICT' })
      await symlink(external, storageRoot)
      await expect(bootstrapLocalMainWorkspaceRoot(input)).rejects.toThrow()
      expect((await stat(external)).mode & 0o777).toBe(0o700)
      expect((await db.pool.query('select count(*)::int as count from workspace_root_host_configurations')).rows[0]?.count).toBe(0)
      await rm(storageRoot)
      const runtimeAlias = join(directory, 'runtime-alias')
      await symlink(runtimeRoot, runtimeAlias)
      await expect(bootstrapLocalMainWorkspaceRoot({ ...input, runtimeRoot: runtimeAlias })).rejects.toThrow()
      expect((await db.pool.query('select count(*)::int as count from workspace_root_host_configurations')).rows[0]?.count).toBe(0)
      const approved = await qualifyApprovedRootAllowlist({ schemaVersion: 1, hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
        configurationRevision: '7', bases: [{ baseId: randomUUID(), canonicalPath: external, accessModes: ['read-only'] }], managedRuntimeRoot: runtimeRoot })
      const sql = await db.pool.connect()
      try {
        await sql.query('begin')
        await sources.policies.publishApprovedHostConfiguration(sql, approved, { mainId, hostRef: approved.hostRef, applicationInstallationId: mainId,
          configurationRevision: '7', configurationDigest: sourceSha256(Buffer.from(JSON.stringify(approved))) })
        await sql.query('commit')
      } catch (error) { await sql.query('rollback'); throw error } finally { sql.release() }
      expect(await bootstrapLocalMainWorkspaceRoot(input)).toEqual(approved)
      expect((await db.pool.query('select count(*)::int as count from workspace_root_host_configurations')).rows[0]?.count).toBe(1)
    } finally { await db.close(); await removeFixtureDirectory(directory) }
  }, 120_000)

  it('uses an already-private isolated server storage override under sticky /tmp without touching default storage', async () => {
    const db = await currentDatabase(), storageRoot = await workspaceRootDirectory(), runtimeRoot = await workspaceRootDirectory()
    try {
      home.path = join(storageRoot, 'unused-default-home')
      const mainId = (await db.pool.query<{ id: string }>('select id from application_installation where singleton=true')).rows[0]!.id
      const commands = new PostgresCommandCoordinator(db.pool)
      const sources = await createProductionSources({ pool: db.pool, commands, mainId, runtimeRoot,
        locations: new WorkspaceLocationService(db.pool, commands, runtimeRoot),
        endpoint: () => { throw new Error('No remote roots') }, dispatch: () => { throw new Error('No jobs') } })
      const input = { pool: db.pool, policies: sources.policies, mainId, runtimeRoot, appStorageRoot: storageRoot }
      const approved = await bootstrapLocalMainWorkspaceRoot(input)
      expect(approved.bases[0]!.canonicalPath).toBe(storageRoot)
      expect(await bootstrapLocalMainWorkspaceRoot(input)).toEqual(approved)
      await expect(stat(workspaceStorageRoot())).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await db.close(); await removeFixtureDirectory(storageRoot); await removeFixtureDirectory(runtimeRoot)
    }
  }, 120_000)
})
