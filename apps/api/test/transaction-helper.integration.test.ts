import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withClientTransaction, withTransaction } from '../src/infrastructure/transaction.js'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'

const connectionString = process.env.TEST_DATABASE_URL
describe.skipIf(!connectionString)('shared transaction helper in PostgreSQL', () => {
  let admin: pg.Pool; let pool: pg.Pool; let schema: string
  const rows = async () => (await pool.query<{ id: string }>('select id from items order by id')).rows.map(row => row.id)
  beforeEach(async () => {
    admin = new pg.Pool({ connectionString }); schema = `transaction_${randomUUID().replaceAll('-', '')}`
    await createFixtureSchema(admin, schema)
    pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 2 })
    await pool.query('create table items (id text primary key)')
  })
  afterEach(async () => { await pool?.end(); if (admin) { await dropFixtureSchema(admin, schema); await admin.end() } })

  it('commits the callback result and returns the connection to the pool', async () => {
    await expect(withTransaction(pool, async (client) => {
      await client.query("insert into items values ('a')")
      return 'done'
    })).resolves.toBe('done')
    expect(await rows()).toEqual(['a'])
    expect(pool.totalCount - pool.idleCount).toBe(0)
  })

  it('rolls back on a throw, rethrows the original error and releases the connection', async () => {
    const original = new Error('callback failed')
    await expect(withTransaction(pool, async (client) => {
      await client.query("insert into items values ('a')")
      throw original
    })).rejects.toBe(original)
    expect(await rows()).toEqual([])
    expect(pool.totalCount - pool.idleCount).toBe(0)
  })

  it('keeps the original error and discards the connection when rollback fails', async () => {
    const original = new Error('callback failed after losing its session')
    let pid = 0
    await expect(withTransaction(pool, async (client) => {
      client.on('error', () => undefined)
      pid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      await client.query("insert into items values ('a')")
      await admin.query('select pg_terminate_backend($1)', [pid])
      throw original
    })).rejects.toBe(original)
    expect(pool.totalCount).toBe(0)
    expect(await rows()).toEqual([])
    const after = (await pool.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
    expect(after).not.toBe(pid)
  })

  it('opens the requested isolation level and read-only mode', async () => {
    const settings = await withTransaction(pool, async (client) => (await client.query<{ isolation: string; readOnly: string }>(
      "select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as \"readOnly\"")).rows[0],
    { isolation: 'repeatable read', readOnly: true })
    expect(settings).toEqual({ isolation: 'repeatable read', readOnly: 'on' })
    await expect(withTransaction(pool, (client) => client.query("insert into items values ('a')"),
      { isolation: 'repeatable read', readOnly: true })).rejects.toMatchObject({ code: '25006' })
    expect(await rows()).toEqual([])
  })

  it('retries a serialization failure only when the caller opts in', async () => {
    const conflict = () => Object.assign(new Error('could not serialize access'), { code: '40001' })
    let attempts = 0
    await expect(withTransaction(pool, async (client) => {
      attempts += 1
      await client.query('insert into items values ($1)', [`attempt-${attempts}`])
      if (attempts === 1) throw conflict()
    }, { conflictRetries: 2 })).resolves.toBeUndefined()
    expect(attempts).toBe(2)
    expect(await rows()).toEqual(['attempt-2'])

    attempts = 0
    const failure = conflict()
    await expect(withTransaction(pool, async () => { attempts += 1; throw failure })).rejects.toBe(failure)
    expect(attempts).toBe(1)
    expect(pool.totalCount - pool.idleCount).toBe(0)
  })

  it('runs consecutive transactions on a caller-owned connection without releasing it', async () => {
    const client = await pool.connect()
    try {
      await withClientTransaction(client, async () => { await client.query("insert into items values ('a')") })
      const original = new Error('second transaction failed')
      await expect(withClientTransaction(client, async () => {
        await client.query("insert into items values ('b')")
        throw original
      })).rejects.toBe(original)
      expect((await client.query<{ id: string }>('select id from items order by id')).rows.map(row => row.id)).toEqual(['a'])
      expect(pool.totalCount - pool.idleCount).toBe(1)
    } finally { client.release() }
  })
})
