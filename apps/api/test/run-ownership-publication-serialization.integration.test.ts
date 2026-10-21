import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readUntil } from './helpers/observableCondition.js'
import { deferred } from './helpers/deferred.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'

import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'

let database: Awaited<ReturnType<typeof currentDatabase>>
let pool: pg.Pool
beforeAll(async () => {
  if (!postgresEnabled) return
  database = await currentDatabase()
  pool = database.pool
}, 60_000)
afterAll(async () => { await database?.close() })

describe.skipIf(!postgresEnabled)('Agent 3 dedicated PostgreSQL publication ownership', () => {
  it('joins an already-started release until the original database connection has drained', async () => {
    const owner = (await RunOwnership.acquire(pool!, `release-drain-${randomUUID()}`, () => undefined))!
    let entered!: () => void
    let finish!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const paused = new Promise<void>(resolve => { finish = resolve })
    const work = owner.oneShotConnection().transaction(async () => { entered(); await paused }).catch(error => error)
    await started
    const first = owner.release()
    let duplicateFinished = false
    const duplicate = owner.release().then(() => { duplicateFinished = true })
    try {
      await new Promise(resolve => setImmediate(resolve))
      expect(duplicateFinished).toBe(false)
    } finally {
      finish()
      await Promise.all([first, duplicate, work])
    }
  })

  it('keeps the same PostgreSQL owner for a retained native review after the engine releases its use', async () => {
    const runId = `retained-review-${randomUUID()}`
    const owner = (await RunOwnership.acquire(pool!, runId, () => undefined))!
    let releaseReview: (() => Promise<void>) | undefined
    try {
      const first = await owner.oneShotConnection().transaction(sql => owner.readOneShotFence(sql))
      releaseReview = owner.retain(() => undefined)
      await owner.release()
      expect(await RunOwnership.acquire(pool!, runId, () => undefined)).toBeUndefined()
      expect(await owner.oneShotConnection().transaction(sql => owner.readOneShotFence(sql))).toEqual(first)
      await releaseReview()
      expect(() => owner.assertOwned()).toThrow()
      const replacement = (await RunOwnership.acquire(pool!, runId, () => undefined))!
      try {
        await releaseReview()
        expect(await replacement.oneShotConnection().transaction(sql => replacement.readOneShotFence(sql))).toBeDefined()
      } finally { await replacement.release() }
    } finally {
      await releaseReview?.()
      await owner.release()
    }
  })

  it('cancels a retained review when its original PostgreSQL owner connection is lost', async () => {
    const runId = `retained-review-loss-${randomUUID()}`
    const owner = (await RunOwnership.acquire(pool!, runId, () => undefined))!
    let releaseReview: (() => Promise<void>) | undefined
    try {
      let notify!: () => void
      const lost = new Promise<void>(resolve => { notify = resolve })
      releaseReview = owner.retain(notify)
      const fence = await owner.oneShotConnection().transaction(sql => owner.readOneShotFence(sql))
      await owner.release()
      await pool!.query('select pg_terminate_backend($1)', [Number(fence.ownerId)])
      await lost
      expect(() => owner.assertOwned()).toThrow()
      await expect(owner.client.query('select 1')).rejects.toThrow()
    } finally {
      await releaseReview?.()
      await owner.release()
    }
  })

  it('excludes a second independent owner and transfers only after session closure', async () => {
    const runId = `a3-owner-${randomUUID()}`
    const owner = await RunOwnership.acquire(pool!, runId, () => undefined)
    expect(owner).toBeDefined()
    try {
      expect(await RunOwnership.acquire(pool!, runId, () => undefined)).toBeUndefined()
      const connection = owner!.oneShotConnection()
      const first = await connection.transaction((sql) => owner!.readOneShotFence(sql))
      const second = await connection.transaction((sql) => owner!.readOneShotFence(sql))
      expect(second).toEqual(first)
      const independent = await pool!.query<{ pid: string }>('select pg_backend_pid()::text as pid')
      expect(independent.rows[0]!.pid).not.toBe(first.ownerId)
    } finally { await owner?.release() }
    const replacement = await RunOwnership.acquire(pool!, runId, () => undefined)
    expect(replacement).toBeDefined()
    await replacement?.release()
    expect(() => owner!.assertOwned()).toThrow()
  })
  it('serializes a native repository query behind the complete publication transaction', async () => {
    const owner = await RunOwnership.acquire(pool!, `a3-serial-${randomUUID()}`, () => undefined)
    expect(owner).toBeDefined()
    try {
      const connection = owner!.oneShotConnection()
      const fence = await connection.transaction(sql => owner!.readOneShotFence(sql))
      const table = `publication_${randomUUID().replaceAll('-', '')}`
      await pool.query(`create table ${table}(label text primary key)`)
      const entered = deferred()
      const finish = deferred()
      const publication = connection.transaction(async (sql) => {
        await sql.query(`insert into ${table} values ('publication')`)
        entered.resolve()
        await finish.promise
      })
      await entered.promise
      let outsideFinished = false
      const outside = owner!.client.query(`insert into ${table} values ('outside')`).then(() => {
        outsideFinished = true
      })
      try {
        // No SQL is pending in the transaction while the outside operation tries to run.
        await readUntil(async () => (await pool.query<{ state: string }>(
          'select state from pg_stat_activity where pid=$1', [Number(fence.ownerId)],
        )).rows[0]?.state, state => state === 'idle in transaction',
        { timeoutMs: 100, description: 'publication transaction waiting for release' })
        expect(outsideFinished).toBe(false)
        expect((await pool.query(`select label from ${table}`)).rows).toEqual([])
      } finally {
        finish.resolve()
        await Promise.all([publication, outside])
      }
      expect((await pool.query(`select label from ${table} order by label`)).rows)
        .toEqual([{ label: 'outside' }, { label: 'publication' }])
    } finally { await owner?.release() }
  })
  it('reads actual PostgreSQL lock ownership rather than echoing an expected fence', async () => {
    const runId = `a3-fence-${randomUUID()}`
    const owner = await RunOwnership.acquire(pool!, runId, () => undefined)
    expect(owner).toBeDefined()
    try {
      const connection = owner!.oneShotConnection()
      await connection.query('select pg_advisory_unlock($1,hashtext($2))', [810002, runId])
      await expect(connection.transaction((sql) => owner!.readOneShotFence(sql))).rejects.toThrow()
    } finally { await owner?.release() }
  })
})
