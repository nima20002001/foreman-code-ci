import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { PostgresSourceReservations, type SourceReservation } from './reservations.js'
import { sourceStorageCapacityFixture } from '../../../test/helpers/sourceStorageCapacityFixture.js'

const idleUsage = {
  bytes: '0', verification_bytes: '0', pending_bytes: '0', preparing: '0',
  materializations: '0', verification_materializations: '0',
  retained_bytes: '0', verification_retained_bytes: '0',
}

function reservationSql(ownerKind: SourceReservation['ownerKind'], usage = idleUsage): GraphSqlClient {
  const empty = { rows: [], rowCount: 0 }
  const query = vi.fn().mockResolvedValue(empty)
    .mockResolvedValueOnce(empty)
    .mockResolvedValueOnce(empty)
  if (ownerKind === 'materialization') query.mockResolvedValueOnce(empty)
  query.mockResolvedValueOnce({ rows: [usage], rowCount: 1 })
  return { query } as unknown as GraphSqlClient
}

it.each(['capture', 'transfer', 'materialization'] as const)(
  'admits the first %s reservation on an idle low-memory scope', async ownerKind => {
    const request = { scopeId: randomUUID(), ownerKind, ownerId: randomUUID(), reservedBytes: 4096 }
    const capacity = sourceStorageCapacityFixture({ availableMemoryBytes: 1400 * 2 ** 20 })
    await expect(new PostgresSourceReservations().reserve(reservationSql(ownerKind), request, { capacity }))
      .resolves.toMatchObject({ ...request, reservationId: expect.any(String), storageCapacity: capacity })
  },
)

it('admits the first reservation even when the available memory measurement is zero', async () => {
  const request = { scopeId: randomUUID(), ownerKind: 'materialization' as const,
    ownerId: randomUUID(), reservedBytes: 4096 }
  const capacity = sourceStorageCapacityFixture({ availableMemoryBytes: 0 })
  await expect(new PostgresSourceReservations().reserve(reservationSql(request.ownerKind), request, { capacity }))
    .resolves.toMatchObject(request)
})

it.each([
  { usage: { ...idleUsage, preparing: '2' }, exhausted: ['preparations'] },
  { usage: { ...idleUsage, materializations: '2' }, exhausted: ['materializations'] },
  { usage: { ...idleUsage, bytes: String(950 * 2 ** 20), retained_bytes: String(600 * 2 ** 20),
    pending_bytes: String(350 * 2 ** 20), materializations: '1' }, exhausted: ['retained_bytes'] },
])('classifies temporary reservation pressure as retryable: $exhausted', async ({ usage, exhausted }) => {
  const request = { scopeId: randomUUID(), ownerKind: 'materialization' as const,
    ownerId: randomUUID(), reservedBytes: 200 * 2 ** 20 }
  await expect(new PostgresSourceReservations().reserve(reservationSql(request.ownerKind, usage), request,
    { capacity: sourceStorageCapacityFixture() })).rejects.toMatchObject({
    code: 'SOURCE_CAPACITY', details: { retryable: true, scopeId: request.scopeId, exhausted,
      usage: { requestedBytes: request.reservedBytes }, limits: { bytes: 2 ** 30 } },
  })
})

it.each([
  { usage: { ...idleUsage, bytes: String(900 * 2 ** 20), retained_bytes: String(900 * 2 ** 20) },
    availableBytes: 4 * 2 ** 30, exhausted: ['retained_bytes'] },
  { usage: { ...idleUsage, preparing: '2' }, availableBytes: 1100 * 2 ** 20,
    exhausted: ['available_bytes', 'preparations'] },
])('keeps hard disk exhaustion permanent even with slot pressure: $exhausted',
  async ({ usage, availableBytes, exhausted }) => {
    const request = { scopeId: randomUUID(), ownerKind: 'materialization' as const,
      ownerId: randomUUID(), reservedBytes: 200 * 2 ** 20 }
    await expect(new PostgresSourceReservations().reserve(reservationSql(request.ownerKind, usage), request,
      { capacity: sourceStorageCapacityFixture({ availableBytes }) })).rejects.toMatchObject({
      code: 'SOURCE_CAPACITY', details: { retryable: false, exhausted },
    })
  },
)

it.each([
  { ...idleUsage, preparing: '1' },
  { ...idleUsage, materializations: '1' },
  { ...idleUsage, verification_materializations: '1' },
])('keeps low-memory preparation limits when the scope has active work: %j', async usage => {
  const request = { scopeId: randomUUID(), ownerKind: 'capture' as const,
    ownerId: randomUUID(), reservedBytes: 4096 }
  const capacity = sourceStorageCapacityFixture({ availableMemoryBytes: 1400 * 2 ** 20 })
  await expect(new PostgresSourceReservations().reserve(reservationSql(request.ownerKind, usage), request, { capacity }))
    .rejects.toMatchObject({ code: 'SOURCE_CAPACITY', details: { exhausted: ['preparations'] } })
})

it('allows additional concurrent reservations when the measured memory supports them', async () => {
  const request = { scopeId: randomUUID(), ownerKind: 'materialization' as const,
    ownerId: randomUUID(), reservedBytes: 4096 }
  const usage = { ...idleUsage, preparing: '1', materializations: '1', pending_bytes: '4096', bytes: '4096' }
  await expect(new PostgresSourceReservations().reserve(reservationSql(request.ownerKind, usage), request,
    { capacity: sourceStorageCapacityFixture({ availableMemoryBytes: 2 * 2 ** 30 }) }))
    .resolves.toMatchObject(request)
})

it.each([
  { usage: idleUsage, availableBytes: 512 * 2 ** 20, exhausted: ['available_bytes'] },
  { usage: { ...idleUsage, bytes: String(2 ** 30) }, availableBytes: 4 * 2 ** 30, exhausted: ['retained_bytes'] },
])('keeps the idle reservation within disk budgets: %j', async ({ usage, availableBytes, exhausted }) => {
  const request = { scopeId: randomUUID(), ownerKind: 'capture' as const,
    ownerId: randomUUID(), reservedBytes: 4096 }
  const capacity = sourceStorageCapacityFixture({ availableMemoryBytes: 1400 * 2 ** 20, availableBytes })
  await expect(new PostgresSourceReservations().reserve(reservationSql(request.ownerKind, usage), request, { capacity }))
    .rejects.toMatchObject({ code: 'SOURCE_CAPACITY', details: { exhausted } })
})
