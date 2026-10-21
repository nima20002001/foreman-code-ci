import assert from 'node:assert/strict'
import { describe, expect, it, vi } from 'vitest'
import type { ExecutionResult } from '@foreman-code/contracts'
import { assertWorkflowFailureReadback } from './helpers/workflowFailureReadback.js'
import {
  useSettlementFixtures, timeout, failed, handoffs, runtime,
} from './helpers/workflowSettlementTestSupport.js'

// Native terminals and physical closure are explicit test inputs. Authenticated
// Save/MCP reads, canonical publication, SQL transactions and settlement execute.
vi.mock('../src/modules/interactions/repeatNativeSettlement.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  settleRepeatNativeExecutionLocked: vi.fn(async () => undefined),
  settleRepeatNativeExecutionWithProofLocked: vi.fn(async () => undefined),
}))

describe.skipIf(process.env.NIM2691_POSTGRES !== '1')('workflow settlement failures', () => {
  const withFixture = useSettlementFixtures()

  it.each([false, true])('settles a nonretryable handoff failure once (restart before acceptance: %s)', async (restart) => {
    await withFixture(handoffs(2), async (f) => {
      let launches = 0
      if (restart) {
        const entry = await f.store.ensureWorkEntry()
        const admitted = await f.store.admitWorkActivation(entry, (nodeId) => f.candidate(nodeId))
        await f.finish(admitted.execution.id, failed(false))
        await f.restart()
      }
      const execute = runtime(f, async (execution) => {
        if (execution.state !== 'completed') { launches++; await f.finish(execution.id, failed(false)) }
      })
      await expect(execute()).rejects.toMatchObject({ code: 'WORK_SELECTED_EXECUTION_FAILED' })
      expect(await f.readRun()).toMatchObject({ executionState: 'completed', outcome: 'failed' })
      expect(f.failureSettlements).toBe(1)
      expect(launches).toBe(restart ? 0 : 1)
      await f.restart()
      await expect(execute()).rejects.toBeInstanceOf(Error)
      await expect(execute()).rejects.toBeInstanceOf(Error)
      expect(f.failureSettlements).toBe(1)
      expect(launches).toBe(restart ? 0 : 1)
      expect((await f.db.pool.query('select 1 from harness_executions where run_id=$1', [f.run.id])).rowCount).toBe(1)
    })
  }, timeout)

  it.each([false, true])('settles an exhausted technical retry once (restart at final terminal: %s)', async (restart) => {
    await withFixture(handoffs(3), async (f) => {
      let launches = 0
      if (restart) {
        const entry = await f.store.ensureWorkEntry()
        const first = await f.store.admitWorkActivation(entry, (nodeId) => f.candidate(nodeId))
        await f.finish(first.execution.id, failed(true))
        const retry = await f.store.acceptWorkTerminal(first.execution.id,
          (attempt) => f.candidate(first.execution.workflowNodeId, attempt))
        assert.equal(retry.kind, 'retry')
        await f.finish(retry.execution.id, failed(true))
        await f.restart()
      }
      const execute = runtime(f, async (execution) => {
        if (execution.state !== 'completed') { launches++; await f.finish(execution.id, failed(true)) }
      })
      await expect(execute()).rejects.toMatchObject({ code: 'WORK_SELECTED_EXECUTION_FAILED' })
      expect(await f.readRun()).toMatchObject({ executionState: 'completed', outcome: 'failed' })
      await f.restart()
      await expect(execute()).rejects.toBeInstanceOf(Error)
      expect(f.failureSettlements).toBe(1)
      expect(launches).toBe(restart ? 0 : 2)
      expect((await f.db.pool.query('select 1 from harness_executions where run_id=$1', [f.run.id])).rowCount).toBe(2)
    })
  }, timeout)

  it('retains the first specific failure across interrupted cleanup and owner restart', async () => {
    await withFixture(handoffs(2), async f => {
      const failure: ExecutionResult = { outcome: 'failed', error: {
        code: 'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED', message: 'The Run has no execution capacity for rework.', retryable: false,
      } }
      await f.lifecycle.requestCleanup(failure)
      await f.lifecycle.requestCleanup({ outcome: 'failed', error: {
        code: 'CLEANUP_RETRY', message: 'A later cleanup error.', retryable: false,
      } })
      expect(await f.readRun()).toMatchObject({ executionState: 'running', outcome: 'pending' })
      await f.restart()
      await f.lifecycle.settleRun(false, true)
      await f.lifecycle.finishCleanup()
      expect((await f.readRun()).result).toEqual(failure)
      await assertWorkflowFailureReadback(f, 'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED')
      await f.lifecycle.settleRun(false, false)
      expect((await f.readRun()).result).toEqual(failure)
    })
  }, timeout)

})
