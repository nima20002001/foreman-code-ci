import assert from 'node:assert/strict'
import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { finished, workHandoffFixture } from './helpers/workHandoffFixture.js'
import { workHandoffJoinDatabase } from './helpers/workHandoffJoinDatabase.js'

describe.skipIf(!postgresEnabled)('work join routing and rounds', () => {
  const database = workHandoffJoinDatabase()

  for (const recover of [false, true]) {
    it(`releases a waiting join when another branch closes (${recover ? 'restart after acceptance' : 'normal'})`, async () => {
      const db = database()
      const t = await workHandoffFixture(db.pool, `join-close-${recover}`, (version) => ({ ...version,
        definition: { ...version.definition, handoffs: { contractVersion: 1 },
          executionPolicy: { maxParallelism: 2, maxNodeExecutions: 20 },
          nodes: version.definition.nodes.map((node, index) => index === 2 ? { ...node,
            choice: { outcomes: [
              { outcome: 'go', target: { kind: 'edge' as const, relationshipId: version.definition.edges[3]!.id } },
              { outcome: 'skip', target: { kind: 'branch_end' as const } },
            ] },
          } : node),
        } }))
      try {
        const a = await t.accept(await t.store.ensureWorkEntry(), finished(1))
        const left = await t.store.admitWorkRequest(a.id, t.version.definition.edges[0]!.id)
        const right = await t.store.admitWorkRequest(a.id, t.version.definition.edges[1]!.id)
        assert.equal(left.kind, 'accepted')
        assert.equal(right.kind, 'accepted')
        const b = await t.accept(left.request.destinationActivationId, finished(1))
        const joined = await t.store.admitWorkRequest(b.id, t.version.definition.edges[2]!.id)
        assert.equal(joined.kind, 'accepted')
        expect(joined.destinationReady).toBe(false)
        const closed = await t.accept(right.request.destinationActivationId, {
          ...finished(1), routing: { kind: 'finish', outcome: 'skip' },
        })
        if (recover) await t.restart()
        expect(await t.route(closed)(right.request.destinationActivationId)).toEqual([joined.request.destinationActivationId])
        if (recover) await t.restart()
        expect(await t.route(closed)(right.request.destinationActivationId)).toEqual([joined.request.destinationActivationId])
        const input = await t.input(joined.request.destinationActivationId)
        assert.equal(input.work.kind, 'join')
        expect(input.work.sources.map((source) => source.request.requesterExecutionId)).toEqual([b.id])
        expect(await t.store.resolveWaitingWorkJoins(left.request.destinationActivationId)).toEqual([])
      } finally { await t.close() }
    }, 120000)

    it(`keeps an unselected join closed (${recover ? 'restart after acceptance' : 'normal'})`, async () => {
      const db = database()
      const t = await workHandoffFixture(db.pool, `join-skipped-${recover}`, (version) => ({ ...version,
        definition: { ...version.definition, handoffs: { contractVersion: 1 },
          nodes: version.definition.nodes.map((node, index) => index === 0 ? { ...node,
            choice: { outcomes: [
              ...version.definition.edges.filter((edge) => edge.source === node.id).map((edge, choice) => ({
                outcome: `branch_${choice}`, target: { kind: 'edge' as const, relationshipId: edge.id },
              })),
              { outcome: 'skip', target: { kind: 'branch_end' as const } },
            ] },
          } : node),
        } }))
      try {
        await t.accept(await t.store.ensureWorkEntry(), { ...finished(1), routing: { kind: 'finish', outcome: 'skip' } })
        if (recover) await t.restart()
        expect(await t.store.resolveWaitingWorkJoins(await t.store.ensureWorkEntry())).toEqual([])
        expect((await db.pool.query('select required from (select work_join_required_edges($1,$1,$2) as required) q',
          [t.run.id, t.version.definition.nodes[3]!.id])).rows[0]?.required).toEqual([])
        expect((await db.pool.query('select activation_id from run_work_activations where run_id=$1 and cause_kind=$2',
          [t.run.id, 'join'])).rowCount).toBe(0)
      } finally { await t.close() }
    }, 120000)

  }
})
