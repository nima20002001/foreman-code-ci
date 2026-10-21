import { afterEach, expect, it, vi } from 'vitest'
import { retryDatabaseOperation } from './databaseTimeout.js'
import { readOperationalFailures } from '../modules/diagnostics/logger.js'
import pg from 'pg'
import { EventEmitter } from 'node:events'
import { queryForReadiness } from './pool.js'

vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number, _value: unknown, options: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    const signal = options.signal
    const abort = () => { clearTimeout(timer); reject(signal?.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(undefined) }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  }),
}))

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
it('bounds replay-safe retries and retains their original cause and attempt count', async () => {
  vi.useFakeTimers()
  const failure = Object.assign(new Error('Database unavailable'), { code: 'DATABASE_READ_TIMEOUT' })
  const controller = new AbortController()
  const retry = retryDatabaseOperation(async () => { throw failure }, () => true, { signal: controller.signal })
    .catch(error => error as unknown)
  let settled = false
  void retry.then(() => { settled = true })
  try {
    await vi.advanceTimersByTimeAsync(31_000)
    expect(settled).toBe(true)
    expect(await retry).toMatchObject({ code: 'DATABASE_RETRY_DEADLINE_EXCEEDED', cause: failure })
    expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'retry database operation',
      lastError: 'DATABASE_READ_TIMEOUT', failureCount: expect.any(Number) }))
  } finally {
    controller.abort()
    await retry
  }
})

it('reports cancel transport failure while preserving the original aborted query', async () => {
  const failure = Object.assign(new Error('Cancel unavailable'), { code: 'ECONNREFUSED' })
  vi.spyOn(pg.Client.prototype, 'connect').mockRejectedValue(failure)
  vi.spyOn(pg.Client.prototype, 'end').mockResolvedValue(undefined)
  const controller = new AbortController()
  const primary = new Error('Original query aborted')
  const client = Object.assign(new EventEmitter(), { processID: 123,
    connection: { stream: { destroy: () => undefined } }, release: () => undefined,
    query: async () => { controller.abort(); throw primary } })
  const pool = { options: {}, connect: async () => client } as unknown as pg.Pool
  await expect(queryForReadiness(pool, 'select 1', controller.signal)).rejects.toBe(primary)
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'cancel original database query',
    lastError: 'ECONNREFUSED', failureCount: 1 }))
})
