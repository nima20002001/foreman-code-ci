import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import * as contracts from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { workspaceMcpFixture, callWorkspaceTool } from './helpers/workspaceMcp.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { FoundationSettingsManagementService } from '../src/modules/settings/management.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { AgentManagementService } from '../src/modules/workspaces/agents.js'
import { OperatorAgentMutationService } from '../src/modules/workspaces/operatorAgents.js'
import type { HarnessCatalogService } from '../src/modules/harnesses/catalog.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

let fixture: Awaited<ReturnType<typeof workspaceMcpFixture>>
beforeAll(async () => {
  fixture = await workspaceMcpFixture({ configure: async ({ pool, commands, services, parentPath }) => {
    const harnesses: Pick<HarnessCatalogService, 'qualifyConfiguration'> = {
      qualifyConfiguration: async configuration => ({
        harness: configuration.harness, version: 'test-port', authenticated: true, ready: true,
        structuredEvents: true, supportsResume: true, supportsCancellation: true, supportsWorkingDirectory: true,
        supportsStartupPrompt: true, supportedNativeTools: [], supportedSettings: [], unsupportedCapabilities: [],
      }),
    }
    services.settings = new FoundationSettingsManagementService(
      new PostgresFoundationSettingsRepository(pool, parentPath), commands, harnesses,
      new PostgresOperatorRepository(pool),
    )
    services.agents = new AgentManagementService(pool)
    services.extensions = {
      agents: new OperatorAgentMutationService(pool, commands, harnesses),
    } as NonNullable<OperatorServices['extensions']>
  } })
}, 60_000)
afterAll(async () => { await fixture?.close() })

it('supports role native-tool policies through authenticated MCP with denied writes and persisted readback', async () => {
  const owner = fixture.owner.client
  const capability = decodeMcpToolResult(await owner.callTool({ name: 'operator_get_capabilities',
    arguments: { detail: 'full' } })) as { tools: string[]; runtimeLimits: Array<{ feature: string }> }
  expect(capability.tools).toEqual(expect.arrayContaining(['agent_defaults_update', 'agent_create', 'agent_update']))
  expect(capability.runtimeLimits).toEqual(expect.arrayContaining([
    expect.objectContaining({ feature: 'native_tool_loading' }),
  ]))
  for (const name of ['agent_defaults_update', 'agent_update']) {
    const schema = decodeMcpToolResult(await owner.callTool({ name: 'operator_tool_schema_get',
      arguments: { name } })) as { inputSchema: unknown; description: string }
    expect(JSON.stringify(schema.inputSchema)).toContain('nativeTools')
    expect(schema.description).toContain('nativeTools')
  }
  const defaults = await callWorkspaceTool(owner, 'agent_defaults_get', contracts.ManagedAgentDefaultsSchema)
  const policies = {
    orchestrator: { mcpServers: ['linear'], apps: false },
    coder: { mcpServers: [], apps: false },
    operator: { mcpServers: ['linear', 'calendar'], apps: true },
  }
  const value = structuredClone(defaults.value)
  for (const role of ['orchestrator', 'coder', 'operator'] as const) value[role].nativeTools = policies[role]
  const updateDefaults = { commandId: randomUUID(), expectedRevision: defaults.revision, value }
  await callWorkspaceTool(owner, 'agent_defaults_update', contracts.AgentDefaultsUpdateResultSchema, updateDefaults)
  const replay = await callWorkspaceTool(owner, 'agent_defaults_update', contracts.AgentDefaultsUpdateResultSchema, updateDefaults)
  expect(replay.replayed).toBe(true)
  const savedDefaults = await callWorkspaceTool(owner, 'agent_defaults_get', contracts.ManagedAgentDefaultsSchema)
  for (const role of ['orchestrator', 'coder', 'operator'] as const) {
    expect(savedDefaults.value[role].nativeTools).toEqual(policies[role])
  }
  expect((await new PostgresOperatorRepository(fixture.pool).ensure()).configuration.nativeTools)
    .toEqual(policies.operator)

  const workspace = await callWorkspaceTool(owner, 'workspace_create', contracts.ManagedWorkspaceCommandResultSchema, {
    commandId: randomUUID(), name: 'Native tools', parentPath: fixture.parentPath,
  })
  const workspaceId = workspace.value.workspace.id
  const agentId = 'native-tools-agent'
  const created = await callWorkspaceTool(owner, 'agent_create', contracts.AgentMutationResultSchema, {
    commandId: randomUUID(), workspaceId, agentId, name: 'Coordinator', productRole: 'orchestrator',
  })
  expect(created.value.agent.nativeTools).toEqual(policies.orchestrator)
  const reader = await fixture.issue([{ actions: ['settings:read', 'agents:read', 'capabilities:read'], scope: {} }])
  await expectMcpAccessDenied(reader.client.callTool({ name: 'agent_defaults_update', arguments: {
    ...updateDefaults, commandId: randomUUID(), expectedRevision: savedDefaults.revision,
  } }))
  const updateAgent = { workspaceId, agentId, commandId: randomUUID(),
    expectedRevision: created.value.metadataRevision,
    expectedConfigurationVersionId: created.value.agent.configurationVersionId!,
    nativeTools: { mcpServers: ['calendar'], apps: false } }
  await expectMcpAccessDenied(reader.client.callTool({ name: 'agent_update', arguments: updateAgent }))
  const updated = await callWorkspaceTool(owner, 'agent_update', contracts.AgentMutationResultSchema, updateAgent)
  expect(updated.value.agent.nativeTools).toEqual(updateAgent.nativeTools)
  expect(updated.value.agent.configurationVersionId).not.toBe(created.value.agent.configurationVersionId)
  expect((await callWorkspaceTool(owner, 'agent_update', contracts.AgentMutationResultSchema, updateAgent)).replayed)
    .toBe(true)
  const readback = await callWorkspaceTool(reader.client, 'agent_get', contracts.ManagedAgentDetailSchema,
    { workspaceId, agentId })
  expect(readback.agent.nativeTools).toEqual(updateAgent.nativeTools)
  expect(readback.agent.configurationVersionId).toBe(updated.value.agent.configurationVersionId)
  const stale = await owner.callTool({ name: 'agent_update', arguments: { ...updateAgent, commandId: randomUUID() } })
  expect(stale.isError).toBe(true)
  expect(JSON.stringify(decodeMcpToolResult(stale))).toContain('AGENT_REVISION_CONFLICT')

  const inherited = await callWorkspaceTool(owner, 'agent_update', contracts.AgentMutationResultSchema, {
    ...updateAgent, commandId: randomUUID(), expectedRevision: updated.value.metadataRevision,
    expectedConfigurationVersionId: updated.value.agent.configurationVersionId!, nativeTools: {},
  })
  expect(inherited.value.agent.nativeTools).toEqual({})
  const renamed = await callWorkspaceTool(owner, 'agent_update', contracts.AgentMutationResultSchema, {
    workspaceId, agentId, name: 'Renamed coordinator', commandId: randomUUID(),
    expectedRevision: inherited.value.metadataRevision,
    expectedConfigurationVersionId: inherited.value.agent.configurationVersionId!,
  })
  expect(renamed.value.agent.nativeTools).toEqual({})
  const final = await callWorkspaceTool(reader.client, 'agent_get', contracts.ManagedAgentDetailSchema,
    { workspaceId, agentId })
  expect(final.agent.nativeTools).toEqual({})
  expect(final.agent.name).toBe('Renamed coordinator')
})
