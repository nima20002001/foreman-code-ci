import type pg from 'pg'
import { NATIVE_INTERACTION_FIXTURES, type DurableInteraction } from '@foreman-code/contracts'
import { describe, expect, it } from 'vitest'
import { readActivityAcknowledgment } from '../src/modules/interactions/activityAcknowledgment.js'

describe('persisted activity acknowledgment accessor', () => {
  const interaction: DurableInteraction = {
    ...NATIVE_INTERACTION_FIXTURES.codex,
    status: 'delivered',
    deliveryState: 'delivered',
  }

  it('returns persisted acknowledgment identity without callback authority', async () => {
    const query = { query: async () => ({
      rows: [{ worker_acknowledgment_id: 'ack', native_turn_id: 'turn' }],
    }) } as unknown as Pick<pg.PoolClient, 'query'>
    expect(await readActivityAcknowledgment(query, interaction)).toEqual({ workerAcknowledgmentId: 'ack', nativeTurnId: 'turn' })
  })

  it.each([
    { status: 'pending', deliveryState: 'not_started' },
    { status: 'decided', deliveryState: 'not_started' },
    { status: 'delivery_pending', deliveryState: 'submitted' },
    { status: 'delivery_pending', deliveryState: 'uncertain' },
    { status: 'canceled', deliveryState: 'delivered' },
  ] as const)('has no acknowledgment before completed delivery: %j', async state => {
    const failing = { query: async () => { throw new Error('Acknowledgment storage is unavailable') } }
    const unavailable = failing as unknown as Pick<pg.PoolClient, 'query'>
    expect(await readActivityAcknowledgment(unavailable, { ...interaction, ...state })).toEqual({})
  })

  it('returns no acknowledgment when completed delivery has no persisted acknowledgment', async () => {
    const query = { query: async () => ({ rows: [] }) } as unknown as Pick<pg.PoolClient, 'query'>
    expect(await readActivityAcknowledgment(query, interaction)).toEqual({})
  })
})
