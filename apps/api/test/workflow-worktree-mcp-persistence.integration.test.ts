import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { ManagedWorkspaceCommandResultSchema } from '@foreman-code/contracts/management'
import {
  CurrentWorkflowCapabilitiesSchema,
  CurrentWorkflowReadResultSchema,
  SavedManagedWorkflowCommandResultSchema,
  SavedManagedWorkflowSchema,
} from '@foreman-code/contracts/wave25'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { setup, repository } from './helpers/workflowWorktreeMcp.js'

describe.runIf(postgresEnabled)('workflow worktrees through authenticated MCP: persistence', () => {
  it('reads capabilities, seeds creation, saves an override and clears it through the same writer', async () => {
    const f = await setup()
    try {
      const capabilities = await f.base.client.callTool({ name: 'workflow_authoring_capabilities_v3', arguments: {} })
      expect(CurrentWorkflowCapabilitiesSchema.parse(decodeMcpToolResult(capabilities)).worktrees)
        .toMatchObject({ workflowDefault: true, agentBranchOverride: true, creationOptOut: true })
      const created = await f.create()
      expect(created.created.value.workflow.defaultWorktree).toEqual({ rootBinding: f.placement.local.rootBinding })
      expect(SavedManagedWorkflowCommandResultSchema.parse(decodeMcpToolResult(await f.base.client.callTool({
        name: 'workflow_create', arguments: created.input,
      })))).toEqual({ ...created.created, replayed: true })
      const input = created.saveInput
      input.graph.defaultWorktree = { rootBinding: f.placement.local.rootBinding!, branchPrefix: 'foreman/site' }
      const overridden = agentWorkflowNode(input.graph.nodes[0])
      overridden.placement = f.placement.remote
      overridden.worktree = { branchPrefix: 'foreman/site/review' }
      agentWorkflowNode(input.graph.nodes[1]).worktree = { branchPrefix: 'foreman/site/build' }
      const saved = await f.save(input)
      expect(await f.save(input)).toEqual({ ...saved, replayed: true })
      expect((await f.read(input.workflowId)).version.definition).toEqual(saved.value.version.definition)

      f.base.services.workflows = new WorkflowManagementService(f.base.db.pool, f.base.commands, { worktrees: f.services })
      const reloaded = await f.base.client.callTool({ name: 'workflow_get', arguments: {
        workspaceId: f.workspaceId, workflowId: input.workflowId,
      } })
      const definition = SavedManagedWorkflowSchema.parse(decodeMcpToolResult(reloaded)).workflow
      expect(agentWorkflowNode(definition.nodes[0]).worktree?.branchPrefix).toBe('foreman/site/review')
      const inherited = agentWorkflowNode(definition.nodes[0])
      delete inherited.placement
      delete inherited.worktree
      const cleared = await f.save({ ...input, commandId: randomUUID(), graph: definition,
        expectedRevision: saved.value.revision, expectedWorkflowVersionId: saved.value.currentVersionId })
      const readback = (await f.read(input.workflowId)).version.definition
      expect(agentWorkflowNode(readback.nodes[0])).not.toHaveProperty('placement')
      expect(agentWorkflowNode(readback.nodes[0])).not.toHaveProperty('worktree')
      expect(readback.defaultWorktree).toEqual(input.graph.defaultWorktree)
      expect(cleared.value.currentVersionId).not.toBe(saved.value.currentVersionId)
      const historicalResponse = await f.base.client.callTool({ name: 'workflow_saved_get_v3', arguments: {
        workspaceId: f.workspaceId, workflowId: input.workflowId, workflowVersionId: saved.value.currentVersionId,
      } })
      expect(CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult(historicalResponse)).version)
        .toEqual(saved.value.version)
      const withoutDefault = structuredClone(readback)
      delete withoutDefault.defaultWorktree
      for (const node of withoutDefault.nodes) {
        if (node.kind === 'job') continue
        delete node.placement
        delete node.worktree
      }
      await f.save({ ...input, commandId: randomUUID(), graph: withoutDefault,
        expectedRevision: cleared.value.revision, expectedWorkflowVersionId: cleared.value.currentVersionId })
      expect((await f.read(input.workflowId)).version.definition).not.toHaveProperty('defaultWorktree')
      expect((await f.base.db.pool.query<{ source: string; outcome: string }>(
        "select source,outcome from management_audit where action='workflow.save.v3' and details->>'commandId'=$1",
        [input.commandId])).rows).toEqual([{ source: 'mcp', outcome: 'succeeded' }])
    } finally { await f.close() }
  }, 30_000)

  it('rejects stale saves, foreign roots, repository substitutions and unavailable source bytes', async () => {
    const f = await setup()
    try {
      const { saveInput } = await f.create()
      const saved = await f.save(saveInput)
      let next = { ...saveInput, commandId: randomUUID(), graph: saved.value.version.definition,
        expectedRevision: saved.value.revision, expectedWorkflowVersionId: saved.value.currentVersionId }
      const failures = [
        { ...next, expectedRevision: next.expectedRevision - 1 },
        { ...next, graph: { ...next.graph, defaultWorktree: { rootBinding: { rootId: randomUUID(), bindingRevision: 1 } } } },
      ]
      for (const input of failures) {
        expect((await f.base.client.callTool({ name: 'workflow_save_v3', arguments: input })).isError).toBe(true)
      }
      const otherWorkspace = await f.base.client.callTool({ name: 'workspace_create', arguments: {
        commandId: randomUUID(), name: 'Other workspace',
      } })
      expect(otherWorkspace.isError).not.toBe(true)
      const otherWorkspaceId = ManagedWorkspaceCommandResultSchema.parse(decodeMcpToolResult(otherWorkspace)).value.workspace.id
      expect(await f.base.client.callTool({ name: 'workflow_create', arguments: {
        workspaceId: otherWorkspaceId, commandId: randomUUID(), name: 'Foreign root',
        defaultWorktree: { rootBinding: f.placement.local.rootBinding },
      } })).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('SOURCE_ROOT_NOT_FOUND') }] })
      const workspace = await f.base.services.workspaces.get(f.base.writer.principal, f.workspaceId)
      const metadataChange = await f.base.client.callTool({ name: 'workspace_update', arguments: {
        workspaceId: f.workspaceId, commandId: randomUUID(), expectedRevision: workspace.revision,
        repository: { ...repository, name: 'another-project' },
      } })
      expect(metadataChange.isError).not.toBe(true)
      expect(await f.base.client.callTool({ name: 'workflow_save_v3', arguments: {
        ...next, graph: { ...next.graph, defaultWorktree: { rootBinding: f.placement.remote.rootBinding } },
      } })).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('WORKTREE_REPOSITORY_CONFLICT') }] })
      const retained = await f.save({ ...next, commandId: randomUUID(), graph: {
        ...next.graph, defaultWorktree: { rootBinding: f.placement.local.rootBinding!, branchPrefix: 'foreman/retained' },
      } })
      next = { ...next, commandId: randomUUID(), expectedRevision: retained.value.revision,
        expectedWorkflowVersionId: retained.value.currentVersionId, graph: retained.value.version.definition }
      await f.base.db.pool.query("update source_snapshots set availability='unavailable' where snapshot_id=$1",
        [f.placement.source.snapshotId])
      expect(await f.base.client.callTool({ name: 'workflow_validate_v3', arguments: {
        workspaceId: next.workspaceId, workflowId: next.workflowId, executionSemanticsVersion: 3,
        expectedRevision: next.expectedRevision, expectedWorkflowVersionId: next.expectedWorkflowVersionId,
        expectedAgentConfigurationVersionIds: next.expectedAgentConfigurationVersionIds,
        graph: next.graph,
      } })).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('SOURCE_UNAVAILABLE') }] })
      expect((await f.read(next.workflowId)).version).toEqual(retained.value.version)
    } finally { await f.close() }
  }, 30_000)
})
