import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { assertOwned, publicError } from '../../../scripts/acceptance/safety.mjs'
import { seed } from '../../../scripts/acceptance/scenarios.mjs'
import { parity } from '../../../scripts/acceptance/parity.mjs'
import { assertTestDatabase, ownedTestDatabaseUrl } from '../../../scripts/test-resources.mjs'
import * as schemas from '@foreman-code/contracts/wave25'
import * as sdk from '@modelcontextprotocol/client'
import { redactKnownSecrets } from '../src/modules/harnesses/secrets.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const state = process.env.ENG07_STATE
const owner = process.env.ENG07_OWNER
const kind = process.argv[2]
const source = (path) => import(pathToFileURL(join(root, 'apps/api/src', path)).href)
const send = (message) => { if (process.connected) process.send(message) }
let close = async () => {}, closing = false
let stage = 'ownership'
async function recordFailure(failedStage, error) {
  const secrets = Object.entries(process.env).filter(([key, value]) => value
    && /TOKEN|SECRET|PASSWORD|KEY|DATABASE_URL/.test(key)).map(([, value]) => value)
  const diagnostic = redactKnownSecrets({ kind, stage: failedStage, code: publicError(error),
    name: error?.name, message: String(error?.message ?? 'Unknown service failure'),
    issues: error?.issues, details: error?.details, method: error?.method,
    path: error?.path, status: error?.status }, secrets)
  try {
    await writeFile(join(state, `${kind}-failure.json`), JSON.stringify(diagnostic, null, 2),
      { flag: 'wx', mode: 0o600 })
  } catch {
    send({ type: 'notice', code: 'STARTUP_DIAGNOSTIC_UNAVAILABLE' })
  }
}
async function shutdown() {
  if (closing) return
  closing = true
  try {
    await close()
    if (process.connected) {
      await new Promise((resolve, reject) => process.send({ type: 'closed' },
        (error) => error ? reject(error) : resolve()))
    }
    process.exit(0)
  }
  catch { send({ type: 'failure', stage: 'shutdown', code: 'SHUTDOWN_FAILED' }); process.exit(1) }
}
process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })
process.on('disconnect', () => { void shutdown() })
process.on('message', (message) => { if (message?.type === 'shutdown') void shutdown() })

async function main() {
  await assertOwned(state, owner)
  if (kind === 'web') {
    stage = 'web-start'
    const web = join(root, 'apps/web'), req = createRequire(join(web, 'package.json'))
    const { createServer } = await import(pathToFileURL(req.resolve('vite')).href)
    const server = await createServer({ root: web, configFile: join(web, 'vite.config.ts'),
      // Do not load .env/.env.local from the checkout or write its Vite cache.
      envDir: join(state, 'empty-env'), cacheDir: join(state, 'vite-cache'), logLevel: 'silent',
      server: { host: '127.0.0.1', port: Number(process.env.ENG07_WEB_PORT), strictPort: true, open: false } })
    close = async () => {
      // Finish HTML-triggered import warmup before close cancels Vite's dependency crawler.
      await server.waitForRequestsIdle()
      await server.close()
    }
    if (closing) return close()
    await server.listen()
    send({ type: 'ready' })
    return
  }
  if (kind !== 'api') throw new Error('Unknown service.')
  stage = 'database-identity'
  const [{ loadConfig }, { createDatabase }, { createCheckpointStore }, { buildProductionApp }, { PostgresAccessService }] = await Promise.all([
    source('config.ts'), source('infrastructure/database.ts'), source('infrastructure/checkpoints.ts'), source('production.ts'),
    source('modules/access/postgres.ts'),
  ])
  // Same production composition, engine, checkpointer, migrations and native
  // ownership services as src/server.ts. Only storage root and logger differ.
  const config = { ...loadConfig(process.env), workspaceStorageRoot: join(state, 'projects') }
  const db = createDatabase(config.database)
  close = () => db.close()
  ownedTestDatabaseUrl()
  await assertTestDatabase(db.pool, { directory: state, token: process.env.FOREMAN_CODE_TEST_OWNER,
    name: process.env.ENG07_DATABASE, databaseUrl: process.env.TEST_DATABASE_URL })
  const identity = (await db.pool.query('select current_database() as database, current_schema() as schema')).rows[0]
  if (identity.database !== process.env.ENG07_DATABASE || identity.schema !== 'eng07') {
    throw Object.assign(new Error('Database identity mismatch.'), { code: 'ACCEPTANCE_DATABASE_IDENTITY_MISMATCH' })
  }
  stage = 'migrations'
  await db.migrate()
  const checkpoints = createCheckpointStore(config.database.connectionString, config.checkpoints.schema, config.database)
  close = async () => { await Promise.allSettled([checkpoints.close(), db.close()]) }
  await checkpoints.setup(); await checkpoints.ping()
  for (const path of [config.workspaceStorageRoot, config.harnesses.workspaceRoot]) await mkdir(path, { recursive: true, mode: 0o700 })
  stage = 'api-start'
  const { app, initialize, reconcile, drainShutdown } = buildProductionApp(config, db, checkpoints, false)
  let timer
  app.addHook('onClose', async () => {
    clearInterval(timer)
    try { await drainShutdown() } finally { await Promise.allSettled([checkpoints.close(), db.close()]) }
  })
  close = () => app.close()
  if (closing) return close()
  await initialize()
  await app.listen({ host: config.host, port: config.port })
  // Recovery starts only after the scoped MCP endpoint is listening, exactly
  // like server.ts. Never seed again or submit another Run during a restart.
  const report = () => send({ type: 'notice', code: 'RECONCILIATION_UNRESOLVED' })
  await reconcile(report)
  timer = setInterval(() => { void reconcile(report).catch(report) }, 5_000)
  timer.unref()
  send({ type: 'ready' })
  let operations = Promise.resolve()
  process.on('message', (message) => {
    operations = operations.then(async () => {
      if (closing || !message || !['seed', 'parity'].includes(message.type)) return
      try {
        const apiUrl = `http://127.0.0.1:${config.port}`
        const result = message.type === 'seed'
          ? await seed({ apiUrl, webUrl: config.browserOrigin,
            projectRoot: config.workspaceStorageRoot, codexModel: process.env.ENG07_CODEX_MODEL, schemas })
          : await parity({ apiUrl, workspaceId: message.demo.workspaceId, workflowIds: message.demo.workflowIds,
            runId: message.runId, access: new PostgresAccessService(db.pool), ...sdk })
        send({ type: 'result', requestId: message.requestId, result })
      } catch (error) {
        await recordFailure(message.type, error)
        send({ type: 'failure', requestId: message.requestId, stage: message.type, code: publicError(error) })
      }
    })
  })
}
main().catch(async (error) => {
  await recordFailure(stage, error)
  send({ type: 'failure', stage, code: publicError(error) })
  try { await close() } finally { process.exit(1) }
})
