import assert from 'node:assert/strict'
import { describe, expect, it, vi } from 'vitest'
import { CANONICAL_RUN_GRAPH_MCP_TOOLS, CanonicalRunGraphCurrentSchema } from '@foreman-code/contracts/wave25'
import { graphRpcValue } from './eng04-graph-composition-fixture.js'
import {
  useSettlementFixtures, timeout, finish, handoffs, acceptedActivation, sourceAndRequest, runtime,
} from './helpers/workflowSettlementTestSupport.js'

// Native terminals and physical closure are explicit test inputs. Authenticated
// Save/MCP reads, canonical publication, SQL transactions and settlement execute.
vi.mock('../src/modules/interactions/repeatNativeSettlement.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  settleRepeatNativeExecutionLocked: vi.fn(async () => undefined),
  settleRepeatNativeExecutionWithProofLocked: vi.fn(async () => undefined),
}))

describe.skipIf(process.env.NIM2691_POSTGRES !== '1')('workflow settlement reviews', () => {
  const withFixture = useSettlementFixtures()

  it.each([false, true])('aggregates all terminal review revisions beyond node count (restart: %s)', async (restart) => {
    await withFixture((graph) => {
      const [a, b, c] = graph.nodes
      assert.ok(a && b && c)
      return { ...handoffs(9)(graph), nodes: [a, b, c], edges: [
        { id: 'review', kind: 'execution', source: a.id, target: b.id },
        { id: 'publish', kind: 'execution', source: a.id, target: c.id },
      ] }
    }, async (f) => {
      let activationId = await f.store.ensureWorkEntry()
      const terminalIds: string[] = []
      for (let revision = 1; revision <= 3; revision++) {
        const source = await acceptedActivation(f, activationId, finish(revision))
        const review = await f.store.admitWorkRequest(source.id, 'review')
        const publish = await f.store.admitWorkRequest(source.id, 'publish')
        assert.equal(review.kind, 'accepted')
        assert.equal(publish.kind, 'accepted')
        const output = await acceptedActivation(f, publish.request.destinationActivationId, finish(revision))
        terminalIds.push(output.id)
        const outcome = revision < 3 ? 'needs_changes' : 'accepted'
        const reviewer = await acceptedActivation(f, review.request.destinationActivationId,
          { outcome: 'succeeded', output: { routing: { kind: 'return', requestId: review.request.requestId, outcome },
            data: { latestDeliverable: { revision }, remainingFindings: outcome === 'accepted' ? [] : [{ id: 'revise' }] } } })
        if (restart) await f.restart() // Accepted terminal exists, return decision does not.
        const returned = await f.store.returnWork(reviewer.id)
        if (revision < 3) {
          assert.ok(returned.value.continuationActivationId)
          activationId = returned.value.continuationActivationId
        } else terminalIds.push(reviewer.id)
      }
      if (restart) await f.restart() // All accepted terminals exist, Run completion does not.
      expect(await f.store.completeWorkRun()).toBe('completed')
      const completed = await f.readRun()
      expect(completed).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
      const outputs = (completed.result?.output as { outputs: Array<{ executionId: string }> }).outputs
      expect(outputs).toHaveLength(4)
      expect(outputs.map((output) => output.executionId).sort()).toEqual(terminalIds.sort())
      const bytes = structuredClone(completed)
      await f.restart()
      expect(await f.store.completeWorkRun()).toBe('completed')
      expect(await f.readRun()).toEqual(bytes)
      expect((await f.db.pool.query("select 1 from run_repeat_effects where run_id=$1 and effect_kind='run.complete'",
        [f.run.id])).rowCount).toBe(1)
      const read = await f.call(CANONICAL_RUN_GRAPH_MCP_TOOLS.current, { protocolVersion: 1, scope: f.scope })
      expect(read.result?.isError, JSON.stringify(read)).not.toBe(true)
      const persisted = CanonicalRunGraphCurrentSchema.parse(graphRpcValue(read.result))
      expect(persisted.state.run).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
      expect(persisted.state.executions).toHaveLength(9)
      const denied = await f.credential([{ actions: ['workflows:read'], scope: { workspaceIds: [f.run.workspaceId] } }])
      const denial = await f.call(CANONICAL_RUN_GRAPH_MCP_TOOLS.current, { protocolVersion: 1, scope: f.scope }, denied.token)
      expect(denial.result?.isError).toBe(true)
    }, 'parallel')
  }, timeout)

  it.each([false, true])('persists a direction wait for accepted review findings (restart after acceptance: %s)', async (restart) => {
    await withFixture(handoffs(2), async (f) => {
      const { request } = await sourceAndRequest(f)
      const reviewer = await acceptedActivation(f, request.destinationActivationId, { outcome: 'succeeded', output: {
        routing: { kind: 'return', requestId: request.requestId, outcome: 'accepted' },
        data: { latestDeliverable: { revision: 1 }, remainingFindings: [{ id: 'open-finding' }] },
      } })
      if (restart) await f.restart()
      const execute = runtime(f, async (execution) => { assert.equal(execution.state, 'completed') })
      await execute()
      expect(await f.readRun()).toMatchObject({ executionState: 'waiting', outcome: 'pending' })
      expect(await f.store.completeWorkRun()).toBe('needs_direction')
      await f.restart()
      await execute()
      expect(await f.store.completeWorkRun()).toBe('needs_direction')
      expect(await f.readRun()).toMatchObject({ executionState: 'waiting', outcome: 'pending' })
      const returned = await f.store.returnWork(reviewer.id)
      expect(returned).toMatchObject({ replayed: true, value: { requestId: request.requestId, outcome: 'accepted',
        remainingFindings: [{ id: 'open-finding' }] } })
      expect((await f.db.pool.query('select 1 from run_work_returns where run_id=$1', [f.run.id])).rowCount).toBe(1)
      expect((await f.db.pool.query('select 1 from run_work_direction_waits where run_id=$1', [f.run.id])).rowCount).toBe(1)
      expect((await f.db.pool.query("select 1 from run_activity where run_id=$1 and kind='work_direction_wait'",
        [f.run.id])).rowCount).toBe(1)
      expect((await f.db.pool.query('select 1 from harness_executions where run_id=$1', [f.run.id])).rowCount).toBe(2)
      expect(f.failureSettlements).toBe(0)
    })
  }, timeout)

  it.each([false, true])('rejects another branch\'s return before accepting its result (restart: %s)', async (restart) => {
    await withFixture(handoffs(8), async (f) => {
      const source = await acceptedActivation(f, await f.store.ensureWorkEntry(), finish())
      const edges = f.version.definition.edges.filter((edge) => edge.kind === 'execution'
        && edge.source === f.version.entryNodeId)
      const left = await f.store.admitWorkRequest(source.id, edges[0]!.id)
      const right = await f.store.admitWorkRequest(source.id, edges[1]!.id)
      assert.equal(left.kind, 'accepted')
      assert.equal(right.kind, 'accepted')
      const admitted = await f.store.admitWorkActivation(right.request.destinationActivationId,
        (nodeId) => f.candidate(nodeId))
      await f.finish(admitted.execution.id, { outcome: 'succeeded', output: {
        routing: { kind: 'return', requestId: left.request.requestId, outcome: 'accepted' },
        data: { latestDeliverable: { revision: 1 }, remainingFindings: [] },
      } })
      if (restart) await f.restart()
      await expect(f.accept(admitted.execution.id)).rejects.toMatchObject({ issues: [{
        code: 'custom', path: ['routing', 'requestId'],
        message: 'Return requestId must match an open received request. '
          + `Valid open request IDs: ${JSON.stringify([right.request.requestId])}`,
      }] })
      expect((await f.store.readExecution(admitted.execution.id)).accepted).toBe(false)
      expect((await f.db.pool.query('select execution_id from run_work_results where execution_id=$1',
        [admitted.execution.id])).rowCount).toBe(0)
      expect((await f.db.pool.query('select return_id from run_work_returns where run_id=$1',
        [f.run.id])).rowCount).toBe(0)
    }, 'parallel')
  }, timeout)
})
