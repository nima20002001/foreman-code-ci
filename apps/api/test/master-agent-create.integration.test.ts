import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { AgentDefaultsUpdateResultSchema, AgentMutationResultSchema, ManagedAgentDefaultsSchema,
  ManagedAgentDetailSchema } from '@foreman-code/contracts/management'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

it.skipIf(!postgresEnabled)('creates explicit Masters through HTTP and MCP from unchanged legacy defaults', async () => {
  const f = await currentOperatorIntegration({ agentManagement: true })
  try {
    const workspaceId = f.f.scope.workspaceId
    const headers = { authorization: `Bearer ${f.writer.token}` }
    const base = `/api/management/workspaces/${workspaceId}/agents`
    const call = async (name: string, input: Record<string, unknown>) => {
      const response = await f.client.callTool({ name, arguments: input })
      expect(response.isError, JSON.stringify(response)).not.toBe(true)
      return decodeMcpToolResult(response)
    }
    const original = ManagedAgentDefaultsSchema.parse(await call('agent_defaults_get', {}))
    const { master: _master, ...stored } = original.value
    void _master
    const legacy = AgentDefaultsUpdateResultSchema.parse(await call('agent_defaults_update', {
      commandId: randomUUID(), expectedRevision: original.revision,
      value: { ...stored, orchestrator: { ...stored.orchestrator,
        harness: { ...stored.orchestrator.harness, model: 'fixture-master-default' },
        nativeTools: { mcpServers: [], apps: false } } },
    })).value
    expect(legacy.value).not.toHaveProperty('master')

    for (const transport of ['http', 'mcp'] as const) {
      const input = { workspaceId, agentId: `master-${transport}`, commandId: randomUUID(),
        name: `Master ${transport}`, productRole: 'master' }
      let created: ReturnType<typeof AgentMutationResultSchema.parse>
      if (transport === 'http') {
        const response = await f.app.inject({ method: 'POST', url: base, headers, payload: input })
        expect(response.statusCode, response.body).toBe(201)
        created = AgentMutationResultSchema.parse(response.json())
      } else created = AgentMutationResultSchema.parse(await call('agent_create', input))
      expect(created.replayed).toBe(false)
      expect(created.value.agent).toMatchObject({ id: input.agentId, productRole: 'master',
        configurationVersionId: expect.any(String), harnessConfiguration: legacy.value.orchestrator.harness,
        nativeTools: legacy.value.orchestrator.nativeTools })
      let readback: ReturnType<typeof ManagedAgentDetailSchema.parse>
      if (transport === 'http') readback = ManagedAgentDetailSchema.parse(await call('agent_get', { workspaceId, agentId: input.agentId }))
      else {
        const response = await f.app.inject({ url: `${base}/${input.agentId}`, headers })
        expect(response.statusCode, response.body).toBe(200)
        readback = ManagedAgentDetailSchema.parse(response.json())
      }
      expect(readback.agent).toEqual(created.value.agent)
      expect(readback.metadataRevision).toBe(created.value.metadataRevision)
      expect(readback.workflowIds).toEqual([])
    }
    expect(ManagedAgentDefaultsSchema.parse(await call('agent_defaults_get', {}))).toEqual(legacy)

    const reader = await f.access.issue({ name: 'Master read only', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['agents:read'], scope: { workspaceIds: [workspaceId] } }] })
    const denied = await f.connect(reader.token)
    const readable = await denied.callTool({ name: 'agent_get', arguments: { workspaceId, agentId: 'master-mcp' } })
    expect(readable.isError, JSON.stringify(readable)).not.toBe(true)
    expect(ManagedAgentDetailSchema.parse(decodeMcpToolResult(readable)).agent).toMatchObject({
      id: 'master-mcp', productRole: 'master',
    })
    const rejected = { workspaceId, agentId: 'denied-master', commandId: randomUUID(), name: 'Denied Master', productRole: 'master' }
    await expectMcpAccessDenied(denied.callTool({ name: 'agent_create', arguments: rejected }))
    const response = await f.app.inject({ method: 'POST', url: base,
      headers: { authorization: `Bearer ${reader.token}` }, payload: rejected })
    expect(response.statusCode).toBe(403)
    const missing = await f.app.inject({ url: `${base}/${rejected.agentId}`, headers })
    expect(missing.statusCode).toBe(404)
  } finally { await f.close() }
}, 30_000)
