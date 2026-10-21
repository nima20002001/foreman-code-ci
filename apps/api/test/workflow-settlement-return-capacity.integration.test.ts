import assert from 'node:assert/strict'
import { MemorySaver } from '@langchain/langgraph'
import { describe, expect, it, vi } from 'vitest'
import { executeRepeatEngineStart, type RepeatEngineStartContext } from '../src/modules/runs/repeatStartComposition.js'
import { RunnerAdmission } from '../src/modules/runs/runnerAdmission.js'
import { assertWorkflowFailureReadback } from './helpers/workflowFailureReadback.js'
import {
  useSettlementFixtures, timeout, finish, handoffs, acceptedActivation, sourceAndRequest,
} from './helpers/workflowSettlementTestSupport.js'

// Native terminals and physical closure are explicit test inputs. Authenticated
// Save/MCP reads, canonical publication, SQL transactions and settlement execute.
vi.mock('../src/modules/interactions/repeatNativeSettlement.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  settleRepeatNativeExecutionLocked: vi.fn(async () => undefined),
  settleRepeatNativeExecutionWithProofLocked: vi.fn(async () => undefined),
}))

describe.skipIf(process.env.NIM2691_POSTGRES !== '1')('workflow settlement return capacity', () => {
  const withFixture = useSettlementFixtures()

  it.each([false, true])('budgets denial continuations and reuses their reservation on replay (restart: %s)', async (restart) => {
    await withFixture((graph) => ({ ...handoffs(5)(graph),
      edges: graph.edges.map((edge) => ({ ...edge, maxWorkHandoffsPerRun: 1 })),
    }), async (f) => {
      const { request } = await sourceAndRequest(f)
      const reviewer = await acceptedActivation(f, request.destinationActivationId, { outcome: 'succeeded', output: {
        routing: { kind: 'return', requestId: request.requestId, outcome: 'needs_changes' },
        data: { latestDeliverable: { revision: 1 }, remainingFindings: [{ id: 'revise' }] },
      } })
      const returned = await f.store.returnWork(reviewer.id)
      assert.ok(returned.value.continuationActivationId)
      const rework = await acceptedActivation(f, returned.value.continuationActivationId, finish(2))
      if (restart) await f.restart()
      const denied = await f.store.admitWorkRequest(rework.id, f.version.definition.edges[0]!.id)
      assert.equal(denied.kind, 'limit_reached')
      const continuationId = denied.notice.continuationActivationId
      expect((await f.store.admitWorkRequest(rework.id, f.version.definition.edges[0]!.id)).replayed).toBe(true)
      const continuation = await f.store.admitWorkActivation(continuationId, (nodeId) => f.candidate(nodeId))
      expect(continuation.reused).toBe(false)
      expect((await f.db.pool.query('select 1 from run_work_denials where run_id=$1', [f.run.id])).rowCount).toBe(1)
      expect((await f.db.pool.query('select 1 from run_work_activations where run_id=$1', [f.run.id])).rowCount).toBe(4)
    })
    await withFixture((graph) => ({ ...handoffs(3)(graph),
      edges: graph.edges.map((edge) => ({ ...edge, maxWorkHandoffsPerRun: 1 })),
    }), async (f) => {
      const { request } = await sourceAndRequest(f)
      const reviewer = await acceptedActivation(f, request.destinationActivationId, { outcome: 'succeeded', output: {
        routing: { kind: 'return', requestId: request.requestId, outcome: 'needs_changes' },
        data: { latestDeliverable: { revision: 1 }, remainingFindings: [{ id: 'revise' }] },
      } })
      const returned = await f.store.returnWork(reviewer.id)
      assert.ok(returned.value.continuationActivationId)
      const rework = await acceptedActivation(f, returned.value.continuationActivationId, finish(2))
      if (restart) await f.restart()
      await expect(f.store.admitWorkRequest(rework.id, f.version.definition.edges[0]!.id))
        .rejects.toMatchObject({ code: 'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED' })
      expect((await f.db.pool.query('select 1 from run_work_denials where run_id=$1', [f.run.id])).rowCount).toBe(0)
      expect((await f.db.pool.query('select 1 from run_work_activations where run_id=$1', [f.run.id])).rowCount).toBe(3)
    })
  }, timeout)

  it.each([false, true])('persists a review-return budget failure through engine composition (restart: %s)', async (restart) => {
    await withFixture(handoffs(2), async (f) => {
      const { source, request } = await sourceAndRequest(f)
      const reviewer = await acceptedActivation(f, request.destinationActivationId, { outcome: 'succeeded', output: {
        routing: { kind: 'return', requestId: request.requestId, outcome: 'needs_changes' },
        data: { latestDeliverable: { revision: 1 }, remainingFindings: [{ id: 'revise' }] },
      } })
      if (restart) await f.restart()
      const unexpectedLaunch = vi.fn(async () => { throw new Error('No native continuation may start beyond the budget') })
      const factory = {
        forOwner: () => f.store,
        preparePlacementExecution: unexpectedLaunch,
        reconcileWorkflowArtifacts: async () => undefined,
      } as unknown as RepeatEngineStartContext['factory']
      await expect(executeRepeatEngineStart({
        owner: f.owner,
        signal: new AbortController().signal,
        checkpointer: new MemorySaver(),
        admission: new RunnerAdmission(2),
        configuredParallelism: 2,
        runtimeRoot: f.db.directory,
        factory,
        native: { observeExact: unexpectedLaunch, assertResume: unexpectedLaunch, failIntervalCheck: unexpectedLaunch,
          abandonAttempt: unexpectedLaunch },
        workflows: { resolveNodeSkills: async (configuration) => configuration, referencesCreatedByExecution: async () => new Set<string>(), getAgentConfiguration: unexpectedLaunch },
        locations: { revalidateRunAuthorization: unexpectedLaunch, revalidateSnapshot: unexpectedLaunch },
        nativeBoundaryEvidence: unexpectedLaunch,
        lifecycle: f.lifecycle,
      })).rejects.toMatchObject({ code: 'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED' })
      expect(unexpectedLaunch).not.toHaveBeenCalled()
      expect(await f.readRun()).toMatchObject({ executionState: 'completed', outcome: 'failed', result: {
        outcome: 'failed', error: {
          code: 'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED',
          message: 'The Run reached its execution limit and cannot start more work.',
          retryable: false,
        },
      } })
      expect(f.failureSettlements).toBe(1)
      expect((await f.db.pool.query('select 1 from run_work_returns where run_id=$1', [f.run.id])).rowCount).toBe(0)
      expect((await f.db.pool.query('select 1 from run_work_activations where run_id=$1', [f.run.id])).rowCount).toBe(2)
      expect((await f.store.readExecution(reviewer.id)).execution.result).toEqual(reviewer.result)
      expect((await f.store.readExecution(source.id)).execution.result).toEqual(source.result)
      await f.restart()
      await assertWorkflowFailureReadback(f, 'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED')
    })
  }, timeout)

})
