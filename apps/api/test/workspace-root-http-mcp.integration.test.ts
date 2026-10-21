import { readUntil } from './helpers/observableCondition.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { removeFixtureDirectory } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { mkdir, rename, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it, vi } from 'vitest'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import type { ApprovedRootAllowlist } from '@foreman-code/contracts/workspace-root-policies'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { workspaceRootDirectory } from './helpers/workspaceRootDirectory.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceBoundLocationService } from '../src/modules/workspace-roots/service.js'
import { PostgresWorkspaceRootPolicies } from '../src/modules/sources/rootPolicies.js'
import { InstalledWorkspaceRootHosts } from '../src/modules/sources/rootHosts.js'
import { openPrivateRoot, identity } from '../src/modules/sources/privateFilesystem.js'
import { assertDeviceHostInstallation } from '../src/modules/devices/hostAuthorization.js'
import { sourceSha256 } from '../src/modules/sources/manifest.js'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { cleanupWorkspaceProjectFolders } from '../src/modules/workspaces/projectFolderCleanup.js'
import { withTransaction } from '../src/infrastructure/transaction.js'

/** Actual Postgres/main installation/grants/native component-safe temporary FS.
 * Synthetic human-approved main configuration; no laptop/provider acceptance. */
describe.skipIf(!postgresEnabled)('W08 independent workspace root HTTP/MCP', () => {
  it('binds an unconfigured workspace without an Agent/Workflow, replays exact receipt and denies a scoped caller', async () => {
    const db = await currentDatabase(), clients: Client[] = []
    let app: ReturnType<typeof buildApp> | undefined
    let rootDirectory: string | undefined
    try {
      const workspaceId = randomUUID(), foreignId = randomUUID()
      for (const id of [workspaceId, foreignId]) await db.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [id, JSON.stringify({ id, name: 'Independent root fixture' })])
      const mainId = (await db.pool.query<{ id: string }>('select id from application_installation where singleton=true')).rows[0]!.id
      rootDirectory = await workspaceRootDirectory()
      const basePath = join(rootDirectory, 'approved-base'), runtimePath = join(rootDirectory, 'root-runtime')
      await mkdir(basePath, { mode: 0o700 }); await mkdir(runtimePath, { mode: 0o700 }); await mkdir(join(basePath, 'project'), { mode: 0o700 })
      const base = await openPrivateRoot(basePath), runtime = await openPrivateRoot(runtimePath)
      let allowlist: ApprovedRootAllowlist
      try { allowlist = { schemaVersion: 1, hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId, configurationRevision: '1',
        bases: [{ baseId: randomUUID(), canonicalPath: basePath, filesystem: await identity(base), accessModes: ['read-only', 'read-write'] }],
        managedRuntimeRoot: runtimePath, runtimeFilesystem: await identity(runtime) } } finally { await base.close(); await runtime.close() }
      const access = new PostgresAccessService(db.pool), commands = new PostgresCommandCoordinator(db.pool)
      const owner = await access.issue({ name: 'Root fixture owner', audience: 'operator', expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ManagementActionSchema.options, scope: {} }] })
      const denied = await access.issue({ name: 'Foreign workspace reader', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: ['source_roots:read', 'workspace_locations:read'], scope: { workspaceIds: [foreignId] } }] })
      const hosts = new InstalledWorkspaceRootHosts(allowlist, async (sql, _principal, host, installation) => {
        const registration = await assertDeviceHostInstallation(sql, host, installation)
        return registration === null ? null : { workerInstallationId: registration.workerInstallationId,
          keyRevision: registration.keyRevision, authorizationRevision: registration.authorizationRevision }
      }, { request: async () => { throw new Error('This synthetic main fixture has no remote worker') } })
      const policies = new PostgresWorkspaceRootPolicies(mainId, hosts)
      await withTransaction(db.pool, async sql => {
        await policies.publishApprovedHostConfiguration(sql, allowlist, {
          mainId, hostRef: allowlist.hostRef, applicationInstallationId: mainId, configurationRevision: '1',
          configurationDigest: sourceSha256(Buffer.from(JSON.stringify(allowlist))),
        })
      })
      const service = new WorkspaceBoundLocationService(db.pool, commands, policies)
      const locations = new WorkspaceLocationService(db.pool, commands, runtimePath, 'runner-local')
      locations.setRootPolicies(policies)
      const workspaces = new WorkspaceManagementService(db.pool, commands, locations)
      const services = { commands, locations, workspaces, workspaceRoots: service } as unknown as OperatorServices
      app = buildApp({ logger: false,
        readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access, services },
      })
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => { const client = new Client({ name: 'independent-root-readback', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } })); return client }
      const client = await connect(owner.token), deniedClient = await connect(denied.token), auth = { authorization: `Bearer ${owner.token}` }
      const baseUrl = `/api/management/workspaces/${workspaceId}`
      const choices = await app.inject({ method: 'GET', url: `${baseUrl}/root-policies`, headers: auth })
      expect(choices.statusCode).toBe(200); expect(choices.json().allowlists[0]).toEqual(allowlist)
      expect(decodeMcpToolResult((await client.callTool({ name: 'workspace_root_choices_list', arguments: { workspaceId } })))).toEqual(choices.json())
      const selection = { workspaceId, hostRef: allowlist.hostRef, allowedBaseId: allowlist.bases[0]!.baseId, configurationRevision: '1',
        relativePath: 'project', accessMode: 'read-only', expectedLocationRevision: 0, expectedRootPolicyRevision: 0 }
      const validation = await client.callTool({ name: 'workspace_root_location_validate', arguments: selection })
      expect(validation.isError).not.toBe(true)
      expect((decodeMcpToolResult(validation) as { attestation: { canonicalProjectRoot: string } }).attestation.canonicalProjectRoot).toBe(join(basePath, 'project'))
      const input = { ...selection, commandId: randomUUID() }
      let attested!: () => void
      let continueBinding!: () => void
      const enteredAttestation = new Promise<void>(resolve => { attested = resolve })
      const bindingGate = new Promise<void>(resolve => { continueBinding = resolve })
      const originalAttest = policies.attest.bind(policies)
      const attestationSpy = vi.spyOn(policies, 'attest').mockImplementationOnce(async root => {
        const result = await originalAttest(root)
        attested()
        await bindingGate
        return result
      })
      const firstSave = app.inject({ method: 'PUT', url: `${baseUrl}/root-location`, headers: auth, payload: input })
      await enteredAttestation
      const overlappingSave = client.callTool({ name: 'workspace_root_location_set', arguments: input })
      continueBinding()
      const saved = await firstSave
      const overlapping = await overlappingSave
      attestationSpy.mockRestore()
      expect(overlapping.isError).not.toBe(true)
      expect(decodeMcpToolResult(overlapping)).toEqual({ ...saved.json(), replayed: true })
      expect(saved.statusCode).toBe(200); expect(saved.json().value).toMatchObject({ evidence: 'bound', workspaceId, locationRevision: 1,
        executionLocation: { runnerId: 'runner-local', rootPath: join(basePath, 'project') } })
      const replay = await client.callTool({ name: 'workspace_root_location_set', arguments: input })
      expect(replay.isError).not.toBe(true); expect(decodeMcpToolResult(replay)).toEqual({ ...saved.json(), replayed: true })
      expect((await service.get(owner.principal, { workspaceId }))).toEqual(saved.json().value)
      expect(decodeMcpToolResult((await client.callTool({ name: 'workspace_get', arguments: { workspaceId } }))))
        .toMatchObject({ executionLocation: saved.json().value.executionLocation, locationValidation: { status: 'ready' } })
      const legacyInput = { workspaceId, commandId: randomUUID(), expectedLocationRevision: 1,
        runnerId: 'runner-local', rootPath: join(basePath, 'project') }
      const legacyHttp = await app.inject({ method: 'PUT', url: `${baseUrl}/location`, headers: auth, payload: legacyInput })
      expect(legacyHttp.statusCode).toBe(409)
      expect(legacyHttp.json().error.code).toBe('WORKSPACE_ROOT_BINDING_REQUIRED')
      const legacyMcp = await client.callTool({ name: 'workspace_location_set', arguments: legacyInput })
      expect(legacyMcp.isError).toBe(true)
      expect(legacyMcp.content).toEqual([{ type: 'text', text: expect.stringContaining('WORKSPACE_ROOT_BINDING_REQUIRED') }])
      expect(await service.get(owner.principal, { workspaceId })).toEqual(saved.json().value)
      const fresh = new WorkspaceBoundLocationService(db.pool, new PostgresCommandCoordinator(db.pool), new PostgresWorkspaceRootPolicies(mainId, hosts))
      expect(await fresh.get(owner.principal, { workspaceId })).toEqual(saved.json().value)
      expect((await app.inject({ method: 'GET', url: `${baseUrl}/root-policies`, headers: { authorization: `Bearer ${denied.token}` } })).statusCode).toBe(403)
      expect((await deniedClient.callTool({ name: 'workspace_root_choices_list', arguments: { workspaceId } })).isError).toBe(true)
      expect((await deniedClient.callTool({ name: 'workspace_root_location_set', arguments: input })).isError).toBe(true)
      expect((await deniedClient.callTool({ name: 'workspace_location_set', arguments: legacyInput })).isError).toBe(true)
      const stale = await app.inject({ method: 'PUT', url: `${baseUrl}/root-location`, headers: auth, payload: { ...input, commandId: randomUUID() } })
      expect(stale.statusCode).toBe(409)
      const receipts = (await db.pool.query('select result from management_command_receipts where principal_id=$1 and command_id=$2', [owner.principal.id, input.commandId])).rows
      expect(receipts).toHaveLength(1); expect(receipts[0]?.result).toEqual(saved.json().value)
      const invalid = { ...input, commandId: randomUUID(), relativePath: 'project/',
        expectedLocationRevision: 1, expectedRootPolicyRevision: 1 }
      const invalidHttp = await app.inject({ method: 'PUT', url: `${baseUrl}/root-location`, headers: auth, payload: invalid })
      expect(invalidHttp.statusCode).toBe(422)
      expect(invalidHttp.json().error.code).toBe('ROOT_RELATIVE_PATH_INVALID')
      const invalidMcp = await client.callTool({ name: 'workspace_root_location_set', arguments: invalid })
      expect(invalidMcp.isError).toBe(true)
      expect(invalidMcp.content).toEqual([{ type: 'text', text: expect.stringContaining('ROOT_RELATIVE_PATH_INVALID') }])
      expect(await fresh.get(owner.principal, { workspaceId })).toEqual(saved.json().value)

      const missing = { ...invalid, commandId: randomUUID(), relativePath: 'not-created' }
      const missingHttp = await app.inject({
        method: 'PUT', url: `${baseUrl}/root-location`, headers: auth, payload: missing,
      })
      expect(missingHttp.statusCode).toBe(409)
      expect(missingHttp.json().error.code).toBe('ROOT_DIRECTORY_MISSING')
      const missingMcp = await client.callTool({ name: 'workspace_root_location_set', arguments: missing })
      expect(missingMcp.isError).toBe(true)
      expect(missingMcp.content).toEqual([
        { type: 'text', text: expect.stringContaining('ROOT_DIRECTORY_MISSING') },
      ])
      const deniedMissing = await deniedClient.callTool({ name: 'workspace_root_location_set', arguments: missing })
      expect(deniedMissing.isError).toBe(true)
      expect(deniedMissing.content).toEqual([{ type: 'text', text: expect.stringContaining('ACCESS_DENIED') }])
      expect(await fresh.get(owner.principal, { workspaceId })).toEqual(saved.json().value)
      expect(decodeMcpToolResult((await client.callTool({ name: 'workspace_get', arguments: { workspaceId } }))))
        .toMatchObject({ executionLocation: saved.json().value.executionLocation, locationValidation: { status: 'ready' } })

      await rename(join(basePath, 'project'), join(basePath, 'original-project'))
      await mkdir(join(basePath, 'project'), { mode: 0o700 })
      const repaired = await client.callTool({ name: 'workspace_root_location_set', arguments: {
        ...invalid, commandId: randomUUID(), relativePath: 'project',
      } })
      expect(repaired.isError).not.toBe(true)
      const replacement = (decodeMcpToolResult(repaired) as { value: { binding: { directoryIdentityHash: string } } }).value
      expect(replacement.binding.directoryIdentityHash).not.toBe(saved.json().value.binding.directoryIdentityHash)
      expect(await fresh.get(owner.principal, { workspaceId })).toEqual(replacement)
      const history = await db.pool.query<{ record: unknown }>(
        'select record from workspace_root_policies where workspace_id=$1 order by root_policy_revision', [workspaceId],
      )
      expect(history.rows.map(row => row.record)).toEqual([saved.json().value.binding, replacement.binding])

      const removableId = randomUUID()
      const projectPath = join(basePath, 'project')
      await mkdir(join(basePath, 'other-project'), { mode: 0o700 })
      const moved = await client.callTool({ name: 'workspace_root_location_set', arguments: {
        ...input, commandId: randomUUID(), relativePath: 'other-project',
        expectedLocationRevision: 2, expectedRootPolicyRevision: 2,
      } })
      expect(moved.isError).not.toBe(true)
      const folderIdentity = await lstat(projectPath, { bigint: true })
      await db.pool.query(`insert into workspaces(id,record,archived_at,created_project_folder)
        values($1,$2::jsonb,now(),$3::jsonb)`, [removableId, JSON.stringify({ id: removableId, name: 'Folder owner' }),
        JSON.stringify({ runnerId: 'runner-local', rootPath: projectPath,
          identity: { device: String(folderIdentity.dev), inode: String(folderIdentity.ino) } })])
      let bindAttested!: () => void
      let finishBind!: () => void
      const bindReached = new Promise<void>(resolve => { bindAttested = resolve })
      const bindPaused = new Promise<void>(resolve => { finishBind = resolve })
      const raceAttestation = vi.spyOn(policies, 'attest').mockImplementationOnce(async root => {
        const result = await originalAttest(root)
        bindAttested()
        await bindPaused
        return result
      })
      const binding = client.callTool({ name: 'workspace_root_location_set', arguments: {
        ...input, commandId: randomUUID(), expectedLocationRevision: 3, expectedRootPolicyRevision: 3,
      } })
      await bindReached
      const cleanupClient = await db.pool.connect()
      const cleanupPid = (await cleanupClient.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      const cleanupPool = { connect: async () => cleanupClient } as unknown as typeof db.pool
      const cleanup = cleanupWorkspaceProjectFolders(cleanupPool, owner.principal, [removableId], 'runner-local', 'http', randomUUID())
      const cleanupOutcome = cleanup.then(() => ({ removed: true as const }), error => ({ error }))
      try {
        await readUntil(async () => (await db.pool.query<{ blocked: boolean }>(
          'select cardinality(pg_blocking_pids($1)) > 0 as blocked', [cleanupPid])).rows[0]!.blocked,
        blocked => blocked, { timeoutMs: 1000, description: 'folder cleanup to wait for binding' })
      } finally {
        finishBind()
        await Promise.allSettled([binding, cleanupOutcome])
      }
      const raceResult = await binding
      raceAttestation.mockRestore()
      expect(raceResult.isError).not.toBe(true)
      expect(await cleanupOutcome).toMatchObject({ error: { code: 'WORKSPACE_FOLDER_CLEANUP_FAILED' } })
      expect((await lstat(projectPath)).isDirectory()).toBe(true)
      expect(decodeMcpToolResult((await client.callTool({ name: 'workspace_get', arguments: { workspaceId } }))))
        .toMatchObject({ locationRevision: 4, locationValidation: { status: 'ready' } })
      expect((await db.pool.query('select count(*)::int as count from workflows')).rows[0]?.count).toBe(0)
      expect((await db.pool.query('select count(*)::int as count from agents')).rows[0]?.count).toBe(0)
    } finally {
      try { await Promise.allSettled(clients.map(client => client.close())); await app?.close(); await db.close() }
      finally { if (rootDirectory) await removeFixtureDirectory(rootDirectory) }
    }
  }, 120_000)
})
