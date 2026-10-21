import assert from 'node:assert/strict'
import { describe, expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { finished, workHandoffFixture } from './helpers/workHandoffFixture.js'

describe.skipIf(!postgresEnabled)('interval checks with work handoffs', () => {
  it('queues work returned to a node only after that node\'s running check finishes', async () => {
    const db = await currentDatabase()
    const t = await workHandoffFixture(db.pool, 'interval-return', (version) => ({ ...version,
      definition: { ...version.definition, handoffs: { contractVersion: 1 },
        executionPolicy: { maxParallelism: 2, maxNodeExecutions: 20 },
        nodes: version.definition.nodes.map((node, index) => {
          const configured = { ...node }
          delete configured.join
          return index === 0 ? { ...configured, interval: { everySeconds: 10 } } : configured
        }),
        edges: [{ id: 'a-b', kind: 'execution', source: version.definition.nodes[0]!.id, target: version.definition.nodes[1]!.id }],
      } }))
    try {
      const watcher = t.version.definition.nodes[0]!
      assert.ok(watcher.kind !== 'job')
      const a = await t.accept(await t.store.ensureWorkEntry(), finished(1))
      const ab = await t.store.admitWorkRequest(a.id, 'a-b')
      assert.equal(ab.kind, 'accepted')
      // A has no open work while B works, so its interval check starts.
      const admission = await t.store.admitTick(watcher.id, () => HarnessExecutionSchema.parse({ id: 'interval-check-1',
        runId: t.run.id, workflowNodeId: watcher.id, agentId: watcher.agentId,
        agentConfigurationVersionId: t.version.agentConfigurationVersionIds[watcher.agentId],
        attempt: 1, input: {}, state: 'queued', createdAt: a.createdAt }), null)
      assert.equal(admission.kind, 'admitted')
      const b = await t.accept(ab.request.destinationActivationId, {
        routing: { kind: 'return', requestId: ab.request.requestId, outcome: 'needs_changes' },
        data: { latestDeliverable: { revision: 1 }, remainingFindings: ['revise'] },
      })
      const continuation = (await t.store.returnWork(b.id)).value.continuationActivationId
      assert.ok(continuation)
      await expect(t.queue(continuation)).rejects.toMatchObject({ code: 'INTERVAL_CHECK_RUNNING' })
      expect((await db.pool.query('select 1 from harness_executions where run_id=$1 and work_activation_id=$2',
        [t.run.id, continuation])).rowCount).toBe(0)

      await db.pool.query(`update harness_executions set record=record||jsonb_build_object('state','completed',
        'finishedAt',$2::text,'result',jsonb_build_object('outcome','succeeded')) where id=$1`,
      [admission.execution.id, new Date().toISOString()])
      const queued = await t.queue(continuation)
      expect(queued).toMatchObject({ reused: false, execution: { workflowNodeId: watcher.id, state: 'queued' } })
    } finally { await t.close(); await db.close() }
  }, 120_000)
})
