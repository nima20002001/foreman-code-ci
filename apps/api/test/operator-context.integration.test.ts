import { randomUUID } from 'node:crypto'
import {
  decodeMcpToolResult, OperatorCompactCapabilitiesSchema, OperatorToolSchemaResultSchema,
  WorkspaceSummaryPageSchema, WorkflowSummaryPageSchema,
} from '@foreman-code/contracts/operator-mcp'
import {
  AgentMutationResultSchema, ManagedAgentDetailSchema, ManagedWorkspacePageSchema, ManagedWorkspaceSchema,
} from '@foreman-code/contracts/management'
import { SavedManagedWorkflowPageSchema, SavedManagedWorkflowSchema } from '@foreman-code/contracts/wave25'
import { describe, expect, it, vi } from 'vitest'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { selectedMainMcpForward } from '../src/modules/placement/workerMcpRelay.js'

describe.skipIf(!postgresEnabled)('Operator context over authenticated MCP', () => {
  it('uses separate migrated databases for concurrent runtime fixtures', async () => {
    const first = await agent3Database()
    let second: Awaited<ReturnType<typeof agent3Database>> | undefined
    try {
      second = await agent3Database()
      const readDatabase = async (fixture: typeof first) =>
        (await fixture.pool.query<{ name: string }>('select current_database() as name')).rows[0]!.name
      expect(await readDatabase(first)).not.toBe(await readDatabase(second))
      const id = randomUUID()
      await first.pool.query('insert into workspaces(id, record) values($1, $2::jsonb)',
        [id, JSON.stringify({ id, name: 'Isolated fixture' })])
      expect((await second.pool.query('select id from workspaces where id=$1', [id])).rows).toEqual([])
    } finally {
      await second?.close()
      await first.close()
    }
  }, 60_000)

  it('forwards a complete large escaped Agent read through the bounded selected Main relay', async () => {
    const f = await currentOperatorIntegration({ agentManagement: true })
    try {
      const workspaceId = f.f.scope.workspaceId
      const created = AgentMutationResultSchema.parse(decodeMcpToolResult(await f.client.callTool({
        name: 'agent_create', arguments: {
          workspaceId, agentId: randomUUID(), commandId: randomUUID(), name: 'Large prompt',
          configuration: { harness: 'codex', model: 'fixture', reasoningEffort: 'low',
            sandbox: 'read-only', serviceTier: 'standard' },
          prompt: { system: '"'.repeat(255000) },
        },
      })))
      const args = { workspaceId, agentId: created.value.agent.id }
      const persisted = await f.services.agents.get(f.writer.principal, workspaceId, args.agentId)
      expect(persisted.agent.prompt?.system).toBe('"'.repeat(255000))
      const doubleEscaped = { content: [{ type: 'text', text: JSON.stringify(persisted) }] }
      expect(Buffer.byteLength(JSON.stringify(doubleEscaped), 'utf8')).toBeGreaterThan(1_000_000)

      const reader = await f.access.issue({ name: 'Relay reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000),
        grants: [{ actions: ['agents:read'], scope: { workspaceIds: [workspaceId] } }] })
      const outsider = await f.access.issue({ name: 'Relay outsider', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000),
        grants: [{ actions: ['agents:read'], scope: { workspaceIds: ['other-workspace'] } }] })
      const forward = selectedMainMcpForward(f.app)
      async function read(token: string) {
        const response = await forward.request({ jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'agent_get', arguments: args } }, token, '2025-11-25')
        expect(response.statusCode).toBe(200)
        expect(Buffer.byteLength(response.body, 'utf8')).toBeLessThan(1_000_000)
        const data = response.contentType === 'text/event-stream'
          ? response.body.split('\n').find((line) => line.startsWith('data:'))!.slice(5) : response.body
        return JSON.parse(data).result as Parameters<typeof decodeMcpToolResult>[0] & { isError?: boolean }
      }
      const result = await read(reader.token)
      expect(result.isError).not.toBe(true)
      expect(result.content).toEqual([])
      expect(ManagedAgentDetailSchema.parse(decodeMcpToolResult(result))).toEqual(persisted)
      const denied = await read(outsider.token)
      expect(denied.isError).toBe(true)
      expect(decodeMcpToolResult(denied)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      expect(await f.services.agents.get(f.writer.principal, workspaceId, args.agentId)).toEqual(persisted)
      const audit = await f.db.pool.query('select sequence from management_audit where principal_id=$1',
        [outsider.principal.id])
      expect(audit.rowCount).toBeGreaterThan(0)
    } finally { await f.close() }
  }, 60000)

  it('looks up available schemas without prior discovery, rejects denied targets and audits denied callers', async () => {
    const f = await currentOperatorIntegration()
    try {
      const update = vi.spyOn(f.services.workspaces, 'update')
      const lookup = async (name: string, includeOutputSchema = false) => {
        const result = await f.client.callTool({ name: 'operator_tool_schema_get', arguments: { name, includeOutputSchema } })
        expect(result.isError).not.toBe(true)
        expect(result.structuredContent).toBeUndefined()
        return OperatorToolSchemaResultSchema.parse(decodeMcpToolResult(result))
      }
      const input = await lookup('workspace_update')
      expect(input).not.toHaveProperty('outputSchema')
      expect(input.inputSchema.required).toEqual(['workspaceId', 'expectedRevision'])
      expect(input.permissionRequirements.actions).toContain('workspaces:update')
      expect((await lookup('workspace_update', true)).outputSchema).toBeDefined()
      expect(update).not.toHaveBeenCalled()
      update.mockRestore()
      expect((await f.client.listTools()).tools.every((tool) => tool.outputSchema === undefined)).toBe(true)

      for (const name of ['device_main_identity_get', 'unknown_tool']) {
        const unavailable = await f.client.callTool({ name: 'operator_tool_schema_get', arguments: { name } })
        expect(unavailable.isError).toBe(true)
        expect(decodeMcpToolResult(unavailable)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
        expect(decodeMcpToolResult(unavailable)).not.toHaveProperty('inputSchema')
        expect(decodeMcpToolResult(unavailable)).not.toHaveProperty('outputSchema')
      }

      const issued = await f.access.issue({ name: 'Schema reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['capabilities:read'], scope: {} }] })
      const reader = await f.connect(issued.token)
      const denied = await reader.callTool({ name: 'operator_tool_schema_get', arguments: { name: 'workspace_update' } })
      expect(denied.isError).toBe(true)
      expect(decodeMcpToolResult(denied)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      expect(denied).not.toHaveProperty('structuredContent')
      expect(decodeMcpToolResult(denied)).not.toHaveProperty('inputSchema')
      expect(decodeMcpToolResult(denied)).not.toHaveProperty('outputSchema')
      const noGrant = await f.access.issue({ name: 'No capability grant', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['workspaces:read'], scope: {} }] })
      const restricted = await f.connect(noGrant.token)
      expect((await restricted.callTool({ name: 'operator_tool_schema_get', arguments: { name: 'workspace_get' } })).isError)
        .toBe(true)
      for (const principalId of [issued.principal.id, noGrant.principal.id]) {
        const audit = await f.db.pool.query('select sequence from management_audit where principal_id=$1', [principalId])
        expect(audit.rowCount).toBeGreaterThan(0)
      }
      const compact = OperatorCompactCapabilitiesSchema.parse(decodeMcpToolResult(
        await reader.callTool({ name: 'operator_get_capabilities', arguments: {} }),
      ))
      expect(compact.tools).toContain('operator_tool_schema_get')
      expect(compact.tools).not.toContain('workspace_update')
      expect(compact.grants).toEqual(issued.principal.grants)
      expect(compact.runtimeLimits).toEqual(expect.arrayContaining([
        expect.objectContaining({ feature: 'native_mcp_provisioning', detail: expect.stringContaining('harnesses:update') }),
        expect.objectContaining({ feature: 'codex_plugins', detail: expect.stringContaining('codex_plugin_change') }),
        expect.objectContaining({ feature: 'remote_runners_and_host_browsing', detail: expect.stringContaining('home') }),
        expect.objectContaining({ feature: 'trusted_device_connections', detail: expect.stringContaining('settings:update') }),
      ]))
    } finally { await f.close() }
  }, 60000)

  it('pages compact persisted workspaces and workflows and returns complete explicit full records', async () => {
    const f = await currentOperatorIntegration()
    try {
      const ids: string[] = []
      for (let index = 0; index < 11; index++) {
        const created = decodeMcpToolResult(await f.client.callTool({ name: 'workspace_create', arguments: {
          commandId: randomUUID(), name: `Context workspace ${index}`, description: 'Persisted workspace description',
        } }))
        ids.push(ManagedWorkspaceSchema.parse(created.value).workspace.id)
      }
      const first = WorkspaceSummaryPageSchema.parse(decodeMcpToolResult(
        await f.client.callTool({ name: 'workspace_list', arguments: {} }),
      ))
      expect(first.items).toHaveLength(10)
      expect(first.pageInfo.nextCursor).not.toBeNull()
      expect(first.items.every((item) => item.detailsOmitted && item.revision === 1)).toBe(true)
      const second = WorkspaceSummaryPageSchema.parse(decodeMcpToolResult(await f.client.callTool({
        name: 'workspace_list', arguments: { cursor: first.pageInfo.nextCursor, limit: 100 },
      })))
      const listed = [...first.items, ...second.items].map((item) => item.workspace.id)
      expect(new Set(listed).size).toBe(listed.length)
      expect(listed).toEqual(expect.arrayContaining(ids))
      const full = ManagedWorkspacePageSchema.parse(decodeMcpToolResult(await f.client.callTool({
        name: 'workspace_list', arguments: { limit: 100, detail: 'full' },
      })))
      expect(full.items.find((item) => item.workspace.id === ids[0])?.workspace.description)
        .toBe('Persisted workspace description')
      const persisted = await f.services.workspaces.get(f.writer.principal, ids[0]!)
      expect(full.items.find((item) => item.workspace.id === ids[0])).toEqual(persisted)
      const readback = ManagedWorkspaceSchema.parse(decodeMcpToolResult(await f.client.callTool({
        name: 'workspace_get', arguments: { workspaceId: ids[0] },
      })))
      expect(readback).toEqual(persisted)

      const workflow = decodeMcpToolResult(await f.client.callTool({ name: 'workflow_create', arguments: {
        workspaceId: ids[0], commandId: randomUUID(), name: 'Context workflow', description: 'Persisted workflow description',
      } }))
      const saved = SavedManagedWorkflowSchema.parse(workflow.value)
      const savedWorkflows = [saved]
      for (let index = 1; index < 11; index++) {
        const created = decodeMcpToolResult(await f.client.callTool({ name: 'workflow_create', arguments: {
          workspaceId: ids[0], commandId: randomUUID(), name: `Context workflow ${index}`,
          description: 'Persisted workflow description',
        } }))
        savedWorkflows.push(SavedManagedWorkflowSchema.parse(created.value))
      }
      const summary = WorkflowSummaryPageSchema.parse(decodeMcpToolResult(await f.client.callTool({
        name: 'workflow_list', arguments: { workspaceId: ids[0] },
      })))
      expect(summary.items).toHaveLength(10)
      expect(summary.pageInfo.nextCursor).not.toBeNull()
      const next = WorkflowSummaryPageSchema.parse(decodeMcpToolResult(await f.client.callTool({
        name: 'workflow_list', arguments: { workspaceId: ids[0], cursor: summary.pageInfo.nextCursor },
      })))
      expect(next.items).toHaveLength(1)
      expect(next.pageInfo.nextCursor).toBeNull()
      const summaries = [...summary.items, ...next.items]
      expect(summaries.map((item) => item.workflow.id).sort())
        .toEqual(savedWorkflows.map((item) => item.workflow.id).sort())
      expect(summaries).toEqual(expect.arrayContaining(savedWorkflows.map((item) => ({
        workflow: { id: item.workflow.id, workspaceId: ids[0], name: item.workflow.name },
        revision: item.revision, currentVersionId: item.currentVersionId,
        archivedAt: item.archivedAt, detailsOmitted: true,
      }))))
      const workflows = SavedManagedWorkflowPageSchema.parse(decodeMcpToolResult(await f.client.callTool({
        name: 'workflow_list', arguments: { workspaceId: ids[0], detail: 'full', limit: 100 },
      })))
      expect(workflows.items).toHaveLength(savedWorkflows.length)
      expect(workflows.items).toEqual(expect.arrayContaining(savedWorkflows))
      const workflowReadback = SavedManagedWorkflowSchema.parse(decodeMcpToolResult(await f.client.callTool({
        name: 'workflow_get', arguments: { workspaceId: ids[0], workflowId: saved.workflow.id },
      })))
      expect(workflowReadback).toEqual(saved)
      for (const limit of [0, 1.5, 101]) {
        expect((await f.client.callTool({ name: 'workspace_list', arguments: { limit } })).isError).toBe(true)
        expect((await f.client.callTool({ name: 'workflow_list', arguments: { workspaceId: ids[0], limit } })).isError)
          .toBe(true)
      }
    } finally { await f.close() }
  }, 60000)
})
