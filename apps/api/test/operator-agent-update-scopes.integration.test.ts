import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION, type Agent } from '@foreman-code/contracts'
import * as contracts from '@foreman-code/contracts/management'
import {
  CurrentOperatorCapabilitiesSchema,
  CurrentWorkflowSaveResultSchema,
  SavedManagedWorkflowCommandResultSchema,
} from '@foreman-code/contracts/wave25'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { AgentManagementService } from '../src/modules/workspaces/agents.js'
import { OperatorAgentMutationService } from '../src/modules/workspaces/operatorAgents.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { callWorkspaceTool, workspaceMcpFixture } from './helpers/workspaceMcp.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

let fixture: Awaited<ReturnType<typeof workspaceMcpFixture>>

beforeAll(async () => {
  fixture = await workspaceMcpFixture({ configureServices: async ({ pool, commands, services }) => {
    services.agents = new AgentManagementService(pool)
    services.workflows = new WorkflowManagementService(pool, commands)
    services.extensions = {
      agents: new OperatorAgentMutationService(pool, commands, {
        qualifyConfiguration: async configuration => ({
          harness: configuration.harness, version: 'fixture', authenticated: true, ready: true,
          structuredEvents: true, supportsResume: true, supportsCancellation: true,
          supportsWorkingDirectory: true, supportsStartupPrompt: true,
          supportedNativeTools: [], supportedSettings: [], unsupportedCapabilities: [],
        }),
      }),
    } as NonNullable<typeof services.extensions>
  } })
}, 60_000)

afterAll(async () => { await fixture?.close() })

async function referenceAgent(workspaceId: string, agent: Agent) {
  const created = (await callWorkspaceTool(fixture.owner.client, 'workflow_create',
    SavedManagedWorkflowCommandResultSchema, {
      workspaceId, commandId: randomUUID(), name: 'Agent reference',
    })).value
  await callWorkspaceTool(fixture.owner.client, 'workflow_save_v3', CurrentWorkflowSaveResultSchema, {
    workspaceId, workflowId: created.workflow.id, commandId: randomUUID(), executionSemanticsVersion: 3,
    expectedRevision: created.revision, expectedWorkflowVersionId: null,
    expectedAgentConfigurationVersionIds: { [agent.id]: agent.configurationVersionId },
    graph: {
      ...created.workflow, entryNodeId: 'worker',
      nodes: [{ id: 'worker', agentId: agent.id, name: 'Worker' }], edges: [],
      approval: { handler: 'user' }, executionCondition: { kind: 'manual' },
      executionPolicy: { maxParallelism: 1, maxNodeExecutions: 1 },
    },
  })
  return created.workflow.id
}

