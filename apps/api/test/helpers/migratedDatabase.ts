import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { applyApplicationMigrations } from '../../src/infrastructure/migrations.js'
import { assertFixtureResourcesSettled, registerTestResourceCleanup } from '../../../../scripts/test-resources.mjs'
import { recordIntegrationStartup } from '../../../../scripts/integration-startup.mjs'
import { createMigratedFixtureDatabase, dropFixtureDatabase, ownedTestDatabaseUrl, removeFixtureDirectory } from './testResources.js'
import { privateFixtureDirectory } from './privateFixtureDirectory.js'
import { createTestPool } from './testPool.mjs'

/** Full-schema fixtures use separate databases; partial-migration fixtures retain separate schemas. */
export async function migratedDatabase() {
  const started = performance.now()
  const url = new URL(ownedTestDatabaseUrl())
  const name = `graphql_fixture_${randomUUID().replaceAll('-', '')}`
  const admin = createTestPool({ connectionString: url.toString(), max: 1 })
  const directory = await privateFixtureDirectory('database-fixture-')
  const invocation = { directory: process.env.FOREMAN_CODE_TEST_ROOT!, token: process.env.FOREMAN_CODE_TEST_OWNER! }
  let created = false
  let pool: pg.Pool | undefined
  try {
    await createMigratedFixtureDatabase(admin, name)
    created = true
    registerTestResourceCleanup(invocation, { kind: 'fixture-database', name })
    url.pathname = `/${name}`
    pool = createTestPool({ connectionString: url.toString(), max: 10,
      options: '-c search_path=public -c statement_timeout=10000 -c lock_timeout=5000' })
    // Standalone test commands may have no template; existing migration checks stay usable there.
    if (!process.env.FOREMAN_CODE_TEST_DATABASE_TEMPLATE) await applyApplicationMigrations(pool)
    recordIntegrationStartup('database-fixture-ready', { setupMs: performance.now() - started })
    const fixturePool = pool
    return { pool: fixturePool, databaseUrl: url.toString(), schema: 'public', directory, async close() {
      await fixturePool.end()
      try {
        assertFixtureResourcesSettled(directory)
        await dropFixtureDatabase(admin, name)
      } finally { await admin.end() }
      await removeFixtureDirectory(directory)
    } }
  } catch (error) {
    await pool?.end()
    try { if (created) await dropFixtureDatabase(admin, name) }
    finally { await admin.end() }
    await removeFixtureDirectory(directory)
    throw error
  }
}
