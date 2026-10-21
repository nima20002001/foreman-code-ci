import pg from 'pg'
import { expect, it, vi } from 'vitest'
import type { GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { agent3Database } from './helpers/wave25Agent3.js'
import { holdPostgresResponses } from './helpers/postgresResponses.js'

it('allows the rollback fault fixture to acquire, exclude and replace a real Run owner', async () => {
  const db = await agent3Database()
  const responses = await holdPostgresResponses(process.env.TEST_DATABASE_URL!)
  const pool = new pg.Pool({ ...db.pool.options, query_timeout: 100 })
  let owner: RunOwnership | undefined
  let replacement: RunOwnership | undefined
  try {
    owner = await RunOwnership.acquire(pool, 'rollback-fixture-owner', () => undefined)
    if (!owner) throw new Error('Expected the original Run owner')
    expect((await owner.client.query('select 1 as usable')).rows).toEqual([{ usable: 1 }])
    expect(await RunOwnership.acquire(db.pool, owner.runId, () => undefined)).toBeUndefined()
    await owner.release()
    replacement = await RunOwnership.acquire(db.pool, owner.runId, () => undefined)
    if (!replacement) throw new Error('Expected the replacement Run owner')
    expect((await replacement.client.query('select 1 as usable')).rows).toEqual([{ usable: 1 }])
  } finally {
    await owner?.release()
    await replacement?.release()
    await pool.end()
    responses.close()
    await db.close()
  }
}, 60_000)

it('releases a real Run owner and its advisory lock while rollback replies remain unavailable', async () => {
  const db = await agent3Database()
  const responses = await holdPostgresResponses(process.env.TEST_DATABASE_URL!)
  const pool = new pg.Pool({ ...db.pool.options, query_timeout: 100 })
  const lost = vi.fn()
  let owner: RunOwnership | undefined
  let replacement: RunOwnership | undefined
  try {
    owner = await RunOwnership.acquire(pool, 'rollback-owner', lost)
    if (!owner) throw new Error('Expected the original Run owner')
    const runId = owner.runId
    const connection = owner.oneShotConnection()
    let queryFailure: unknown
    const work = vi.fn(async (sql: GraphTransactionSql) => {
      await sql.query('select 1')
      responses.hold()
      try {
        await sql.query('select 2')
      } catch (error) {
        queryFailure = error
        throw error
      }
    })
    const failed = connection.transaction(work).catch(error => error)
    const queued = connection.query('select 3').catch(error => error)
    await vi.waitFor(() => expect(queryFailure).toMatchObject({ message: 'Query read timeout' }),
      { timeout: 3_000, interval: 10 })
    await owner.release()
    expect(await failed).toMatchObject({ message: 'Query read timeout' })
    expect(await queued).toMatchObject({ code: 'GRAPH_TRANSACTION_FAILED' })
    expect(connection.unusable).toBe(true)
    expect(work).toHaveBeenCalledOnce()
    await vi.waitFor(async () => {
      replacement ??= await RunOwnership.acquire(db.pool, runId, () => undefined)
      expect(replacement).toBeDefined()
    }, { timeout: 3_000, interval: 10 })
    expect((await replacement!.client.query('select 1 as usable')).rows).toEqual([{ usable: 1 }])
  } finally {
    await owner?.release()
    await replacement?.release()
    await pool.end()
    responses.close()
    await db.close()
  }
}, 60_000)
