import { readProductEnvironment } from '../packages/contracts/src/productEnvironment.mjs'
import { createRequire } from 'node:module'
import { apiIdentityMatches, webIdentityMatches } from './dev-identity.mjs'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, copyFile, chmod } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { loadProductEnvFile } from '../packages/contracts/src/productEnvironmentNode.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const customApiEnv = readProductEnvironment(process.env, 'API_ENV_FILE')
const apiEnv = customApiEnv ?? join(root, 'apps/api/.env')
const children = []
let stopping = false

function stop() {
  if (stopping) return
  stopping = true
  for (const { child } of children) {
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* Already stopped. */ }
  }
}

function start(name, args, options = {}) {
  const child = spawn('corepack', ['pnpm', ...args], {
    cwd: root, stdio: 'inherit', detached: true, ...options,
  })
  child.on('error', (error) => { console.error(`${name}: ${error.message}`) })
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ name, code, signal }))
  })
  children.push({ name, child, exited })
  return child
}

async function run(name, args) {
  const child = spawn('corepack', ['pnpm', ...args], { cwd: root, stdio: 'inherit' })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (exitCode) => resolve(exitCode))
  })
  if (code !== 0) throw new Error(`${name} failed (exit ${code}).`)
}

async function listening(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false) })
  })
}

async function responds(url, accepts) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
    return accepts(response, await response.text())
  } catch (error) {
    if (error.cause?.code !== 'ECONNREFUSED') diagnosticWarning('read development readiness', error)
    return false
  }
}

export async function runningApiAcceptsBrowserOrigin(apiUrl, browserOrigin, request = fetch) {
  try {
    const response = await request(`${apiUrl}/api/local-human`, {
      headers: { origin: browserOrigin }, signal: AbortSignal.timeout(2000),
    })
    return response.ok && Boolean(JSON.parse(await response.text()).principal)
  } catch (error) {
    if (error.cause?.code !== 'ECONNREFUSED') diagnosticWarning('read browser origin readiness', error, 'INVALID_READINESS_RESPONSE')
    return false
  }
}

async function waitFor(name, url, accepts, child) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && !stopping) {
    if (await responds(url, accepts)) return
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`${name} stopped before becoming ready.`)
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`${name} did not become ready at ${url}.`)
}

