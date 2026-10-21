import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { PostgresSourceReservations, type SourceReservation } from '../src/modules/sources/reservations.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { sourceStorageCapacityFixture } from './helpers/sourceStorageCapacityFixture.js'

let database: Awaited<ReturnType<typeof migratedDatabase>> | undefined
afterEach(async () => {
  await database?.close()
  database = undefined
})

function lowMemoryCapacity() {
  return sourceStorageCapacityFixture({ availableMemoryBytes: 1400 * 2 ** 20 })
}

it.each(['capture', 'transfer', 'materialization'] as const)(
  'persists the first low-memory %s reservation and admits more work after preparation closes', async ownerKind => {
    database = await migratedDatabase()
    const pool = database.pool
    const reservations = new PostgresSourceReservations(async () => lowMemoryCapacity())
    const request = { scopeId: randomUUID(), ownerKind, ownerId: randomUUID(), reservedBytes: 4096 }
    const first = await withTransaction(pool, sql => reservations.reserve(sql, request))
    expect(first).toMatchObject({ ...request, reservationId: expect.any(String) })
    const stored = await pool.query<{ record: SourceReservation; state: string }>(
      'select record,state from source_storage_reservations where reservation_id=$1', [first.reservationId])
    expect(stored.rows).toEqual([{ record: first, state: 'preparing' }])
    const restarted = new PostgresSourceReservations(async () => lowMemoryCapacity())
    expect(await withTransaction(pool, sql => restarted.reserve(sql, request))).toEqual(first)
    await expect(withTransaction(pool, sql => restarted.reserve(sql, { ...request, ownerId: randomUUID() })))
      .rejects.toMatchObject({ code: 'SOURCE_CAPACITY', details: { exhausted: expect.arrayContaining(['preparations']) } })
    await withTransaction(pool, sql => restarted.retain(sql, first, 'retained'))
    await expect(withTransaction(pool, sql => restarted.reserve(sql, { ...request, ownerId: randomUUID() })))
      .resolves.toMatchObject({ scopeId: request.scopeId, ownerKind })
  },
)

it.each(['owned', 'uncertain'] as const)(
  'keeps memory limits while a low-memory materialization is %s', async state => {
    database = await migratedDatabase()
    const pool = database.pool
    const reservations = new PostgresSourceReservations(async () => lowMemoryCapacity())
    const request = { scopeId: randomUUID(), ownerKind: 'materialization' as const,
      ownerId: randomUUID(), reservedBytes: 4096 }
    const first = await withTransaction(pool, sql => reservations.reserve(sql, request))
    await withTransaction(pool, sql => reservations.retain(sql, first, state))
    await expect(withTransaction(pool, sql => reservations.reserve(sql, { ...request, ownerId: randomUUID() })))
      .rejects.toMatchObject({ code: 'SOURCE_CAPACITY', details: {
        exhausted: ['preparations'], usage: { preparing: 0, activeMaterializations: 1 },
      } })
    await expect(withTransaction(pool, sql => reservations.reserve(sql,
      { ...request, ownerKind: 'capture', ownerId: randomUUID() })))
      .rejects.toMatchObject({ code: 'SOURCE_CAPACITY', details: { exhausted: ['preparations'] } })
    await expect(withTransaction(pool, sql => reservations.reserve(sql,
      { ...request, scopeId: randomUUID(), ownerId: randomUUID() })))
      .resolves.toMatchObject({ ownerKind: 'materialization' })
  },
)

it('serializes competing first preparations on an idle low-memory scope', async () => {
  database = await migratedDatabase()
  const pool = database.pool
  const reservations = new PostgresSourceReservations(async () => lowMemoryCapacity())
  const scopeId = randomUUID()
  const reserve = () => withTransaction(pool, sql => reservations.reserve(sql,
    { scopeId, ownerKind: 'capture', ownerId: randomUUID(), reservedBytes: 4096 }))
  const results = await Promise.allSettled([reserve(), reserve()])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.find(result => result.status === 'rejected'))
    .toMatchObject({ status: 'rejected', reason: { code: 'SOURCE_CAPACITY' } })
  const stored = await pool.query<{ state: string; reserved_bytes: string }>(
    'select state,reserved_bytes from source_storage_reservations where scope_id=$1', [scopeId])
  expect(stored.rows).toEqual([{ state: 'preparing', reserved_bytes: '4096' }])
})
