#!/usr/bin/env node
import { diagnosticWarning } from '../diagnostic-warning.mjs'
import { spawn, execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { BASE, HELP, assertOwned, environment, freePort, options, publicError,
  verificationToolEnvironment } from './safety.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const exec = promisify(execFile)
const service = join(root, 'apps/api/scripts/local-acceptance-service.mjs')
const abort = new AbortController()
let state, owner, resources, admin, removeRoot, dropDatabase, api, web, input, stage = 'arguments', stopping = false
let end
const ended = new Promise((resolve) => { end = resolve })
let safeEnv = {}
let toolEnv = {}
let completeCleanup
const cleanupOwners = []
const children = []
function interrupted() { if (abort.signal.aborted) throw new Error('Acceptance interrupted.') }
function finish(code = 0) {
  if (code) process.exitCode = code
  abort.abort(); end()
}
process.once('SIGINT', () => finish())
process.once('SIGTERM', () => finish())

// No command text, error message, output, connection URL or environment dump is
// forwarded to the terminal. stdout is captured only for non-secret identity probes.
async function command(file, args, { cwd = root, capture = false, timeout = 90_000 } = {}) {
  interrupted()
  try {
    const result = await exec(file, args, { cwd, env: toolEnv, encoding: 'utf8',
      maxBuffer: 1024 * 1024, timeout, signal: abort.signal, killSignal: 'SIGTERM' })
    return capture ? result.stdout.trim() : undefined
  } catch (error) {
    if (state) {
      const secrets = Object.entries({ ...process.env, ...toolEnv }).filter(([key, value]) => value
        && /TOKEN|SECRET|PASSWORD|KEY|DATABASE_URL/.test(key)).flatMap(([, value]) => [
        value, JSON.stringify(value).slice(1, -1),
      ]).sort((left, right) => right.length - left.length)
      const redact = (text) => secrets.reduce((result, secret) => result.replaceAll(secret, '[REDACTED]'),
        String(text ?? ''))
      const diagnostic = { stage, code: error.code, signal: error.signal,
        stdout: redact(error.stdout), stderr: redact(error.stderr) }
      try {
        await writeFile(join(state, 'command-failure.json'), JSON.stringify(diagnostic, null, 2),
          { mode: 0o600, flag: 'wx' })
      } catch {
        console.error('ENG07 private command diagnostic unavailable.')
      }
    }
    throw error
  }
}
function ownedChild(name, file, args, env, ipc = false) {
  interrupted()
  const child = spawn(file, args, { cwd: root, env, detached: true,
    stdio: ipc ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'ignore' })
  let ready, failed, exited
  const record = { name, child, expected: false, closed: false, done: false, pending: new Map() }
  record.ready = new Promise((resolve, reject) => { ready = resolve; failed = reject })
  // A process can fail while a different startup stage is being awaited.
  record.ready.catch(() => undefined)
  record.exited = new Promise((resolve) => { exited = resolve })
  const onExit = (code) => {
    if (record.done) return
    record.done = true; record.code = code
    failed(new Error('Owned process exited before readiness.'))
    for (const request of record.pending.values()) request.reject(new Error('Service exited.'))
    record.pending.clear(); exited()
    if (!record.expected && !stopping) {
      console.error(`ENG07 ${name} exited unexpectedly. No other service will be adopted.`)
      finish(1)
    }
  }
  child.once('error', () => onExit(1))
  child.once('exit', (code) => onExit(code ?? 1))
  if (ipc) child.on('message', (message) => {
    if (message?.type === 'ready') ready()
    if (message?.type === 'closed') record.closed = true
    if (message?.type === 'notice') {
      // A notice is NOT evidence of recovery or native closure. Retain receipts
      // at teardown rather than erase potentially unresolved crash evidence.
      if (!record.noticeShown) { console.log('ENG07 recovery is unresolved; inspect the Run before continuing.'); record.noticeShown = true }
    }
    if (message?.type === 'failure') {
      const error = Object.assign(new Error('Service operation failed.'), { code: message.code, stage: message.stage })
      if (message.requestId) record.pending.get(message.requestId)?.reject(error)
      else failed(error)
    }
    if (message?.type === 'result') record.pending.get(message.requestId)?.resolve(message.result)
  })
  children.push(record)
  return record
}
async function bounded(promise, milliseconds, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(label), { code: 'ACCEPTANCE_TIMEOUT' })), milliseconds)
  })]) } finally { clearTimeout(timer) }
}
async function request(record, type, content = {}) {
  interrupted()
  const requestId = randomUUID()
  const response = new Promise((resolve, reject) => { record.pending.set(requestId, { resolve, reject }) })
  try {
    record.child.send({ type, requestId, ...content }, (error) => {
      if (error) record.pending.get(requestId)?.reject(new Error('IPC unavailable.'))
    })
    return await bounded(response, type === 'seed' ? 180_000 : 300_000, type)
  } finally { record.pending.delete(requestId) }
}
async function stop(record, signal = 'SIGTERM', milliseconds = 75_000) {
  if (!record || record.done) return
  record.expected = true
  if (signal === 'SIGTERM' && record.child.connected) {
    const sent = new Promise((resolve, reject) => record.child.send({ type: 'shutdown' },
      (error) => error ? reject(error) : resolve()))
    await bounded(Promise.all([sent, record.exited]), milliseconds, 'owned shutdown')
  } else {
    record.child.kill(signal)
    await bounded(record.exited, milliseconds, 'owned shutdown')
  }
}
async function shutdown() {
  stopping = true
  input?.close()
  let orderly = true
  for (const record of [web, api]) {
    if (!record) continue
    try {
      await stop(record)
      if (record.code !== 0 || !record.closed) {
        orderly = false
        console.error(`ENG07 ${record.name} shutdown did not confirm resource closure.`)
      }
    } catch (error) {
      orderly = false
      console.error(`ENG07 ${record.name} shutdown failed (${publicError(error)}).`)
      record.expected = true; record.child.kill('SIGKILL')
      await bounded(record.exited, 5000, 'owned forced exit').catch(error => diagnosticWarning('join owned acceptance process', error))
    }
  }
  if (!state) return
  if (!orderly || children.some((record) => !record.done)) {
    process.exitCode = 1
    console.error(`ENG07 retained private task state: ${state}`)
    console.error('Native/cleanup settlement is not proven. Do not delete it or kill processes by name. See the walkthrough.')
    await admin?.end()
    return
  }
  await assertOwned(state, owner)
  for (const cleanup of cleanupOwners) completeCleanup(cleanup.resource, cleanup.id)
  try {
    if (resources.databaseUrl) await dropDatabase(admin, resources)
  } finally { await admin.end() }
  removeRoot(resources)
  console.log('ENG07 owned test database and task files removed.')
}
async function readyHttp(url, accepts, headers = {}) {
  interrupted()
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
  const body = await response.text()
  if (!response.ok) {
    let code = 'ACCEPTANCE_READINESS_FAILED'
    try { code = publicError(JSON.parse(body).error) } catch (error) { diagnosticWarning('read acceptance readiness error', error, 'INVALID_READINESS_RESPONSE') }
    throw Object.assign(new Error('Service readiness failed.'), { code })
  }
  if (!accepts(body)) throw Object.assign(new Error('Service readiness response is invalid.'), {
    code: 'ACCEPTANCE_READINESS_INVALID',
  })
}
async function main() {
  const opts = options(process.argv.slice(2))
  if (opts.help) { console.log(HELP); return }
  stage = 'prerequisites (Node 22+, non-root Unix, PostgreSQL 17, installed pinned pnpm dependencies)'
  if (!['linux', 'darwin'].includes(process.platform) || !process.getuid || process.getuid() === 0
    || Number(process.versions.node.split('.')[0]) < 22) throw new Error('Unsupported execution environment.')
  if (process.platform !== 'linux' && !opts.smoke) {
    stage = 'native recovery requires Linux at this head (macOS supports --smoke only)'
    throw new Error('Native recovery platform unsupported.')
  }
  if (!opts.smoke && !process.stdin.isTTY) throw new Error('Interactive acceptance needs a terminal; use --smoke for CI.')
  const apiRequire = createRequire(join(root, 'apps/api/package.json'))
  const tsx = apiRequire.resolve('tsx')
  createRequire(join(root, 'apps/web/package.json')).resolve('vite')
  apiRequire.resolve('pg'); apiRequire.resolve('@modelcontextprotocol/client')
  const { createTestRoot, createTestDatabase, testAdminPool, testEnvironment,
    completeTestResourceCleanup, registerTestResourceCleanup,
    dropTestDatabase, removeTestRoot } = await import('../test-resources.mjs')
  dropDatabase = dropTestDatabase
  removeRoot = removeTestRoot
  completeCleanup = completeTestResourceCleanup
  admin = await testAdminPool()
  resources = createTestRoot(undefined, 'eng07-')
  state = resources.directory
  cleanupOwners.push({ resource: resources, id: registerTestResourceCleanup(resources,
    { kind: 'local-acceptance', stateDirectory: state }) })
  if (process.env.FOREMAN_CODE_TEST_ROOT) {
    const parent = { directory: process.env.FOREMAN_CODE_TEST_ROOT, token: process.env.FOREMAN_CODE_TEST_OWNER }
    cleanupOwners.push({ resource: parent, id: registerTestResourceCleanup(parent,
      { kind: 'local-acceptance', stateDirectory: state }) })
  }
  owner = randomUUID()
  await writeFile(join(state, 'owner.json'), JSON.stringify({ owner, base: BASE }), { mode: 0o600, flag: 'wx' })
  resources = await createTestDatabase(admin, resources)
  const isolated = testEnvironment(process.env, resources)
  safeEnv = { ...environment(isolated), NODE_OPTIONS: isolated.NODE_OPTIONS,
    FOREMAN_CODE_API_ENV_FILE: isolated.FOREMAN_CODE_API_ENV_FILE }
  toolEnv = {
    ...Object.fromEntries(Object.entries(safeEnv).filter(([key]) => !key.endsWith('_API_KEY'))),
    ...verificationToolEnvironment(isolated),
    // A build must validate the prepared dependencies rather than reinstall them under the isolated home.
    pnpm_config_verify_deps_before_run: 'error',
    // pnpm's default virtual-store setting depends on the install's CI context.
    ...(isolated.CI !== undefined ? { CI: isolated.CI } : {}),
    ...(isolated.FOREMAN_CODE_HEAVY_JOB_COMMON ? { FOREMAN_CODE_HEAVY_JOB_COMMON: isolated.FOREMAN_CODE_HEAVY_JOB_COMMON } : {}),
    ...(isolated.FOREMAN_CODE_HEAVY_JOB_TOKEN ? { FOREMAN_CODE_HEAVY_JOB_TOKEN: isolated.FOREMAN_CODE_HEAVY_JOB_TOKEN } : {}),
  }
  stage = 'port reservation check'
  await freePort(opts.apiPort); await freePort(opts.webPort)
  stage = 'checkout identity'
  const head = await command('git', ['rev-parse', 'HEAD'], { capture: true })
  if (head !== BASE) console.log('ENG07 checkout differs from the documented base; record its commit separately before accepting results.')
  stage = 'contracts build (run corepack pnpm install beforehand)'
  await command('corepack', ['pnpm', '--filter', '@foreman-code/contracts', 'build'])
  interrupted()
  process.umask(0o077)
  await assertOwned(state, owner)
  for (const name of ['projects', 'runtime', 'empty-env']) await mkdir(join(state, name), { mode: 0o700 })
  const database = resources.name
  const apiRequirePg = apiRequire('pg')
  const pool = new apiRequirePg.Pool({ connectionString: resources.databaseUrl, max: 1 })
  try {
    await pool.query('CREATE SCHEMA eng07; REVOKE CREATE ON SCHEMA public FROM PUBLIC')
    await pool.query(`ALTER DATABASE "${database}" SET search_path TO eng07`)
  } finally { await pool.end() }
  const apiUrl = `http://127.0.0.1:${opts.apiPort}`, webUrl = `http://127.0.0.1:${opts.webPort}`
  const appEnv = { ...safeEnv, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(opts.apiPort),
    DATABASE_URL: resources.databaseUrl, DATABASE_QUERY_TIMEOUT_MS: '60000',
    LANGGRAPH_CHECKPOINT_SCHEMA: 'eng07_checkpoints', HARNESS_WORKSPACE_ROOT: join(state, 'runtime'),
    FOREMAN_CODE_BROWSER_ORIGIN: webUrl,
    ENG07_DATABASE: database,
    ENG07_STATE: state, ENG07_OWNER: owner, ENG07_WEB_PORT: String(opts.webPort),
    ...(opts.codexModel ? { ENG07_CODEX_MODEL: opts.codexModel } : {}), TMPDIR: join(state, 'tmp') }
  const startApi = async () => {
    interrupted(); await assertOwned(state, owner); await freePort(opts.apiPort)
    api = ownedChild('API', process.execPath, ['--import', tsx, service, 'api'], appEnv, true)
    await bounded(api.ready, 120_000, 'API startup')
    await readyHttp(`${apiUrl}/health/ready`, () => true)
    await readyHttp(`${apiUrl}/api/local-human`, (body) => Boolean(JSON.parse(body).principal), { origin: webUrl })
  }
  stage = 'API migrations and production startup'
  await startApi()
  stage = 'semantics-3 seed and persisted readback'
  const demo = await request(api, 'seed')
  stage = 'web startup'
  const webEnv = { ...toolEnv, NODE_ENV: 'development', ENG07_STATE: state, ENG07_OWNER: owner,
    ENG07_WEB_PORT: String(opts.webPort), VITE_API_URL: apiUrl, TMPDIR: join(state, 'tmp') }
  web = ownedChild('Web', process.execPath, ['--import', tsx, service, 'web'], webEnv, true)
  await bounded(web.ready, 90_000, 'Web startup')
  await readyHttp(webUrl, (body) => /<html(?:\s|>)/i.test(body))
  await readyHttp(`${webUrl}/api/local-human`, (body) => Boolean(JSON.parse(body).principal), { origin: webUrl })
  console.log(`ENG07 ready: ${webUrl} (API ${apiUrl}). Dev browser access is loopback-only.`)
  console.log(`Workspace: ${demo.workspaceId}; eight saved workflows, ${demo.agentCount} Agents.`)
  console.log(`Execution folder: ${demo.executionFolder}`)
  if (opts.codexModel) console.log('Codex branch seeded. Check native project-config trust and MCP readiness before Start; no trust or account settings were changed.')
  const probe = async (runId) => {
    stage = 'HTTP/MCP parity'
    const result = await request(api, 'parity', { demo, ...(runId ? { runId } : {}) })
    console.log(`ENG07 parity passed: ${result.comparisons} exact comparisons, ${result.deniedTransports} denied transports, one cross-transport command replay.`)
  }
  if (opts.smoke) { await probe(); return }
  stage = 'interactive acceptance'
  console.log('Open ENG07 Acceptance in the Board. No Run starts automatically.')
  console.log('Commands: restart-api | crash-api | parity [RUN_ID] | quit')
  input = createInterface({ input: process.stdin, output: process.stdout })
  let operations = Promise.resolve()
  input.on('line', (line) => {
    operations = operations.then(async () => {
      if (abort.signal.aborted) return
      const text = line.trim()
      if (text === 'quit') { finish(); return }
      if (text === 'restart-api' || text === 'crash-api') {
        stage = text
        api.expected = true
        if (text === 'crash-api') await stop(api, 'SIGKILL', 10_000)
        else {
          await stop(api)
          if (!api.closed || api.code !== 0) { throw new Error('API shutdown is not proven.') }
        }
        await startApi()
        console.log('ENG07 API restarted against the SAME database and recovery directories. No seed, new Run or approval replay was submitted.')
        return
      }
      const match = /^parity(?: ([A-Za-z0-9_-]{1,200}))?$/.exec(text)
      if (match) { await probe(match[1]); return }
      console.log('Use restart-api, crash-api, parity [RUN_ID], or quit. Do not enter credentials here.')
    }).catch((error) => {
      console.error(`ENG07 ${stage} failed (${publicError(error)}). Inspect the Board; no automatic command resubmission.`)
      finish(1)
    })
  })
  input.once('close', () => finish())
  await ended
}
main().catch(async (error) => {
  if (!abort.signal.aborted) console.error(`ENG07 ${stage} failed (${publicError(error)}; service stage: ${error.stage ?? 'controller'}). See prerequisites and troubleshooting in docs/acceptance/owner-walkthrough.md.`)
  const archive = process.env.FOREMAN_CODE_TEST_EVIDENCE_ARCHIVE
  if (archive && state) {
    try {
      await mkdir(archive, { recursive: true, mode: 0o700 })
      for (const kind of ['api', 'web', 'command']) {
        const file = join(state, `${kind}-failure.json`)
        try {
          const diagnostic = await readFile(file, 'utf8')
          const extension = kind === 'command' ? 'log' : 'json'
          const archived = join(archive, `local-${kind}-failure-${randomUUID()}.${extension}`)
          await writeFile(archived, diagnostic,
            { flag: 'wx', mode: 0o600 })
          if (kind === 'command') console.error(`ENG07 private command diagnostic log: ${archived}`)
        } catch (failure) {
          if (failure.code !== 'ENOENT') throw failure
        }
      }
    } catch (error) {
      diagnosticWarning('retain acceptance startup diagnostics', error)
      console.error('ENG07 private startup diagnostic archive failed.')
    }
  }
  process.exitCode = process.exitCode || 1
}).finally(async () => {
  try { await shutdown() } catch {
    process.exitCode = 1
    console.error('ENG07 cleanup ownership check failed. Nothing further was removed.')
  }
})
