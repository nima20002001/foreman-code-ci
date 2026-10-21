import { describe, expect, it, vi } from 'vitest'
import { acquireDatabaseConnection, withDatabaseReadRetry } from './databaseReadRetry.js'

const timeout = () => new Error('timeout exceeded when trying to connect')

describe('read-only connection acquisition retry', () => {
  it.each([
    'timeout exceeded when trying to connect',
    'Connection terminated due to connection timeout',
  ])('retries %s once and returns the acquired connection', async message => {
    const client = {}
    const acquire = vi.fn().mockRejectedValueOnce(new Error(message)).mockResolvedValue(client)
    await expect(withDatabaseReadRetry(() => acquireDatabaseConnection(acquire))).resolves.toBe(client)
    expect(acquire).toHaveBeenCalledTimes(2)
  })

  it('shares one retry budget across every acquisition in a tool call', async () => {
    const acquire = vi.fn().mockRejectedValueOnce(timeout()).mockResolvedValueOnce({}).mockRejectedValue(timeout())
    await expect(withDatabaseReadRetry(async () => {
      await acquireDatabaseConnection(acquire)
      await acquireDatabaseConnection(acquire)
    })).rejects.toThrow('timeout exceeded when trying to connect')
    expect(acquire).toHaveBeenCalledTimes(3)
  })

  it('does not retry a write acquisition, query timeout or authentication failure', async () => {
    const write = vi.fn().mockRejectedValue(timeout())
    await expect(acquireDatabaseConnection(write)).rejects.toThrow('timeout exceeded')
    expect(write).toHaveBeenCalledOnce()
    for (const error of [new Error('Query read timeout'), Object.assign(new Error('bad password'), { code: '28P01' })]) {
      const acquire = vi.fn().mockRejectedValue(error)
      await expect(withDatabaseReadRetry(() => acquireDatabaseConnection(acquire))).rejects.toBe(error)
      expect(acquire).toHaveBeenCalledOnce()
    }
  })

  it('stops after the second timeout and cancels before retrying', async () => {
    const acquire = vi.fn().mockRejectedValue(timeout())
    await expect(withDatabaseReadRetry(() => acquireDatabaseConnection(acquire))).rejects.toThrow('timeout exceeded')
    expect(acquire).toHaveBeenCalledTimes(2)
    const controller = new AbortController()
    const cancelled = vi.fn(async () => {
      controller.abort(new Error('read canceled'))
      throw timeout()
    })
    await expect(withDatabaseReadRetry(() => acquireDatabaseConnection(cancelled), controller.signal))
      .rejects.toThrow('read canceled')
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it('keeps concurrent read budgets and writes separate', async () => {
    const first = vi.fn().mockRejectedValueOnce(timeout()).mockResolvedValue('first')
    const second = vi.fn().mockRejectedValueOnce(timeout()).mockResolvedValue('second')
    const write = vi.fn().mockRejectedValue(timeout())
    const results = await Promise.allSettled([
      withDatabaseReadRetry(() => acquireDatabaseConnection(first)),
      withDatabaseReadRetry(() => acquireDatabaseConnection(second)),
      acquireDatabaseConnection(write),
    ])
    expect(results.slice(0, 2)).toEqual([
      { status: 'fulfilled', value: 'first' }, { status: 'fulfilled', value: 'second' },
    ])
    expect(results[2]?.status).toBe('rejected')
    expect(write).toHaveBeenCalledOnce()
  })
})
