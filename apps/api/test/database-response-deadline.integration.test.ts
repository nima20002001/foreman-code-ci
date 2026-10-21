import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { createPool } from '../src/infrastructure/pool.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { holdPostgresResponses } from './helpers/postgresResponses.js'

it.skipIf(!postgresEnabled)('delivers completed queries after a delayed reply while retaining the SQL and response deadlines', async () => {
  const fixture = await migratedDatabase()
  try {
    const url = new URL(fixture.databaseUrl)
    url.searchParams.set('options', `-c search_path=${fixture.schema}`)
    // Hold the real connection's incoming bytes; the dedicated endpoint and guard stay unchanged.
    const responses = await holdPostgresResponses(url.toString())
    try {
      const pool = createPool({ connectionString: url.toString(), maxConnections: 1,
        connectionTimeoutMs: 2000, queryTimeoutMs: 1000 }, 'database-response-deadline')
      const table = `response_deadline_${randomUUID().replaceAll('-', '')}`
      try {
        await pool.query('select 1')
        await pool.query(`create table ${table}(value int primary key)`)
        responses.hold()
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true })
        const completed = pool.query<{ value: number }>('select 42::int as value')
          .then(result => ({ rows: result.rows }), error => ({ error }))
        await responses.received()
        await vi.advanceTimersByTimeAsync(1001)
        responses.release()
        expect(await completed).toEqual({ rows: [{ value: 42 }] })

        responses.hold()
        const committed = pool.query<{ value: number }>(`insert into ${table}(value) values(42) returning value`)
          .then(result => ({ rows: result.rows }), error => ({ error }))
        await responses.received()
        await vi.advanceTimersByTimeAsync(1001)
        responses.release()
        expect(await committed).toEqual({ rows: [{ value: 42 }] })
        vi.useRealTimers()
        expect((await pool.query(`select value from ${table}`)).rows).toEqual([{ value: 42 }])

        await expect(pool.query('select pg_sleep(2)')).rejects.toMatchObject({ code: '57014' })

        // Pool.query discards the canceled connection. Finish the replacement
        // handshake before withholding a query response.
        await pool.query('select 1')
        responses.hold()
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true })
        const silent = pool.query('select 1').catch(error => error as Error)
        await responses.received()
        await vi.advanceTimersByTimeAsync(2001)
        await expect(silent).resolves.toMatchObject({ message: 'Query read timeout' })
      } finally {
        vi.useRealTimers()
        responses.release()
        await pool.end()
      }
    } finally { responses.close() }
  } finally { await fixture.close() }
}, 30_000)
