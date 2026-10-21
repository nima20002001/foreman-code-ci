import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { ManagementActionSchema, ManagedWorkspaceCommandResultSchema }
  from '@foreman-code/contracts/management'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'

describe.skipIf(!postgresEnabled)('workspace folder cleanup across computers', () => {
  it.each(['another-computer', 'runner-local'])('respects physical references on %s through authenticated MCP', async runnerId => {
    const db = await currentDatabase()
    const clients: Client[] = []
    let app: ReturnType<typeof buildApp> | undefined
    try {
      const parent = join(db.directory, 'workspaces')
      const runtime = join(db.directory, 'runtime')
      await mkdir(parent, { mode: 0o700 })
      await mkdir(runtime, { mode: 0o700 })
      const commands = new PostgresCommandCoordinator(db.pool)
      const access = new PostgresAccessService(db.pool)
      const locations = new WorkspaceLocationService(db.pool, commands, runtime, 'runner-local')
      const defaults = new PostgresFoundationSettingsRepository(db.pool, parent)
      const workspaces = new WorkspaceManagementService(db.pool, commands, locations, defaults, parent)
      const services = { commands, locations, workspaces } as unknown as OperatorServices
      app = buildApp({ logger: false,
        readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access, services },
      })
      const expiresAt = new Date(Date.now() + 600_000)
      const owner = await access.issue({ name: 'Folder owner', audience: 'operator', expiresAt,
        grants: [{ actions: ManagementActionSchema.options, scope: {} }] })
      const reader = await access.issue({ name: 'Folder reader', audience: 'operator', expiresAt,
        grants: [{ actions: ['workspaces:read', 'workspace_locations:read'], scope: {} }] })
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => {
        const client = new Client({ name: 'Folder cleanup regression', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
          authProvider: { token: async () => token },
        }))
        return client
      }
      const client = await connect(owner.token)
      const denied = await connect(reader.token)
      const created = await client.callTool({ name: 'workspace_create', arguments: {
        name: 'Owned project', parentPath: parent, commandId: randomUUID(),
      } })
      expect(created.isError).not.toBe(true)
      const workspace = ManagedWorkspaceCommandResultSchema.parse(decodeMcpToolResult(created)).value
      const projectPath = workspace.executionLocation!.rootPath
      const otherId = randomUUID()
      const otherLocation = { runnerId, rootPath: projectPath }
      await db.pool.query(`insert into workspaces(id,record,execution_location,location_revision)
        values($1,$2::jsonb,$3::jsonb,1)`, [otherId, JSON.stringify({ id: otherId, name: 'Other computer project' }),
        JSON.stringify(otherLocation)])
      const input = { workspaceId: workspace.workspace.id, expectedRevision: workspace.revision, commandId: randomUUID() }
      expect((await denied.callTool({ name: 'workspace_archive', arguments: input })).isError).toBe(true)
      expect((await lstat(projectPath)).isDirectory()).toBe(true)
      const archived = await client.callTool({ name: 'workspace_archive', arguments: input })
      if (runnerId === 'runner-local') {
        expect(archived.isError).toBe(true)
        expect(archived.content).toEqual([{ type: 'text', text: expect.stringContaining('WORKSPACE_FOLDER_CLEANUP_FAILED') }])
        expect((await lstat(projectPath)).isDirectory()).toBe(true)
      } else {
        expect(archived.isError).not.toBe(true)
        await expect(lstat(projectPath)).rejects.toMatchObject({ code: 'ENOENT' })
        const replay = await client.callTool({ name: 'workspace_archive', arguments: input })
        expect(replay.isError).not.toBe(true)
        expect(ManagedWorkspaceCommandResultSchema.parse(decodeMcpToolResult(replay)).replayed).toBe(true)
      }
      const readback = await client.callTool({ name: 'workspace_get', arguments: { workspaceId: otherId } })
      expect(readback.isError).not.toBe(true)
      expect(decodeMcpToolResult(readback)).toMatchObject({ executionLocation: otherLocation, archivedAt: null })
      const retained = await db.pool.query<{ created_project_folder: unknown }>(
        'select created_project_folder from workspaces where id=$1', [workspace.workspace.id],
      )
      expect(retained.rows[0]!.created_project_folder === null).toBe(runnerId !== 'runner-local')
    } finally {
      await Promise.allSettled(clients.map(client => client.close()))
      await app?.close()
      await db.close()
    }
  }, 120_000)
})
