import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { CurrentWorkflowReadResultSchema, CurrentWorkflowSaveResultSchema } from '@foreman-code/contracts/wave25'
import { RunPlacementGetResultSchema } from '@foreman-code/contracts/placement-readback'
import { DomainError } from '../src/modules/errors.js'
import { fixture, startInput, toolError } from './helpers/nodePlacementStartFixture.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('mixed computer placement defaults', () => {
  it('freezes a remote workflow default and a local Agent override through authenticated MCP', async () => {
    const f = await fixture({ gitSource: true })
    try {
      f.saveInput.graph.defaultWorktree = { rootBinding: f.placement.remote.rootBinding!,
        branchPrefix: 'foreman/site/default' }
      const inherited = agentWorkflowNode(f.saveInput.graph.nodes[0])
      const explicit = agentWorkflowNode(f.saveInput.graph.nodes[1])
      explicit.placement = f.placement.local
      explicit.worktree = { branchPrefix: 'foreman/site/reviewer' }
      const saved = await f.save('mcp')
      const accepted = await f.start('mcp', startInput(f, saved))
      const read = async (nodeId: string) => {
        const response = await f.client.callTool({ name: 'run_node_placement_get', arguments: {
          workspaceId: f.saveInput.workspaceId, workflowId: f.saveInput.workflowId,
          runId: accepted.run.id, nodeId,
        } })
        expect(response.isError).not.toBe(true)
        return RunPlacementGetResultSchema.parse(decodeMcpToolResult(response)).readback
      }
      const inheritedRead = await read(inherited.id)
      const explicitRead = await read(explicit.id)
      expect(inheritedRead).toMatchObject({ evidence: 'accepted', placement: {
        labelAtAcceptance: 'Workflow default', hostRef: f.placement.remote.hostRef,
        payload: { instanceId: f.placement.remote.instanceId,
          worktree: { repository: 'octo/site', branch: 'foreman/site/default' } },
      } })
      expect(explicitRead).toMatchObject({ evidence: 'accepted', placement: {
        hostRef: f.placement.local.hostRef, payload: { instanceId: f.placement.local.instanceId,
          worktree: { repository: 'octo/site', branch: 'foreman/site/reviewer' } },
      } })
      const workspace = (await f.base.db.pool.query<{ revision: number }>(
        'select revision from workspaces where id=$1', [f.saveInput.workspaceId])).rows[0]!
      await f.base.services.workspaces.update(f.base.writer.principal, 'mcp', {
        workspaceId: f.saveInput.workspaceId, commandId: randomUUID(), expectedRevision: Number(workspace.revision),
        repository: { provider: 'github', owner: 'changed', name: 'site', defaultBranch: 'main' },
      })
      expect(await read(inherited.id)).toEqual(inheritedRead)
      expect(await read(explicit.id)).toEqual(explicitRead)
    } finally { await f.close() }
  }, 120_000)

  it('clears explicit placement through MCP Save and readback, then resolves inherited Main at Start', async () => {
    const f = await fixture()
    try {
      agentWorkflowNode(f.saveInput.graph.nodes[0]).placement = f.placement.local
      const original = await f.save('mcp')
      const graph = structuredClone(original.version.definition)
      const clearedNode = agentWorkflowNode(graph.nodes[1])
      delete clearedNode.placement
      const input = { ...f.saveInput, commandId: randomUUID(), expectedRevision: original.revision,
        expectedWorkflowVersionId: original.currentVersionId, graph }
      const reader = await f.base.access.issue({ name: 'Placement reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 60_000), grants: [{ actions: ['workflows:read', 'graph:read'],
          scope: { workspaceIds: [input.workspaceId], workflowIds: [input.workflowId] } }] })
      const denied = await f.connect(reader.token)
      expect(toolError(await denied.callTool({ name: 'workflow_save_v3', arguments: input })))
        .toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      const result = await f.client.callTool({ name: 'workflow_save_v3', arguments: input })
      expect(result.isError).not.toBe(true)
      const saved = CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(result)).value
      expect(agentWorkflowNode(saved.version.definition.nodes[1])).not.toHaveProperty('placement')
      const scope = { workspaceId: input.workspaceId, workflowId: input.workflowId }
      const read = await f.client.callTool({ name: 'workflow_saved_get_v3', arguments: scope })
      expect(read.isError).not.toBe(true)
      expect(CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult(read)).version).toEqual(saved.version)
      const retry = await f.client.callTool({ name: 'workflow_save_v3', arguments: input })
      expect(CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(retry)))
        .toEqual({ value: saved, replayed: true })
      const historical = await f.client.callTool({ name: 'workflow_saved_get_v3', arguments: {
        ...scope, workflowVersionId: original.version.id,
      } })
      expect(CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult(historical)).version).toEqual(original.version)
      const accepted = await f.start('mcp', startInput(f, saved))
      const placement = await f.client.callTool({ name: 'run_node_placement_get', arguments: {
        ...scope, runId: accepted.run.id, nodeId: clearedNode.id,
      } })
      expect(placement.isError).not.toBe(true)
      expect(RunPlacementGetResultSchema.parse(decodeMcpToolResult(placement)).readback)
        .toMatchObject({ evidence: 'accepted', placement: { labelAtAcceptance: 'Main',
          hostRef: f.placement.local.hostRef } })
    } finally { await f.close() }
  }, 120_000)

  it('starts a fully placed workflow without probing the original workspace directory', async () => {
    const f = await fixture()
    try {
      agentWorkflowNode(f.saveInput.graph.nodes[0]).placement = f.placement.local
      const saved = await f.save('mcp')
      const directory = vi.spyOn(f.base.locations, 'snapshot').mockRejectedValue(
        new DomainError('LOCATION_UNAVAILABLE', 'Workspace directory unavailable.', 409))
      const accepted = await f.start('mcp', startInput(f, saved))
      expect(accepted.run.workflowVersionId).toBe(saved.version.id)
      expect(directory).not.toHaveBeenCalled()
    } finally { await f.close() }
  }, 120_000)


})
