import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { WorkflowKanbanLayoutReadSchema } from '@foreman-code/contracts'
import * as c from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

it('shows, moves and hides a workflow Kanban through authenticated MCP and HTTP, denying a read-only caller', async () => {
  const database = await migratedDatabase()
  const { pool } = database
  const access = new PostgresAccessService(pool), commands = new PostgresCommandCoordinator(pool)
  const workspaces = new WorkspaceManagementService(pool, commands, new WorkspaceLocationService(pool, commands))
  const workflows = new WorkflowManagementService(pool, commands)
  const services = { commands, workspaces, workflows } as unknown as OperatorServices
  const app = buildApp({ logger: false, readiness: {
    database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined },
  }, operator: { access, services } })
  const clients: Client[] = []
  try {
    const expiresAt = new Date(Date.now() + 120_000)
    const owner = await access.issue({ name: 'Kanban owner', audience: 'operator', expiresAt,
      grants: [{ actions: [...c.ManagementActionSchema.options], scope: {} }] })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'kanban-layout-test', version: '1.0.0' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const workspaceId = (await workspaces.create(owner.principal, 'http', { commandId: randomUUID(), name: 'Kanban' })).value.workspace.id
    const created = await workflows.create(owner.principal, 'http', { workspaceId, name: 'Release', commandId: randomUUID() })
    const workflowId = created.value.workflow.id
    const scope = { workspaceId, workflowId }
    const read = async (client: Client) => WorkflowKanbanLayoutReadSchema.parse(decodeMcpToolResult(
      await client.callTool({ name: 'workflow_kanban_layout_get', arguments: scope })))

    const ownerClient = await connect(owner.token)
    const names = (await ownerClient.listTools()).tools.map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining(['workflow_kanban_layout_get', 'workflow_kanban_layout_set']))
    expect(await read(ownerClient)).toEqual({ ...scope, layout: { visible: false, frame: null } })

    const shown = { visible: true, frame: { x: 640, y: -40, width: 720, height: 440 } }
    const saved = WorkflowKanbanLayoutReadSchema.parse(decodeMcpToolResult(await ownerClient.callTool({
      name: 'workflow_kanban_layout_set', arguments: { ...scope, layout: shown } })))
    expect(saved).toEqual({ ...scope, layout: shown })

    const reader = await access.issue({ name: 'Kanban reader', audience: 'operator', expiresAt,
      grants: [{ actions: ['workflows:read'], scope: { workspaceIds: [workspaceId] } }] })
    const readerClient = await connect(reader.token)
    const readerNames = (await readerClient.listTools()).tools.map((tool) => tool.name)
    expect(readerNames).toContain('workflow_kanban_layout_get')
    expect(readerNames).not.toContain('workflow_kanban_layout_set')
    await expectMcpAccessDenied(readerClient.callTool({ name: 'workflow_kanban_layout_set',
      arguments: { ...scope, layout: { visible: false, frame: shown.frame } } }))
    expect(await read(readerClient)).toEqual({ ...scope, layout: shown })

    // Removing from the Board hides it over HTTP too, keeping its place; the workflow itself is unchanged.
    const path = `/api/management/workspaces/${workspaceId}/workflows/${workflowId}/kanban-layout`
    const deniedHttp = await app.inject({ method: 'PUT', url: path, headers: { authorization: `Bearer ${reader.token}` },
      payload: { layout: { visible: false, frame: null } } })
    expect(deniedHttp.statusCode).toBe(403)
    const hidden = await app.inject({ method: 'PUT', url: path, headers: { authorization: `Bearer ${owner.token}` },
      payload: { layout: { ...shown, visible: false } } })
    expect(hidden.statusCode).toBe(200)
    const httpRead = await app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${reader.token}` } })
    expect(httpRead.json()).toEqual({ ...scope, layout: { ...shown, visible: false } })
    expect(await read(ownerClient)).toEqual({ ...scope, layout: { ...shown, visible: false } })
    const workflow = c.ManagedWorkflowSchema.parse(decodeMcpToolResult(await ownerClient.callTool({ name: 'workflow_get', arguments: scope })))
    expect(workflow.revision).toBe(created.value.revision)
    expect((await pool.query(`select count(*) from management_audit where action = 'workflow.kanban_layout.set'
      and outcome = 'succeeded'`)).rows[0].count).toBe('2')

    const invalid = await ownerClient.callTool({ name: 'workflow_kanban_layout_set',
      arguments: { ...scope, layout: { visible: true, frame: { x: 0, y: 0, width: 10, height: 10 } } } })
    expect(invalid.isError).toBe(true)
    const unknown = await ownerClient.callTool({ name: 'workflow_kanban_layout_get', arguments: { workspaceId, workflowId: 'missing-workflow' } })
    expect(unknown).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('WORKFLOW_NOT_FOUND') }] })
  } finally {
    for (const client of clients) await client.close()
    await app.close()
    await database.close()
  }
}, 30_000)
