import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { PostgresSourceReservations } from '../src/modules/sources/reservations.js'
import { sourceStorageCapacityFixture } from './helpers/sourceStorageCapacityFixture.js'
import { agent3Database } from './helpers/wave25Agent3.js'
import { withTransaction } from '../src/infrastructure/transaction.js'

let database: Awaited<ReturnType<typeof agent3Database>> | undefined
afterEach(async () => { await database?.close(); database = undefined })

it.each(['owned', 'uncertain'] as const)(
  'admits another source using free memory without charging the %s materialization twice', async state => {
    database = await agent3Database()
    const pool = database.pool
    const scopeId = randomUUID()
    let availableMemoryBytes = 4 * 2 ** 30
    const reservations = new PostgresSourceReservations(async () => sourceStorageCapacityFixture({
      cpuCount: 6, availableMemoryBytes,
    }))
    const request = () => ({ scopeId, ownerKind: 'materialization' as const,
      ownerId: randomUUID(), reservedBytes: 4096 })
    const first = await withTransaction(pool, sql => reservations.reserve(sql, request()))
    await withTransaction(pool, sql => reservations.retain(sql, first, state))

    // The host reading already excludes the first execution's resident memory.
    availableMemoryBytes = 1536 * 2 ** 20
    const second = await withTransaction(pool, sql => reservations.reserve(sql, request()))
    expect(second.ownerId).not.toBe(first.ownerId)
    await expect(withTransaction(pool, sql => reservations.reserve(sql, request())))
      .rejects.toMatchObject({ code: 'SOURCE_CAPACITY', details: { exhausted: ['preparations'] } })

    await withTransaction(pool, sql => reservations.retain(sql, second, 'owned'))
    availableMemoryBytes = 2 ** 30
    await expect(withTransaction(pool, sql => reservations.reserve(sql, request())))
      .rejects.toMatchObject({ code: 'SOURCE_CAPACITY', details: { exhausted: ['preparations'] } })
    const stored = await pool.query<{ owner_id: string; state: string; reserved_bytes: string }>(
      'select owner_id,state,reserved_bytes from source_storage_reservations where scope_id=$1', [scopeId])
    expect(stored.rows).toHaveLength(2)
    expect(stored.rows).toEqual(expect.arrayContaining([
      { owner_id: first.ownerId, state, reserved_bytes: '4096' },
      { owner_id: second.ownerId, state: 'owned', reserved_bytes: '4096' },
    ]))
  },
)

it('shares a measured host budget across many ordinary Agents and retains it after restart', async () => {
  database = await agent3Database()
  const pool = database.pool
  const scopeId = randomUUID()
  const readCapacity = async () => sourceStorageCapacityFixture({ totalBytes: 64 * 2 ** 30,
    availableBytes: 32 * 2 ** 30, cpuCount: 8, availableMemoryBytes: 16 * 2 ** 30 })
  const reservations = new PostgresSourceReservations(readCapacity)
  const agents = []
  for (let index = 0; index < 14; index++) {
    const capture = await reservations.reserve(pool, { scopeId, ownerKind: 'capture', ownerId: randomUUID(),
      reservedBytes: 32 * 2 ** 20 })
    await reservations.retain(pool, capture, 'retained')
  }
  for (let index = 0; index < 16; index++) {
    const agent = await reservations.reserve(pool, { scopeId, ownerKind: 'materialization', ownerId: randomUUID(),
      reservedBytes: 163 * 2 ** 20 * 3 })
    await reservations.retain(pool, agent, 'owned')
    agents.push(agent)
  }
  const restarted = new PostgresSourceReservations(readCapacity)
  expect(await restarted.reserve(pool, agents[0]!)).toEqual(agents[0])
  await expect(restarted.reserve(pool, { scopeId, ownerKind: 'materialization', ownerId: randomUUID(),
    reservedBytes: 163 * 2 ** 20 * 3 })).rejects.toMatchObject({ code: 'SOURCE_CAPACITY' })
  const stored = await pool.query<{ state: string; reserved_bytes: string }>(
    'select state,reserved_bytes from source_storage_reservations where owner_id=any($1::text[])',
    [agents.map(agent => agent.ownerId)])
  expect(stored.rows).toHaveLength(16)
  expect(stored.rows.every(row => row.state === 'owned'
    && Number(row.reserved_bytes) === 163 * 2 ** 20 * 3)).toBe(true)
})

it('serializes competing reservations and counts every outstanding writer against real free space', async () => {
  database = await agent3Database()
  const pool = database.pool
  const scopeId = randomUUID()
  const reservations = new PostgresSourceReservations(async () => sourceStorageCapacityFixture({
    totalBytes: 64 * 2 ** 30, availableBytes: 2 * 2 ** 30, cpuCount: 4,
  }))
  async function reserve() {
    return withTransaction(pool, sql => reservations.reserve(sql, { scopeId, ownerKind: 'capture', ownerId: randomUUID(),
      reservedBytes: 600 * 2 ** 20 }))
  }
  const results = await Promise.allSettled([reserve(), reserve()])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const rejected = results.find(result => result.status === 'rejected')
  expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'SOURCE_CAPACITY' } })
  expect((await pool.query('select reserved_bytes from source_storage_reservations where scope_id=$1', [scopeId]))
    .rows).toEqual([{ reserved_bytes: String(600 * 2 ** 20) }])
})

it('fails closed without a current host measurement and leaves no new reservation', async () => {
  database = await agent3Database()
  const request = { scopeId: randomUUID(), ownerKind: 'capture' as const, ownerId: randomUUID(), reservedBytes: 1 }
  await expect(new PostgresSourceReservations().reserve(database.pool, request))
    .rejects.toMatchObject({ code: 'SOURCE_CAPACITY_UNAVAILABLE' })
  const stale = new PostgresSourceReservations(async () => sourceStorageCapacityFixture({
    observedAt: new Date(Date.now() - 60_000).toISOString(),
  }))
  await expect(stale.reserve(database.pool, request)).rejects.toMatchObject({ code: 'SOURCE_CAPACITY_UNAVAILABLE' })
  expect((await database.pool.query('select 1 from source_storage_reservations where owner_id=$1',
    [request.ownerId])).rows).toEqual([])
})
