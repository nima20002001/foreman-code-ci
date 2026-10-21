import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { callWorkspaceTool } from './helpers/workspaceMcp.js'
import { createFixtureSchema, dropFixtureSchema, removeFixtureDirectory } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rename, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import * as c from '@foreman-code/contracts/management'
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

it('removes a workspace through authenticated MCP with denied access, replay and persisted readback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-removal-'))
  const connectionString = process.env.TEST_DATABASE_URL!
  const schema = 'settings_removal_' + randomUUID().replaceAll('-', '')
  const admin = new pg.Pool({ connectionString })
  await createFixtureSchema(admin, schema)
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
  const access = new PostgresAccessService(pool), commands = new PostgresCommandCoordinator(pool)
  const locations = new WorkspaceLocationService(pool, commands)
  const workspaces = new WorkspaceManagementService(pool, commands, locations)
  const workflows = new WorkflowManagementService(pool, commands)
  const services = { commands, workspaces, workflows } as unknown as OperatorServices
  const app = buildApp({ logger: false, readiness: {
    database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined },
  }, operator: { access, services } })
  const clients: Client[] = []
  try {
    await applyApplicationMigrations(pool)
    const owner = await access.issue({ name: 'Removal owner', audience: 'operator',
      grants: [{ actions: [...c.ManagementActionSchema.options], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'settings-removal-test', version: '1.0.0' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const client = await connect(owner.token)
    const reader = await access.issue({ name: 'Reader', audience: 'operator', grants: [{ actions: ['workspaces:read'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
    const denied = await connect(reader.token)

    // The single-workspace removal action uses the same authenticated archive capability.
    const single = (await callWorkspaceTool(client, 'workspace_create', c.ManagedWorkspaceCommandResultSchema, {
      commandId: randomUUID(), name: 'Single removal', parentPath: directory,
    })).value
    const project = join(directory, 'Single removal')
    await writeFile(join(project, 'owned.txt'), 'owned content')
    // Existing workspaces recover ownership only from their creation receipt and original location identity.
    await pool.query('alter table workspaces drop column created_project_folder')
    await pool.query('delete from application_migrations where version = 264405')
    await applyApplicationMigrations(pool)
    expect((await pool.query('select created_project_folder from workspaces where id=$1', [single.workspace.id])).rows[0].created_project_folder.rootPath).toBe(project)
    const retained = await workflows.create(owner.principal, 'http', { commandId: randomUUID(), workspaceId: single.workspace.id, name: 'History stays' })
    const singleInput = { commandId: randomUUID(), workspaceId: single.workspace.id, expectedRevision: single.revision }
    await expectMcpAccessDenied(denied.callTool({ name: 'workspace_archive', arguments: singleInput }))
    const archiveOnly = await access.issue({ name: 'Archive only', audience: 'operator', grants: [{ actions: ['workspaces:archive'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
    expect((await (await connect(archiveOnly.token)).callTool({ name: 'workspace_archive', arguments: singleInput })).isError).toBe(true)
    expect(await readFile(join(project, 'owned.txt'), 'utf8')).toBe('owned content')
    const removed = await callWorkspaceTool(client, 'workspace_archive', c.ManagedWorkspaceCommandResultSchema, singleInput)
    expect(removed.value.archivedAt).not.toBeNull()
    const replayed = await callWorkspaceTool(client, 'workspace_archive', c.ManagedWorkspaceCommandResultSchema, singleInput)
    expect(replayed.replayed).toBe(true)
    const persisted = await callWorkspaceTool(client, 'workspace_get', c.ManagedWorkspaceSchema,
      { workspaceId: single.workspace.id })
    expect(persisted.archivedAt).toBe(removed.value.archivedAt)
    expect(persisted.revision).toBe(single.revision + 1)
    await expect(stat(project)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await pool.query('select id from workflows where id=$1', [retained.value.workflow.id])).rowCount).toBe(1)
    // A new workspace can reuse the deleted name, without old archived references blocking cleanup.
    const reused = (await workspaces.create(owner.principal, 'http', { commandId: randomUUID(), name: 'Single removal', parentPath: directory })).value
    await workspaces.archive(owner.principal, 'http', { commandId: randomUUID(), workspaceId: reused.workspace.id, expectedRevision: reused.revision })
    await expect(stat(project)).rejects.toMatchObject({ code: 'ENOENT' })

    // Selected existing folders are never owned by workspace removal.
    const external = join(directory, 'existing'); await mkdir(external); await writeFile(join(external, 'keep.txt'), 'keep')
    const attached = (await workspaces.create(owner.principal, 'http', { commandId: randomUUID(), name: 'Attached' })).value
    await locations.set(owner.principal, 'http', { commandId: randomUUID(), workspaceId: attached.workspace.id,
      expectedLocationRevision: 0, runnerId: locations.runnerId, rootPath: external })
    await client.callTool({ name: 'workspace_archive', arguments: { commandId: randomUUID(), workspaceId: attached.workspace.id, expectedRevision: attached.revision } })
    expect(await readFile(join(external, 'keep.txt'), 'utf8')).toBe('keep')

    // A replaced directory is protected, and restoring the original allows the same command to finish cleanup.
    const retry = (await workspaces.create(owner.principal, 'http', { commandId: randomUUID(), name: 'Retry', parentPath: directory })).value
    const retryPath = join(directory, 'Retry'), moved = join(directory, 'moved')
    await rename(retryPath, moved); await mkdir(retryPath); await writeFile(join(retryPath, 'keep.txt'), 'replacement')
    const retryInput = { commandId: randomUUID(), workspaceId: retry.workspace.id, expectedRevision: retry.revision }
    expect((await client.callTool({ name: 'workspace_archive', arguments: retryInput })).isError).toBe(true)
    expect(await readFile(join(retryPath, 'keep.txt'), 'utf8')).toBe('replacement')
    await removeFixtureDirectory(retryPath, { force: false }); await rename(moved, retryPath)
    const retried = await callWorkspaceTool(client, 'workspace_archive', c.ManagedWorkspaceCommandResultSchema, retryInput)
    expect(retried.replayed).toBe(true)
    await expect(stat(retryPath)).rejects.toMatchObject({ code: 'ENOENT' })

    const batch = await Promise.all(['Batch A', 'Batch B'].map(async (name) => (await workspaces.create(owner.principal, 'http', { commandId: randomUUID(), name, parentPath: directory })).value))
    const batchResult = await client.callTool({ name: 'workspace_batch_archive', arguments: { commandId: randomUUID(), workspaces: batch.map((item) => ({ workspaceId: item.workspace.id, expectedRevision: item.revision })) } })
    expect(batchResult.isError, JSON.stringify(batchResult)).not.toBe(true)
    for (const name of ['Batch A', 'Batch B']) await expect(stat(join(directory, name))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await pool.query("select 1 from management_audit where action='workspace.folder.cleanup' and outcome='succeeded'")).rowCount).toBeGreaterThan(0)
  } finally {
    for (const client of clients) await client.close()
    await app.close(); await pool.end()
    await dropFixtureSchema(admin, schema); await admin.end()
    await removeFixtureDirectory(directory)
  }
}, 30_000)
