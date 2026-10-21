import { expect, it } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { createAdmittedNativeManager } from './admittedManager.js'

it('cancels an admission that has not produced an allocation when disposal starts', async () => {
  const entered = deferred()
  let attempts = 0
  const admitted = createAdmittedNativeManager('codex', signal => {
    attempts++
    entered.resolve()
    return new Promise<never>((_resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  })
  const opening = admitted.manager.capabilities().then(value => value, error => error)
  await entered.promise
  await admitted.manager.dispose!()
  expect(await opening).toMatchObject({ code: 'NATIVE_MANAGER_DISPOSED' })
  await expect(admitted.manager.capabilities()).rejects.toMatchObject({ code: 'NATIVE_MANAGER_DISPOSED' })
  expect(attempts).toBe(1)
})
