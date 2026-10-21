import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { AgentMutationResultSchema, ManagedWorkspaceCommandResultSchema, ManagementActionSchema } from '@foreman-code/contracts/management'
import { SavedManagedWorkflowCommandResultSchema } from '@foreman-code/contracts/wave25'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { setup, repository } from './helpers/workflowWorktreeMcp.js'

describe.runIf(postgresEnabled)('workflow worktrees through authenticated MCP: roots', () => {
  it('authorizes and validates root-only Agent overrides without a workflow default or branch prefix', async () => {
    const f = await setup()
    try {
      const { saveInput } = await f.create(null)
      agentWorkflowNode(saveInput.graph.nodes[0]).placement = f.placement.local
      expect(saveInput.graph).not.toHaveProperty('defaultWorktree')
      expect(agentWorkflowNode(saveInput.graph.nodes[0])).not.toHaveProperty('worktree')
      for (const missing of ['sources:read', 'source_roots:read', 'workspace_locations:read'] as const) {
        const issued = await f.base.access.issue({ name: `Root-only missing ${missing}`, audience: 'operator',
          expiresAt: new Date(Date.now() + 600000), grants: [{
            actions: ManagementActionSchema.options.filter(action => action !== missing),
            scope: { workspaceIds: [f.workspaceId] },
          }] })
        const client = await f.base.connect(issued.token)
        await expectMcpAccessDenied(client.callTool({ name: 'workflow_save_v3', arguments: saveInput }))
        await expectMcpAccessDenied(client.callTool({ name: 'workflow_edit_v3', arguments: {
          ...saveInput, action: 'stage_edits', draftId: randomUUID(),
        } }))
      }
      const reader = await f.base.access.issue({ name: 'Root-only reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['workflows:read', 'graph:read'],
          scope: { workspaceIds: [f.workspaceId] } }] })
      await expectMcpAccessDenied((await f.base.connect(reader.token)).callTool({
        name: 'workflow_save_v3', arguments: saveInput,
      }))
      const saved = await f.save(saveInput)
      expect(agentWorkflowNode((await f.read(saveInput.workflowId)).version.definition.nodes[0]).placement)
        .toEqual(f.placement.local)
      const next = { ...saveInput, commandId: randomUUID(), graph: structuredClone(saved.value.version.definition),
        expectedRevision: saved.value.revision, expectedWorkflowVersionId: saved.value.currentVersionId }
      const workspace = await f.base.services.workspaces.get(f.base.writer.principal, f.workspaceId)
      const changed = await f.base.client.callTool({ name: 'workspace_update', arguments: {
        workspaceId: f.workspaceId, commandId: randomUUID(), expectedRevision: workspace.revision,
        repository: { ...repository, name: 'other-project' },
      } })
      expect(changed.isError).not.toBe(true)
      agentWorkflowNode(next.graph.nodes[0]).placement = f.placement.remote
      expect(await f.base.client.callTool({ name: 'workflow_save_v3', arguments: next }))
        .toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('WORKTREE_REPOSITORY_CONFLICT') }] })
      agentWorkflowNode(next.graph.nodes[0]).placement = f.placement.local
      await f.base.db.pool.query("update source_snapshots set availability='unavailable' where snapshot_id=$1",
        [f.placement.source.snapshotId])
      expect(await f.base.client.callTool({ name: 'workflow_edit_v3', arguments: {
        ...next, commandId: randomUUID(), action: 'stage_edits', draftId: randomUUID(),
      } })).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('SOURCE_UNAVAILABLE') }] })
      expect((await f.read(saveInput.workflowId)).version).toEqual(saved.value.version)
    } finally { await f.close() }
  }, 30_000)

  it('rejects a root-only Agent override bound to another workspace', async () => {
    const f = await setup()
    try {
      const workspaceResponse = await f.base.client.callTool({ name: 'workspace_create', arguments: {
        commandId: randomUUID(), name: 'Foreign Agent root',
      } })
      expect(workspaceResponse.isError).not.toBe(true)
      const workspace = ManagedWorkspaceCommandResultSchema.parse(decodeMcpToolResult(workspaceResponse)).value
      const workspaceId = workspace.workspace.id
      const agentResponse = await f.base.client.callTool({ name: 'agent_create', arguments: {
        workspaceId, agentId: randomUUID(), commandId: randomUUID(), name: 'Worker',
        configuration: f.base.f.configurations[0]!.harness,
      } })
      expect(agentResponse.isError, JSON.stringify(agentResponse)).not.toBe(true)
      const agent = AgentMutationResultSchema.parse(decodeMcpToolResult(agentResponse)).value.agent
      const workflowResponse = await f.base.client.callTool({ name: 'workflow_create', arguments: {
        workspaceId, commandId: randomUUID(), name: 'Foreign source selection', defaultWorktree: null,
      } })
      expect(workflowResponse.isError).not.toBe(true)
      const workflow = SavedManagedWorkflowCommandResultSchema.parse(decodeMcpToolResult(workflowResponse)).value
      const nodeId = randomUUID()
      expect(await f.base.client.callTool({ name: 'workflow_save_v3', arguments: {
        workspaceId, workflowId: workflow.workflow.id, commandId: randomUUID(), executionSemanticsVersion: 3,
        expectedRevision: workflow.revision, expectedWorkflowVersionId: null,
        expectedAgentConfigurationVersionIds: { [agent.id]: agent.configurationVersionId },
        graph: { ...workflow.workflow, entryNodeId: nodeId, executionPolicy: { maxParallelism: 1, maxNodeExecutions: 1 },
          nodes: [{ id: nodeId, kind: 'agent', name: 'Worker', agentId: agent.id, placement: f.placement.remote }] },
      } })).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('SOURCE_ROOT_NOT_FOUND') }] })
    } finally { await f.close() }
  }, 30_000)

  it('rejects a branch prefix for a read-only root while retaining root-only defaults', async () => {
    const f = await setup({ sourceAccessMode: 'read-only' })
    try {
      const { saveInput } = await f.create()
      expect((await f.save(saveInput)).value.version.definition.defaultWorktree?.rootBinding)
        .toEqual(f.placement.local.rootBinding)
      expect(await f.base.client.callTool({ name: 'workflow_create', arguments: {
        workspaceId: f.workspaceId, commandId: randomUUID(), name: 'Read-only branch',
        defaultWorktree: { rootBinding: f.placement.local.rootBinding, branchPrefix: 'foreman/review' },
      } })).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('WORKTREE_ACCESS_CONFLICT') }] })
    } finally { await f.close() }
  }, 30_000)
})
