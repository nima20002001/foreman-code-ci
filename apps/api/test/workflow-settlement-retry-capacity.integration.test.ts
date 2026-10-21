import assert from 'node:assert/strict'
import { MemorySaver } from '@langchain/langgraph'
import { describe, expect, it, vi } from 'vitest'
import type { HarnessExecution } from '@foreman-code/contracts'
import {
  useSettlementFixtures, timeout, finish, failed, handoffs, acceptedActivation, runtime,
} from './helpers/workflowSettlementTestSupport.js'

// Native terminals and physical closure are explicit test inputs. Authenticated
// Save/MCP reads, canonical publication, SQL transactions and settlement execute.
vi.mock('../src/modules/interactions/repeatNativeSettlement.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  settleRepeatNativeExecutionLocked: vi.fn(async () => undefined),
  settleRepeatNativeExecutionWithProofLocked: vi.fn(async () => undefined),
}))

describe.skipIf(process.env.NIM2691_POSTGRES !== '1')('workflow settlement retry capacity', () => {
  const withFixture = useSettlementFixtures()

  it.each([false, true])('fails downstream admission after an early retry uses the last slot (restart: %s)', async (restart) => {
    for (const workHandoffs of [false, true]) {
      await withFixture((graph) => ({ ...graph,
        ...(workHandoffs ? { handoffs: { contractVersion: 1 } } : {}),
        executionPolicy: { maxParallelism: 1, maxNodeExecutions: 2 },
      }), async (f) => {
        const saver = new MemorySaver()
        let launched = 0
        const observe = async (execution: HarnessExecution) => {
          if (execution.state === 'completed') return
          launched++
          await f.finish(execution.id, execution.attempt === 1 ? failed(true) : finish())
        }
        if (workHandoffs) {
          const entry = await f.store.ensureWorkEntry()
          const first = await f.store.admitWorkActivation(entry, (nodeId) => f.candidate(nodeId))
          await f.finish(first.execution.id, failed(true))
          const retry = await f.store.acceptWorkTerminal(first.execution.id,
            (attempt) => f.candidate(first.execution.workflowNodeId, attempt))
          assert.equal(retry.kind, 'retry')
          await f.finish(retry.execution.id, finish())
          await f.accept(retry.execution.id)
        } else {
          const ref = { nodeId: f.version.entryNodeId, occurrence: null }
          const first = await f.store.admit(ref, () => f.candidate(ref.nodeId))
          assert.equal(first.kind, 'admitted')
          await f.finish(first.execution.id, failed(true))
          const retry = await f.store.acceptTerminal(first.execution.id, (attempt) => f.candidate(ref.nodeId, attempt))
          assert.equal(retry.kind, 'retry')
          await f.finish(retry.execution.id, { outcome: 'succeeded', output: { revision: 2 } })
          await f.store.acceptTerminal(retry.execution.id, () => { throw new Error('Success cannot retry') })
        }
        if (restart) await f.restart()
        const execute = runtime(f, observe, saver)
        await expect(execute()).rejects.toMatchObject({ code: workHandoffs
          ? 'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED' : 'REPEAT_EXECUTION_BUDGET_EXHAUSTED' })
        expect(launched).toBe(0)
        expect(await f.readRun()).toMatchObject({ executionState: 'completed', outcome: 'failed' })
        expect((await f.db.pool.query('select 1 from harness_executions where run_id=$1', [f.run.id])).rowCount).toBe(2)
        expect((await f.db.pool.query('select 1 from run_work_requests where run_id=$1', [f.run.id])).rowCount).toBe(0)
      })
    }
  }, timeout)

  it.each([false, true])('protects queued activation capacity from a technical retry (restart: %s)', async (restart) => {
    await withFixture((graph) => {
      const [a, b, c] = graph.nodes
      assert.ok(a && b && c)
      return { ...handoffs(3)(graph), nodes: [a, b, c], edges: [
        { id: 'first', kind: 'execution', source: a.id, target: b.id },
        { id: 'second', kind: 'execution', source: a.id, target: c.id },
      ] }
    }, async (f) => {
      const source = await acceptedActivation(f, await f.store.ensureWorkEntry(), finish())
      const first = await f.store.admitWorkRequest(source.id, 'first')
      const second = await f.store.admitWorkRequest(source.id, 'second')
      assert.equal(first.kind, 'accepted')
      assert.equal(second.kind, 'accepted')
      const branch = await f.store.admitWorkActivation(first.request.destinationActivationId, (nodeId) => f.candidate(nodeId))
      await f.finish(branch.execution.id, failed(true))
      if (restart) await f.restart()
      f.setProductionRetryPolicy()
      await expect(f.store.acceptWorkTerminal(branch.execution.id,
        () => { throw new Error('Retry must not consume the queued sibling reservation') }))
        .rejects.toMatchObject({ code: 'WORK_SELECTED_EXECUTION_FAILED' })
      const sibling = await f.store.admitWorkActivation(second.request.destinationActivationId, (nodeId) => f.candidate(nodeId))
      expect(sibling.reused).toBe(false)
      expect((await f.store.admitWorkRequest(source.id, 'second')).replayed).toBe(true)
      expect((await f.store.admitWorkActivation(second.request.destinationActivationId,
        () => { throw new Error('Replay must not reserve another slot') })).reused).toBe(true)
      expect((await f.db.pool.query('select 1 from harness_executions where run_id=$1', [f.run.id])).rowCount).toBe(3)
    }, 'parallel')
  }, timeout)

})
