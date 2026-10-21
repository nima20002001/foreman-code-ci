import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { AgentMutationResultSchema } from '@foreman-code/contracts/management'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'

it.skipIf(!postgresEnabled)('persists the initiating Agent transport on success, failure and cross-transport replay', async () => {
  const f = await currentOperatorIntegration({ agentManagement: true })
  try {
    const workspaceId = f.f.scope.workspaceId
    const http = (path: string, method: 'POST' | 'PATCH', input: Record<string, unknown>) => f.app.inject({ method,
      url: `/api/management/workspaces/${workspaceId}/agents${path}`,
      headers: { authorization: `Bearer ${f.writer.token}` }, payload: input })
    const mcp = async (name: string, input: Record<string, unknown>) => {
      const response = await f.client.callTool({ name, arguments: input })
      expect(response.isError, JSON.stringify(response)).not.toBe(true)
      return AgentMutationResultSchema.parse(decodeMcpToolResult(response))
    }
    for (const source of ['http', 'mcp'] as const) {
      const create = { workspaceId, agentId: `audit-${source}`, commandId: randomUUID(), name: 'Audit Agent',
        productRole: 'coder', configuration: { harness: 'codex', model: 'fixture', reasoningEffort: 'low',
          sandbox: 'read-only', serviceTier: 'standard' } }
      const created = source === 'mcp' ? await mcp('agent_create', create)
        : AgentMutationResultSchema.parse((await http('', 'POST', create)).json())
      const update = { workspaceId, agentId: create.agentId, commandId: randomUUID(),
        expectedRevision: created.value.metadataRevision,
        expectedConfigurationVersionId: created.value.agent.configurationVersionId, name: 'Renamed Agent' }
      const saved = source === 'mcp' ? await mcp('agent_update', update)
        : AgentMutationResultSchema.parse((await http(`/${create.agentId}`, 'PATCH', update)).json())
      expect(saved.value.agent.name).toBe('Renamed Agent')
      const replay = source === 'http' ? await mcp('agent_update', update)
        : AgentMutationResultSchema.parse((await http(`/${create.agentId}`, 'PATCH', update)).json())
      expect(replay).toEqual({ ...saved, replayed: true })
      const failed = { ...update, commandId: randomUUID() }
      if (source === 'http') expect((await http(`/${create.agentId}`, 'PATCH', failed)).statusCode).toBe(409)
      else expect((await f.client.callTool({ name: 'agent_update', arguments: failed })).isError).toBe(true)
      const rows = (await f.db.pool.query(
        `select principal_id,source,action,target_key,outcome,details->>'commandId' as command_id
         from management_audit where details->>'commandId'=any($1) order by sequence`,
        [[create.commandId, update.commandId, failed.commandId]])).rows
      expect(rows).toEqual([
        { principal_id: f.writer.principal.id, source, action: 'agent.create', target_key: `workspace:${workspaceId}:agent:${create.agentId}`,
          outcome: 'succeeded', command_id: create.commandId },
        { principal_id: f.writer.principal.id, source, action: 'agent.update', target_key: `workspace:${workspaceId}:agent:${create.agentId}`,
          outcome: 'succeeded', command_id: update.commandId },
        { principal_id: f.writer.principal.id, source, action: 'agent.update', target_key: `workspace:${workspaceId}:agent:${create.agentId}`,
          outcome: 'failed', command_id: failed.commandId },
      ])
    }
  } finally { await f.close() }
}, 30_000)
