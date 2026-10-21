import { afterEach, expect, it, vi } from 'vitest'
import { retryStartupDatabase, runBackgroundPassAtStartup } from './startupDatabase.js'

afterEach(() => { vi.useRealTimers() })

it.each([
  new Error('Query read timeout'),
  new Error('timeout exceeded when trying to connect'),
  new Error('Connection terminated due to connection timeout'),
  new Error('Connection terminated unexpectedly'),
  Object.assign(new Error('statement timed out'), { code: '57014' }),
  Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
  Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
  Object.assign(new Error('connection timed out'), { code: 'ETIMEDOUT' }),
  Object.assign(new Error('database starting'), { code: '57P03' }),
  Object.assign(new Error('database restarting'), { code: '57P01' }),
])('retries a replay-safe startup read after a transient failure: %s', async failure => {
  vi.useFakeTimers()
  const operation = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue('loaded')
  const pending = retryStartupDatabase(operation)
  await vi.advanceTimersByTimeAsync(100)
  await expect(pending).resolves.toBe('loaded')
  expect(operation).toHaveBeenCalledTimes(2)
})

it.each([
  Object.assign(new Error('password authentication failed'), { code: '28P01' }),
  Object.assign(new Error('database does not exist'), { code: '3D000' }),
  Object.assign(new Error('hostname does not exist'), { code: 'ENOTFOUND' }),
  Object.assign(new Error('permission denied'), { code: '42501', cause: new Error('Query read timeout') }),
  Object.assign(new Error('statement canceled by caller'), { code: '57014' }),
  new Error('Invalid startup configuration'),
])('fails a permanent startup error without replaying the operation: %s', async failure => {
  const operation = vi.fn().mockRejectedValue(failure)
  await expect(retryStartupDatabase(operation)).rejects.toBe(failure)
  expect(operation).toHaveBeenCalledOnce()
})

it('cancels startup during backoff without another database operation', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const operation = vi.fn().mockRejectedValue(new Error('Query read timeout'))
  const pending = retryStartupDatabase(operation, { signal: controller.signal }).catch(error => error)
  await vi.advanceTimersByTimeAsync(0)
  const reason = new Error('Startup canceled by shutdown')
  controller.abort(reason)
  expect(await pending).toMatchObject({ name: 'AbortError', cause: reason })
  await vi.advanceTimersByTimeAsync(5_000)
  expect(operation).toHaveBeenCalledOnce()
})

it('checks runtime cancellation before retrying a failed database operation', async () => {
  let closing = false
  const reason = new Error('Runtime is shutting down')
  const operation = vi.fn(async () => {
    closing = true
    throw new Error('Query read timeout')
  })
  await expect(retryStartupDatabase(operation, { check: () => {
    if (closing) throw reason
  } })).rejects.toBe(reason)
  expect(operation).toHaveBeenCalledOnce()
})

it.each([
  new Error('Connection terminated due to connection timeout'),
  new Error('timeout exceeded when trying to connect'),
  new Error('Connection terminated unexpectedly'),
  Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
])('reports a transient failure of a background pass at startup so the next tick retries it: %s', async failure => {
  const report = vi.fn()
  await expect(runBackgroundPassAtStartup(() => Promise.reject(failure), report)).resolves.toBeUndefined()
  expect(report).toHaveBeenCalledExactlyOnceWith(failure)
})

it.each([
  Object.assign(new Error('password authentication failed'), { code: '28P01' }),
  Object.assign(new Error('relation "runs" does not exist'), { code: '42P01' }),
  new Error('Invalid startup configuration'),
])('still fails startup on a permanent background pass error: %s', async failure => {
  const report = vi.fn()
  await expect(runBackgroundPassAtStartup(() => Promise.reject(failure), report)).rejects.toBe(failure)
  expect(report).not.toHaveBeenCalled()
})
