import { removeFixtureDirectory } from './helpers/testResources.js'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { resolveProductEnvironment } from '@foreman-code/contracts/product-environment'
import { createDatabase } from '../src/infrastructure/database.js'
import { readRuntimeIdentity } from '../src/infrastructure/runtimeIdentity.js'

it('rejects reuse of a matching API that still trusts a different browser port', async () => {
  const connectionString = process.env.TEST_DATABASE_URL!
  const database = createDatabase({ connectionString, maxConnections: 2, connectionTimeoutMs: 5000, queryTimeoutMs: 5000 })
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const directory = await mkdtemp(join(tmpdir(), 'startup-origin-'))
  const observed: Array<string | undefined> = []
  let coordinator: ReturnType<typeof spawn> | undefined
  await database.migrate()
  const identity = await readRuntimeIdentity(database.pool, root, connectionString)
  const api = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/api/local-human') {
      observed.push(request.headers.origin)
      // Like the real local dev gate, originless probes succeed. A different
      // explicit browser origin must fail even though all identity fields match.
      if (request.headers.origin && request.headers.origin !== 'http://127.0.0.1:1') {
        response.statusCode = 403
        response.end(JSON.stringify({ error: { code: 'CSRF_ORIGIN_NOT_ALLOWED' } }))
      } else response.end(JSON.stringify({ principal: { id: "local-human" } }))
    } else if (request.url === '/health/identity') response.end(JSON.stringify(identity))
    else response.end(JSON.stringify({ status: 'ok', service: 'graphql-api' }))
  })
  try {
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
    const address = api.address()
    if (!address || typeof address === 'string') throw new Error('No API address')
    const frontend = createServer()
    await new Promise<void>((resolve) => frontend.listen(0, '127.0.0.1', resolve))
    const frontendAddress = frontend.address()
    if (!frontendAddress || typeof frontendAddress === 'string') throw new Error('No frontend address')
    const browserOrigin = `http://127.0.0.1:${frontendAddress.port}`
    await new Promise<void>((resolve) => frontend.close(() => resolve()))
    const file = join(directory, 'api.env')
    await writeFile(file, `DATABASE_URL=${connectionString}\nPORT=${address.port}\nHOST=127.0.0.1\nFOREMAN_CODE_BROWSER_ORIGIN=${browserOrigin}\nFOREMAN_CODE_WEB_PORT=${frontendAddress.port}\n`, { mode: 0o600 })
    const environment = resolveProductEnvironment(process.env)
    for (const key of ['DATABASE_URL', 'PORT', 'HOST', 'FOREMAN_CODE_API_ENV_FILE', 'GRAPHQL_API_ENV_FILE',
      'FOREMAN_CODE_BROWSER_ORIGIN', 'GRAPHQL_BROWSER_ORIGIN', 'FOREMAN_CODE_WEB_PORT', 'GRAPHQL_WEB_PORT']) {
      delete environment[key]
    }
    coordinator = spawn('corepack', ['pnpm', 'dev'], { cwd: root,
      env: { ...environment, FOREMAN_CODE_API_ENV_FILE: file }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    coordinator.stdout?.on('data', (data: Buffer) => { output += data.toString() })
    coordinator.stderr?.on('data', (data: Buffer) => { output += data.toString() })
    const code = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Startup did not reject the incompatible API')), 20_000)
      coordinator!.once('error', (error) => { clearTimeout(timeout); reject(error) })
      coordinator!.once('exit', (value) => { clearTimeout(timeout); resolve(value) })
    })
    expect(code).toBe(1)
    expect(output).toContain(`does not accept local browser access from ${browserOrigin}`)
    expect(output).not.toContain('Foreman Code ready:')
    expect(observed).toContain(browserOrigin)
    expect(api.listening).toBe(true)
  } finally {
    if (coordinator?.pid) { try { coordinator.kill('SIGTERM') } catch { /* Already exited. */ } }
    await new Promise<void>((resolve) => api.close(() => resolve()))
    await database.close()
    await removeFixtureDirectory(directory)
  }
}, 30_000)
