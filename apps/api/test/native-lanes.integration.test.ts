import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { NativeSessionLaneSchema } from '@foreman-code/contracts'

import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresInteractionCoordinationRepository } from '../src/modules/interactions/coordination.js'

const connectionString = process.env.TEST_DATABASE_URL!
const schema = `lanes_${randomUUID().replaceAll('-', '')}`
const admin = new pg.Pool({ connectionString })
const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
beforeAll(async () => {
  await createFixtureSchema(admin, schema)
  await applyApplicationMigrations(pool)
}, 60_000)
afterAll(async () => {
  await pool.end()
  try { await dropFixtureSchema(admin, schema) } finally { await admin.end() }
}, 60_000)

it('round-trips claimed and renewed lane leases through PostgreSQL and the shared contract', async () => {
  const repository = new PostgresInteractionCoordinationRepository(pool)
  const lane = await repository.ensureLane({ id: 'lane', harness: 'codex', nativeSessionId: 'session', ownerAgentId: 'agent',
    observedStatus: 'idle', revision: 0, connectionGeneration: 0, observedAt: new Date().toISOString() })
  const expiry = new Date(Date.now() + 60_000).toISOString()
  const claimed = await repository.claimLane(lane.id, lane.revision, 'owner', 'token', expiry, 'turn')
  expect(claimed.leaseExpiresAt).toBe(expiry)
  expect(claimed.correlationId).toBeUndefined()
  await repository.renewLane(lane.id, 'token', 60_000)
  const renewed = NativeSessionLaneSchema.parse((await pool.query('select record from native_session_lanes where id=$1', [lane.id])).rows[0].record)
  expect(Date.parse(renewed.leaseExpiresAt!)).toBeGreaterThan(Date.now())
  await repository.bindLaneTurn({ id: lane.id, token: 'token' }, 'workflow-turn')
  const fence = { id: lane.id, token: 'token' }
  await repository.acknowledgeLaneTurn(fence, 'workflow-turn', 'native-turn')
  await repository.acknowledgeLaneTurn(fence, 'workflow-turn', 'native-turn')
  expect(await repository.getLane('codex', 'session')).toMatchObject({
    currentTurnOrMessageId: 'native-turn', correlationId: 'workflow-turn', leaseToken: 'token',
  })
  await expect(repository.acknowledgeLaneTurn(fence, 'another-workflow-turn', 'native-turn'))
    .rejects.toMatchObject({ code: 'NATIVE_TURN_IDENTITY_CONFLICT' })
  await expect(repository.acknowledgeLaneTurn(fence, 'workflow-turn', 'different-native-turn'))
    .rejects.toMatchObject({ code: 'NATIVE_TURN_IDENTITY_CONFLICT' })
  const released = await repository.releaseLane(lane.id, 'token', {
    observedStatus: 'idle', currentTurnOrMessageId: 'native-turn',
  })
  expect(released.correlationId).toBe('workflow-turn')
  expect(released.currentTurnOrMessageId).toBe('native-turn')
  await expect(repository.assertLaneLease(lane.id, 'token')).rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
  await expect(repository.acknowledgeLaneTurn(fence, 'workflow-turn', 'native-turn'))
    .rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
})
