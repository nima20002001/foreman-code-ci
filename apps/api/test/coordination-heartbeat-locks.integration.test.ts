import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresInteractionCoordinationRepository } from '../src/modules/interactions/coordination.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'

let database: Awaited<ReturnType<typeof currentDatabase>>
let repository: PostgresInteractionCoordinationRepository
beforeAll(async () => {
  if (!postgresEnabled) return
  database = await currentDatabase()
  repository = new PostgresInteractionCoordinationRepository(database.pool)
}, 60_000)
afterAll(async () => { await database?.close() })

async function seedLane() {
  return repository.ensureLane({
    id: randomUUID(), harness: 'codex', nativeSessionId: randomUUID(), ownerAgentId: 'reviewer',
    observedStatus: 'busy', connectionGeneration: 2, revision: 0, observedAt: new Date().toISOString(),
    leaseOwner: 'writer', leaseToken: 'writer-token', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
}

async function promptly<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Heartbeat waited on the row lock')), 1_000)
    })])
  } finally {
    clearTimeout(timer)
  }
}

describe.skipIf(!postgresEnabled)('native lane heartbeat row locks', () => {
  it('defers while locked without changing expiry, then persists renewal by the same owner', async () => {
    const lane = await seedLane()
    const ownership = { owner: 'writer', connectionGeneration: 2 }
    await withTransaction(database.pool, async locker => {
      await locker.query('select id from native_session_lanes where id=$1 for update', [lane.id])
      await expect(promptly(repository.renewLane(lane.id, 'writer-token', 30_000, ownership)))
        .rejects.toMatchObject({ code: 'SESSION_LANE_RENEWAL_BUSY' })
      expect(await repository.getLane(lane.harness, lane.nativeSessionId)).toEqual(lane)
    })
    const expiresAt = await repository.renewLane(lane.id, 'writer-token', 120_000, ownership)
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.parse(lane.leaseExpiresAt!))
    expect(await repository.getLane(lane.harness, lane.nativeSessionId)).toEqual({
      ...lane, revision: lane.revision + 1, leaseExpiresAt: expiresAt,
    })
  })

  it.each([
    { owner: 'successor', connectionGeneration: 2 },
    { owner: 'writer', connectionGeneration: 3 },
  ])('rejects stale ownership %j both during contention and after unlocking', async ownership => {
    const lane = await seedLane()
    await withTransaction(database.pool, async locker => {
      await locker.query('select id from native_session_lanes where id=$1 for update', [lane.id])
      await expect(promptly(repository.renewLane(lane.id, 'writer-token', 30_000, ownership)))
        .rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
      expect(await repository.getLane(lane.harness, lane.nativeSessionId)).toEqual(lane)
    })
    await expect(repository.renewLane(lane.id, 'writer-token', 30_000, ownership))
      .rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
    expect(await repository.getLane(lane.harness, lane.nativeSessionId)).toEqual(lane)
  })
})
