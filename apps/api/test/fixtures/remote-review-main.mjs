/* global process, setInterval, clearInterval */
import { readFile, rename, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { componentLogger, serializeError } from '../../src/modules/diagnostics/logger.ts'
import { createDatabase } from '../../src/infrastructure/database.ts'
import { createCheckpointStore } from '../../src/infrastructure/checkpoints.ts'
import { buildProductionApp } from '../../src/production.ts'
import { codexQualificationSuite } from '../../src/modules/harnesses/qualification/cliEntry.ts'
import { discoverInventoryLauncher } from '../../src/modules/harnesses/hostDiscovery.ts'
import { inventoryDriverPayloads } from '../../src/modules/harnesses/payloadDiscovery.ts'
import { discoverInstalledClaudeSdk } from '../../src/modules/harnesses/claudeSdk/currentPin.ts'
import { ApprovalExecutionCoordinator } from '../../src/modules/interactions/execution.ts'

if (process.env.FOREMAN_CODE_RESTART_FIXTURE_READY) {
  const preserve = ApprovalExecutionCoordinator.prototype.preserveActiveForRestart
  ApprovalExecutionCoordinator.prototype.preserveActiveForRestart = function (owner) {
    const preservation = preserve.call(this, owner)
    return Promise.all([
      preservation,
      // Release blocked admission after classification, or while classification waits for startup.
      Promise.race([preservation, delay(500)]).then(() =>
        writeFile(`${process.env.FOREMAN_CODE_RESTART_FIXTURE_READY}.preserving`, 'preserving', { mode: 0o600 })),
    ]).then(([result]) => result)
  }
}

const { config, infrastructure, claudeInventory } = JSON.parse(await readFile(process.argv[2], 'utf8'))
infrastructure.inventoryDiscovery = {
  launcher: discoverInventoryLauncher, payloads: inventoryDriverPayloads,
  claude: async (_host, environment, signal) => claudeInventory
    ? discoverInstalledClaudeSdk(claudeInventory,
      { harnessInstallationId: 'fixture-claude-sdk', environment }, signal)
    : null,
}
const database = createDatabase(config.database)
const checkpoints = createCheckpointStore(config.database.connectionString, config.checkpoints.schema, config.database)
const production = buildProductionApp(config, database, checkpoints, false,
  undefined, undefined, { codex: codexQualificationSuite }, infrastructure)
const reportReconciliation = error => componentLogger('engine').error({ err: error }, 'run reconciliation failed')
if (process.env.FOREMAN_CODE_RESTART_FIXTURE_READY) {
  production.app.post('/__fixture-reconcile', async request => {
    if (request.body.kind === 'reconcile-reviews') await production.engine.reconcile(reportReconciliation)
    else await production.reconcile(reportReconciliation)
    return { reconciled: true }
  })
}
const files = production.registerFileStorage()
await checkpoints.setup()
await production.initialize()
// Complete disk initialization before Fastify's bounded onReady hook runs.
await files.bytes.initialize()
const origin = await production.app.listen({ host: '127.0.0.1', port: config.port })
await production.startDeviceListener()
let reconciliationTimer
if (process.env.FOREMAN_CODE_RESTART_FIXTURE_READY) {
  await production.reconcile(reportReconciliation)
  reconciliationTimer = setInterval(() => {
    void production.reconcile(reportReconciliation).catch(reportReconciliation)
  }, 5000)
  reconciliationTimer.unref()
}
process.send?.({ kind: 'ready', origin })
if (process.env.FOREMAN_CODE_RESTART_FIXTURE_READY) {
  const readyFile = process.env.FOREMAN_CODE_RESTART_FIXTURE_READY
  await writeFile(`${readyFile}.tmp`,
    JSON.stringify({ pid: process.pid, origin }), { mode: 0o600 })
  await rename(`${readyFile}.tmp`, readyFile)
}
let closing = false
let reconciliationFailure
process.on('message', async message => {
  if (!['reconcile', 'reconcile-reviews'].includes(message?.kind) || closing) return
  try {
    const report = error => { reconciliationFailure = error }
    if (message.kind === 'reconcile-reviews') await production.engine.reconcile(report)
    else await production.reconcile(report)
    if (reconciliationFailure) throw reconciliationFailure
    process.send?.({ kind: 'reconciled', requestId: message.requestId })
  } catch (error) {
    reconciliationFailure = error
    const checkpointErrors = []
    for (const { id } of (await database.pool.query('select id from runs')).rows) {
      const tuple = await checkpoints.saver.getTuple({ configurable: { thread_id: id } })
      checkpointErrors.push(...(tuple?.pendingWrites ?? []).filter(write => write[1] === '__error__')
        .map(write => ({ runId: id, error: write[2] })))
    }
    process.send?.({ kind: 'reconcile-failed', requestId: message.requestId,
      message: error.message, code: error.code, stack: error.stack, details: { original: error.details, checkpointErrors } })
  }
})
async function close() {
  if (closing) return
  closing = true
  clearInterval(reconciliationTimer)
  try {
    await production.shutdown()
    await checkpoints.close()
    await database.close()
    if (reconciliationFailure) throw reconciliationFailure
    process.exit(0)
  } catch (error) {
    process.stderr.write(`${JSON.stringify(serializeError(error))}\n`)
    process.exit(1)
  }
}
process.on('SIGTERM', close)
process.on('SIGINT', close)
