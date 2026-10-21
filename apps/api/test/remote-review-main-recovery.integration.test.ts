import { describe, expect, it } from 'vitest'
import { receipts, retainedReviewRecovery, useRemoteReviewFixture } from './helpers/remoteReviewProductionCases.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { graphFixture, ownedGraph } from './eng04-graph-composition-fixture.js'
import { repeatNativePending, REPEAT_NATIVE_PENDING_MESSAGE } from '../src/modules/interactions/repeatNativeEvidence.js'
import { readPublicProjectionLocked } from '../src/modules/run-graph/compactSnapshot.js'
import { graphSourceDigest, openRunGraphPublication } from '../src/modules/run-graph/publication.js'

it('keeps pending native settlement retryable and rolls back the incomplete Run publication', async () => {
  const db = await currentDatabase()
  try {
    const fixture = await graphFixture(db, { form: 'single', qualifiedReads: true })
    try {
      const before = await fixture.repeat.snapshot(fixture.writer.principal, fixture.readRequest)
      await expect(ownedGraph(db, fixture, owner => owner.oneShotConnection().transaction(async sql => {
        const publication = await openRunGraphPublication(sql, fixture.scope, readPublicProjectionLocked)
        await publication.repeatChange({
          evidence: { sourceKind: 'run', sourceId: 'pending-native-completion', sourceRevision: '1' },
          sourceDigest: graphSourceDigest('pending-native-completion'),
          effect: null,
        }, owner, async transaction => {
          await transaction.query(`update runs set execution_state='running',
            record=jsonb_set(record,'{executionState}','"running"') where id=$1`, [fixture.run.id])
          repeatNativePending()
        }, async () => [{ type: 'repeat.run.state', state: before.state.run }])
      }))).rejects.toMatchObject({
        name: 'DomainError', code: 'REPEAT_CLEANUP_PENDING', message: REPEAT_NATIVE_PENDING_MESSAGE, status: 409,
      })
      expect(await fixture.repeat.snapshot(fixture.writer.principal, fixture.readRequest)).toEqual(before)
    } finally {
      await fixture.app.close()
    }
  } finally {
    await db.close()
  }
}, 60_000)

describe('production remote review after graceful Main recovery', () => {
  const withRemoteReviewFixture = useRemoteReviewFixture()
  it('continues the original retained review with the Worker alive', async () => {
    await withRemoteReviewFixture(async fixture => {
      const recovered = await retainedReviewRecovery(fixture, 'graceful')
      const settled = await fixture.details(recovered.runId)
      expect(settled.run).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
      expect(settled.cleanupPending).not.toBe(true)
      const cleanup = (await fixture.db.pool.query<{ pending: boolean }>(
        'select pending from run_cleanup_intents where run_id=$1', [recovered.runId],
      )).rows[0]!
      expect(cleanup.pending).toBe(false)
      const reviewer = (await receipts(fixture, recovered.runId)).find(receipt => receipt.retainedReviewer)
      expect(reviewer).toBeDefined()
      expect(reviewer!.phase).toBe('confirmed_terminal')
      expect(reviewer!.stopFence).toBe(true)
      expect(reviewer!.terminal).toMatchObject({ kind: 'cancelled', closureEvidenceDigest: expect.any(String) })
      expect(reviewer!.terminal!.closureEvidenceDigest).toMatch(/^[a-f0-9]{64}$/)
      const launches = fixture.registry.snapshot().launches
        .filter(launch => recovered.launchIds.includes(launch.launchId))
      expect(launches).toHaveLength(recovered.launchIds.length)
      for (const launch of launches) {
        expect(launch.lifecycle).toBe('closed')
        expect(launch.closureEvidence).toBeDefined()
      }
      expect((await fixture.executions(recovered.runId)).every(execution => execution.state === 'completed')).toBe(true)
    })
  }, 120_000)
})
