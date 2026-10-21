import assert from 'node:assert/strict'
import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { finished, workHandoffFixture } from './helpers/workHandoffFixture.js'
import { workHandoffJoinDatabase } from './helpers/workHandoffJoinDatabase.js'

describe.skipIf(!postgresEnabled)('work join routing and rounds', () => {
  const database = workHandoffJoinDatabase()

  for (const recover of [false, true]) {
    for (const branch of [0, 1]) {
      it(`runs the all-join from choice branch ${branch} (${recover ? 'restart after acceptance' : 'normal'})`, async () => {
        const db = database()
        const t = await workHandoffFixture(db.pool, `choice-join-${branch}-${recover}`, (version) => ({ ...version,
          definition: { ...version.definition, handoffs: { contractVersion: 1 },
            executionPolicy: { maxParallelism: 2, maxNodeExecutions: 20 },
            nodes: version.definition.nodes.map((node, index) => index === 0 ? { ...node,
              choice: { outcomes: version.definition.edges.filter((edge) => edge.source === node.id)
                .map((edge, choice) => ({ outcome: `branch_${choice}`,
                  target: { kind: 'edge' as const, relationshipId: edge.id } })) },
            } : node),
          } }))
        try {
          const entry = await t.accept(await t.store.ensureWorkEntry(), {
            ...finished(1), routing: { kind: 'request', outcome: `branch_${branch}` },
          })
          const request = await t.store.admitWorkRequest(entry.id)
          assert.equal(request.kind, 'accepted')
          const selected = await t.accept(request.request.destinationActivationId, finished(1))
          if (recover) await t.restart()
          const route = t.version.definition.edges.find((edge) => edge.source === selected.workflowNodeId)!
          const joined = await t.store.admitWorkRequest(selected.id, route.id)
          assert.equal(joined.kind, 'accepted')
          expect(joined.destinationReady).toBe(true)
          if (recover) await t.restart()
          const input = await t.input(joined.request.destinationActivationId)
          assert.equal(input.work.kind, 'join')
          expect(input.work.sources.map((source) => source.request.requesterExecutionId)).toEqual([selected.id])
          const replay = await t.store.admitWorkRequest(selected.id, route.id)
          assert.equal(replay.kind, 'accepted')
          expect(replay.request).toEqual(joined.request)
          await t.accept(joined.request.destinationActivationId, finished(2))
          const states = (await db.pool.query<{ state: string }>(
            'select state from run_work_activations where run_id=$1', [t.run.id])).rows
          expect(states.every((row) => row.state === 'completed')).toBe(true)
          expect((await db.pool.query('select request_id from run_work_requests where run_id=$1',
            [t.run.id])).rowCount).toBe(2)
        } finally { await t.close() }
      }, 120000)
    }

  }
})
