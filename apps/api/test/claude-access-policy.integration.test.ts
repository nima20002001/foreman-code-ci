import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { CLAUDE_FULL_ACCESS_REQUIRED } from '@foreman-code/contracts/claude'
import { AgentMutationResultSchema, ManagedAgentDetailSchema, HarnessCatalogResultSchema, HarnessCatalogEntrySchema } from '@foreman-code/contracts/management'
import { CurrentWorkflowSaveResultSchema } from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { OperatorAgentMutationService } from '../src/modules/workspaces/operatorAgents.js'

const fullAccess = { harness: 'claude' as const, model: 'recorded-model', authMode: 'subscription' as const,
  configDirectory: '/recorded/profile', permissionMode: 'default' as const, sandbox: 'danger-full-access' as const,
  tools: ['Write'], permissionRules: [], instructions: '', mcpServers: {} }

it('rejects non-full Claude saves and Start through authenticated MCP, preserving Full access readback and denied callers', async () => {
  const f = await currentOperatorIntegration()
  const call = async (name: string, arguments_: Record<string, unknown>) => {
    const result = await f.client.callTool({ name, arguments: arguments_ })
    expect(result.isError).not.toBe(true)
    return decodeMcpToolResult(result)
  }
  try {
    Object.assign(f.services, { extensions: {
      agents: new OperatorAgentMutationService(f.db.pool, f.commands, f.services.harnesses),
    } })
    const workspaceId = f.f.scope.workspaceId
    const reader = await f.access.issue({ name: 'Claude access reader', audience: 'operator',
      grants: [{ actions: ['agents:read', 'harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
    const denied = await f.connect(reader.token)
    const agentId = randomUUID()
    const create = { workspaceId, commandId: randomUUID(), agentId, name: 'Full access Claude',
      configuration: fullAccess, prompt: {} }
    const forbidden = await denied.callTool({ name: 'agent_create', arguments: create })
    expect(forbidden.isError).toBe(true)
    expect(JSON.stringify(forbidden.content)).toContain('ACCESS_DENIED')
    for (const sandbox of ['read-only', 'workspace-write']) {
      const rejected = await f.client.callTool({ name: 'agent_create', arguments: {
        ...create, commandId: randomUUID(), configuration: { ...fullAccess, sandbox },
      } })
      expect(rejected.isError).toBe(true)
      expect(JSON.stringify(rejected.content)).toContain(CLAUDE_FULL_ACCESS_REQUIRED)
    }
    expect((await f.db.pool.query('select id from agents where id=$1', [agentId])).rows).toEqual([])
    const created = AgentMutationResultSchema.parse(await call('agent_create', create))
    const configurationId = created.value.agent.configurationVersionId
    if (!configurationId) throw new Error('Saved agent has no configuration version')
    const readback = ManagedAgentDetailSchema.parse(await call('agent_get', { workspaceId, agentId }))
    expect(readback.agent.harnessConfiguration).toEqual(fullAccess)

    const harnesses = HarnessCatalogResultSchema.parse(await call('harness_list', {}))
    const defaults = Object.fromEntries(harnesses.items.map(item => [item.harness, item.defaults]))
    const defaultsRevision = harnesses.items[0]!.defaultsRevision
    for (const sandbox of ['read-only', 'workspace-write']) {
      const rejected = await f.client.callTool({ name: 'harness_defaults_update', arguments: {
        commandId: randomUUID(), expectedRevision: defaultsRevision,
        defaults: { ...defaults, claude: { ...fullAccess, sandbox } },
      } })
      expect(rejected.isError).toBe(true)
      expect(JSON.stringify(rejected.content)).toContain(CLAUDE_FULL_ACCESS_REQUIRED)
    }
    await call('harness_defaults_update', { commandId: randomUUID(), expectedRevision: defaultsRevision,
      defaults: { ...defaults, claude: fullAccess } })
    expect(HarnessCatalogEntrySchema.parse(await call('harness_get', { harness: 'claude' })).defaults).toEqual(fullAccess)

    const input = await f.create()
    input.graph.nodes = [{ ...input.graph.nodes[0]!, agentId }]
    input.graph.edges = []
    input.expectedAgentConfigurationVersionIds = { [agentId]: configurationId }
    const saved = CurrentWorkflowSaveResultSchema.parse(await call('workflow_save_v3', input))
    // Represent an existing unsupported configuration without enabling it through a save command.
    await f.db.pool.query("update agent_configuration_versions set record=jsonb_set(record,'{harness,sandbox}','\"read-only\"') where id=$1", [configurationId])
    const start = await f.client.callTool({ name: 'run_start', arguments: {
      workspaceId, workflowId: input.workflowId, commandId: randomUUID(), executionSemanticsVersion: 3,
      workflowVersionId: saved.value.version.id, expectedWorkflowRevision: saved.value.revision,
      expectedLocationRevision: 1, expectedAgentConfigurationVersionIds: { [agentId]: configurationId }, input: {},
    } })
    expect(start.isError).toBe(true)
    expect(JSON.stringify(start.content)).toContain(CLAUDE_FULL_ACCESS_REQUIRED)
    expect((await f.db.pool.query('select id from runs where workflow_id=$1', [input.workflowId])).rows).toEqual([])
  } finally { await f.close() }
}, 60_000)
