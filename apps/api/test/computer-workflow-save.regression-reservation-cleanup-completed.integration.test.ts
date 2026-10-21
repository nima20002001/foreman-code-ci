import { expect, it, vi } from 'vitest'
import { remoteReviewProduction, waitForRemoteReview } from './helpers/remoteReviewProduction.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { MaterializationReservationCleanup } from '../src/modules/sources/materializationReservationCleanup.js'
import type { SourceReservation } from '../src/modules/sources/reservations.js'

it('defers reservation cleanup without waiting on a locked completed Run', async () => {
  // Payloads stay unchanged here; startup discovery and profile qualification still run.
  const fixture = await remoteReviewProduction({
    workflow: 'single', installationRefreshIntervalMs: 60_000, parallelSetup: true,
  })
  try {
    const started = await fixture.start()
    const runId = started.run.id
    const completed = await waitForRemoteReview(async () => {
      const details = await fixture.details(runId)
      if (details.run.executionState !== 'completed' || details.cleanupPending) {
        await fixture.reconcile()
        return fixture.details(runId)
      }
      return details
    }, value => value.run.executionState === 'completed' && !value.cleanupPending,
    'workflow completion after cleanup deferral')
    expect(completed.run.outcome).toBe('succeeded')
    const retainedOwner = await waitForRemoteReview(
      () => RunOwnership.acquire(fixture.db.pool, runId, () => {}),
      value => value !== undefined, 'completed Run ownership release')
    if (!retainedOwner) throw new Error('The completed Run owner did not release its lock.')
    const releaseRetained = retainedOwner.retain(() => {})
    await retainedOwner.release()
    try {
      // Keep native review ownership until the first acquisition observes it.
      const acquireOwner = async () => {
        const owner = await RunOwnership.acquire(fixture.db.pool, runId, () => {})
        await releaseRetained()
        return owner
      }
      const owner = await waitForRemoteReview(acquireOwner, value => value !== undefined,
        'retained completed Run ownership release')
      try { expect(owner).toBeDefined() } finally { await owner?.release() }
    } finally {
      await releaseRetained()
      await retainedOwner.release()
    }
    const reservation = (await fixture.db.pool.query<{ record: SourceReservation; state: string }>(
      `select s.record,s.state from source_storage_reservations s
       join execution_dispatch_intents i on i.operation_id=s.owner_id
       where i.run_id=$1 and s.owner_kind='materialization' and s.state<>'reclaimed'`, [runId])).rows[0]
    expect(reservation).toBeDefined()
    if (!reservation) throw new Error('The completed workflow has no retained source reservation.')
    await fixture.db.pool.query("update source_storage_reservations set state='uncertain' where reservation_id=$1",
      [reservation.record.reservationId])
    try {
      await withTransaction(fixture.db.pool, async transaction => {
        await transaction.query('select id from runs where id=$1 for update', [runId])
        const reclaim = vi.fn(async () => ({ closures: [] }))
        const cleanup = new MaterializationReservationCleanup(fixture.db.pool, reclaim)
        const startedAt = Date.now()
        expect(await cleanup.reconcile()).toBe(0)
        expect(reclaim).not.toHaveBeenCalled()
        const retained = await transaction.query<{ state: string; record: SourceReservation }>(
          'select state,record from source_storage_reservations where reservation_id=$1',
          [reservation.record.reservationId])
        expect(retained.rows[0]).toEqual({ state: 'uncertain', record: {
          ...reservation.record,
          cleanupRetry: { failures: reservation.record.cleanupRetry?.failures ?? 0, nextAttemptAt: expect.any(String) },
        } })
        const deferredAt = Date.parse(retained.rows[0]!.record.cleanupRetry!.nextAttemptAt)
        expect(deferredAt).toBeGreaterThanOrEqual(startedAt)
        expect(deferredAt).toBeLessThanOrEqual(Date.now())
      })
    } finally {
      await fixture.db.pool.query('update source_storage_reservations set state=$2 where reservation_id=$1',
        [reservation.record.reservationId, reservation.state])
    }
  } finally {
    await fixture.close()
  }
}, 240_000)
