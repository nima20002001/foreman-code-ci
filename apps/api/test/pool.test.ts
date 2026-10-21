import { EventEmitter } from 'node:events'

import pg from 'pg'
import { describe, expect, it, vi } from 'vitest'

import { createPool, queryForReadiness } from '../src/infrastructure/pool.js'
import { withDatabaseReadRetry } from '../src/infrastructure/databaseReadRetry.js'

const connectionString = 'postgresql://graphql:graphql@127.0.0.1:5432/graphql'

describe('PostgreSQL probe cleanup', () => {
  it('bounds acquisition behind a held connection to one second', async () => {
    // Mock the driver's network boundary; the real pool owns the lease and queue.
    const connect = vi.spyOn(pg.Client.prototype, 'connect').mockImplementation(function (
      this: pg.Client, callback: Parameters<pg.Client['connect']>[0],
    ) {
      queueMicrotask(() => Reflect.apply(callback, this, [null, this]))
    })
    const pool = createPool({
      connectionString,
      maxConnections: 1, connectionTimeoutMs: 10_000,
    }, 'busy-pool')
    let held: pg.PoolClient | undefined
    try {
      held = await pool.connect()
      const started = performance.now()
      await expect(pool.connect()).rejects.toThrow('timeout exceeded when trying to connect')
      expect(performance.now() - started).toBeLessThan(2500)
      expect(pool.waitingCount).toBe(0)
      held.release()
      held = undefined
      const next = await pool.connect()
      next.release()
    } finally {
      held?.release()
      await pool.end()
      connect.mockRestore()
    }
  })

  it('retries Promise and callback acquisitions only inside a read-only scope', async () => {
    const release = vi.fn()
    const client = { release } as unknown as pg.PoolClient
    const connections = vi.fn<() => Promise<pg.PoolClient>>()
      .mockRejectedValueOnce(new Error('timeout exceeded when trying to connect'))
      .mockResolvedValue(client)
    const acquire = vi.spyOn(pg.Pool.prototype, 'connect').mockImplementation(() => connections())
    const pool = createPool({ connectionString, maxConnections: 1, connectionTimeoutMs: 100 }, 'retry-pool')
    try {
      await expect(withDatabaseReadRetry(() => pool.connect())).resolves.toBe(client)
      expect(acquire).toHaveBeenCalledTimes(2)
      acquire.mockClear()
      connections.mockRejectedValueOnce(new Error('Connection terminated due to connection timeout'))
      await withDatabaseReadRetry(() => new Promise<void>((resolve, reject) => {
        pool.connect((error, acquired, done) => {
          if (error) { reject(error); return }
          expect(acquired).toBe(client)
          done()
          resolve()
        })
      }))
      expect(acquire).toHaveBeenCalledTimes(2)
      expect(release).toHaveBeenCalledOnce()
      acquire.mockClear()
      connections.mockRejectedValue(new Error('timeout exceeded when trying to connect'))
      await expect(pool.connect()).rejects.toThrow('timeout exceeded')
      expect(acquire).toHaveBeenCalledOnce()
    } finally {
      acquire.mockRestore()
      await pool.end()
    }
  })

  it('handles and reports idle pool errors without throwing', async () => {
    const onError = vi.fn()
    const pool = createPool({
      connectionString, maxConnections: 1, connectionTimeoutMs: 100, onError,
    }, 'test-pool')
    try {
      const error = new Error('database restarted')
      expect(() => pool.emit('error', error)).not.toThrow()
      expect(onError).toHaveBeenCalledWith(error)
    } finally {
      await pool.end()
    }
  })

  it('returns a healthy lease acquired after cancellation without executing a query', async () => {
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(), release: vi.fn(),
    })
    let acquire!: (client: pg.PoolClient) => void
    const pool = {
      connect: () => new Promise<pg.PoolClient>((resolve) => { acquire = resolve }),
    } as unknown as pg.Pool
    const controller = new AbortController()
    const work = queryForReadiness(pool, 'select 1', controller.signal)
    let settled = false
    void work.then(() => { settled = true }, () => { settled = true })
    controller.abort(new Error('probe aborted'))
    await Promise.resolve()
    expect(settled).toBe(false)
    acquire(client as unknown as pg.PoolClient)
    await expect(work).rejects.toThrow('probe aborted')
    expect(client.query).not.toHaveBeenCalled()
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false)
    expect(client.listenerCount('error')).toBe(0)
  })

  it('destroys an active canceled query exactly once', async () => {
    let rejectQuery!: (error: Error) => void
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(() => new Promise<void>((_resolve, reject) => { rejectQuery = reject })),
      release: vi.fn((destroy: boolean) => {
        if (destroy) rejectQuery(new Error('connection destroyed'))
      }),
    })
    const pool = { connect: async () => client } as unknown as pg.Pool
    const controller = new AbortController()
    const work = queryForReadiness(pool, 'select 1', controller.signal)
    const rejected = expect(work).rejects.toThrow('connection destroyed')
    await vi.waitFor(() => expect(client.query).toHaveBeenCalledOnce())
    controller.abort()
    await rejected
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
    expect(client.listenerCount('error')).toBe(0)
  })
})
