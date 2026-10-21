import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { setupMaterializationReservationCleanup } from './helpers/materializationReservationCleanup.js'

let fixture: Awaited<ReturnType<typeof setupMaterializationReservationCleanup>> | undefined
afterEach(async () => { await fixture?.close(); fixture = undefined })

it('settles a fenced cleanup while another caller holds the original reconciliation command lock', async () => {
  fixture = await setupMaterializationReservationCleanup()
  const f = fixture
  const orphan = await f.orphan('owned')
  const reconciliationId = randomUUID()
  const commandId = randomUUID()
  const operationId = orphan.reservation.ownerId
  const owner = {
    identity: { operationId, ownerPrincipalId: f.principal.id,
      expiresAt: new Date(Date.now() - 1000).toISOString() },
    root: f.root, source: f.root.source, attempt: orphan.attempt, record: null,
    physicalClosureConfirmed: false, preparationClosed: true,
  }
  await f.pool.query(`insert into source_preparation_reconciliations
    (operation_id,reconciliation_id,workspace_id,principal_id,command_id,status,owner)
    values($1,$2,$3,$4,$5,'reconciling',$6::jsonb)`,
  [operationId, reconciliationId, f.workspaceId, f.principal.id, commandId, JSON.stringify(owner)])
  const reclaim = f.reclaim.getMockImplementation()!
  f.reclaim.mockImplementationOnce(grant => withTransaction(f.pool, async sql => {
    await sql.query('select pg_advisory_xact_lock(hashtext($1))',
      [`command:${f.principal.id}:source.preparation.reconcile:${commandId}`])
    return reclaim(grant)
  }))
  expect(await f.cleanup.reconcile()).toBe(1)
  expect((await f.pool.query('select state from source_storage_reservations where reservation_id=$1',
    [orphan.reservation.reservationId])).rows[0]).toEqual({ state: 'reclaimed' })
  expect((await f.pool.query('select status,closure from source_preparation_reconciliations where operation_id=$1',
    [operationId])).rows[0]).toMatchObject({ status: 'closed', closure: {
    reconciliationId, operationId, admissionClosed: true, childrenClosed: true, claimReleased: true,
  } })
  await expect(readFile(join(f.namespace, orphan.receipt.materializationId, 'tree', 'source.txt')))
    .rejects.toMatchObject({ code: 'ENOENT' })
}, 60_000)
