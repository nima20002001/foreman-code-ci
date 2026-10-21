import { afterEach, expect, it, vi } from 'vitest'

import { buildApp } from '../src/app.js'
import { deferred } from './helpers/deferred.js'

afterEach(() => { vi.useRealTimers() })

it('finishes starting when startup work outlasts ten seconds under load', async () => {
  vi.useFakeTimers()
  const app = buildApp({ readiness: {
    database: { ping: async () => undefined },
    checkpoints: { ping: async () => undefined },
  } })
  const startupWork = deferred<void>()
  app.addHook('onReady', () => startupWork.promise)
  const ready = app.ready().then(() => 'ready', (error: unknown) => error)

  await vi.advanceTimersByTimeAsync(15_000)
  startupWork.resolve()

  expect(await ready).toBe('ready')
  await app.close()
})
