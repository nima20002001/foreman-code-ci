import { diagnosticWarning } from './diagnostic-warning.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveProductEnvironment } from '../packages/contracts/src/productEnvironment.mjs'

import { ownedTestDatabaseUrl } from './test-resources.mjs'

const databaseUrl = ownedTestDatabaseUrl()
const testDbScript = fileURLToPath(new URL('./test-db.mjs', import.meta.url))
const root = fileURLToPath(new URL('../', import.meta.url))
const apiDirectory = fileURLToPath(new URL('../apps/api/', import.meta.url))
const run = promisify(execFile)
const restartPostgres = process.argv.includes('--restart-postgres')
const probe = createServer()
probe.listen(0, '127.0.0.1')
await once(probe, 'listening')
const port = probe.address().port
const origin = `http://127.0.0.1:${port}`
await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))

const manifest = JSON.parse(await readFile(new URL('../apps/api/package.json', import.meta.url), 'utf8'))
const [runtime, ...args] = manifest.scripts.start.split(' ')
assert.equal(runtime, 'node')
assert.deepEqual(args, ['dist/server.js'], 'Production must run compiled JavaScript without a TS loader')
const state = await mkdtemp(join(homedir(), '.foreman-code-production-smoke-'))
const environment = resolveProductEnvironment(process.env)
const child = spawn(process.execPath, args, {
  cwd: apiDirectory,
  env: {
    ...environment,
    HOST: '127.0.0.1',
    PORT: String(port),
    FOREMAN_CODE_BROWSER_ORIGIN: origin,
    DATABASE_URL: databaseUrl,
    DATABASE_CONNECTION_TIMEOUT_MS: '250',
    DATABASE_QUERY_TIMEOUT_MS: '1000',
    READINESS_TIMEOUT_MS: '1000',
    LANGGRAPH_CHECKPOINT_SCHEMA: 'langgraph_production_smoke',
    HARNESS_WORKSPACE_ROOT: process.env.HARNESS_WORKSPACE_ROOT ?? join(state, 'runtime'),
    WORKSPACE_STORAGE_ROOT: process.env.WORKSPACE_STORAGE_ROOT ?? join(state, 'workspaces'),
    FILE_STORAGE_ROOT: process.env.FILE_STORAGE_ROOT ?? join(state, 'files'),
    FOREMAN_CODE_APP_MCP_DIRECTORY: environment.FOREMAN_CODE_APP_MCP_DIRECTORY ?? join(state, 'mcp'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
child.stdout.on('data', (chunk) => { output += chunk })
child.stderr.on('data', (chunk) => { output += chunk })
const exited = new Promise((resolve) => {
  child.once('exit', (code, signal) => resolve({ code, signal }))
  child.once('error', (error) => resolve({ error }))
})

async function request(path, options = {}) {
  const response = await fetch(`${origin}${path}`, {
    ...options, headers: { origin, ...options.headers }, credentials: 'omit', signal: AbortSignal.timeout(2000),
  })
  return { status: response.status, body: await response.json() }
}

async function waitForReady() {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, `API exited before readiness:\n${output}`)
    assert.equal(child.signalCode, null, `API was terminated:\n${output}`)
    try {
      const response = await request('/health/ready')
      if (response.status === 200) {
        assert.deepEqual(response.body.checks, { database: 'ok', checkpoints: 'ok' })
        return
      }
    } catch (error) {
      if (error.cause?.code !== 'ECONNREFUSED') diagnosticWarning('read startup smoke readiness', error)
    }
    await delay(50)
  }
  throw new Error(`API never became ready:\n${output}`)
}

let postgresStopped = false
try {
  await waitForReady()
  assert.equal((await request('/health/live')).status, 200)
  if (environment.FOREMAN_CODE_WEB_DIST) {
    const dashboard = await fetch(`http://127.0.0.1:${port}/workspaces`, {
      credentials: 'omit', signal: AbortSignal.timeout(2000),
    })
    assert.equal(dashboard.status, 200)
    assert.match(dashboard.headers.get('content-type'), /text\/html/)
    assert.match(await dashboard.text(), /\/assets\//)
    for (const path of ['/sign-in', '/setup']) assert.equal((await request(path)).status, 404)
    console.log('Compiled local dashboard: /workspaces=200; retired authentication pages=404')
  }
  const human = await request('/api/local-human')
  assert.equal(human.status, 200)
  assert.equal(human.body.principal.id, 'principal-local-human')
  const created = await request('/api/management/workspaces', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: randomUUID(), name: `Local HTTP smoke ${randomUUID()}` }),
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const workspace = created.body.value
  const workspaceId = workspace.workspace.id
  const workspacePath = `/api/management/workspaces/${encodeURIComponent(workspaceId)}`
  try {
    for (const suffix of ['root-location', 'root-policies']) {
      const response = await request(`${workspacePath}/${suffix}`)
      assert.equal(response.status, 200, JSON.stringify(response.body))
      assert.equal(response.body.workspaceId, workspaceId)
      assert.equal((await request(`${workspacePath}/${suffix}`, {
        headers: { authorization: 'Bearer invalid' },
      })).status, 401)
      assert.equal((await request(`${workspacePath}/${suffix}`, {
        headers: { origin: 'http://127.0.0.1:9999' },
      })).status, 403)
    }
    console.log('Unauthenticated local HTTP: root-location=200, root-policies=200; invalid bearer=401')
  } finally {
    const archived = await request(workspacePath, {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: randomUUID(), expectedRevision: workspace.revision }),
    })
    assert.equal(archived.status, 200, JSON.stringify(archived.body))
  }
  if (restartPostgres) {
    // Restart the dedicated test dependency while retaining this invocation's database.
    await delay(50)
    postgresStopped = true
    await run(process.execPath, [testDbScript, 'stop'], { cwd: root, timeout: 30000 })
    assert.equal((await request('/health/live')).status, 200)
    const started = Date.now()
    const readiness = await request('/health/ready')
    assert.equal(readiness.status, 503)
    assert.deepEqual(readiness.body.checks, { database: 'unavailable', checkpoints: 'unavailable' })
    assert.ok(Date.now() - started < 2000, 'Readiness must have a deadline')
    assert.equal(child.exitCode, null, `API crashed during database restart:\n${output}`)
    await run(process.execPath, [testDbScript, 'up'], { cwd: root, timeout: 60000 })
    postgresStopped = false
    await waitForReady()
  }
  console.log(`Production start passed on ${process.version}${restartPostgres ? ' with PostgreSQL restart/recovery' : ''}`)
} catch (error) {
  console.error(output)
  throw error
} finally {
  if (postgresStopped) {
    await run(process.execPath, [testDbScript, 'up'], { cwd: root, timeout: 60000 })
      .catch((error) => console.error('Could not restart test PostgreSQL:', error.message))
  }
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  await exited
  clearTimeout(timer)
  await rm(state, { recursive: true, force: true })
}
