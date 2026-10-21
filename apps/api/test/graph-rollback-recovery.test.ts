import type pg from 'pg'
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { ExclusiveGraphConnection, withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'

const connections: ExclusiveGraphConnection[] = []
afterEach(async () => {
  await Promise.all(connections.splice(0).map(connection => connection.close()))
  vi.useRealTimers()
})

function connectionFixture(rollback: () => Promise<unknown>) {
  const failure = new Error('Query read timeout')
  const end = vi.fn(async () => undefined)
  const raw = { end, query: async (statement: string) => {
    if (statement === 'rollback') return rollback()
    return { rows: [], rowCount: 0 }
  } } as unknown as pg.ClientBase
  const connection = new ExclusiveGraphConnection(raw, () => undefined)
  connections.push(connection)
  const work = vi.fn(async () => { throw failure })
  return { connection, work, failure, end }
}

it('abandons repeated rollback timeouts and rejects queued work without replaying the callback', async () => {
  vi.useFakeTimers()
  const f = connectionFixture(async () => { throw new Error('Query read timeout') })
  let settled = false
  const failed = f.connection.transaction(f.work).catch(error => { settled = true; return error })
  const queued = f.connection.query('select 1').catch(error => error)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(settled).toBe(true)
  expect(await failed).toBe(f.failure)
  expect(await queued).toMatchObject({ code: 'GRAPH_TRANSACTION_FAILED' })
  expect(f.end).toHaveBeenCalledOnce()
  expect(f.connection.unusable).toBe(true)
  expect(f.work).toHaveBeenCalledOnce()
})

it('lets close interrupt rollback recovery even when the rollback reply never arrives', async () => {
  vi.useFakeTimers()
  const f = connectionFixture(() => new Promise(() => undefined))
  const failed = f.connection.transaction(f.work).catch(error => error)
  await vi.advanceTimersByTimeAsync(0)
  let closed = false
  const closing = f.connection.close().then(() => { closed = true })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(closed).toBe(true)
  await closing
  expect(await failed).toBe(f.failure)
  expect(f.end).toHaveBeenCalledOnce()
})

it('keeps a connection healthy when one rollback timeout is followed by confirmation', async () => {
  vi.useFakeTimers()
  const rollback = vi.fn().mockRejectedValueOnce(new Error('Query read timeout'))
    .mockResolvedValue({ rows: [], rowCount: 0 })
  const f = connectionFixture(rollback)
  const failed = f.connection.transaction(f.work).catch(error => error)
  await vi.advanceTimersByTimeAsync(500)
  expect(await failed).toBe(f.failure)
  expect(f.connection.unusable).toBe(false)
  expect(f.end).not.toHaveBeenCalled()
  await expect(f.connection.query('select 1')).resolves.toMatchObject({ rows: [] })
})

it('discards a pooled lease when rollback recovery cannot confirm the transaction', async () => {
  const failure = new Error('Transaction failed')
  const release = vi.fn()
  const raw = Object.assign(new EventEmitter(), { release, query: async (statement: string) => {
    if (statement === 'rollback') throw new Error('Rollback failed')
    return { rows: [], rowCount: 0 }
  } }) as unknown as pg.PoolClient
  const pool = { connect: async () => raw } as unknown as pg.Pool
  await expect(withExclusiveGraphConnection(pool, connection =>
    connection.transaction(async () => { throw failure }))).rejects.toBe(failure)
  expect(release).toHaveBeenCalledWith(true)
  expect(release).toHaveBeenCalledOnce()
})
