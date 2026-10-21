import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const state = process.argv[2]
assert.ok(state && state.startsWith('/') && process.connected)
const origin = new URL(process.env.FOREMAN_CODE_BROWSER_ORIGIN)
const api = new URL(process.env.VITE_API_URL)
for (const url of [origin, api]) {
  assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port
    && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash)
}
const web = join(root, 'apps/web')
const require = createRequire(join(web, 'package.json'))
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href)
let server
let stopping
const shutdown = () => {
  stopping ??= (async () => {
    await server?.close()
    if (process.connected) await new Promise(sent => process.send({ type: 'closed' }, sent))
    if (process.connected) process.disconnect()
    // Vite's watcher can still register fs watchers after close; they would keep this disposable process alive.
    process.exit(0)
  })()
  void stopping.catch(error => {
    console.error(error)
    process.exitCode = 1
    if (process.connected) process.disconnect()
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('disconnect', shutdown)
try {
  server = await createServer({ root: web, configFile: join(web, 'vite.config.ts'),
    envDir: join(state, 'empty-web-env'), cacheDir: join(state, 'vite-cache'), logLevel: 'error',
    server: { host: '127.0.0.1', port: Number(origin.port), strictPort: true, open: false } })
  if (stopping) await server.close()
  else {
    await server.listen()
    process.send({ type: 'ready', origin: origin.origin })
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
  await server?.close()
  if (process.connected) process.disconnect()
}
