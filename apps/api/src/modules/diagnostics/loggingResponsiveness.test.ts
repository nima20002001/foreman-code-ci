import fs from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it.each(['stdout', 'file'])('delivers a ready database reply while the %s log sink is slow', async sink => {
  vi.stubEnv('LOG_LEVEL', 'info')
  vi.resetModules()
  const { logger, enableFileLogging } = await import('./logger.js')
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'logging-responsiveness-'))
  try {
    if (sink === 'file') await enableFileLogging({ LOG_FILE: join(directory, 'api.log') })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const writeSync = fs.writeSync
    vi.spyOn(fs, 'writeSync').mockImplementation((...args: Parameters<typeof fs.writeSync>) => {
      const [fd] = args
      if ((sink === 'stdout' && fd === 1) || (sink === 'file' && fd !== 1)) {
        // A synchronous sink holds the event loop past the pending reply's deadline.
        vi.advanceTimersByTime(21)
      }
      return Reflect.apply(writeSync, fs, args)
    })
    let deadline: ReturnType<typeof setTimeout> | undefined
    const received = new Promise<string>(resolve => queueMicrotask(() => resolve('database reply')))
    const expired = new Promise<string>(resolve => { deadline = setTimeout(() => resolve('read timeout'), 20) })
    const response = Promise.race([received, expired])
    logger.info({ component: 'db', statements: 3 }, 'Database transaction statements')
    expect(await response).toBe('database reply')
    clearTimeout(deadline)
  } finally {
    vi.useRealTimers()
    vi.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
  }
})
