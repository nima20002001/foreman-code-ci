import assert from 'node:assert/strict'
import { describe, expect, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { CANONICAL_RUN_GRAPH_MCP_TOOLS } from '@foreman-code/contracts/wave25'
import { hasWorkflowExecutionCapacityLocked } from '../src/modules/runs/workflowExecutionBudget.js'
import { graphRpcValue } from './eng04-graph-composition-fixture.js'
import { snapshot, success, timeout, useWorkflowJobBudgetFixture } from './helpers/workflowJobBudgetFixture.js'

vi.mock('../src/modules/interactions/repeatNativeSettlement.js', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  settleRepeatNativeExecutionLocked: vi.fn(async () => undefined),
  settleRepeatNativeExecutionWithProofLocked: vi.fn(async () => undefined),
}))

describe.skipIf(!postgresEnabled)('shared workflow Agent and Job budget', () => {
  const withJob = useWorkflowJobBudgetFixture()
  it.each(['preparing', 'admitted'] as const)('counts a %s Job before allowing a parallel Agent retry', async state => {
    await withJob((graph, job) => {
      assert.ok(graph.entryNodeId, 'Expected an Agent entry node')
      return { ...graph, nodes: [...graph.nodes, job],
        edges: [...graph.edges, { id: 'build-edge', kind: 'execution', source: graph.entryNodeId, target: job.id }],
        executionPolicy: { maxParallelism: 2, maxNodeExecutions: 3 },
      }
    }, async f => {
      const root = await f.store.admit({ nodeId: f.version.entryNodeId, occurrence: null }, () => f.candidate(f.version.entryNodeId))
      assert.equal(root.kind, 'admitted')
      if (root.kind !== 'admitted') throw new Error('Expected root admission')
      await f.finish(root.execution.id, success)
      await f.store.acceptTerminal(root.execution.id, () => { throw new Error('Unexpected root retry') })
      const ref = { nodeId: f.version.definition.nodes[1]!.id, occurrence: null }
      const branch = await f.store.admit(ref, () => f.candidate(ref.nodeId))
      assert.equal(branch.kind, 'admitted')
      if (branch.kind !== 'admitted') throw new Error('Expected branch admission')
      const preparation = await f.jobStore().prepareJob({ nodeId: f.node.id, occurrence: null })
      expect(preparation.kind).toBe('preparation')
      if (state === 'admitted') await f.admitJob()
      const capacity = () => f.owner.oneShotConnection().transaction(sql =>
        hasWorkflowExecutionCapacityLocked(sql, f.run.id, f.version))
      expect(await capacity()).toBe(false)
      await f.finish(branch.execution.id, { outcome: 'failed',
        error: { code: 'PROVIDER_FAILED', message: 'Failure at the last allowed attempt.', retryable: true } })
      f.setProductionRetryPolicy()
      const retry = vi.fn(() => f.candidate(ref.nodeId, 2))
      const accepted = await f.store.acceptTerminal(branch.execution.id, retry)
      expect(accepted).toMatchObject({ kind: 'accepted', resolution: { value: { resolution: 'failed' } } })
      if (accepted.kind !== 'accepted') throw new Error('Expected first terminal acceptance')
      expect(retry).not.toHaveBeenCalled()
      await f.restart()
      expect(await f.store.acceptTerminal(branch.execution.id, retry))
        .toEqual({ kind: 'resolved', resolution: accepted.resolution })
      expect(retry).not.toHaveBeenCalled()
      expect(await capacity()).toBe(false)
      const replay = await f.jobStore().prepareJob({ nodeId: f.node.id, occurrence: null })
      if (state === 'preparing') expect(replay).toEqual(preparation)
      else expect(replay.kind).toBe('admitted')
      const persisted = await snapshot(f)
      expect(persisted.state.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ state: expect.objectContaining({ workflowNodeId: ref.nodeId }),
          resolution: accepted.resolution.value }),
        expect.objectContaining({ state: expect.objectContaining({ workflowNodeId: f.node.id,
          lifecycle: state === 'preparing' ? 'starting' : 'queued' }) }),
      ]))
      const denied = await f.credential([{ actions: ['runs:read'],
        scope: { workspaceIds: [f.run.workspaceId], workflowIds: ['another-workflow'] } }])
      const blocked = await f.call(CANONICAL_RUN_GRAPH_MCP_TOOLS.snapshot,
        { protocolVersion: 1, scope: f.scope }, denied.token)
      expect(blocked.result?.isError).toBe(true)
      expect(graphRpcValue(blocked.result)).toMatchObject({ error: { code: 'GRAPH_READ_ACCESS_DENIED' } })
      expect(await snapshot(f)).toEqual(persisted)
      expect((await f.db.pool.query('select id from harness_executions where run_id=$1', [f.run.id])).rows).toHaveLength(2)
    })
  }, timeout)

})
