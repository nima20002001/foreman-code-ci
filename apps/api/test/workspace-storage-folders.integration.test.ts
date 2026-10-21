import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { seedAgent3 } from './helpers/wave25Agent3.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { callWorkspaceTool } from './helpers/workspaceMcp.js'
import { removeFixtureDirectory } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rename, lstat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import * as c from '@foreman-code/contracts/management'
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

it('discovers real unregistered folders without writes and safely deletes contents through authenticated MCP and HTTP', async () => {
  const connectionString = process.env.TEST_DATABASE_URL
  if (!connectionString || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('An explicit loopback TEST_DATABASE_URL is required.')
  }
  const directory = await mkdtemp(join(tmpdir(), 'workspace-storage-folders-'))
  const root = join(directory, 'workspaces'), external = join(directory, 'external')
  await mkdir(root); await mkdir(external)
  const database = await migratedDatabase()
  const { pool } = database
  const access = new PostgresAccessService(pool), commands = new PostgresCommandCoordinator(pool)
  const locations = new WorkspaceLocationService(pool, commands, undefined, 'runner-local')
  const defaults = new PostgresFoundationSettingsRepository(pool, root)
  const workspaces = new WorkspaceManagementService(pool, commands, locations, defaults, root)
  const services = { commands, workspaces } as unknown as OperatorServices
  const app = buildApp({ logger: false, readiness: {
    database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined },
  }, operator: { access, services } })
  const clients: Client[] = []
  try {
    const expiresAt = new Date(Date.now() + 120_000)
    const owner = await access.issue({ name: 'Folder owner', audience: 'operator',
      grants: [{ actions: [...c.ManagementActionSchema.options], scope: {} }], expiresAt })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'storage-folders-test', version: '1.0.0' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const client = await connect(owner.token)
    const reader = await access.issue({ name: 'Folder reader', audience: 'operator',
      grants: [{ actions: ['workspaces:read', 'workspace_locations:read', 'capabilities:read'], scope: {} }], expiresAt })
    const denied = await connect(reader.token)
    const scoped = await access.issue({ name: 'Scoped reader', audience: 'operator',
      grants: [{ actions: [...c.ManagementActionSchema.options], scope: { workspaceIds: ['only-one'] } }], expiresAt })
    await expect(workspaces.storageFolders.list(scoped.principal, {})).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    for (const name of ['A missing', 'B missing', 'C missing']) {
      await mkdir(join(root, name)); await writeFile(join(root, name, 'content.txt'), name)
    }
    await symlink(external, join(root, 'outside-link'))
    await writeFile(join(external, 'keep.txt'), 'keep outside')
    await symlink(external, join(root, 'A missing', 'external-link'))
    const registered = (await workspaces.create(owner.principal, 'http', { commandId: randomUUID(), name: 'Registered', parentPath: root })).value
    const read = (caller: Client, cursor?: string) => callWorkspaceTool(caller,
      'workspace_storage_folders_list', c.WorkspaceStorageFoldersPageSchema, { limit: 1, ...(cursor ? { cursor } : {}) })
    const before = (await pool.query('select count(*)::int as count from workspaces')).rows[0].count
    const first = await read(denied)
    expect(first.rootPath).toBe(root)
    expect(first.items.map((item) => item.name)).toEqual(['A missing'])
    const second = await read(client, first.pageInfo.nextCursor!)
    const third = await read(client, second.pageInfo.nextCursor!)
    expect([...second.items, ...third.items].map((item) => item.name)).toEqual(['B missing', 'C missing'])
    expect(third.pageInfo.nextCursor).toBeNull()
    expect((await pool.query('select count(*)::int as count from workspaces')).rows[0].count).toBe(before)
    expect((await workspaces.list(owner.principal, { limit: 1, includeArchived: false })).items[0]!.workspace.id).toBe(registered.workspace.id)
    const input = { commandId: randomUUID(), path: first.items[0]!.path, expectedIdentity: first.items[0]!.identity }
    const tools = (await denied.listTools()).tools.map((tool) => tool.name)
    expect(tools).toContain('workspace_storage_folders_list')
    expect(tools).not.toContain('workspace_storage_folder_delete')
    const capabilities = decodeMcpToolResult((await denied.callTool({ name: 'operator_get_capabilities', arguments: { detail: 'full' } }))) as { tools: string[] }
    expect(capabilities.tools).not.toContain('workspace_storage_folder_delete')
    await expectMcpAccessDenied(denied.callTool({ name: 'workspace_storage_folder_delete', arguments: input }))
    const deniedHttp = await app.inject({ method: 'POST', url: '/api/management/workspace-storage/folders/delete',
      headers: { authorization: `Bearer ${reader.token}` }, payload: input })
    expect(deniedHttp.statusCode).toBe(403)
    expect(await readFile(join(input.path, 'content.txt'), 'utf8')).toBe('A missing')
    const removed = await callWorkspaceTool(client, 'workspace_storage_folder_delete',
      c.WorkspaceStorageFolderDeleteResultSchema, input)
    expect(removed.value.path).toBe(input.path)
    const replayed = await callWorkspaceTool(client, 'workspace_storage_folder_delete',
      c.WorkspaceStorageFolderDeleteResultSchema, input)
    expect(replayed.replayed).toBe(true)
    await expect(lstat(input.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await read(client)).items[0]!.name).toBe('B missing')
    expect((await pool.query("select result from management_command_receipts where operation='workspace.storage_folder.delete' and command_id=$1", [input.commandId])).rows[0].result).toEqual({ path: input.path })

    // The bulk UI uses these same authenticated per-folder commands and receipts.
    const bulkPaths = ['Bulk first', 'Bulk second'].map((name) => join(root, name))
    for (const path of bulkPaths) { await mkdir(path); await writeFile(join(path, 'owned.txt'), 'owned bulk test content') }
    const bulkFolders = (await callWorkspaceTool(client, 'workspace_storage_folders_list',
      c.WorkspaceStorageFoldersPageSchema, { limit: 100 })).items.filter((item) => bulkPaths.includes(item.path))
    expect(bulkFolders).toHaveLength(2)
    for (const item of bulkFolders) {
      const command = { commandId: randomUUID(), path: item.path, expectedIdentity: item.identity }
      await expectMcpAccessDenied(denied.callTool({ name: 'workspace_storage_folder_delete', arguments: command }))
      const result = await callWorkspaceTool(client, 'workspace_storage_folder_delete',
        c.WorkspaceStorageFolderDeleteResultSchema, command)
      expect(result.value.path).toBe(item.path)
      const replayed = await callWorkspaceTool(client, 'workspace_storage_folder_delete',
        c.WorkspaceStorageFolderDeleteResultSchema, command)
      expect(replayed.replayed).toBe(true)
      expect((await pool.query("select result->>'path' as path from management_command_receipts where operation='workspace.storage_folder.delete' and command_id=$1", [command.commandId])).rows[0].path).toBe(item.path)
      await expect(lstat(item.path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect((await workspaces.storageFolders.list(owner.principal, { limit: 100 })).items.some((item) => bulkPaths.includes(item.path))).toBe(false)

    // The original identity is required even when a different folder now has the same name.
    const replacement = second.items[0]!
    const moved = join(directory, 'moved'); await rename(replacement.path, moved); await mkdir(replacement.path)
    await expect(workspaces.storageFolders.delete(owner.principal, 'http', { commandId: randomUUID(), path: replacement.path, expectedIdentity: replacement.identity })).rejects.toMatchObject({ code: 'DIRECTORY_CHANGED' })
    await removeFixtureDirectory(replacement.path, { force: false }); await rename(moved, replacement.path)
    // Storage root, nested paths, external paths, links and registered destinations are protected.
    for (const path of [root, external, join(root, 'outside-link'), registered.executionLocation!.rootPath, join(root, 'C missing', 'nested')]) {
      const result = await client.callTool({ name: 'workspace_storage_folder_delete', arguments: { commandId: randomUUID(), path, expectedIdentity: third.items[0]!.identity } })
      expect(result.isError).toBe(true)
    }
    expect(await readFile(join(external, 'keep.txt'), 'utf8')).toBe('keep outside')
    // Assignment made after discovery is still checked by the deletion transaction.
    await locations.set(owner.principal, 'http', { commandId: randomUUID(), workspaceId: registered.workspace.id,
      expectedLocationRevision: 1, runnerId: locations.runnerId, rootPath: third.items[0]!.path })
    await expect(workspaces.storageFolders.delete(owner.principal, 'http', { commandId: randomUUID(), path: third.items[0]!.path, expectedIdentity: third.items[0]!.identity })).rejects.toMatchObject({ code: 'DIRECTORY_IN_USE' })
    await defaults.updateWorkspaceDefaults({ suggestedName: 'New workspace', description: '', parentPath: replacement.path }, 0)
    await expect(workspaces.storageFolders.delete(owner.principal, 'http', { commandId: randomUUID(), path: replacement.path, expectedIdentity: replacement.identity })).rejects.toMatchObject({ code: 'DIRECTORY_IN_USE' })
    const protectedFolders = await workspaces.storageFolders.list(owner.principal, { limit: 100 })
    expect(protectedFolders.items.find((item) => item.path === replacement.path)?.deletion).toMatchObject({ status: 'protected', reason: 'defaults' })
    expect(protectedFolders.items.find((item) => item.path === registered.executionLocation!.rootPath)?.deletion).toMatchObject({ status: 'protected', reason: 'owned_folder' })
    expect(protectedFolders.items.some((item) => item.path === third.items[0]!.path)).toBe(false)
    const archivedPath = join(root, 'Archived folder'); await mkdir(archivedPath)
    const archived = (await workspaces.create(owner.principal, 'http', { commandId: randomUUID(), name: 'Archived reference' })).value
    await locations.set(owner.principal, 'http', { commandId: randomUUID(), workspaceId: archived.workspace.id,
      expectedLocationRevision: 0, runnerId: locations.runnerId, rootPath: archivedPath })
    await workspaces.archive(owner.principal, 'http', { commandId: randomUUID(), workspaceId: archived.workspace.id, expectedRevision: archived.revision })
    const archivedFolder = (await workspaces.storageFolders.list(owner.principal, { limit: 100 })).items.find((item) => item.path === archivedPath)!
    expect(archivedFolder.deletion).toMatchObject({ status: 'protected', reason: 'archived_workspace' })
    await expect(workspaces.storageFolders.delete(owner.principal, 'http', { commandId: randomUUID(), path: archivedPath, expectedIdentity: archivedFolder.identity })).rejects.toMatchObject({ code: 'DIRECTORY_IN_USE' })
    // A saved Run snapshot remains protected after its workspace location changes.
    const activePath = join(root, 'Active snapshot'); await mkdir(activePath)
    const activeFolder = (await workspaces.storageFolders.list(owner.principal, { limit: 100 })).items.find((item) => item.path === activePath)!
    const snapshot = await seedAgent3(pool, activePath, makeCurrentWorkflowFixture(randomUUID(), 'single'))
    await locations.set(owner.principal, 'http', { workspaceId: snapshot.run.workspaceId, commandId: randomUUID(),
      expectedLocationRevision: 1, runnerId: locations.runnerId, rootPath: external })
    await expect(workspaces.storageFolders.delete(owner.principal, 'http', { commandId: randomUUID(), path: activePath, expectedIdentity: activeFolder.identity })).rejects.toMatchObject({ code: 'DIRECTORY_IN_USE' })
    expect((await workspaces.storageFolders.list(owner.principal, { limit: 100 })).items.find((item) => item.path === activePath)?.deletion).toMatchObject({ status: 'protected', reason: 'active_run' })
    const httpPath = join(root, 'HTTP folder'); await mkdir(httpPath); await writeFile(join(httpPath, 'nested-content.txt'), 'owned test content')
    const headers = { authorization: `Bearer ${owner.token}` }
    const listedHttp = c.WorkspaceStorageFoldersPageSchema.parse((await app.inject({ url: '/api/management/workspace-storage/folders?limit=100', headers })).json())
    const httpFolder = listedHttp.items.find((item) => item.path === httpPath)!
    const removedHttp = await app.inject({ method: 'POST', url: '/api/management/workspace-storage/folders/delete', headers,
      payload: { commandId: randomUUID(), path: httpFolder.path, expectedIdentity: httpFolder.identity } })
    expect(removedHttp.statusCode).toBe(200)
    expect(c.WorkspaceStorageFolderDeleteResultSchema.parse(removedHttp.json()).value.path).toBe(httpPath)
    await expect(lstat(httpPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await workspaces.storageFolders.list(owner.principal, { limit: 100 })).items.some((item) => item.path === httpPath)).toBe(false)
    expect((await pool.query("select 1 from management_audit where action='workspace.storage_folder.delete' and outcome='succeeded'")).rowCount).toBe(4)
  } finally {
    for (const client of clients) await client.close()
    await app.close()
    await database.close()
    await removeFixtureDirectory(directory)
  }
}, 30_000)
