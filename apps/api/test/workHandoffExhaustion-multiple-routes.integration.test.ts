import assert from 'node:assert/strict'
import { describe, expect, it } from 'vitest'
import { makeCurrentWorkflowFixture, WorkActivationInputSchema } from '@foreman-code/contracts/wave25'
import { runWorkHandoffWithRestart, workHandoffRuntimeFixture } from './helpers/workHandoffRuntimeFixture.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { finished } from './helpers/workHandoffFixture.js'

describe.skipIf(!postgresEnabled)('exhausted saved work routes: multiple-routes', () => {
  for (const recover of [false, true]) it(`preserves both exhausted routes (${recover ? 'restart after acceptance' : 'normal'})`, async () => {
    const definition = makeCurrentWorkflowFixture(`multiple-exhausted-${recover}`, 'parallel')
    const sourceId = definition.version.entryNodeId
    const targets = definition.version.definition.nodes.slice(1, 3)
    definition.version.definition.handoffs = { contractVersion: 1 }
    definition.version.definition.executionPolicy = { maxParallelism: 2, maxNodeExecutions: 20 }
    definition.version.definition.nodes = definition.version.definition.nodes.map((node) => {
      const configured = { ...node }
      delete configured.join
      return configured
    })
    definition.version.definition.edges = targets.map((node, index) => ({ id: `a-${index + 1}`,
      kind: 'execution', source: sourceId, target: node.id, maxWorkHandoffsPerRun: 1 }))
    const f = await workHandoffRuntimeFixture(definition, (nodeId, request) => {
      const { work } = WorkActivationInputSchema.parse(request.input)
      if (nodeId !== sourceId) {
        assert.equal(work.kind, 'work_request')
        const outcome = nodeId === targets[0]!.id ? 'needs_changes' : 'accepted'
        return { routing: { kind: 'return', requestId: work.request.requestId, outcome },
          data: { latestDeliverable: { revision: 1 }, remainingFindings: outcome === 'needs_changes' ? ['revise'] : [] } }
      }
      if (work.kind === 'limit_denial' && work.denial.relationshipId === 'a-1') {
        return { routing: { kind: 'finish' },
          data: { latestDeliverable: { revision: 3 }, remainingFindings: ['review unavailable'] } }
      }
      if (work.kind === 'entry') return finished(1)
      if (work.kind === 'work_return') return finished(2)
      return finished(3)
    })
    try {
      const runtime = await runWorkHandoffWithRestart(f, recover, (execution) => {
        const { work } = WorkActivationInputSchema.parse(execution.input)
        return work.kind === 'limit_denial' && work.denial.relationshipId === 'a-2'
      })
      expect(await runtime.runs.get(f.f.run.id)).toMatchObject({ executionState: 'waiting', outcome: 'pending' })
      const causes = (await f.db.pool.query<{ relationship_id: string; execution_id: string }>(
        `select relationship_id,execution_id from run_work_unresolved
         where run_id=$1 and relationship_id is not null order by relationship_id`, [f.f.run.id])).rows
      expect(causes.map((row) => row.relationship_id)).toEqual(['a-1', 'a-2'])
      expect(new Set(causes.map((row) => row.execution_id)).size).toBe(1)
      expect((await f.db.pool.query('select used from run_work_connection_usage where run_id=$1', [f.f.run.id])).rows)
        .toEqual([{ used: 1 }, { used: 1 }])
      const before = { ...f.provider.counts }
      await runtime.engine.start(f.f.run.id)
      expect(f.provider.counts).toEqual(before)
      expect((await f.db.pool.query('select run_id from run_work_direction_waits where run_id=$1',
        [f.f.run.id])).rowCount).toBe(1)
    } finally { await f.close() }
  }, 120000)
})
