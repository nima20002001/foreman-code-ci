import assert from 'node:assert/strict'
import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { finished, workHandoffFixture } from './helpers/workHandoffFixture.js'
import { workHandoffJoinDatabase } from './helpers/workHandoffJoinDatabase.js'

describe.skipIf(!postgresEnabled)('work join routing and rounds', () => {
  const database = workHandoffJoinDatabase()

  for (const recover of [false, true]) {
    it(`separates revised join inputs from the completed round (${recover ? 'restart after acceptance' : 'normal'})`, async () => {
      const db = database()
      const t = await workHandoffFixture(db.pool, `join-rework-${recover}`, (version) => ({ ...version,
        definition: { ...version.definition, handoffs: { contractVersion: 1 },
          executionPolicy: { maxParallelism: 3, maxNodeExecutions: 30 },
          nodes: [...version.definition.nodes, { id: 'reviewer', name: 'Reviewer', agentId: version.definition.nodes[3]!.agentId }],
          edges: [...version.definition.edges,
            { id: 'a-reviewer', kind: 'execution', source: version.entryNodeId, target: 'reviewer' }],
        } }))
      try {
        const runRound = async (activationId: string, revision: number) => {
          const a = await t.accept(activationId, finished(revision))
          const branches = []
          for (const edge of t.version.definition.edges.filter((item) => item.source === t.version.entryNodeId
            && item.id !== 'a-reviewer')) {
            const request = await t.store.admitWorkRequest(a.id, edge.id)
            assert.equal(request.kind, 'accepted')
            branches.push(await t.accept(request.request.destinationActivationId, finished(revision)))
          }
          if (recover) await t.restart()
          const joins = []
          for (const execution of branches) {
            const edge = t.version.definition.edges.find((item) => item.source === execution.workflowNodeId)!
            const joined = await t.store.admitWorkRequest(execution.id, edge.id)
            assert.equal(joined.kind, 'accepted')
            expect(joined.destinationReady).toBe(joins.length > 0)
            joins.push(joined)
          }
          expect(joins[0]!.request.destinationActivationId).toBe(joins[1]!.request.destinationActivationId)
          const joinId = joins[0]!.request.destinationActivationId
          const input = await t.input(joinId)
          assert.equal(input.work.kind, 'join')
          expect(input.work.sources.map((source) => source.request.requesterExecutionId).sort())
            .toEqual(branches.map((execution) => execution.id).sort())
          expect(input.work.sources.map((source) => source.acceptedSourceResult.output))
            .toEqual([finished(revision), finished(revision)])
          const replay = await t.store.admitWorkRequest(branches[0]!.id, joins[0]!.request.relationshipId)
          assert.equal(replay.kind, 'accepted')
          expect(replay.replayed).toBe(true)
          expect(replay.request.destinationActivationId).toBe(joinId)
          await t.accept(joinId, finished(revision))
          return { a, joinId }
        }
        const first = await runRound(await t.store.ensureWorkEntry(), 1)
        const reviewRequest = await t.store.admitWorkRequest(first.a.id, 'a-reviewer')
        assert.equal(reviewRequest.kind, 'accepted')
        const review = await t.accept(reviewRequest.request.destinationActivationId, {
          routing: { kind: 'return', requestId: reviewRequest.request.requestId, outcome: 'needs_changes' },
          data: { latestDeliverable: { revision: 1 }, remainingFindings: ['revise both inputs'] },
        })
        if (recover) await t.restart()
        const returned = await t.store.returnWork(review.id)
        assert.ok(returned.value.continuationActivationId)
        const second = await runRound(returned.value.continuationActivationId, 2)
        expect(second.joinId).not.toBe(first.joinId)
        expect((await db.pool.query('select activation_id from run_work_activations where run_id=$1 and cause_kind=$2',
          [t.run.id, 'join'])).rowCount).toBe(2)
      } finally { await t.close() }
    }, 120000)
  }
})
