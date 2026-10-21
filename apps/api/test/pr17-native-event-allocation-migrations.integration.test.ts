import { describe, expect, it } from 'vitest'
import { appendNativeEvent } from '../src/modules/runs/nativeEvents.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { nativeActivityNoiseMigration } from '../src/infrastructure/nativeActivityNoiseMigration.js'
import { nativeEventSequenceMigration } from '../src/infrastructure/nativeEventSequenceMigration.js'
import { counts, createDatabase, event, nextSequence, timestamp, withDatabaseFixture } from './pr17-native-event-allocation.test-support.js'

describe('native event sequence migration on fresh databases', () => {
  const database = withDatabaseFixture(createDatabase)

  it('applies on a fresh database and is a receipt-controlled no-op on restart', async () => {
    await database(async (pool) => {
      expect(await nextSequence(pool)).toBe('0')
      const receipts = (await pool.query('select * from application_migrations order by version')).rows
      await appendNativeEvent(pool, event())
      await applyApplicationMigrations(pool)
      expect((await pool.query('select * from application_migrations order by version')).rows).toEqual(receipts)
      expect(await nextSequence(pool)).toBe('1')
      expect(await counts(pool)).toEqual({ events: 1, activity: 1 })
      const fn = await pool.query("select provolatile,prosecdef from pg_proc where oid='append_harness_native_event(jsonb)'::regprocedure")
      expect(fn.rows).toEqual([{ provolatile: 'v', prosecdef: false }])
    })
  })
})

describe('native event sequence migration upgrades', () => {
  const database = withDatabaseFixture(() => createDatabase(true))

  it('upgrades the actual existing PR17 migration level without changing event history; rollback is restart-safe', async () => {
    await database(async (pool) => {
      const legacy = event(7); delete legacy.connectionId
      const connected = event(41, { connectionId: 'previous-connection' })
      await pool.query(`insert into harness_native_events(execution_id,sequence,record,connection_id,source_sequence)
        values('execution',7,$1::jsonb,null,null),('execution',41,$2::jsonb,'previous-connection',3)`, [JSON.stringify(legacy), JSON.stringify(connected)])
      for (const sequence of [7, 41]) {
        await pool.query(`insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
          values('run','harness','harness_output','execution',$1,jsonb_build_object('nativeEventSequence',$2::integer,'nativeEventType','assistant.delta'))`, [timestamp, sequence])
      }
      const oldEvents = (await pool.query('select * from harness_native_events order by sequence')).rows
      const oldActivity = (await pool.query('select * from run_activity order by sequence')).rows
      const oldReceipts = (await pool.query('select * from application_migrations order by version')).rows
      const client = await pool.connect()
      try {
        await client.query('begin')
        await client.query('select pg_advisory_xact_lock($1)', [810_001])
        await client.query(nativeEventSequenceMigration.sql)
        await client.query('insert into application_migrations(version) values(1702)')
        await client.query('rollback') // Simulated failed deployment: DDL/backfill/receipt all roll back.
      } finally { await client.query('rollback'); client.release() }
      expect((await pool.query("select to_regprocedure('append_harness_native_event(jsonb)') as fn")).rows[0].fn).toBeNull()
      expect((await pool.query('select * from application_migrations order by version')).rows).toEqual(oldReceipts)
      await applyApplicationMigrations(pool)
      expect(await nextSequence(pool)).toBe('42')
      expect((await pool.query('select * from harness_native_events order by sequence')).rows).toEqual(oldEvents)
      expect((await pool.query('select * from run_activity order by sequence')).rows).toEqual(oldActivity)
      await appendNativeEvent(pool, legacy)
      await appendNativeEvent(pool, { ...connected, sequence: 3 })
      expect(await counts(pool)).toEqual({ events: 2, activity: 2 })
      await appendNativeEvent(pool, event(0))
      expect(await nextSequence(pool)).toBe('43')
      await applyApplicationMigrations(pool)
      expect(await nextSequence(pool)).toBe('43')
      expect((await pool.query('select * from application_migrations where version<>all($1::bigint[]) order by version',
        [[1702, nativeActivityNoiseMigration.version]])).rows).toEqual(oldReceipts)
      expect((await pool.query('select version from application_migrations where version=1702')).rowCount).toBe(1)
      expect(await counts(pool)).toEqual({ events: 3, activity: 3 })
    })
  }, 20_000)
})
