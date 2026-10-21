import { describe, expect, it } from 'vitest'
import { appendNativeEvent } from '../src/modules/runs/nativeEvents.js'
import { counts, createDatabase, event, nextSequence, withDatabaseFixture } from './pr17-native-event-allocation.test-support.js'

describe('PostgreSQL native event allocation invariants', () => {
  const database = withDatabaseFixture(createDatabase)

  it('keeps event, counter and Activity atomic in caller-owned and autocommit transactions', async () => {
    await database(async (pool) => {
      const client = await pool.connect()
      try {
        await client.query('begin')
        await appendNativeEvent(client, event())
        expect(await counts(pool)).toEqual({ events: 0, activity: 0 })
        await client.query('rollback')
        expect(await nextSequence(pool)).toBe('0')
        // Exercise an autocommit Client, not just a Pool or an explicit transaction.
        await appendNativeEvent(client, event())
        expect(await counts(pool)).toEqual({ events: 1, activity: 1 })
      } finally { await client.query('rollback'); client.release() }
      await pool.query("alter table run_activity add constraint reject_fixture_activity check (payload->>'nativeEventType' <> 'fixture.reject')")
      await expect(appendNativeEvent(pool, event(18, { type: 'fixture.reject' }))).rejects.toMatchObject({ code: '23514' })
      expect(await counts(pool)).toEqual({ events: 1, activity: 1 })
      expect(await nextSequence(pool)).toBe('1')
    })
  })

  it('preserves legacy identity, rejects changed legacy history, and advances the high-water mark', async () => {
    await database(async (pool) => {
      const legacy = event(41)
      delete legacy.connectionId
      await appendNativeEvent(pool, legacy)
      await appendNativeEvent(pool, legacy)
      await expect(appendNativeEvent(pool, { ...legacy, payload: { text: 'conflict' } }))
        .rejects.toMatchObject({ code: 'NATIVE_EVENT_IDENTITY_CONFLICT' })
      await appendNativeEvent(pool, event(0))
      expect((await pool.query('select sequence from harness_native_events order by sequence')).rows).toEqual([{ sequence: 41 }, { sequence: 42 }])
      expect(await counts(pool)).toEqual({ events: 2, activity: 2 })
      expect(await nextSequence(pool)).toBe('43')
    })
  })

  it('fails closed at integer sequence exhaustion without wrapping, while exact replay still works', async () => {
    await database(async (pool) => {
      await pool.query("update harness_executions set native_event_next_sequence=2147483647 where id='execution'")
      await appendNativeEvent(pool, event())
      await appendNativeEvent(pool, event())
      await expect(appendNativeEvent(pool, event(18))).rejects.toMatchObject({ code: '22003' })
      expect(await nextSequence(pool)).toBe('2147483648')
      expect(await counts(pool)).toEqual({ events: 1, activity: 1 })
    })
  })
})
