import { afterEach, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { logger, readOperationalFailures } from './logger.js'
import { fallbackOnError, ignoreError, logIgnoredError } from './ignoredError.js'
import { withConversationPageRead } from '../conversations/activityCursor.js'

afterEach(() => { vi.restoreAllMocks() })

function captureLogs() {
  const lines: Array<{ fields: Record<string, unknown>; message: string }> = []
  vi.spyOn(logger, 'child').mockImplementation((bindings) => {
    const record = (fields: Record<string, unknown>, message: string) => {
      lines.push({ fields: { ...bindings, ...fields }, message })
    }
    // Transaction statement metrics are info records, not the failures captured here.
    return { warn: record, error: record, info: () => undefined } as unknown as ReturnType<typeof logger.child>
  })
  return lines
}

it('logs an ignored failure with component, operation, ids and error, then resolves to undefined', async () => {
  const lines = captureLogs()
  const failure = new Error('rollback refused')
  await expect(Promise.reject(failure).catch(ignoreError('db', 'transaction rollback', { commandId: 'command-1' }))).resolves.toBeUndefined()
  expect(lines).toHaveLength(1)
  expect(lines[0]!.message).toBe('Ignored failure of transaction rollback')
  expect(lines[0]!.fields).toMatchObject({
    component: 'db', operation: 'transaction rollback', commandId: 'command-1', err: failure,
  })
})

it('keeps expected error codes silent and resolves to the fallback', async () => {
  const lines = captureLogs()
  const missing = Object.assign(new Error('gone'), { code: 'ENOENT' })
  await expect(Promise.reject(missing).catch(fallbackOnError(null, 'jobs', 'read exit file', {}, ['ENOENT']))).resolves.toBeNull()
  expect(lines).toHaveLength(0)
  await expect(Promise.reject(new Error('denied')).catch(fallbackOnError(null, 'jobs', 'read exit file', {}, ['ENOENT']))).resolves.toBeNull()
  expect(lines).toHaveLength(1)
})

it('does not suppress other cleanup failures or change the fallback object', async () => {
  const lines = captureLogs()
  const fallback = { stopped: false }
  const failure = Object.assign(new Error('permission denied'), { code: 'EPERM' })
  await expect(Promise.reject(failure).catch(fallbackOnError(
    fallback, 'harness', 'kill process group', { pid: 123 }, ['ESRCH'],
  ))).resolves.toBe(fallback)
  expect(lines[0]!.fields).toMatchObject({ component: 'harness', pid: 123, err: failure })
})

it('retains non-Error rejections while throttling repeated cleanup warnings', () => {
  const lines = captureLogs()
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now)
  logIgnoredError('jobs', 'close helper', null)
  logIgnoredError('jobs', 'close helper', 'close failed')
  expect(lines.map(line => line.fields.err)).toEqual([null])
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({
    component: 'jobs', operation: 'close helper', lastError: 'OPERATION_FAILED', failureCount: 2,
  }))
  vi.mocked(Date.now).mockReturnValue(now + 30_000)
  logIgnoredError('jobs', 'close helper', 'close failed')
  expect(lines.map(line => line.fields.err)).toEqual([null, 'close failed'])
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({
    component: 'jobs', operation: 'close helper', lastError: 'OPERATION_FAILED', failureCount: 3,
  }))
})

it('reports failed rollback, releases the client and preserves the original read error', async () => {
  const lines = captureLogs()
  const readFailure = new Error('read failed')
  const rollbackFailure = new Error('connection closed')
  const release = vi.fn()
  const client = {
    query: vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(rollbackFailure),
    release,
  }
  const pool = { connect: async () => client } as unknown as pg.Pool
  await expect(withConversationPageRead(pool, async () => { throw readFailure })).rejects.toBe(readFailure)
  expect(release).toHaveBeenCalledOnce()
  expect(release).toHaveBeenCalledWith(rollbackFailure)
  expect(lines).toHaveLength(1)
  expect(lines[0]!.message).toBe('Transaction rollback failed; discarding its connection')
  expect(lines[0]!.fields).toMatchObject({
    component: 'db', operation: 'transaction rollback', err: rollbackFailure,
  })
})
