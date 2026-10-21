import { removeFixtureDirectory } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { expect, it } from 'vitest'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'

it('creates a ready project folder once, preserves defaults and rejects collisions and traversal', async () => {
  const parentPath = await mkdtemp(join(tmpdir(), 'workspace-create-'))
  const database = await migratedDatabase()
  const { pool } = database
  try {
    const principal = (await new PostgresAccessService(pool).issue({
      name: 'Creation test', audience: 'operator', expiresAt: new Date(Date.now() + 60_000),
      grants: [{ actions: ['workspaces:create', 'workspaces:read', 'workspace_locations:read', 'workspace_locations:update', 'workspace_locations:provision'], scope: {} }],
    })).principal
    const defaults = new PostgresFoundationSettingsRepository(pool)
    expect((await defaults.getWorkspaceDefaults()).value.parentPath).toBe(join(homedir(), '.local', 'share', 'graphql', 'workspaces'))
    await defaults.updateWorkspaceDefaults({ suggestedName: 'Project', description: '', parentPath }, 0)
    const commands = new PostgresCommandCoordinator(pool)
    const locations = new WorkspaceLocationService(pool, commands)
    const service = new WorkspaceManagementService(pool, commands, locations, defaults)
    const input = { commandId: randomUUID(), name: 'My Project ü', parentPath: (await defaults.getWorkspaceDefaults()).value.parentPath! }
    const created = await service.create(principal, 'http', input)
    expect(created.value.executionLocation?.rootPath).toBe(join(parentPath, input.name))
    expect(created.value.locationValidation.status).toBe('ready')
    expect((await service.create(principal, 'http', input)).replayed).toBe(true)
    expect(await readdir(parentPath)).toEqual([input.name])
    await expect(service.create(principal, 'http', { ...input, commandId: randomUUID() })).rejects.toMatchObject({ code: 'WORKSPACE_FOLDER_EXISTS' })
    await expect(service.create(principal, 'http', { ...input, commandId: randomUUID(), name: '../escape' })).rejects.toMatchObject({ code: 'WORKSPACE_FOLDER_NAME_INVALID' })
    const mcp = await service.create(principal, 'mcp', { ...input, commandId: randomUUID(), name: 'MCP' })
    expect(mcp.value.executionLocation?.rootPath).toBe(join(parentPath, 'MCP'))
    const restricted = { ...principal, grants: [{ actions: ['workspaces:create' as const], scope: {} }] }
    await expect(service.create(restricted, 'http', { ...input, commandId: randomUUID(), name: 'Denied' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await defaults.updateWorkspaceDefaults({ suggestedName: 'Elsewhere', description: '', parentPath: tmpdir() }, 1)
    expect((await service.get(principal, created.value.workspace.id)).executionLocation?.rootPath).toBe(join(parentPath, input.name))
    expect((await pool.query('select count(*)::int as count from workspaces')).rows[0].count).toBe(2)
  } finally {
    await database.close()
    await removeFixtureDirectory(parentPath)
  }
}, 30_000)
