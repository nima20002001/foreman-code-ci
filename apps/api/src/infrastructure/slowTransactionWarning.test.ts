import { setTimeout as delay } from 'node:timers/promises'
import type pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as diagnostics from '../modules/diagnostics/logger.js'
import { ExclusiveGraphConnection, beforeGraphCommit } from '../modules/run-graph/connection.js'
import { withTransaction } from './transaction.js'

function fakeClient() {
  const query = vi.fn(async () => {
    await delay(5)
    return { rows: [], rowCount: 0 }
  })
  return { query, release: vi.fn() }
}

function captureWarnings() {
  const warn = vi.fn()
  vi.spyOn(diagnostics, 'componentLogger').mockReturnValue({ warn, error: vi.fn(), info: vi.fn() } as never)
  return warn
}

afterEach(() => { vi.restoreAllMocks() })

describe('slow transaction warning', () => {
  it('reports a pooled transaction that waits on non-database work between its queries', async () => {
    const warn = captureWarnings()
    const client = fakeClient()
    await withTransaction({ connect: async () => client as unknown as pg.PoolClient }, async sql => {
      await sql.query('select 1')
      await delay(1_100)
      await sql.query('select 2')
    })
    expect(warn).toHaveBeenCalledOnce()
    const [fields, message] = warn.mock.calls[0]!
    expect(message).toBe('Slow database transaction')
    expect(fields.caller).toEqual(expect.any(String))
    expect(fields.totalMs).toBeGreaterThanOrEqual(1_000)
    expect(fields.betweenQueriesMs).toBeGreaterThanOrEqual(1_000)
    expect(fields.largestGapMs).toBeGreaterThanOrEqual(1_000)
    expect(fields.queryMs).toBeLessThan(fields.betweenQueriesMs)
    // begin and commit are statements of the transaction too
    expect(Number(fields.queries)).toBe(4)
  })

  it('reports a slow Run graph transaction including its commit checks', async () => {
    const warn = captureWarnings()
    const connection = new ExclusiveGraphConnection(fakeClient() as unknown as pg.ClientBase, () => {})
    try {
      await connection.transaction(async sql => {
        await sql.query('select 1')
        beforeGraphCommit(sql, async () => { await delay(1_100); await sql.query('select 2') })
      })
    } finally { await connection.close() }
    expect(warn).toHaveBeenCalledOnce()
    const [fields] = warn.mock.calls[0]!
    expect(fields.caller).toEqual(expect.any(String))
    expect(fields.totalMs).toBeGreaterThanOrEqual(1_000)
    expect(fields.largestGapMs).toBeGreaterThanOrEqual(1_000)
    // begin and commit are statements of the transaction too
    expect(Number(fields.queries)).toBe(4)
  })

  it('stays quiet for a short transaction', async () => {
    const warn = captureWarnings()
    const client = fakeClient()
    await withTransaction({ connect: async () => client as unknown as pg.PoolClient }, async sql => {
      await sql.query('select 1')
    })
    const connection = new ExclusiveGraphConnection(fakeClient() as unknown as pg.ClientBase, () => {})
    try { await connection.transaction(async sql => { await sql.query('select 1') }) } finally { await connection.close() }
    expect(warn).not.toHaveBeenCalled()
  })
})
