import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { CurrentWorkflowReadResultSchema } from '@foreman-code/contracts/wave25'
import { RunPlacementGetResultSchema } from '@foreman-code/contracts/placement-readback'
import { SourceRootListResultSchema } from '@foreman-code/contracts/source-admission'
import { WorkspaceBoundLocationSetResultSchema } from '@foreman-code/contracts/workspace-bound-location'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { fixture, startInput, toolError } from './helpers/nodePlacementStartFixture.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('saved placement after a workspace root reset', () => {
  it.each(['explicit', 'implicit', 'implicit-with-stale-root', 'workflow-default'] as const)(
    'starts %s placement at the latest root revisions through MCP and retains Run facts', async mode => {
      const f = await fixture()
      try {
        const node = agentWorkflowNode(f.saveInput.graph.nodes[0])
        f.saveInput.graph.nodes = [node]
        f.saveInput.graph.edges = []
        f.saveInput.expectedAgentConfigurationVersionIds = {
          [node.agentId]: f.saveInput.expectedAgentConfigurationVersionIds[node.agentId]!,
        }
        if (mode === 'explicit') node.placement = f.placement.local
        if (mode === 'workflow-default') {
          f.saveInput.graph.defaultWorktree = { rootBinding: f.placement.local.rootBinding! }
        }
        if (mode === 'implicit-with-stale-root') {
          const stale = structuredClone(await f.placement.sources.rootGet(f.base.writer.principal, 'mcp', {
            workspaceId: f.saveInput.workspaceId, ...f.placement.local.rootBinding!,
          }))
          stale.binding.rootId = randomUUID()
          stale.selection.rootPolicyId = randomUUID()
          await f.base.db.pool.query(`insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision)
            values($1,$2,$3,1)`, [stale.binding.rootId, f.saveInput.workspaceId, 'd'.repeat(64)])
          await f.base.db.pool.query(`insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record)
            values($1,1,$2,$3,$4::jsonb)`, [stale.binding.rootId, f.saveInput.workspaceId,
            stale.source.snapshotId, JSON.stringify(stale)])
        }
        const saved = await f.save('mcp')
        const policies = await f.placement.policies.read(f.base.db.pool, f.base.writer.principal, f.saveInput.workspaceId)
        const policy = policies.find(value => value.rootPolicyId === f.placement.local.rootPolicyId)!
        const resetInput = { workspaceId: f.saveInput.workspaceId, hostRef: policy.hostRef,
          allowedBaseId: policy.allowedBaseId, configurationRevision: policy.configurationRevision,
          relativePath: policy.relativePath, accessMode: policy.accessMode,
          expectedLocationRevision: f.placement.locationRevision,
          expectedRootPolicyRevision: Number(policy.rootPolicyRevision), commandId: randomUUID() }
        const resetResult = await f.client.callTool({ name: 'workspace_root_location_set', arguments: resetInput })
        expect(resetResult.isError, JSON.stringify(resetResult)).not.toBe(true)
        const reset = WorkspaceBoundLocationSetResultSchema.parse(decodeMcpToolResult(resetResult)).value
        if (reset.evidence !== 'bound') throw new Error('Expected bound workspace root')
        expect(reset.binding.rootPolicyId).toBe(policy.rootPolicyId)
        expect(reset.binding.canonicalProjectRoot).toBe(policy.canonicalProjectRoot)
        expect(Number(reset.binding.rootPolicyRevision)).toBe(Number(policy.rootPolicyRevision) + 1)
        expect(reset.locationRevision).toBe(f.placement.locationRevision + 1)

        const input = { ...startInput(f, saved), expectedLocationRevision: reset.locationRevision }
        const reader = await f.base.access.issue({ name: 'Placement reader', audience: 'operator',
          grants: [{ actions: ['runs:read'], scope: { workspaceIds: [input.workspaceId] } }] })
        const denied = await f.connect(reader.token)
        expect(toolError(await denied.callTool({ name: 'run_start', arguments: input })))
          .toMatchObject({ error: { code: 'ACCESS_DENIED' } })
        const accepted = await f.start('mcp', input)
        const scope = { workspaceId: input.workspaceId, workflowId: input.workflowId,
          runId: accepted.run.id, nodeId: node.id }
        const read = async () => {
          const result = await f.client.callTool({ name: 'run_node_placement_get', arguments: scope })
          expect(result.isError).not.toBe(true)
          return RunPlacementGetResultSchema.parse(decodeMcpToolResult(result)).readback
        }
        const readback = await read()
        if (readback.evidence !== 'accepted') throw new Error('Expected accepted Run placement')
        const placement = readback.placement
        expect(placement.destination).toMatchObject({ rootPolicyId: reset.binding.rootPolicyId,
          rootPolicyRevision: reset.binding.rootPolicyRevision, locationRevision: String(reset.locationRevision),
          canonicalProjectRoot: reset.binding.canonicalProjectRoot })
        const rootsResult = await f.client.callTool({ name: 'source_root_list', arguments: {
          workspaceId: input.workspaceId,
        } })
        expect(rootsResult.isError).not.toBe(true)
        const roots = SourceRootListResultSchema.parse(decodeMcpToolResult(rootsResult)).items
        const root = roots.find(value => value.binding.rootId === f.placement.local.rootBinding!.rootId)!
        expect(root.selection).toMatchObject({ rootPolicyRevision: reset.binding.rootPolicyRevision,
          locationRevision: String(reset.locationRevision) })
        expect(root.binding.bindingRevision).toBeGreaterThan(f.placement.local.rootBinding!.bindingRevision)
        expect(placement.source).toMatchObject({ ...root.source, rootId: root.binding.rootId,
          bindingRevision: root.binding.bindingRevision })
        expect((await f.base.db.pool.query('select record from run_node_placements where run_id=$1 and node_id=$2',
          [accepted.run.id, node.id])).rows[0]?.record).toEqual(placement)
        const workflow = await f.client.callTool({ name: 'workflow_saved_get_v3', arguments: {
          workspaceId: input.workspaceId, workflowId: input.workflowId,
        } })
        expect(CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult(workflow)).version).toEqual(saved.version)

        const nextReset = await f.client.callTool({ name: 'workspace_root_location_set', arguments: {
          ...resetInput, commandId: randomUUID(), expectedLocationRevision: reset.locationRevision,
          expectedRootPolicyRevision: Number(reset.binding.rootPolicyRevision),
        } })
        expect(nextReset.isError).not.toBe(true)
        expect(await read()).toEqual(readback)
        expect(await f.start('mcp', input)).toEqual({ ...accepted, replayed: true })
      } finally { await f.close() }
    }, 120_000,
  )
})
