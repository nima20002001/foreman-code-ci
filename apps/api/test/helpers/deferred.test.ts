import { expect, it } from 'vitest'
import { deferred, rejectableDeferred } from './deferred.js'

it('keeps a resolve-only gate pending until the caller resolves it', async () => {
  const gate = deferred<number>()
  let settled = false
  const result = gate.promise.then(value => {
    settled = true
    return value
  })
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(gate).not.toHaveProperty('reject')
  gate.resolve(Promise.resolve(42))
  expect(await result).toBe(42)
})

it('supports void gates and preserves rejection identity', async () => {
  const gate = deferred()
  gate.resolve()
  await expect(gate.promise).resolves.toBeUndefined()

  const failed = rejectableDeferred()
  const error = new Error('Interrupted')
  const rejection = expect(failed.promise).rejects.toBe(error)
  failed.reject(error)
  await rejection
})
