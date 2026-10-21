import { setupMaterializationReservationCleanup } from './helpers/materializationReservationCleanup.js'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { releaseMaterializationClaim } from '../src/modules/sources/materialization.js'

let fixture: Awaited<ReturnType<typeof setupMaterializationReservationCleanup>> | undefined
afterEach(async () => { vi.useRealTimers(); await fixture?.close(); fixture = undefined })

function advanceCleanupRetry() {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 30_000)
}

it('keeps an offline uncertain reservation charged and retries automatically', async () => {
  fixture = await setupMaterializationReservationCleanup()
  const f = fixture
  const orphan = await f.orphan('preparing')
  f.offline()
  const report = vi.fn()
  expect(await f.cleanup.reconcile(report)).toBe(0)
  expect(report).toHaveBeenCalledTimes(1)
  expect((await f.pool.query('select state from source_storage_reservations where reservation_id=$1',
    [orphan.reservation.reservationId])).rows[0]!.state).toBe('uncertain')
  f.onlineWorker()
  expect(await f.cleanup.reconcile()).toBe(0)
  advanceCleanupRetry()
  expect(await f.cleanup.reconcile()).toBe(1)
}, 60_000)

it('keeps a reservation charged until the Worker confirms native closure', async () => {
  fixture = await setupMaterializationReservationCleanup()
  const f = fixture
  const orphan = await f.orphan('owned')
  f.nativeActive()
  const report = vi.fn()
  expect(await f.cleanup.reconcile(report)).toBe(0)
  expect(report).toHaveBeenCalledTimes(1)
  expect((await f.pool.query('select state from source_storage_reservations where reservation_id=$1',
    [orphan.reservation.reservationId])).rows[0]!.state).toBe('uncertain')
  expect(await readFile(join(f.namespace, orphan.receipt.materializationId, 'tree', 'source.txt'))).toBeDefined()
  f.nativeStopped()
  expect(await f.cleanup.reconcile()).toBe(0)
  advanceCleanupRetry()
  expect(await f.cleanup.reconcile()).toBe(1)
}, 60_000)

it('reclaims a released Worker copy when Main lost its preparation metadata', async () => {
  fixture = await setupMaterializationReservationCleanup()
  const f = fixture
  const orphan = await f.orphan('owned')
  await releaseMaterializationClaim(orphan.receipt, async () => 'released')
  expect(await f.cleanup.reconcile()).toBe(1)
  await expect(readFile(join(f.namespace, orphan.receipt.materializationId, 'tree', 'source.txt')))
    .rejects.toMatchObject({ code: 'ENOENT' })
  expect((await f.pool.query('select state from source_storage_reservations where reservation_id=$1',
    [orphan.reservation.reservationId])).rows[0]!.state).toBe('reclaimed')
}, 60_000)

it('retries an expired cleanup owner and persists its confirmed closure', async () => {
  fixture = await setupMaterializationReservationCleanup()
  const f = fixture
  const orphan = await f.orphan('owned')
  const reconciliationId = randomUUID()
  const owner = { identity: { operationId: orphan.reservation.ownerId, ownerPrincipalId: f.principal.id,
    expiresAt: new Date(Date.now() + 600_000).toISOString() }, root: f.root, source: f.root.source,
    attempt: orphan.attempt, record: null, physicalClosureConfirmed: false, preparationClosed: true }
  await f.pool.query(`insert into source_preparation_reconciliations
    (operation_id,reconciliation_id,workspace_id,principal_id,command_id,status,owner)
    values($1,$2,$3,$4,$5,'reconciling',$6::jsonb)`, [orphan.reservation.ownerId, reconciliationId,
    f.workspaceId, f.principal.id, randomUUID(), JSON.stringify(owner)])
  expect(await f.cleanup.reconcile()).toBe(0)
  expect(f.reclaim).not.toHaveBeenCalled()
  owner.identity.expiresAt = new Date(Date.now() - 1000).toISOString()
  await f.pool.query('update source_preparation_reconciliations set owner=$2::jsonb where operation_id=$1',
    [orphan.reservation.ownerId, JSON.stringify(owner)])
  expect(await f.cleanup.reconcile()).toBe(1)
  const closed = (await f.pool.query('select status,closure from source_preparation_reconciliations where operation_id=$1',
    [orphan.reservation.ownerId])).rows[0]!
  expect(closed).toMatchObject({ status: 'closed', closure: { reconciliationId,
    operationId: orphan.reservation.ownerId, admissionClosed: true, childrenClosed: true, claimReleased: true } })
}, 60_000)

it('keeps an unowned reservation charged until its original cleanup root is recovered', async () => {
  fixture = await setupMaterializationReservationCleanup()
  const f = fixture
  const orphan = await f.orphan('owned')
  await f.pool.query("update source_storage_reservations set record=record-'preparation' where reservation_id=$1",
    [orphan.reservation.reservationId])
  expect(await f.cleanup.reconcile()).toBe(0)
  expect(f.reclaim).not.toHaveBeenCalled()
  const retained = (await f.pool.query<{ state: string; reserved_bytes: string }>(
    'select state,reserved_bytes from source_storage_reservations where reservation_id=$1',
    [orphan.reservation.reservationId])).rows[0]!
  expect(retained).toEqual({ state: 'owned', reserved_bytes: String(orphan.reservation.reservedBytes) })
  expect(await readFile(join(f.namespace, orphan.receipt.materializationId, 'tree', 'source.txt'))).toBeDefined()
}, 60_000)
