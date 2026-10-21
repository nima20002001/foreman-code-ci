import { afterEach, expect, it } from 'vitest'
import { CommandAttempt, commandWasRejected } from './commandAttempt'
import { collectManagementPages } from './managementPaging'
import { assertSession, beginSessionChange, finishSessionChange, sessionGeneration, sessionSignal } from './sessionBoundary'

afterEach(() => finishSessionChange())
it('F22 follows all pages and reports a complete catalog', async () => {
  const result = await collectManagementPages(async (cursor) => cursor === undefined
    ? { items: ['first'], pageInfo: { nextCursor: 'more' } }
    : { items: ['last'], pageInfo: { nextCursor: null } })
  expect(result).toEqual({ items: ['first', 'last'], pageInfo: { nextCursor: null } })
})
it('F22 rejects repeated cursors instead of returning partial data', async () => {
  await expect(collectManagementPages(async () => ({ items: [], pageInfo: { nextCursor: 'same' } }))).rejects.toThrow('repeated')
})
it('F24 an uncertain command retries the same identity and values', () => {
  const attempt = new CommandAttempt<{ name: string }>()
  const first = attempt.input({ name: 'Workspace' })
  attempt.failed(new Error('Lost response'))
  expect(attempt.input({ name: 'Workspace' })).toEqual(first)
  expect(() => attempt.input({ name: 'Different' })).toThrow('unknown outcome')
  attempt.succeeded()
  expect(attempt.input({ name: 'Different' }).commandId).not.toBe(first.commandId)
})
it('F27 switching aborts old requests and rejects late responses', () => {
  const generation = sessionGeneration(), signal = sessionSignal()
  beginSessionChange()
  expect(signal.aborted).toBe(true)
  expect(() => assertSession(generation)).toThrow('Operator access changed')
})
it.each([
  [{ code: 'ACCESS_DENIED', status: 403 }, true],
  [{ code: 'REVISION_CONFLICT', status: 409 }, true],
  [{ code: 'INVALID_REQUEST' }, true],
  [{ code: 'INVALID_RESPONSE', status: 400 }, false],
  [{ code: 'HTTP_ERROR', status: 403 }, false],
  [{ code: 'TIMEOUT', status: 408 }, false],
  [{ code: 'BUSY', status: 429 }, false],
  [{ code: 'NETWORK_ERROR', status: 0 }, false],
  [{ code: 'INTERNAL', status: 500 }, false],
] as const)('classifies a command failure and retains ambiguous retries (%j)', (error, rejected) => {
  const attempt = new CommandAttempt<{ name: string }>()
  const input = attempt.input({ name: 'Build settings' })
  attempt.failed(error)
  expect(commandWasRejected(error)).toBe(rejected)
  expect(attempt.unresolved).toBe(!rejected)
  const next = attempt.input({ name: 'Build settings' })
  if (rejected) expect(next.commandId).not.toBe(input.commandId)
  else expect(next).toEqual(input)
})
