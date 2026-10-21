import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it, vi } from 'vitest'
import { ScopedMcpDetectionSchema } from '@foreman-code/contracts'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { McpDetectionService, type NativeMcpInspector } from '../src/modules/harnesses/mcpDetection.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { OperatorWorkspaceControls } from '../src/modules/workspaces/operatorControls.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'

it('validates the persisted workspace identity before HTTP and authenticated MCP inspection', async () => {
  const database = await currentDatabase()
  const directory = await mkdtemp(join(tmpdir(), 'workspace-mcp-detection-'))
  const rootPath = join(directory, 'project')
  await mkdir(rootPath)
  const access = new PostgresAccessService(database.pool)
  const commands = new PostgresCommandCoordinator(database.pool)
  const locations = new WorkspaceLocationService(database.pool, commands)
  const workspaces = new WorkspaceManagementService(database.pool, commands, locations)
  const inspect = vi.fn<NativeMcpInspector['inspect']>(async input => ({
    harness: input.harness, runnerId: input.runnerId, workingDirectory: input.workingDirectory,
    providerVersion: 'recorded-provider', inspectedAt: new Date().toISOString(),
  }))
  const detection = new McpDetectionService({ inspect }, 'http://127.0.0.1:3000/mcp')
  const controls = new OperatorWorkspaceControls(database.pool, commands, locations, detection)
  const services = { commands, locations, workspaces, extensions: { workspace: controls } } as unknown as OperatorServices
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services }, mcpDetection: { pool: database.pool, service: detection },
  })
  const clients: Client[] = []
  try {
    const owner = await access.issue({ name: 'Location owner', audience: 'operator',
      grants: [{ actions: [...ManagementActionSchema.options], scope: {} }],
      expiresAt: new Date(Date.now() + 120_000) })
    const workspace = (await workspaces.create(owner.principal, 'mcp', {
      commandId: randomUUID(), name: 'Inspection project', description: '',
    })).value.workspace
    await locations.set(owner.principal, 'mcp', { workspaceId: workspace.id, commandId: randomUUID(),
      expectedLocationRevision: 0, runnerId: locations.runnerId, rootPath })
    const reader = await access.issue({ name: 'Scoped inspector', audience: 'operator',
      grants: [{ actions: ['harnesses:read', 'workspace_locations:read'], scope: { workspaceIds: [workspace.id] } }],
      expiresAt: new Date(Date.now() + 120_000) })
    const denied = await access.issue({ name: 'Inspector without location grant', audience: 'operator',
      grants: [{ actions: ['harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'workspace-diagnostics', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    const client = await connect(reader.token)
    const deniedClient = await connect(denied.token)
    const args = { workspaceId: workspace.id, harness: 'codex' }
    const url = `/api/management/workspaces/${workspace.id}/harnesses/codex/mcp-detection`
    const http = (token = reader.token) => app.inject({ url, headers: { authorization: `Bearer ${token}` } })
    const mcp = () => client.callTool({ name: 'harness_mcp_detection_get', arguments: args })
    expect((await http()).statusCode).toBe(200)
    const initial = await mcp()
    expect(initial.isError).not.toBe(true)
    expect(ScopedMcpDetectionSchema.parse(decodeMcpToolResult(initial)).workingDirectory).toBe(rootPath)
    expect(inspect.mock.calls.length).toBeGreaterThan(0)
    const calls = inspect.mock.calls.length
    expect((await http(denied.token)).statusCode).toBe(403)
    const refused = await deniedClient.callTool({ name: 'harness_mcp_detection_get', arguments: args })
    expect(refused.isError).toBe(true)
    expect(decodeMcpToolResult(refused)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    expect(inspect).toHaveBeenCalledTimes(calls)
    const saved = (await database.pool.query(
      'select execution_location,execution_location_identity,location_revision from workspaces where id=$1', [workspace.id],
    )).rows[0]

    await rename(rootPath, join(directory, 'saved-directory'))
    await mkdir(rootPath)
    const replaced = await http()
    expect(replaced.statusCode).toBe(409)
    expect(replaced.json()).toMatchObject({ error: { code: 'WORKSPACE_LOCATION_CHANGED' } })
    const replacedMcp = await mcp()
    expect(replacedMcp.isError).toBe(true)
    expect(decodeMcpToolResult(replacedMcp)).toMatchObject({ error: { code: 'WORKSPACE_LOCATION_CHANGED' } })
    expect(inspect).toHaveBeenCalledTimes(calls)
    expect((await database.pool.query(
      'select execution_location,execution_location_identity,location_revision from workspaces where id=$1', [workspace.id],
    )).rows[0]).toEqual(saved)

    await database.pool.query('update workspaces set execution_location_identity=null where id=$1', [workspace.id])
    const unbound = await http()
    expect(unbound.statusCode).toBe(409)
    expect(unbound.json()).toMatchObject({ error: { code: 'WORKSPACE_LOCATION_UNCONFIGURED' } })
    const unboundMcp = await mcp()
    expect(unboundMcp.isError).toBe(true)
    expect(decodeMcpToolResult(unboundMcp)).toMatchObject({ error: { code: 'WORKSPACE_LOCATION_UNCONFIGURED' } })
    expect(inspect).toHaveBeenCalledTimes(calls)

    await locations.set(owner.principal, 'mcp', { workspaceId: workspace.id, commandId: randomUUID(),
      expectedLocationRevision: 1, runnerId: locations.runnerId, rootPath })
    expect((await http()).statusCode).toBe(200)
    expect((await mcp()).isError).not.toBe(true)
    const rebound = await workspaces.get(owner.principal, workspace.id)
    expect(rebound).toMatchObject({ locationRevision: 2, executionLocation: { rootPath } })
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await app.close()
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
