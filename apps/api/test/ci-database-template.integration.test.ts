import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { migrations } from '../src/infrastructure/migrations.js'
import { createTestDatabaseTemplate, dropTestDatabaseTemplate } from '../../../scripts/test-database-template.mjs'
import { createTestDatabase, createTestRoot, dropTestDatabase, removeTestRoot,
  testAdminPool } from '../../../scripts/test-resources.mjs'
import { createTestPool } from './helpers/testPool.mjs'
import { integrationPhaseLine } from '../../../scripts/integration-phase.mjs'

it('retains a migrated template across CI jobs while dropping their isolated databases', async () => {
  const admin = await testAdminPool()
  const root = createTestRoot(process.env.FOREMAN_CODE_TEST_ROOT)
  const cacheDirectory = join(root.directory, 'templates')
  await mkdir(cacheDirectory, { mode: 0o700 })
  const jobs = [createTestRoot(root.directory), createTestRoot(root.directory)]
  const templates: Awaited<ReturnType<typeof createTestDatabaseTemplate>>[] = []
  const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = []
  const pools: ReturnType<typeof createTestPool>[] = []
  try {
    for (const job of jobs) {
      const started = performance.now()
      const template = await createTestDatabaseTemplate(admin, job, { cacheDirectory })
      templates.push(template)
      const database = await createTestDatabase(admin, job, { template })
      databases.push(database)
      const elapsedMs = performance.now() - started
      const phase = templates.length === 1 ? 'cold-db-setup' : 'warm-db-setup'
      console.log(integrationPhaseLine('ci-database-template.integration.test.ts', phase, elapsedMs))
      console.log(`[ci-db-measure] ${phase} seconds=${(elapsedMs / 1000).toFixed(3)}`)
      pools.push(createTestPool({ connectionString: database.databaseUrl, max: 1 }))
    }
    expect(templates[1]!.name).toBe(templates[0]!.name)
    expect(templates[1]!.timings.migrationMs).toBe(0)
    const applied = await pools[1]!.query('select version from application_migrations order by version')
    expect(applied.rows.map(row => row.version)).toEqual(migrations.map(migration => migration.version).sort((a, b) => a - b))
    await pools[0]!.query('insert into workspaces(id,record) values ($1,$2::jsonb)',
      ['ci-template-probe', JSON.stringify({ id: 'ci-template-probe', name: 'CI probe' })])
    expect((await pools[1]!.query('select id from workspaces')).rows).toEqual([])
    await pools[0]!.end()
    await dropTestDatabase(admin, databases[0]!)
    expect((await admin.query('select datname from pg_database where datname=$1', [databases[0]!.name])).rows).toEqual([])
    databases.shift()
    expect((await pools[1]!.query('select count(*)::int as count from application_migrations')).rows[0].count)
      .toBe(migrations.length)
  } finally {
    for (const pool of pools) if (!pool.ending) await pool.end()
    for (const database of databases) await dropTestDatabase(admin, database)
    const uniqueTemplates = [...new Map(templates.map(template => [template.name, template])).values()]
    for (const template of uniqueTemplates) {
      await dropTestDatabaseTemplate(admin, template)
      if (!jobs.some(job => job.directory === template.directory)) removeTestRoot(template)
    }
    for (const job of jobs) removeTestRoot(job)
    removeTestRoot(root)
    await admin.end()
  }
}, 60_000)
