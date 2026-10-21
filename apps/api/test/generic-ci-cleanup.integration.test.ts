import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { deferred } from './helpers/deferred.js'
import { genericCiRepository } from './helpers/genericCiRepository.js'

it('waits for a pending CI launch before removing its disposable repository', async () => {
  const preparing = deferred()
  const resume = deferred()
  const repository = await genericCiRepository({ beforeLaunch: async () => {
    preparing.resolve()
    await resume.promise
  } })
  let closing: Promise<void> | undefined
  try {
    const [computer] = await repository.endpoint.computers()
    const started = await repository.endpoint.request(computer!, {
      operation: 'start', runId: randomUUID(), repository: 'octo/site',
      commit: repository.commit, suite: 'install', scope: 'full',
    })
    expect(started).toMatchObject({ operation: 'start', run: { state: 'starting' } })
    await preparing.promise
    let closed = false
    closing = repository.close().then(() => { closed = true })
    // This window proves that cleanup does not finish while the launch is blocked.
    // eslint-disable-next-line no-restricted-syntax
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(closed).toBe(false)
    resume.resolve()
    await expect(closing).resolves.toBeUndefined()
  } finally {
    resume.resolve()
    await (closing ?? repository.close())
  }
})
