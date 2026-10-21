import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { sourceStorageCapacityFixture } from './helpers/sourceStorageCapacityFixture.js'
import { PostgresSourceReservations } from '../src/modules/sources/reservations.js'
import { withTransaction } from '../src/infrastructure/transaction.js'

it.each(['retained', 'uncertain'] as const)('charges %s bytes until reclamation', async state => {
  const database = await migratedDatabase()
  const reservations = new PostgresSourceReservations(async () => sourceStorageCapacityFixture())
  const scopeId = randomUUID()
  const request = (reservedBytes: number) => ({ scopeId, ownerKind: 'transfer' as const,
    ownerId: randomUUID(), reservedBytes })
  try {
    const retained = await withTransaction(database.pool, async sql => {
      const reservation = await reservations.reserve(sql, request(2 ** 30 - 1))
      await reservations.retain(sql, reservation, state)
      return reservation
    })
    const admitted = await withTransaction(database.pool, sql => reservations.reserve(sql, request(1)))
    await expect(withTransaction(database.pool, sql => reservations.reserve(sql, request(1))))
      .rejects.toMatchObject({ code: 'SOURCE_CAPACITY' })
    expect((await database.pool.query(`select reservation_id,state,reserved_bytes::text
      from source_storage_reservations where scope_id=$1 order by reserved_bytes desc`, [scopeId])).rows)
      .toEqual([
        { reservation_id: retained.reservationId, state, reserved_bytes: String(2 ** 30 - 1) },
        { reservation_id: admitted.reservationId, state: 'preparing', reserved_bytes: '1' },
      ])
    await withTransaction(database.pool, sql => reservations.reclaimed(sql, retained, async () => true))
    const next = await withTransaction(database.pool, sql => reservations.reserve(sql, request(1)))
    expect((await database.pool.query(`select state from source_storage_reservations
      where reservation_id=$1`, [next.reservationId])).rows).toEqual([{ state: 'preparing' }])
  } finally { await database.close() }
})
