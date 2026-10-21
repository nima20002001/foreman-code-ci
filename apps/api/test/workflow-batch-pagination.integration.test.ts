import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import * as c from '@foreman-code/contracts/management'
import { expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

it('paginates and atomically archives through authenticated MCP with scope, revision and retry safety', async () => {
  const database = await migratedDatabase()
  const { pool } = database
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
    const owner = await access.issue({ name: 'Batch owner', audience: 'operator',
      grants: [{ actions: [...c.ManagementActionSchema.options], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'batch-test', version: '1.0.0' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const client = await connect(owner.token)
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('workflow_batch_archive')
    const workspaceId = (await workspaces.create(owner.principal, 'http', { commandId: randomUUID(), name: 'Batch' })).value.workspace.id
    await workspaces.create(owner.principal, 'http', { commandId: randomUUID(), name: 'Second' })
    const first = c.ManagedWorkspacePageSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'workspace_list', arguments: { detail: 'full', limit: 1 } }))))
    const next = c.ManagedWorkspacePageSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'workspace_list', arguments: { detail: 'full', limit: 1, cursor: first.pageInfo.nextCursor } }))))
    expect(first.items).toHaveLength(1); expect(next.items).toHaveLength(1)
    expect(first.items[0]!.workspace.id).not.toBe(next.items[0]!.workspace.id)
    expect(next.pageInfo.nextCursor).toBeNull()
    const querySpy = vi.spyOn(pool, 'query')
    await workspaces.list(owner.principal, { limit: 20, includeArchived: false })
    expect(querySpy).toHaveBeenCalledTimes(2) // page + one batched location read
    querySpy.mockRestore()
    const created = await Promise.all(['Alpha', 'Beta', 'Gamma'].map((name) => workflows.create(owner.principal, 'http', { workspaceId, name, commandId: randomUUID() })))
    const readPage = async (cursor?: string) => c.ManagedWorkflowPageSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'workflow_list', arguments: { detail: 'full', workspaceId, limit: 2, ...(cursor ? { cursor } : {}) } }))))
    const a = await readPage(), b = await readPage(a.pageInfo.nextCursor!)
    expect(a.items).toHaveLength(2); expect(b.items).toHaveLength(1); expect(b.pageInfo.nextCursor).toBeNull()
    expect(new Set([...a.items, ...b.items].map((item) => item.workflow.id)).size).toBe(3)
    const input = { workspaceId, commandId: randomUUID(), workflows: created.slice(0, 2).map(({ value }) => ({ workflowId: value.workflow.id, expectedRevision: value.revision })) }
    const reader = await access.issue({ name: 'Reader', audience: 'operator', grants: [{ actions: ['workflows:read'], scope: { workspaceIds: [workspaceId] } }], expiresAt: new Date(Date.now() + 60_000) })
    const denied = await connect(reader.token)
    expect((await denied.listTools()).tools.map((tool) => tool.name)).not.toContain('workflow_batch_archive')
    await expectMcpAccessDenied(denied.callTool({ name: 'workflow_batch_archive', arguments: input }))
    const scoped = await access.issue({ name: 'Scoped', audience: 'operator', grants: [{ actions: ['workflows:read', 'workflows:archive'], scope: { workspaceIds: [workspaceId], workflowIds: [input.workflows[0]!.workflowId] } }], expiresAt: new Date(Date.now() + 60_000) })
    const scopedClient = await connect(scoped.token)
    expect((await scopedClient.callTool({ name: 'workflow_batch_archive', arguments: input })).isError).toBe(true)
    const scopedPage = c.ManagedWorkflowPageSchema.parse(decodeMcpToolResult((await scopedClient.callTool({ name: 'workflow_list', arguments: { detail: 'full', workspaceId, limit: 1 } }))))
    expect(scopedPage.items.map((item) => item.workflow.id)).toEqual([input.workflows[0]!.workflowId])
    expect(scopedPage.pageInfo.nextCursor).toBeNull()
    expect((await client.callTool({ name: 'workflow_batch_archive', arguments: { ...input, commandId: randomUUID(), workflows: [input.workflows[0], { ...input.workflows[1], expectedRevision: 99 }] } })).isError).toBe(true)
    expect((await readPage()).items).toHaveLength(2)
    expect((await pool.query('select count(*) from workflows where archived_at is not null')).rows[0].count).toBe('0')
    const result = c.WorkflowBatchArchiveResultSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'workflow_batch_archive', arguments: input }))))
    expect(result.value.workflowIds.sort()).toEqual(input.workflows.map((item) => item.workflowId).sort())
    expect(result.replayed).toBe(false)
    const replay = c.WorkflowBatchArchiveResultSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'workflow_batch_archive', arguments: input }))))
    expect(replay.replayed).toBe(true)
    expect((await readPage()).items.map((item) => item.workflow.id)).toEqual([created[2]!.value.workflow.id])
    const archived = c.ManagedWorkflowSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'workflow_get', arguments: { workspaceId, workflowId: input.workflows[0]!.workflowId } }))))
    expect(archived.archivedAt).not.toBeNull(); expect(archived.revision).toBe(input.workflows[0]!.expectedRevision + 1)
    expect((await pool.query("select count(*) from management_audit where action = 'workflow.batch_archive' and outcome = 'succeeded'")).rows[0].count).toBe('1')
  } finally {
    for (const client of clients) await client.close()
    await app.close()
    await database.close()
  }
}, 30_000)
