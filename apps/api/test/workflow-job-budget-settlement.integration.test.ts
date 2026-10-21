import { describe, expect, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { assertWorkflowFailureReadback } from './helpers/workflowFailureReadback.js'
import { requireJobPreparationDeadline } from '../src/modules/jobs/preparationDeadline.js'
import type { WorkflowJobDriver } from '../src/modules/jobs/workflowRuntimePorts.js'
import { runtime, sink, timeout, useWorkflowJobBudgetFixture } from './helpers/workflowJobBudgetFixture.js'

vi.mock('../src/modules/interactions/repeatNativeSettlement.js', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  settleRepeatNativeExecutionLocked: vi.fn(async () => undefined),
  settleRepeatNativeExecutionWithProofLocked: vi.fn(async () => undefined),
}))

describe.skipIf(!postgresEnabled)('workflow Job budget failure settlement', () => {
  const withJob = useWorkflowJobBudgetFixture()

  it('settles budget exhaustion before Job admission and retains its cause on HTTP and MCP', async () => {
    await withJob(sink, async f => {
      const prepare = vi.fn(f.driver.prepare)
      await expect(runtime(f, { ...f.driver, prepare })).rejects.toMatchObject({ code: 'WORKFLOW_EXECUTION_BUDGET_EXHAUSTED' })
      expect(prepare).not.toHaveBeenCalled()
      expect((await f.db.pool.query('select slot_id from workflow_job_preparations where run_id=$1', [f.run.id])).rows).toEqual([])
      await assertWorkflowFailureReadback(f, 'WORKFLOW_EXECUTION_BUDGET_EXHAUSTED')
      const terminal = await f.readRun()
      await f.restart()
      await expect(f.jobStore().prepareJob({ nodeId: f.node.id, occurrence: null })).rejects.toMatchObject({ code: 'GRAPH_TERMINAL_CONFLICT' })
      expect(await f.readRun()).toEqual(terminal)
      expect((await f.db.pool.query('select id from harness_executions where run_id=$1', [f.run.id])).rows).toHaveLength(2)
    })
  }, timeout)

  it('settles an expired original preparation without launching a Job or resetting the deadline', async () => {
    await withJob((graph, job) => ({ ...sink(graph, job), executionPolicy: { maxParallelism: 1, maxNodeExecutions: 3 } }), async f => {
      const prepare: WorkflowJobDriver['prepare'] = async preparation => {
        const budget = f.definition.spec.policy.preparationTimeoutMs
        await f.db.pool.query('update workflow_job_preparations set created_at=$2 where run_id=$1',
          [f.run.id, new Date(Date.now() - budget - 1000)])
        await f.owner.oneShotConnection().transaction(sql =>
          requireJobPreparationDeadline(sql, 'workflow', preparation.executionId, budget))
        throw new Error('Expired preparation was accepted')
      }
      await expect(runtime(f, { ...f.driver, prepare })).rejects.toMatchObject({ code: 'JOB_PREPARATION_TIMEOUT' })
      await assertWorkflowFailureReadback(f, 'JOB_PREPARATION_TIMEOUT')
      const terminal = await f.readRun()
      await f.restart()
      await expect(f.jobStore().prepareJob({ nodeId: f.node.id, occurrence: null })).rejects.toMatchObject({ code: 'GRAPH_TERMINAL_CONFLICT' })
      expect(await f.readRun()).toEqual(terminal)
      expect((await f.db.pool.query('select id from job_executions where workspace_id=$1', [f.run.workspaceId])).rows).toEqual([])
    })
  }, timeout)
})
