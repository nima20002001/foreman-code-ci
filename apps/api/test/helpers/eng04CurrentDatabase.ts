import { createFixtureSchema, dropFixtureSchema, removeFixtureDirectory } from './testResources.js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { applyApplicationMigrations, migrations } from '../../src/infrastructure/migrations.js'
import { privateFixtureDirectory } from './privateFixtureDirectory.js'
import { recordIntegrationStartup } from '../../../../scripts/integration-startup.mjs'

export const postgresEnabled = Boolean(process.env.TEST_DATABASE_URL)
/** The existing disposable loopback test gate, without importing retired
 * execution seeders. No DATABASE_URL fallback or live/shared data cleanup. */
export async function currentDatabase(options: {
  beforeMigration?: number; deferMigration?: number | number[]; databaseUrl?: string
} = {}) {
  const started = performance.now()
  const url = options.databaseUrl ?? process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests')
  const parsed = new URL(url)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || !parsed.pathname.toLowerCase().includes('test')) {
    throw new Error('Use a loopback PostgreSQL database explicitly named for tests')
  }
  const schema = `eng04_b_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: url, max: 1 })
  await createFixtureSchema(admin, schema)
  const pool = new pg.Pool({ connectionString: url, max: 10,
    options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000` })
  const directory = await privateFixtureDirectory('eng04-b-')
  const beforeMigration = performance.now()
  try {
    const deferred = Array.isArray(options.deferMigration) ? options.deferMigration : [options.deferMigration]
    const pendingMigration = options.beforeMigration ?? deferred[0]
    if (pendingMigration === undefined) {
      await applyApplicationMigrations(pool)
    } else {
      const index = migrations.findIndex((migration) => migration.version === pendingMigration)
      if (index < 0) throw new Error('The requested migration is not registered')
      const fixtureMigrations = options.beforeMigration === undefined
        ? migrations.filter((migration) => !deferred.includes(migration.version))
        : migrations.slice(0, index)
      const client = await pool.connect()
      try {
        await client.query('begin')
        // Fixture history is trusted SQL; send it together to avoid a round trip per statement.
        const statements = fixtureMigrations.map(migration => `${migration.sql};
          insert into application_migrations(version) values(${migration.version});`)
        if (statements.length) await client.query(statements.join('\n'))
        await client.query('commit')
      } catch (error) {
        await client.query('rollback')
        throw error
      } finally {
        client.release()
      }
    }
  } catch (error) {
    await pool.end(); await dropFixtureSchema(admin, schema); await admin.end()
    await removeFixtureDirectory(directory); throw error
  }
  recordIntegrationStartup('schema-fixture-ready', {
    setupMs: beforeMigration - started, migrationMs: performance.now() - beforeMigration,
  })
  return { pool, schema, directory, async close() {
    await pool.end()
    try { await dropFixtureSchema(admin, schema) } finally { await admin.end() }
    await removeFixtureDirectory(directory)
  } }
}
