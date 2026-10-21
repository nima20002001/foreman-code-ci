import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { retryStartupDatabase } from '../src/infrastructure/startupDatabase.js'

const requireStatic = createRequire(createRequire(import.meta.url).resolve('@fastify/static'))
const glob = requireStatic('glob') as { glob: (...args: unknown[]) => Promise<string[]> }
const originalGlob = glob.glob
const cleanup: (() => Promise<unknown>)[] = []
let slowDiscovery = false

// The plugin uses CommonJS and captures glob when it is first imported.
glob.glob = async (...args) => {
  if (slowDiscovery) await delay(11_000)
  return originalGlob(...args)
}
const { registerBuiltWeb } = await import('../src/builtWeb.js')

afterAll(() => { glob.glob = originalGlob })

afterEach(async () => {
  slowDiscovery = false
  for (const close of cleanup.splice(0).reverse()) await close()
})

it('starts with a slow static directory dependency and retries transient startup reads', async () => {
  const temporaryRoot = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(temporaryRoot, { recursive: true })
  const root = await mkdtemp(join(temporaryRoot, 'web-startup-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Application</title>')
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'assets/app.js'), 'console.log("ready")')
  const app = buildApp({ readiness: {
    database: { ping: async () => undefined },
    checkpoints: { ping: async () => undefined },
  } })
  cleanup.push(() => app.close())
  await registerBuiltWeb(app, root)

  slowDiscovery = true
  const read = vi.fn().mockRejectedValueOnce(new Error('Query read timeout')).mockImplementation(async () => {
    await delay(25)
    return 'loaded'
  })
  const initialization = retryStartupDatabase(read)
  expect(await initialization).toBe('loaded')
  expect(read).toHaveBeenCalledTimes(2)

  const listening = app.listen({ host: '127.0.0.1', port: 0 }).catch(error => error)
  const address = await listening
  expect(address).toEqual(expect.any(String))
  expect((await app.inject('/health/live')).statusCode).toBe(200)
  expect((await app.inject('/')).body).toContain('<title>Application</title>')
  expect((await app.inject('/assets/app.js')).statusCode).toBe(200)
  for (const url of ['/api/missing', '/mcp', '/health/missing', '/assets/missing.js',
    '/assets/%2e%2e/%2e%2e/package.json']) {
    const response = await app.inject({ url, headers: { accept: 'text/html' } })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
  }
})
