import assert from 'node:assert/strict'
import { describe, expect, it } from 'vitest'
import { trustedWorkNoticePrompt } from '../src/modules/runs/workHandoffNotice.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { finished, workHandoffFixture } from './helpers/workHandoffFixture.js'
import { sharedWorkHandoffExhaustionDatabase } from './helpers/workHandoffExhaustionDatabase.js'

describe.skipIf(!postgresEnabled)('exhausted saved work routes: automatic alternatives', () => {
  const database = sharedWorkHandoffExhaustionDatabase()
  for (const recover of [false, true]) {
    it(`describes automatic notice alternatives without named choices (${recover ? 'restart after acceptance' : 'normal'})`, async () => {
      const db = database()
      const t = await workHandoffFixture(db.pool, `automatic-alternative-${recover}`, (version) => ({ ...version,
        definition: { ...version.definition, handoffs: { contractVersion: 1 },
          executionPolicy: { maxParallelism: 2, maxNodeExecutions: 20 },
          nodes: version.definition.nodes.map((node) => {
            const configured = { ...node }
            delete configured.join
            return configured
          }),
          edges: [
            { id: 'a-b', kind: 'execution', source: version.entryNodeId,
              target: version.definition.nodes[1]!.id, maxWorkHandoffsPerRun: 1 },
            { id: 'a-c', kind: 'execution', source: version.entryNodeId, target: version.definition.nodes[2]!.id },
          ],
        } }))
      try {
        const a = await t.accept(await t.store.ensureWorkEntry(), finished(1))
        const ab = await t.store.admitWorkRequest(a.id, 'a-b')
        assert.equal(ab.kind, 'accepted')
        const b = await t.accept(ab.request.destinationActivationId, {
          routing: { kind: 'return', requestId: ab.request.requestId, outcome: 'needs_changes' },
          data: { latestDeliverable: { revision: 1 }, remainingFindings: ['revise'] },
        })
        const returned = await t.store.returnWork(b.id)
        assert.ok(returned.value.continuationActivationId)
        const revised = await t.accept(returned.value.continuationActivationId, finished(2))
        if (recover) await t.restart()
        const denied = await t.store.admitWorkRequest(revised.id, 'a-b')
        assert.equal(denied.kind, 'limit_reached')
        if (recover) await t.restart()
        const input = await t.input(denied.notice.continuationActivationId)
        assert.equal(input.work.kind, 'limit_denial')
        expect(input.work.notice.alternatives).toEqual([expect.objectContaining({ relationshipId: 'a-c', outcomes: [] })])
        expect(trustedWorkNoticePrompt(input)).toContain('a clean finish follows saved outgoing connections')
        const final = await t.accept(denied.notice.continuationActivationId, finished(3))
        if (recover) await t.restart()
        const blocked = await t.store.admitWorkRequest(final.id, 'a-b')
        assert.equal(blocked.kind, 'needs_direction')
        const allowed = await t.store.admitWorkRequest(final.id, 'a-c')
        assert.equal(allowed.kind, 'accepted')
        expect(allowed.destinationReady).toBe(true)
      } finally { await t.close() }
    }, 120000)
  }
})
