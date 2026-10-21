import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AgentSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { AgentMutationResultSchema, ManagedAgentDetailSchema, ManagedWorkspaceCommandResultSchema } from '@foreman-code/contracts/management'
import {
  CURRENT_WORKFLOW_ROUTES,
  CurrentEditReadResultSchema,
  CurrentWorkflowReadResultSchema,
  SavedManagedWorkflowCommandResultSchema,
  type CurrentWorkflowSaveInput,
} from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import { ProviderAccountConfigurationService } from '../src/modules/harnesses/providerAccountConfiguration.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { setup } from './helpers/workflowWorktreeMcp.js'

describe.runIf(postgresEnabled)('workflow worktrees through authenticated MCP: edits', () => {
  it('rejects a rootless prefix before staging and preserves the saved state after correction and Discard', async () => {
    const f = await setup()
    const app = buildApp({ readiness: { database: { ping: async () => undefined },
      checkpoints: { ping: async () => undefined } }, operator: { access: f.base.access, services: f.base.services } })
    try {
      const workspaceResult = await f.base.client.callTool({ name: 'workspace_create', arguments: {
        commandId: randomUUID(), name: 'Workspace without approved roots',
      } })
      expect(workspaceResult.isError).not.toBe(true)
      const workspace = ManagedWorkspaceCommandResultSchema.parse(decodeMcpToolResult(workspaceResult)).value
      const workspaceId = workspace.workspace.id
      await f.base.services.locations.set(f.base.writer.principal, 'http', {
        workspaceId, commandId: randomUUID(), expectedLocationRevision: workspace.locationRevision,
        runnerId: f.base.locations.runnerId, rootPath: f.placement.local.projectRoot,
      })
      const agentResult = await f.base.client.callTool({ name: 'agent_create', arguments: {
        workspaceId, agentId: randomUUID(), commandId: randomUUID(), name: 'Worker',
        configuration: f.base.f.configurations[0]!.harness,
      } })
      expect(agentResult.isError).not.toBe(true)
      const agentDetail = AgentMutationResultSchema.parse(decodeMcpToolResult(agentResult)).value
      const agent = agentDetail.agent
      const createdResult = await f.base.client.callTool({ name: 'workflow_create', arguments: {
        workspaceId, commandId: randomUUID(), name: 'Prefix recovery', defaultWorktree: null,
      } })
      expect(createdResult.isError).not.toBe(true)
      const created = SavedManagedWorkflowCommandResultSchema.parse(decodeMcpToolResult(createdResult)).value
      const nodeId = randomUUID()
      const input: CurrentWorkflowSaveInput = {
        workspaceId, workflowId: created.workflow.id, commandId: randomUUID(), executionSemanticsVersion: 3,
        expectedRevision: created.revision, expectedWorkflowVersionId: null,
        expectedAgentConfigurationVersionIds: { [agent.id]: agent.configurationVersionId! },
        graph: { ...created.workflow, entryNodeId: nodeId, approval: { handler: 'user' },
          executionPolicy: { maxParallelism: 1, maxNodeExecutions: 1 },
          nodes: [{ id: nodeId, kind: 'agent', name: 'Worker', agentId: agent.id }] },
      }
      const saved = (await f.save(input)).value
      const stage = { ...input, action: 'stage_edits', commandId: randomUUID(), draftId: randomUUID(),
        expectedRevision: saved.revision, expectedWorkflowVersionId: saved.currentVersionId,
        graph: { ...saved.version.definition, nodes: [{ ...saved.version.definition.nodes[0]!,
          worktree: { branchPrefix: 'foreman/journey-worker' } }] },
        stagedAgents: [{ agent: { ...agent, name: 'Unsaved Worker' }, baseRevision: agentDetail.metadataRevision }],
      }
      const reader = await f.base.access.issue({ name: 'Read-only prefix caller', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['workflows:read', 'graph:read', 'agents:read'],
          scope: { workspaceIds: [workspaceId] } }] })
      await expectMcpAccessDenied((await f.base.connect(reader.token)).callTool({
        name: 'workflow_edit_v3', arguments: stage,
      }))
      const headers = { authorization: `Bearer ${f.base.writer.token}` }
      const url = CURRENT_WORKFLOW_ROUTES.edits.replace(':workspaceId', workspaceId)
        .replace(':workflowId', input.workflowId)
      const rejected = await app.inject({ method: 'POST', url, headers, payload: stage })
      expect(rejected.statusCode, rejected.body).toBe(409)
      expect(rejected.json()).toMatchObject({ error: { code: 'WORKTREE_BINDING_REQUIRED' } })
      expect(await f.base.client.callTool({ name: 'workflow_edit_v3', arguments: stage }))
        .toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('WORKTREE_BINDING_REQUIRED') }] })
      const readInput = { action: 'read_edits', workspaceId, workflowId: input.workflowId, draftId: stage.draftId }
      const read = await f.base.client.callTool({ name: 'workflow_edits_get_v3', arguments: readInput })
      expect(CurrentEditReadResultSchema.parse(decodeMcpToolResult(read)).intent).toBeNull()

      const corrected = { ...stage, commandId: randomUUID(), graph: saved.version.definition }
      const staged = await f.base.client.callTool({ name: 'workflow_edit_v3', arguments: corrected })
      expect(staged.isError, JSON.stringify(staged)).not.toBe(true)
      const intent = CurrentEditReadResultSchema.parse(decodeMcpToolResult(staged)).intent!
      const discard = { ...readInput, action: 'discard_edits', intentId: intent.id, commandId: intent.discardCommandId }
      const discarded = await f.base.client.callTool({ name: 'workflow_edit_v3', arguments: discard })
      expect(discarded.isError, JSON.stringify(discarded)).not.toBe(true)
      expect(CurrentEditReadResultSchema.parse(decodeMcpToolResult(discarded)).intent?.state).toBe('discarded')
      const reloaded = await app.inject({ method: 'GET', url: `${url}?draftId=${stage.draftId}`, headers })
      expect(reloaded.statusCode, reloaded.body).toBe(200)
      expect(CurrentEditReadResultSchema.parse(reloaded.json()).intent?.state).toBe('discarded')
      const savedRead = await f.base.client.callTool({ name: 'workflow_saved_get_v3', arguments: {
        workspaceId, workflowId: input.workflowId,
      } })
      expect(CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult(savedRead)).version).toEqual(saved.version)
      const agentRead = await f.base.client.callTool({ name: 'agent_get', arguments: { workspaceId, agentId: agent.id } })
      expect(ManagedAgentDetailSchema.parse(decodeMcpToolResult(agentRead)).agent).toEqual(agent)
    } finally {
      await app.close()
      await f.close()
    }
  }, 30_000)

  it('pins a provider account and worktree together through staged edits and persisted reads', async () => {
    const accountId = randomUUID()
    const accountConfigurations = new ProviderAccountConfigurationService({
      resolve: async () => ({ accountId, homePath: '/accounts/codex/home', authMode: 'subscription' }),
    })
    const f = await setup({ accountConfigurations })
    try {
      const { saveInput } = await f.create()
      const saved = (await f.save(saveInput)).value
      const agentId = randomUUID()
      const nodeId = randomUUID()
      const agent = AgentSchema.parse({ id: agentId, name: 'Account-backed coder', productRole: 'coder',
        harnessConfiguration: f.base.f.configurations[0]!.harness })
      const definition = saved.version.definition
      const stage = {
        ...saveInput, action: 'stage_edits', draftId: randomUUID(), commandId: randomUUID(),
        expectedRevision: saved.revision, expectedWorkflowVersionId: saved.currentVersionId,
        graph: { ...definition,
          nodes: [...definition.nodes, { ...agentWorkflowNode(definition.nodes[0]), id: nodeId, agentId }],
          edges: [...definition.edges, { ...definition.edges[0]!, id: randomUUID(),
            source: definition.nodes.at(-1)!.id, target: nodeId }],
          executionPolicy: { ...definition.executionPolicy!, maxNodeExecutions: definition.executionPolicy!.maxNodeExecutions + 1 },
          defaultWorktree: { rootBinding: f.placement.local.rootBinding!, branchPrefix: 'foreman/accounts' },
        },
        stagedAgents: [{ agent, baseRevision: null }],
      }
      const reader = await f.base.access.issue({ name: 'Read-only account/worktree caller', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['workflows:read', 'graph:read', 'agents:read'],
          scope: { workspaceIds: [f.workspaceId] } }] })
      await expectMcpAccessDenied((await f.base.connect(reader.token)).callTool({
        name: 'workflow_edit_v3', arguments: stage,
      }))
      const staged = await f.base.client.callTool({ name: 'workflow_edit_v3', arguments: stage })
      expect(staged.isError, JSON.stringify(staged)).not.toBe(true)
      const intent = CurrentEditReadResultSchema.parse(decodeMcpToolResult(staged)).intent!
      const published = await f.base.client.callTool({ name: 'workflow_edit_v3', arguments: {
        workspaceId: f.workspaceId, workflowId: saveInput.workflowId, draftId: stage.draftId,
        intentId: intent.id, action: 'stop_and_save', commandId: intent.advanceCommandId,
      } })
      expect(published.isError, JSON.stringify(published)).not.toBe(true)
      expect(CurrentEditReadResultSchema.parse(decodeMcpToolResult(published)).intent?.state).toBe('saved')
      expect((await f.read(saveInput.workflowId)).version.definition.defaultWorktree).toEqual(stage.graph.defaultWorktree)
      const readback = await f.base.client.callTool({ name: 'agent_get', arguments: {
        workspaceId: f.workspaceId, agentId,
      } })
      expect(readback.isError).not.toBe(true)
      expect(ManagedAgentDetailSchema.parse(decodeMcpToolResult(readback)).agent.harnessConfiguration)
        .toMatchObject({ accountId })
    } finally { await f.close() }
  }, 30_000)
})
