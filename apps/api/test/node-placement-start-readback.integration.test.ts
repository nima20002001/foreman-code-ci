import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { onTestFailed } from 'vitest'
import { CurrentWorkflowReadResultSchema } from '@foreman-code/contracts/wave25'
import { RunPlacementGetResultSchema } from '@foreman-code/contracts/placement-readback'
import type { AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import { ApprovedSourceSchema, SourceRootListResultSchema } from '@foreman-code/contracts/source-admission'
import { ScheduleOperatorCapabilitiesSchema } from '../src/mcp/operator/tools/workflowSchedules.js'
import { advanceMainSourceBinding, fixture, startInput, toolError } from './helpers/nodePlacementStartFixture.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('mixed computer placement readback', () => {
  it('persists implicit Main placement for an artifact producer through authenticated MCP and denies a reader', async () => {
    const f = await fixture()
    try {
      const node = agentWorkflowNode(f.saveInput.graph.nodes[0])
      node.artifactOutputs = { version: 1, outputKeys: ['report'] }
      f.saveInput.graph.nodes = [node]
      f.saveInput.graph.edges = []
      f.saveInput.expectedAgentConfigurationVersionIds = {
        [node.agentId]: f.saveInput.expectedAgentConfigurationVersionIds[node.agentId]!,
      }
      const saved = await f.save('mcp')
      expect(agentWorkflowNode(saved.version.definition.nodes[0]).placement).toBeUndefined()
      const input = startInput(f, saved)
      const accepted = await f.start('mcp', input)
      const result = await f.client.callTool({ name: 'run_node_placement_get', arguments: {
        workspaceId: input.workspaceId, workflowId: input.workflowId, runId: accepted.run.id, nodeId: node.id,
      } })
      expect(result.isError).not.toBe(true)
      const read = RunPlacementGetResultSchema.parse(decodeMcpToolResult(result))
      if (read.readback.evidence !== 'accepted') throw new Error('Accepted Main placement required')
      expect(read.readback.placement.hostRef).toEqual(f.placement.local.hostRef)
      expect(read.readback.placement.payload).toMatchObject({ kind: 'agent', artifactOutputs: node.artifactOutputs })
      expect((await f.base.db.pool.query('select record from run_node_placements where run_id=$1 and node_id=$2',
        [accepted.run.id, node.id])).rows[0]?.record).toEqual(read.readback.placement)
      const reader = await f.base.access.issue({ name: 'Artifact workflow reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 60_000), grants: [{ actions: ['runs:read'],
          scope: { workspaceIds: [input.workspaceId], workflowIds: [input.workflowId] } }] })
      const denied = await f.connect(reader.token)
      expect(toolError(await denied.callTool({ name: 'run_start', arguments: { ...input, commandId: randomUUID() } })))
        .toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    } finally { await f.close() }
  }, 120_000)
  it.each(['http', 'mcp'] as const)('%s Save and Start persist an unplaced Main Agent and an explicit remote Agent', async via => {
    const f = await fixture()
    let stage = 'save'
    onTestFailed(() => { console.error(`Placement test failed at ${stage}:`, f.base.dispatchErrors) })
    try {
      const saved = await f.save(via)
      const local = agentWorkflowNode(saved.version.definition.nodes[0])
      const remote = agentWorkflowNode(saved.version.definition.nodes[1])
      expect(local.placement).toBeUndefined()
      expect(remote.placement).toEqual(f.placement.remote)
      const input = startInput(f, saved)
      stage = 'start'
      const accepted = await f.start(via, input)
      expect(accepted.accepted).toBe(true)
      expect(accepted.replayed).toBe(false)
      expect(await f.start(via === 'http' ? 'mcp' : 'http', input)).toEqual({ ...accepted, replayed: true })
      const rootResult = await f.client.callTool({ name: 'source_root_list', arguments: { workspaceId: input.workspaceId } })
      expect(rootResult.isError).not.toBe(true)
      const roots = SourceRootListResultSchema.parse(decodeMcpToolResult(rootResult)).items
      const expected = [f.placement.local, f.placement.remote]
      stage = 'placement readback'
      const readbacks: AcceptedNodePlacement[] = []
      for (const [index, node] of [local, remote].entries()) {
        const scope = { workspaceId: input.workspaceId, workflowId: input.workflowId, runId: accepted.run.id, nodeId: node.id }
        const response = await f.app.inject({ method: 'GET', headers: f.headers,
          url: `${f.path}/runs/${scope.runId}/nodes/${node.id}/placement` })
        expect(response.statusCode).toBe(200)
        const read = RunPlacementGetResultSchema.parse(response.json())
        const tool = await f.client.callTool({ name: 'run_node_placement_get', arguments: scope })
        expect(tool.isError).not.toBe(true)
        expect(RunPlacementGetResultSchema.parse(decodeMcpToolResult(tool))).toEqual(read)
        if (read.readback.evidence !== 'accepted') throw new Error('Expected accepted placement')
        const pin = read.readback.placement
        if (index === 0) expect(pin.labelAtAcceptance).toBe('Main')
        expect(pin.hostRef).toEqual(expected[index]!.hostRef)
        expect(pin.destination.canonicalProjectRoot).toBe(expected[index]!.projectRoot)
        const root = roots.find(root => root.binding.rootId === expected[index]!.rootBinding!.rootId)!
        expect(root.binding.bindingRevision).toBeGreaterThan(expected[index]!.rootBinding!.bindingRevision)
        expect(pin.source).toEqual({ kind: 'pending', ...root.source, revisionId: root.source.snapshotId,
          rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision,
          materializationId: null, materializationDigest: null })
        const sourceResult = await f.client.callTool({ name: 'source_get', arguments: {
          workspaceId: input.workspaceId, ...root.source,
        } })
        expect(sourceResult.isError).not.toBe(true)
        expect(ApprovedSourceSchema.parse(decodeMcpToolResult(sourceResult)).manifest.git?.commit)
          .toBe(f.git('rev-parse', 'HEAD'))
        expect(pin.payload).toMatchObject({ kind: 'agent', agentId: node.agentId,
          agentConfigurationVersionId: saved.version.agentConfigurationVersionIds[node.agentId],
          instanceId: expected[index]!.instanceId, instanceRevision: '1', harnessInstallationId: expected[index]!.harnessInstallationId })
        readbacks.push(pin)
      }
      expect(readbacks[0]!.source).toMatchObject({ snapshotId: roots[0]!.source.snapshotId })
      expect(readbacks[1]!.source).toMatchObject({ snapshotId: roots[0]!.source.snapshotId })
      expect((await f.base.db.pool.query('select record from run_node_placements where run_id=$1 order by node_id',
        [accepted.run.id])).rows.map(row => row.record)).toEqual([...readbacks].sort((a, b) => a.nodeId.localeCompare(b.nodeId)))
      await advanceMainSourceBinding(f)
      stage = 'retained readback and retry'
      const retained = await f.client.callTool({ name: 'run_node_placement_get', arguments: {
        workspaceId: input.workspaceId, workflowId: input.workflowId, runId: accepted.run.id, nodeId: local.id,
      } })
      expect(RunPlacementGetResultSchema.parse(decodeMcpToolResult(retained)).readback)
        .toMatchObject({ evidence: 'accepted', placement: readbacks[0] })
      expect(await f.start(via, input)).toEqual({ ...accepted, replayed: true })
      const reader = await f.base.access.issue({ name: 'Foreign workflow reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 60_000), grants: [{ actions: ['runs:read', 'workspace_locations:read'],
          scope: { workspaceIds: [input.workspaceId], workflowIds: ['another-workflow'] } }] })
      const denied = await f.connect(reader.token)
      stage = 'denied caller'
      expect(toolError(await denied.callTool({ name: 'run_start', arguments: { ...input, commandId: randomUUID() } })))
        .toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      expect(toolError(await denied.callTool({ name: 'run_node_placement_get', arguments: {
        workspaceId: input.workspaceId, workflowId: input.workflowId, runId: accepted.run.id, nodeId: local.id,
      } }))).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      expect((await f.app.inject({ method: 'POST', url: `${f.path}/runs`,
        headers: { authorization: `Bearer ${reader.token}` }, payload: { ...input, commandId: randomUUID() } })).statusCode).toBe(403)
      expect((await f.app.inject({ method: 'GET', url: `${f.path}/runs/${accepted.run.id}/nodes/${local.id}/placement`,
        headers: { authorization: `Bearer ${reader.token}` } })).statusCode).toBe(403)
      const capabilities = await f.client.callTool({ name: 'operator_get_capabilities', arguments: { detail: 'full',
        workspaceId: input.workspaceId, workflowId: input.workflowId, runId: accepted.run.id,
      } })
      expect(capabilities.isError).not.toBe(true)
      expect(ScheduleOperatorCapabilitiesSchema.parse(decodeMcpToolResult(capabilities)).tools).toContain('run_node_placement_get')
      const read = await f.client.callTool({ name: 'workflow_saved_get_v3', arguments: {
        workspaceId: input.workspaceId, workflowId: input.workflowId,
      } })
      expect(CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult(read)).version).toEqual(saved.version)
      expect(f.base.provider.counts.sessions).toBe(0)
      stage = 'close'
    } finally { await f.close() }
  }, 120_000)


})
