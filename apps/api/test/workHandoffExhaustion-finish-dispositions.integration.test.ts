import assert from 'node:assert/strict'
import { describe, expect, it } from 'vitest'
import { trustedWorkNoticePrompt } from '../src/modules/runs/workHandoffNotice.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { finished, workHandoffFixture } from './helpers/workHandoffFixture.js'
import { sharedWorkHandoffExhaustionDatabase } from './helpers/workHandoffExhaustionDatabase.js'

describe.skipIf(!postgresEnabled)('exhausted saved work routes: finish dispositions', () => {
  const database = sharedWorkHandoffExhaustionDatabase()
  for (const recover of [false, true]) {
    for (const disposition of ['automatic_finish', 'named_finish', 'finish_with_findings'] as Array<
      'automatic_finish' | 'named_finish' | 'finish_with_findings'
    >) {
      it(`records ${disposition} after the notice (${recover ? 'restart after acceptance' : 'normal'})`, async () => {
        const db = database()
        const named = disposition === 'named_finish'
        const t = await workHandoffFixture(db.pool, `exhaust-${disposition}-${recover}`, (version) => ({ ...version,
          definition: { ...version.definition, handoffs: { contractVersion: 1 },
            executionPolicy: { maxParallelism: 1, maxNodeExecutions: 20 },
            nodes: version.definition.nodes.map((node, index) => {
              const configured = { ...node,
                ...(named && index === 0 ? { choice: { outcomes: [
                  { outcome: 'review', target: { kind: 'edge' as const, relationshipId: 'a-b' } },
                ] } } : {}),
              }
              delete configured.join
              return configured
            }),
            edges: [{ id: 'a-b', kind: 'execution', source: version.entryNodeId,
              target: version.definition.nodes[1]!.id, maxWorkHandoffsPerRun: 1 }],
          } }))
        const finish = (revision: number) => ({ ...finished(revision),
          routing: named ? { kind: 'finish' as const, outcome: 'review' } : { kind: 'finish' as const } })
        try {
          const first = await t.accept(await t.store.ensureWorkEntry(), finish(1))
          const request = await t.store.admitWorkRequest(first.id, 'a-b')
          assert.equal(request.kind, 'accepted')
          const review = await t.accept(request.request.destinationActivationId, {
            routing: { kind: 'return', requestId: request.request.requestId, outcome: 'needs_changes' },
            data: { latestDeliverable: { revision: 1 }, remainingFindings: ['revise'] },
          })
          const returned = await t.store.returnWork(review.id)
          assert.ok(returned.value.continuationActivationId)
          const revised = await t.accept(returned.value.continuationActivationId, finish(2))
          if (recover) await t.restart()
          const denial = await t.store.admitWorkRequest(revised.id, 'a-b')
          assert.equal(denial.kind, 'limit_reached')
          expect((await t.store.admitWorkRequest(revised.id, 'a-b')).kind).toBe('limit_reached')
          const input = await t.input(denial.notice.continuationActivationId)
          const prompt = trustedWorkNoticePrompt(input)
          expect(prompt).toContain('maximum number of work handoffs')
          expect(prompt).toContain('automatic')
          const last = await t.accept(denial.notice.continuationActivationId,
            disposition === 'finish_with_findings' ? {
              routing: { kind: 'finish' },
              data: { latestDeliverable: { revision: 3 }, remainingFindings: ['cannot review further'] },
            } : finish(3))
          const before = (await db.pool.query('select activation_id from run_work_activations where run_id=$1',
            [t.run.id])).rowCount
          if (recover) await t.restart()
          const action = t.route(last)
          expect(await action(denial.notice.continuationActivationId)).toEqual([])
          if (recover) await t.restart()
          expect(await t.route(last)(denial.notice.continuationActivationId)).toEqual([])
          const unresolved = (await db.pool.query<{ reason: string; relationship_id: string | null }>(
            'select reason,relationship_id from run_work_unresolved where run_id=$1', [t.run.id])).rows
          expect(unresolved).toEqual([{ reason: disposition === 'finish_with_findings'
            ? 'finish_with_findings' : 'repeated_exhausted_route',
            relationship_id: disposition === 'finish_with_findings' ? null : 'a-b' }])
          if (disposition !== 'finish_with_findings') {
            const direction = await t.store.admitWorkRequest(last.id, 'a-b')
            assert.equal(direction.kind, 'needs_direction')
            expect(direction.replayed).toBe(true)
          }
          expect((await db.pool.query('select activation_id from run_work_activations where run_id=$1',
            [t.run.id])).rowCount).toBe(before)
          expect((await db.pool.query('select denial_id from run_work_denials where run_id=$1',
            [t.run.id])).rowCount).toBe(1)
          expect((await db.pool.query('select used from run_work_connection_usage where run_id=$1',
            [t.run.id])).rows).toEqual([{ used: 1 }])
          expect((await db.pool.query('select delivery_state from run_work_notices where run_id=$1',
            [t.run.id])).rows).toEqual([{ delivery_state: 'delivered' }, { delivery_state: 'delivered' }])
        } finally { await t.close() }
      }, 120000)
    }
  }
})
