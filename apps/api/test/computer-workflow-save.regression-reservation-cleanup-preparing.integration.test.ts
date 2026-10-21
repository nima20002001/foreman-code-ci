import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { remoteReviewProduction, waitForRemoteReview } from './helpers/remoteReviewProduction.js'
import { completeReservationCleanupWorkflow } from './helpers/reservationCleanupWorkflow.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { MaterializationReservationCleanup } from '../src/modules/sources/materializationReservationCleanup.js'
import type { SourceReservation } from '../src/modules/sources/reservations.js'

it('defers reservation cleanup without waiting on a Run that is preparing native execution', async () => {
  const fixture = await remoteReviewProduction({ workflow: 'single', parallelSetup: true })
  try {
    const workingDirectory = join(fixture.directory, 'worker-runtime')
    // Hold native preparation without blocking background inventory and profile checks.
    await fixture.provider.blockModels({ workingDirectory })
    let runId: string
    try {
      const started = await fixture.start()
      runId = started.run.id
      await waitForRemoteReview(() => fixture.provider.calls(), calls => calls.some(call =>
        call.method === 'model/list' && typeof call.workingDirectory === 'string'
        && call.workingDirectory.startsWith(`${workingDirectory}/`)), 'workflow native preparation entry')
      const reservation = await waitForRemoteReview(async () => {
        const result = await fixture.db.pool.query<{ record: SourceReservation }>(
          `select s.record from source_storage_reservations s
           join execution_dispatch_intents i on i.operation_id=s.owner_id
           where i.run_id=$1 and s.owner_kind='materialization' and s.state<>'reclaimed'`, [runId])
        return result.rows[0]?.record
      }, value => value !== undefined, 'the active workflow source reservation')
      if (!reservation) throw new Error('The workflow has no source reservation.')
      const owner = await RunOwnership.acquire(fixture.db.pool, runId, () => {})
      try { expect(owner).toBeUndefined() } finally { await owner?.release() }
      const transaction = await fixture.db.pool.connect()
      try {
        await transaction.query('begin')
        await transaction.query('select id from runs where id=$1 for update', [runId])
        const reclaim = vi.fn(async () => ({ closures: [] }))
        const cleanup = new MaterializationReservationCleanup(fixture.db.pool, reclaim)
        expect(await cleanup.reconcile()).toBe(0)
        expect(reclaim).not.toHaveBeenCalled()
        const retained = await transaction.query<{ state: string; record: SourceReservation }>(
          'select state,record from source_storage_reservations where reservation_id=$1', [reservation.reservationId])
        expect(retained.rows[0]?.state).not.toBe('reclaimed')
        expect(retained.rows[0]?.record.reclamation).toBeUndefined()
      } finally {
        try { await transaction.query('rollback') } finally { transaction.release() }
      }
    } finally {
      await fixture.provider.releaseModels()
    }
    const completed = await completeReservationCleanupWorkflow(fixture, runId)
    expect(completed.run.outcome).toBe('succeeded')
  } finally {
    await fixture.close()
  }
}, 240_000)