async function main() {
  if (customApiEnv && !isAbsolute(customApiEnv)) throw new Error('FOREMAN_CODE_API_ENV_FILE must be an absolute path.')
  try {
    await access(apiEnv)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    if (customApiEnv) throw new Error(`FOREMAN_CODE_API_ENV_FILE does not exist: ${apiEnv}`)
    await copyFile(join(root, 'apps/api/.env.example'), apiEnv, constants.COPYFILE_EXCL)
    await chmod(apiEnv, 0o600)
    console.log('Created apps/api/.env from the local example.')
  }
  process.env.FOREMAN_CODE_API_ENV_FILE = apiEnv
  loadProductEnvFile(apiEnv)
  const port = Number(process.env.PORT ?? 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.')
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing from apps/api/.env.')
  const database = new URL(process.env.DATABASE_URL)
  const apiUrl = `http://127.0.0.1:${port}`
  await run('Contracts build', ['--filter', '@foreman-code/contracts', 'build'])
  const { resolveLocalBrowserOrigin } = await import('../packages/contracts/dist/browserOrigin.js')
  const { createRuntimeIdentity } = await import('../packages/contracts/dist/runtimeIdentityNode.js')
  const browser = resolveLocalBrowserOrigin(process.env)
  process.env.FOREMAN_CODE_BROWSER_ORIGIN = browser.origin
  const webUrl = browser.origin
  const { Client } = createRequire(join(root, 'apps/api/package.json'))('pg')
  async function expectedIdentity() {
    const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000, query_timeout: 2000 })
    try {
      await client.connect()
      const result = await client.query('select id from application_installation where singleton = true')
      if (!result.rows[0]?.id) throw new Error('Missing installation identity')
      return createRuntimeIdentity(root, process.env.DATABASE_URL, result.rows[0].id)
    } catch { throw new Error('Could not verify the configured database installation identity. Restart the intended API after applying migrations.') }
    finally { await client.end() }
  }
  const apiLive = (response, body) => response.ok && body.includes('"service":"graphql-api"')
  const apiReady = (response, body) => response.ok && body.includes('"status":"ok"')
  const webReady = webIdentityMatches(createRuntimeIdentity(root, process.env.DATABASE_URL, '').checkoutId, apiUrl)

  if (['127.0.0.1', 'localhost'].includes(database.hostname)
      && (database.port || '5432') === '5432' && database.pathname === '/graphql'
      && database.username === 'graphql' && database.password === 'graphql') {
    await run('PostgreSQL', ['db:up'])
  } else {
    console.log('Using the configured PostgreSQL database; Docker Compose was skipped.')
  }

  let api
  if (await listening(port)) {
    if (!await responds(`${apiUrl}/health/live`, apiLive)) {
      throw new Error(`Port ${port} is in use by a different or unhealthy service.`)
    }
    if (!await runningApiAcceptsBrowserOrigin(apiUrl, webUrl)) {
      throw new Error(`The API at ${apiUrl} does not accept local browser access from ${browser.origin}. Restart the intended API with this FOREMAN_CODE_BROWSER_ORIGIN, or choose its existing browser origin.`)
    }
    if (!await responds(`${apiUrl}/health/identity`, apiIdentityMatches(await expectedIdentity()))) {
      throw new Error(`The API at ${apiUrl} belongs to a different checkout or database installation. Stop the intended process explicitly or choose a different PORT.`)
    }
    console.log(`Using the Foreman Code API already running at ${apiUrl}.`)
  } else {
    api = start('API', ['--filter', '@foreman-code/api', 'dev'], {
      // Keep API logs on disk by default (.logs/api.*.log) unless the caller chose a destination.
      env: { ...process.env, ...(!process.env.LOG_DIR && !process.env.LOG_FILE ? { LOG_DIR: join(root, '.logs') } : {}),
        FOREMAN_CODE_BROWSER_ORIGIN: webUrl },
    })
  }
  await waitFor('API', `${apiUrl}/health/ready`, apiReady, api)

  await waitFor('API identity', `${apiUrl}/health/identity`, apiIdentityMatches(await expectedIdentity()), api)

  let web
  if (await listening(browser.port, browser.host)) {
    if (!await responds(`${webUrl}/__graphql_dev_identity`, webReady)) {
      throw new Error(`Port ${browser.port} is in use by a different checkout, API target or unhealthy web service. Stop that process explicitly or choose a different FOREMAN_CODE_WEB_PORT.`)
    }
    console.log(`Using the Foreman Code web server already running at ${webUrl}.`)
  } else {
    web = start('Web', ['--filter', '@foreman-code/web', 'dev'], {
      env: { ...process.env, VITE_API_URL: apiUrl },
    })
  }
  await waitFor('Web', `${webUrl}/__graphql_dev_identity`, webReady, web)

  if (children.length === 0) {
    console.log('Foreman Code is already running.')
    return
  }
  // dev:api and dev:web already own a contracts watcher when one is reused.
  if (api && web) start('Contracts watcher', ['--filter', '@foreman-code/contracts', 'dev'])
  console.log(`Foreman Code ready: ${webUrl} (API ${apiUrl}).`)
  console.log('Server ready for browsing. Harness execution eligibility is separate; check Operator chat for rollout and saved-default qualification status.')
  console.log('Local development browser access is active; open the app without signing in.')
  const ended = await Promise.race(children.map(({ exited }) => exited))
  if (!stopping) {
    console.error(`${ended.name} stopped (exit ${ended.code ?? ended.signal}).`)
    process.exitCode = 1
    stop()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  main().catch((error) => {
    stop()
    console.error(`Foreman Code dev startup failed: ${error.message}`)
    process.exitCode = 1
  })
}
import { diagnosticWarning } from './diagnostic-warning.mjs'