it('allows workflow-scoped Agent readers to update through HTTP and MCP and denies ungranted references', async () => {
  const workspace = await callWorkspaceTool(fixture.owner.client, 'workspace_create',
    contracts.ManagedWorkspaceCommandResultSchema, {
      commandId: randomUUID(), name: 'Scoped Agent updates', parentPath: fixture.parentPath,
    })
  const workspaceId = workspace.value.workspace.id
  const agentId = randomUUID()
  const created = (await callWorkspaceTool(fixture.owner.client, 'agent_create',
    contracts.AgentMutationResultSchema, {
      workspaceId, agentId, commandId: randomUUID(), name: 'Worker', productRole: 'coder',
      configuration: {
        harness: 'codex', model: 'fixture', reasoningEffort: 'low', sandbox: 'read-only',
        serviceTier: 'standard', advanced: DEFAULT_CODEX_ADVANCED_CONFIGURATION,
      },
    })).value
  const workflowId = await referenceAgent(workspaceId, created.agent)
  const scoped = await fixture.issue([
    { actions: ['agents:update'], scope: { workspaceIds: [workspaceId] } },
    { actions: ['agents:read', 'graph:read', 'graph:edit'],
      scope: { workspaceIds: [workspaceId], workflowIds: [workflowId] } },
    { actions: ['capabilities:read'], scope: {} },
  ])
  const agentUrl = `/api/management/workspaces/${workspaceId}/agents/${agentId}`
  const headers = { authorization: `Bearer ${scoped.token}`, host: '127.0.0.1' }
  const httpInput = {
    workspaceId, agentId, commandId: randomUUID(), expectedRevision: created.metadataRevision,
    expectedConfigurationVersionId: created.agent.configurationVersionId!,
    prompt: { system: 'HTTP instructions' },
  }
  const readOnly = await fixture.issue([{ actions: ['agents:read'],
    scope: { workspaceIds: [workspaceId], workflowIds: [workflowId] } }])
  const deniedUpdate = await fixture.app.inject({ method: 'PATCH', url: agentUrl,
    headers: { ...headers, authorization: `Bearer ${readOnly.token}` }, payload: httpInput })
  expect(deniedUpdate.statusCode).toBe(403)
  expect(deniedUpdate.json()).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
  await expectMcpAccessDenied(readOnly.client.callTool({ name: 'agent_update', arguments: httpInput }))
  const httpReply = await fixture.app.inject({ method: 'PATCH', url: agentUrl, headers, payload: httpInput })
  expect(httpReply.statusCode).toBe(200)
  const httpSaved = contracts.AgentMutationResultSchema.parse(httpReply.json())
  expect(httpSaved.value.agent.prompt).toEqual(httpInput.prompt)
  expect(httpSaved.value.affectedWorkflowIds).toEqual([workflowId])

  const tools = (await scoped.client.listTools()).tools.map(tool => tool.name)
  expect(tools).toContain('agent_update')
  expect(tools).not.toContain('agent_create')
  const capabilities = await callWorkspaceTool(scoped.client, 'operator_get_capabilities',
    CurrentOperatorCapabilitiesSchema, { detail: 'full', workspaceId, workflowId })
  expect(capabilities.tools).toContain('agent_update')
  expect(capabilities.requirements?.find(requirement => requirement.name === 'agent_update')?.actions)
    .toEqual(['agents:update', 'agents:read'])

  const mcpInput = {
    ...httpInput, commandId: randomUUID(), expectedRevision: httpSaved.value.metadataRevision,
    expectedConfigurationVersionId: httpSaved.value.agent.configurationVersionId!,
    prompt: { system: 'MCP instructions' },
  }
  const mcpSaved = await callWorkspaceTool(scoped.client, 'agent_update',
    contracts.AgentMutationResultSchema, mcpInput)
  expect(mcpSaved.value.agent.prompt).toEqual(mcpInput.prompt)
  expect(mcpSaved.value.metadataRevision).toBe(httpSaved.value.metadataRevision + 1)
  expect(mcpSaved.value.agent.configurationVersionId).not.toBe(httpSaved.value.agent.configurationVersionId)
  expect(mcpSaved.value.affectedWorkflowIds).toEqual([workflowId])
  expect(await callWorkspaceTool(scoped.client, 'agent_update', contracts.AgentMutationResultSchema, mcpInput))
    .toEqual({ ...mcpSaved, replayed: true })
  const httpReplay = await fixture.app.inject({ method: 'PATCH', url: agentUrl, headers, payload: mcpInput })
  expect(httpReplay.statusCode).toBe(200)
  expect(contracts.AgentMutationResultSchema.parse(httpReplay.json())).toEqual({ ...mcpSaved, replayed: true })

  const listInput = { workspaceId, workflowId }
  const readback = await callWorkspaceTool(scoped.client, 'agent_list', contracts.ManagedAgentPageSchema, listInput)
  expect(readback.items).toEqual([expect.objectContaining({
    agent: mcpSaved.value.agent, metadataRevision: mcpSaved.value.metadataRevision,
  })])
  const listUrl = `/api/management/workspaces/${workspaceId}/agents?workflowId=${workflowId}`
  const httpReadback = await fixture.app.inject({ method: 'GET', url: listUrl, headers })
  expect(httpReadback.statusCode).toBe(200)
  expect(contracts.ManagedAgentPageSchema.parse(httpReadback.json())).toEqual(readback)

  const secondWorkflowId = await referenceAgent(workspaceId, mcpSaved.value.agent)
  expect(secondWorkflowId).not.toBe(workflowId)
  const deniedInput = {
    ...mcpInput, commandId: randomUUID(), expectedRevision: mcpSaved.value.metadataRevision,
    expectedConfigurationVersionId: mcpSaved.value.agent.configurationVersionId!,
    prompt: { system: 'Denied instructions' },
  }
  expect((await scoped.client.listTools()).tools.map(tool => tool.name)).toContain('agent_update')
  await expectMcpAccessDenied(scoped.client.callTool({ name: 'agent_update', arguments: deniedInput }))
  const httpDenied = await fixture.app.inject({ method: 'PATCH', url: agentUrl, headers,
    payload: { ...deniedInput, commandId: randomUUID() } })
  expect(httpDenied.statusCode).toBe(403)
  expect(httpDenied.json()).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
  expect(await callWorkspaceTool(scoped.client, 'agent_list', contracts.ManagedAgentPageSchema, listInput))
    .toEqual(readback)

  const reader = await fixture.issue([{ actions: ['agents:read'],
    scope: { workspaceIds: [workspaceId], workflowIds: [workflowId] } }])
  expect((await reader.client.listTools()).tools.map(tool => tool.name)).not.toContain('agent_update')
  await expectMcpAccessDenied(reader.client.callTool({ name: 'agent_update', arguments: {
    ...deniedInput, commandId: randomUUID(),
  } }))
  const readerDenied = await fixture.app.inject({ method: 'PATCH', url: agentUrl,
    headers: { ...headers, authorization: `Bearer ${reader.token}` },
    payload: { ...deniedInput, commandId: randomUUID() } })
  expect(readerDenied.statusCode).toBe(403)
  expect(readerDenied.json()).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
})

it('does not discover Agent updates when workspace mutation and workflow read grants are disjoint', async () => {
  const scoped = await fixture.issue([
    { actions: ['agents:update'], scope: { workspaceIds: ['workspace-a'] } },
    { actions: ['agents:read'], scope: { workspaceIds: ['workspace-b'], workflowIds: ['workflow-b'] } },
    { actions: ['capabilities:read'], scope: {} },
  ])
  expect((await scoped.client.listTools()).tools.map(tool => tool.name)).not.toContain('agent_update')
  const capabilities = decodeMcpToolResult(await scoped.client.callTool({
    name: 'operator_get_capabilities', arguments: { detail: 'full' },
  }))
  expect(CurrentOperatorCapabilitiesSchema.parse(capabilities).tools).not.toContain('agent_update')
})
