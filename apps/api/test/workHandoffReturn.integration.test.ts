import assert from 'node:assert/strict'
import { describe, expect, it } from 'vitest'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { finished, workHandoffFixture } from './helpers/workHandoffFixture.js'

describe.skipIf(!postgresEnabled)('nested work returns', () => {
  for (const recover of [false, true]) {
    it(`returns to the original caller after review rework (${recover ? 'restart after acceptance' : 'normal'})`, async () => {
      const db = await currentDatabase()
      const t = await workHandoffFixture(db.pool, `nested-return-${recover}`, (version) => ({ ...version,
        definition: { ...version.definition, handoffs: { contractVersion: 1 },
          executionPolicy: { maxParallelism: 2, maxNodeExecutions: 20 },
          nodes: version.definition.nodes.map((node) => {
            const configured = { ...node }
            delete configured.join
            return configured
          }),
          edges: [
            { id: 'a-b', kind: 'execution', source: version.definition.nodes[0]!.id, target: version.definition.nodes[1]!.id },
            { id: 'b-c', kind: 'execution', source: version.definition.nodes[1]!.id, target: version.definition.nodes[2]!.id },
          ],
        } }))
      try {
        const a = await t.accept(await t.store.ensureWorkEntry(), finished(1))
        const ab = await t.store.admitWorkRequest(a.id, 'a-b')
        assert.equal(ab.kind, 'accepted')
        const b = await t.accept(ab.request.destinationActivationId, finished(1))
        const bc = await t.store.admitWorkRequest(b.id, 'b-c')
        assert.equal(bc.kind, 'accepted')
        const c = await t.accept(bc.request.destinationActivationId, {
          routing: { kind: 'return', requestId: bc.request.requestId, outcome: 'needs_changes' },
          data: { latestDeliverable: { revision: 1 }, remainingFindings: ['revise'] },
        })
        if (recover) await t.restart()
        const review = await t.store.returnWork(c.id)
        assert.ok(review.value.continuationActivationId)
        if (recover) await t.restart()
        const input = await t.input(review.value.continuationActivationId)
        expect(input.work.kind).toBe('work_return')
        expect(input.parentRequest?.requestId).toBe(ab.request.requestId)
        expect((await t.store.returnWork(c.id)).value).toEqual(review.value)
        const revised = await t.accept(review.value.continuationActivationId, {
          routing: { kind: 'return', requestId: ab.request.requestId, outcome: 'accepted' },
          data: { latestDeliverable: { revision: 2 }, remainingFindings: [] },
        })
        if (recover) await t.restart()
        const returned = await t.store.returnWork(revised.id)
        expect(returned.value.requestId).toBe(ab.request.requestId)
        expect(returned.value.requesterActivationId).toBe(ab.request.requesterActivationId)
        expect(returned.value.latestDeliverable).toEqual({ revision: 2 })
        expect((await t.store.returnWork(revised.id)).replayed).toBe(true)
        expect((await db.pool.query('select return_id from run_work_returns where run_id=$1 and request_id=$2',
          [t.run.id, ab.request.requestId])).rowCount).toBe(1)
      } finally { await t.close(); await db.close() }
    }, 120000)
    it(`keeps the caller through a handoff-limit continuation (${recover ? 'restart after acceptance' : 'normal'})`, async () => {
      const db = await currentDatabase()
      const t = await workHandoffFixture(db.pool, `denied-return-${recover}`, (version) => ({ ...version,
        definition: { ...version.definition, handoffs: { contractVersion: 1 },
          executionPolicy: { maxParallelism: 2, maxNodeExecutions: 20 },
          nodes: version.definition.nodes.map((node) => {
            const configured = { ...node }
            delete configured.join
            return configured
          }),
          edges: [
            { id: 'a-b', kind: 'execution', source: version.definition.nodes[0]!.id, target: version.definition.nodes[1]!.id },
            { id: 'b-c', kind: 'execution', source: version.definition.nodes[1]!.id,
              target: version.definition.nodes[2]!.id, maxWorkHandoffsPerRun: 1 },
          ],
        } }))
      try {
        const a = await t.accept(await t.store.ensureWorkEntry(), finished(1))
        const ab = await t.store.admitWorkRequest(a.id, 'a-b')
        assert.equal(ab.kind, 'accepted')
        const b = await t.accept(ab.request.destinationActivationId, finished(1))
        const bc = await t.store.admitWorkRequest(b.id, 'b-c')
        assert.equal(bc.kind, 'accepted')
        const c = await t.accept(bc.request.destinationActivationId, {
          routing: { kind: 'return', requestId: bc.request.requestId, outcome: 'needs_changes' },
          data: { latestDeliverable: { revision: 1 }, remainingFindings: ['revise'] },
        })
        const review = await t.store.returnWork(c.id)
        assert.ok(review.value.continuationActivationId)
        const revised = await t.accept(review.value.continuationActivationId, finished(2))
        if (recover) await t.restart()
        const denied = await t.store.admitWorkRequest(revised.id, 'b-c')
        assert.equal(denied.kind, 'limit_reached')
        if (recover) await t.restart()
        const input = await t.input(denied.notice.continuationActivationId)
        expect(input.work.kind).toBe('limit_denial')
        expect(input.parentRequest?.requestId).toBe(ab.request.requestId)
        const final = await t.accept(denied.notice.continuationActivationId, {
          routing: { kind: 'return', requestId: ab.request.requestId, outcome: 'accepted' },
          data: { latestDeliverable: { revision: 2 }, remainingFindings: [] },
        })
        if (recover) await t.restart()
        expect((await t.store.returnWork(final.id)).value.requestId).toBe(ab.request.requestId)
        expect((await t.store.returnWork(final.id)).replayed).toBe(true)
      } finally { await t.close(); await db.close() }
    }, 120000)
  }
})
