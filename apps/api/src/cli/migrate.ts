import { OperatorRuntimeOwner } from '../infrastructure/operatorRuntimeOwner.js'
import { loadConfig } from '../config.js'
import { createDatabase, MIGRATION_QUERY_TIMEOUT_MS } from '../infrastructure/database.js'
import { createCheckpointStore } from '../infrastructure/checkpoints.js'

const config = loadConfig(process.env)
// DDL batches have a separate bounded deadline from individual API requests.
const migrationOptions = { ...config.database, maxConnections: 1, queryTimeoutMs: MIGRATION_QUERY_TIMEOUT_MS }
const database = createDatabase(migrationOptions)
const checkpoints = createCheckpointStore(config.database.connectionString, config.checkpoints.schema, migrationOptions)
const lifetime = new AbortController()
const maintenance = new OperatorRuntimeOwner(config.database.connectionString, error => lifetime.abort(error))
try {
  await maintenance.acquire()
  lifetime.signal.throwIfAborted()
  await database.migrate()
  lifetime.signal.throwIfAborted()
  await checkpoints.setup()
  lifetime.signal.throwIfAborted()
  console.log('Application and checkpoint migrations applied.')
} finally {
  try { await Promise.all([checkpoints.close(), database.close()]) } finally { await maintenance.close() }
}
