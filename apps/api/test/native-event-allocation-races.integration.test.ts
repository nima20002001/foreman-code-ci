import type { HarnessNativeEvent } from '@foreman-code/contracts'
import { describe, expect, it } from 'vitest'
import { beginTransaction, commitTransaction, rollbackTransaction } from '../src/infrastructure/transaction.js'
import { appendNativeEvent } from '../src/modules/runs/nativeEvents.js'
import { counts, event, forcedRace, nextSequence, withSharedAllocationDatabase } from './pr17-native-event-allocation.test-support.js'

describe('PostgreSQL native event allocation races', () => {
  const database = withSharedAllocationDatabase()

  it('forces the stale-snapshot race; stores both events and their Activity references exactly once', async () => {
    await database(async (pool) => {
      const first = event(17); const second = event(18)
      await forcedRace(pool, first, second)
      const stored = await pool.query<{ sequence: number; source_sequence: number; record: HarnessNativeEvent; activity_count: number }>(`select
        n.sequence,n.source_sequence,n.record,count(a.sequence)::integer as activity_count
        from harness_native_events n left join run_activity a on a.harness_execution_id=n.execution_id
          and (a.payload->>'nativeEventSequence')::integer=n.sequence and a.kind='harness_output'
        group by n.execution_id,n.sequence order by n.sequence`)
      expect(stored.rows.map((row) => row.sequence)).toEqual([0, 1])
      expect(stored.rows.map((row) => row.source_sequence)).toEqual([17, 18])
      for (const row of stored.rows) {
        expect(row.record.sequence).toBe(row.sequence)
        expect(row.activity_count).toBe(1)
      }
      const before = await nextSequence(pool)
      await appendNativeEvent(pool, first)
      await appendNativeEvent(pool, second)
      expect(await counts(pool)).toEqual({ events: 2, activity: 2 })
      expect(await nextSequence(pool)).toBe(before)
      for (const original of [first, second]) {
        await expect(appendNativeEvent(pool, { ...original, payload: { text: 'different history' } }))
          .rejects.toMatchObject({ code: 'NATIVE_EVENT_IDENTITY_CONFLICT', status: 409 })
      }
      expect(await counts(pool)).toEqual({ events: 2, activity: 2 })
      expect(await nextSequence(pool)).toBe(before)
    })
  }, 20_000)

  it('serializes overlapping Activity commits and keeps cursor pages lossless while publication is paused', async () => {
    await database(async pool => {
      const a = await pool.connect()
      const b = await pool.connect()
      const gateA = await pool.connect()
      const gateB = await pool.connect()
      const pending: Promise<unknown>[] = []
      let gateInstalled = false
      const readActivity = (cursor = '0') => pool.query<{ sequence: string; harness_execution_id: string }>(`
        select a.sequence::text,a.harness_execution_id from run_activity a
        where a.run_id='run' and a.kind='harness_output' and a.sequence>$1::bigint
        order by a.sequence limit 1`, [cursor])
      const blockedBy = async (waiter: number, holder: number) => (await pool.query<{ blocked: boolean }>(
        'select $2::integer=any(pg_blocking_pids($1::integer)) as blocked', [waiter, holder])).rows[0]!.blocked
      try {
        // The deferred fixture trigger runs after sequence publication and pauses COMMIT on a separate lock.
        await pool.query(`create function pause_fixture_activity_commit() returns trigger language plpgsql as $$
          begin
            perform pg_advisory_xact_lock(hashtextextended(
              current_schema() || ':fixture_activity_commit:' || NEW.harness_execution_id,0));
            return null;
          end $$;
          create constraint trigger zz_fixture_activity_commit_gate after insert on run_activity
            deferrable initially deferred for each row when (NEW.kind='harness_output')
            execute function pause_fixture_activity_commit()`)
        gateInstalled = true
        await beginTransaction(gateA)
        await beginTransaction(gateB)
        for (const [gate, executionId] of [[gateA, 'execution'], [gateB, 'other-execution']] as const) {
          await gate.query(`select pg_advisory_xact_lock(hashtextextended(
            current_schema() || ':fixture_activity_commit:' || $1::text,0))`, [executionId])
        }
        const pidA = (await a.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
        const pidB = (await b.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
        const gatePidA = (await gateA.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
        const gatePidB = (await gateB.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
        await beginTransaction(a)
        await beginTransaction(b)
        await appendNativeEvent(a, event())
        await appendNativeEvent(b, event(0, { executionId: 'other-execution' }))
        expect(await counts(pool)).toEqual({ events: 0, activity: 0 })
        const firstCommit = commitTransaction(a)
        pending.push(Promise.allSettled([firstCommit]))
        await expect.poll(() => blockedBy(pidA, gatePidA)).toBe(true)
        const secondCommit = commitTransaction(b)
        pending.push(Promise.allSettled([secondCommit]))
        await expect.poll(() => blockedBy(pidB, pidA)).toBe(true)
        expect((await readActivity()).rows).toEqual([])
        expect(await counts(pool)).toEqual({ events: 0, activity: 0 })

        await commitTransaction(gateA)
        await firstCommit
        await expect.poll(() => blockedBy(pidB, gatePidB)).toBe(true)
        expect(await counts(pool)).toEqual({ events: 1, activity: 1 })
        const firstPage = (await readActivity()).rows
        expect(firstPage).toMatchObject([{ harness_execution_id: 'execution' }])
        const cursor = firstPage[0]!.sequence
        expect((await readActivity(cursor)).rows).toEqual([])

        await commitTransaction(gateB)
        await secondCommit
        const secondPage = (await readActivity(cursor)).rows
        expect(secondPage).toMatchObject([{ harness_execution_id: 'other-execution' }])
        expect(BigInt(secondPage[0]!.sequence)).toBeGreaterThan(BigInt(cursor))
        expect((await readActivity(secondPage[0]!.sequence)).rows).toEqual([])
        expect(await counts(pool)).toEqual({ events: 2, activity: 2 })
      } finally {
        await rollbackTransaction(gateA)
        await rollbackTransaction(gateB)
        await Promise.all(pending)
        await rollbackTransaction(a)
        await rollbackTransaction(b)
        a.release()
        b.release()
        gateA.release()
        gateB.release()
        if (gateInstalled) {
          await pool.query(`drop trigger zz_fixture_activity_commit_gate on run_activity;
            drop function pause_fixture_activity_commit()`)
        }
      }
    })
  }, 20_000)

  it('forces concurrent exact replay to remain a no-op after waiting for the first commit', async () => {
    await database(async (pool) => {
      const original = event()
      await forcedRace(pool, original, original)
      expect(await counts(pool)).toEqual({ events: 1, activity: 1 })
      expect(await nextSequence(pool)).toBe('1')
    })
  }, 20_000)

  it('distinguishes connections even when their source sequence restarts at the same value', async () => {
    await database(async (pool) => {
      await forcedRace(pool, event(0), event(0, { connectionId: 'connection-2' }))
      expect(await counts(pool)).toEqual({ events: 2, activity: 2 })
      expect((await pool.query('select sequence from harness_native_events order by sequence')).rows).toEqual([{ sequence: 0 }, { sequence: 1 }])
    })
  }, 20_000)

  it.each(['execution', 'other-execution'] as const)(
    'publishes Activity in commit order across different executions when %s commits first', async firstExecutionId => {
      await database(async (pool) => {
        const a = await pool.connect()
        const b = await pool.connect()
        const firstEvent = event()
        const secondEvent = event(0, { executionId: 'other-execution' })
        const readActivity = (cursor = '0') => pool.query<{ sequence: string; harness_execution_id: string }>(`
          select a.sequence::text,a.harness_execution_id from run_activity a
          where a.run_id='run' and a.kind='harness_output' and a.sequence>$1::bigint
          order by a.sequence limit 1`, [cursor])
        try {
          await beginTransaction(a, { isolation: 'read committed' })
          await beginTransaction(b, { isolation: 'read committed' })
          await appendNativeEvent(a, firstEvent)
          await b.query("select set_config('statement_timeout','500ms',true)")
          await appendNativeEvent(b, secondEvent)
          expect(await counts(pool)).toEqual({ events: 0, activity: 0 })
          expect((await readActivity()).rows).toEqual([])

          const firstCommit = firstExecutionId === 'execution' ? a : b
          const secondCommit = firstExecutionId === 'execution' ? b : a
          const secondExecutionId = firstExecutionId === 'execution' ? 'other-execution' : 'execution'
          await commitTransaction(firstCommit)
          expect(await counts(pool)).toEqual({ events: 1, activity: 1 })
          const firstPage = (await readActivity()).rows
          expect(firstPage).toMatchObject([{ harness_execution_id: firstExecutionId }])
          const cursor = firstPage[0]!.sequence
          expect((await readActivity(cursor)).rows).toEqual([])

          await commitTransaction(secondCommit)
          const secondPage = (await readActivity(cursor)).rows
          expect(secondPage).toMatchObject([{ harness_execution_id: secondExecutionId }])
          expect(BigInt(secondPage[0]!.sequence)).toBeGreaterThan(BigInt(cursor))
          expect(new Set([...firstPage, ...secondPage].map(row => row.sequence)).size).toBe(2)
          expect((await readActivity(secondPage[0]!.sequence)).rows).toEqual([])
          expect(await counts(pool)).toEqual({ events: 2, activity: 2 })
          const events = await pool.query('select execution_id,sequence from harness_native_events order by execution_id')
          expect(events.rows).toEqual([
            { execution_id: 'execution', sequence: 0 },
            { execution_id: 'other-execution', sequence: 0 },
          ])
          await appendNativeEvent(pool, firstEvent)
          await appendNativeEvent(pool, secondEvent)
          expect(await counts(pool)).toEqual({ events: 2, activity: 2 })
          expect((await readActivity(secondPage[0]!.sequence)).rows).toEqual([])
        } finally {
          await rollbackTransaction(a)
          await rollbackTransaction(b)
          a.release()
          b.release()
        }
      })
  }, 20_000)

  it('does not serialize different executions when native events produce no Activity', async () => {
    await database(async (pool) => {
      const a = await pool.connect()
      const b = await pool.connect()
      const payload = { nativeMethod: 'item/agentMessage/delta', text: 'stream chunk' }
      try {
        await beginTransaction(a)
        await appendNativeEvent(a, event(17, { payload }))
        await beginTransaction(b)
        await b.query("set local lock_timeout='2s'")
        await appendNativeEvent(b, event(0, { executionId: 'other-execution', payload }))
        await commitTransaction(b) // Must finish while a still owns its execution row.
        expect(await counts(pool)).toEqual({ events: 1, activity: 0 })
        await commitTransaction(a)
        expect(await counts(pool)).toEqual({ events: 2, activity: 0 })
      } finally {
        await rollbackTransaction(a)
        await rollbackTransaction(b)
        a.release()
        b.release()
      }
    })
  })

})
