import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { migrations } from '../src/infrastructure/migrations.js'
import { createTestDatabaseTemplate, dropTestDatabaseTemplate, migrationContentsHash } from '../../../scripts/test-database-template.mjs'
import { assertTestResourcesSettled, completeTestResourceCleanup, createTestDatabase, createTestRoot,
  dropTestDatabase, registerTestResourceCleanup, removeTestRoot, resetTestDatabase, settleTestResources,
  testAdminPool, testEnvironment } from '../../../scripts/test-resources.mjs'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { createTestPool } from './helpers/testPool.mjs'

let admin: Awaited<ReturnType<typeof testAdminPool>>
let root: ReturnType<typeof createTestRoot>
let template: Awaited<ReturnType<typeof createTestDatabaseTemplate>>

beforeAll(async () => {
  admin = await testAdminPool()
  root = createTestRoot(process.env.FOREMAN_CODE_TEST_ROOT)
  template = await createTestDatabaseTemplate(admin, root)
}, 60_000)

afterAll(async () => {
  try {
    if (template) await dropTestDatabaseTemplate(admin, template)
    if (root) removeTestRoot(root)
  } finally { await admin?.end() }
})

async function fixture() {
  const resource = createTestRoot(root.directory)
  const database = await createTestDatabase(admin, resource, { template })
  const pool = createTestPool({ connectionString: database.databaseUrl, max: 1 })
  return { database, pool, async close() {
    await pool.end()
    await dropTestDatabase(admin, database)
    removeTestRoot(database)
  } }
}

it('reuses one content-keyed migrated template and prevents connections to it', async () => {
  expect((await createTestDatabaseTemplate(admin, root)).name).toBe(template.name)
  expect(template.hash).toBe(migrationContentsHash(migrations))
  const pool = createTestPool({ connectionString: template.databaseUrl, max: 1 })
  try { await expect(pool.query('select 1')).rejects.toMatchObject({ code: '55000' }) }
  finally { await pool.end() }
})

it('clones migrations while isolating rows, sequences, schemas and installation identities', async () => {
  const first = await fixture()
  const second = await fixture()
  try {
    const applied = await second.pool.query<{ version: number }>('select version from application_migrations order by version')
    expect(applied.rows.map(row => row.version)).toEqual(migrations.map(migration => migration.version).sort((a, b) => a - b))
    const firstId = (await first.pool.query('select id from application_installation')).rows[0].id
    const secondId = (await second.pool.query('select id from application_installation')).rows[0].id
    expect(firstId).not.toBe(secondId)
    await first.pool.query('create table template_probe(id serial primary key, value text)')
    await first.pool.query('insert into template_probe(value) values ($1)', ['first clone'])
    await first.pool.query('create schema template_probe_schema')
    expect((await second.pool.query("select to_regclass('template_probe') as relation")).rows[0].relation).toBeNull()
    expect((await second.pool.query("select nspname from pg_namespace where nspname='template_probe_schema'")).rows).toEqual([])
    await second.pool.query('create table template_probe(id serial primary key, value text)')
    expect((await second.pool.query('insert into template_probe(value) values ($1) returning id', ['second clone'])).rows[0].id).toBe(1)
    expect((await first.pool.query('select value from template_probe')).rows).toEqual([{ value: 'first clone' }])
    const environment = testEnvironment({ PATH: process.env.PATH }, second.database)
    expect(JSON.parse(environment.FOREMAN_CODE_TEST_DATABASE_TEMPLATE!)).toMatchObject({ name: template.name, hash: template.hash })
  } finally {
    await first.close()
    await second.close()
  }
})

it('resets a used slot by cloning a clean database with a fresh installation identity', async () => {
  const first = await fixture()
  let reset: Awaited<ReturnType<typeof resetTestDatabase>> | undefined
  let pool: pg.Pool | undefined
  try {
    const previousId = (await first.pool.query('select id from application_installation')).rows[0].id
    await first.pool.query('create table template_probe(value text)')
    await first.pool.query('insert into template_probe values ($1)', ['discarded'])
    await first.pool.end()
    reset = await resetTestDatabase(admin, first.database)
    pool = createTestPool({ connectionString: reset.databaseUrl, max: 1 })
    expect(reset.name).not.toBe(first.database.name)
    expect((await pool.query("select to_regclass('template_probe') as relation")).rows[0].relation).toBeNull()
    expect((await pool.query('select id from application_installation')).rows[0].id).not.toBe(previousId)
    expect((await pool.query('select count(*)::int as count from application_migrations')).rows[0].count).toBe(migrations.length)
    expect((await admin.query('select datname from pg_database where datname=$1', [first.database.name])).rows).toEqual([])
  } finally {
    await pool?.end()
    if (reset) {
      await dropTestDatabase(admin, reset)
      removeTestRoot(first.database)
    } else await first.close()
  }
})

it('provides independently migrated databases through the shared fixture helper', async () => {
  const first = await migratedDatabase()
  const second = await migratedDatabase()
  try {
    await first.pool.query('insert into workspaces(id,record) values ($1,$2::jsonb)',
      ['fixture-workspace', JSON.stringify({ id: 'fixture-workspace', name: 'Fixture workspace' })])
    expect((await second.pool.query('select id from workspaces')).rows).toEqual([])
    const applied = await second.pool.query('select count(*)::int as count from application_migrations')
    expect(applied.rows[0].count).toBe(migrations.length)
  } finally {
    await first.close()
    await second.close()
  }
})

it('settles an abandoned fixture database before resetting a slot, only after its callers close', async () => {
  const resource = createTestRoot(root.directory)
  const database = await createTestDatabase(admin, resource, { template })
  const abandoned = await createTestDatabase(admin, resource, { template })
  registerTestResourceCleanup(resource, { kind: 'fixture-database', name: abandoned.name })
  const pool = createTestPool({ connectionString: abandoned.databaseUrl, max: 1 })
  let reset: Awaited<ReturnType<typeof resetTestDatabase>> | undefined
  try {
    try {
      await pool.query('select 1')
      await expect(settleTestResources(admin, resource)).rejects.toThrow('closure is unconfirmed')
      await expect(resetTestDatabase(admin, database)).rejects.toThrow('cleanup remains unconfirmed')
      expect(() => assertTestResourcesSettled(resource)).toThrow('cleanup remains unconfirmed')
      expect((await admin.query('select datname from pg_database where datname=$1', [database.name])).rows)
        .toEqual([{ datname: database.name }])
    } finally { await pool.end() }
    await settleTestResources(admin, resource)
    reset = await resetTestDatabase(admin, database)
    assertTestResourcesSettled(resource)
    expect((await admin.query('select datname from pg_database where datname=any($1::text[])',
      [[database.name, abandoned.name]])).rows).toEqual([])
    expect(reset.name).not.toBe(database.name)
  } finally {
    await settleTestResources(admin, resource)
    await dropTestDatabase(admin, reset ?? database)
    removeTestRoot(resource)
  }
})

it('retains a slot and its recovery state when a native cleanup owner has not confirmed closure', async () => {
  const resource = createTestRoot(root.directory)
  const database = await createTestDatabase(admin, resource, { template })
  const cleanupId = registerTestResourceCleanup(resource, { kind: 'native-qualification' })
  try {
    await expect(settleTestResources(admin, resource)).rejects.toThrow('cleanup remains unconfirmed')
    await expect(resetTestDatabase(admin, database)).rejects.toThrow('cleanup remains unconfirmed')
    expect(() => removeTestRoot(resource)).toThrow('cleanup remains unconfirmed')
    expect((await admin.query('select datname from pg_database where datname=$1', [database.name])).rows)
      .toEqual([{ datname: database.name }])
  } finally {
    completeTestResourceCleanup(resource, cleanupId)
    await dropTestDatabase(admin, database)
    removeTestRoot(resource)
  }
})

it('rejects foreign template ownership and changed migration contents before creating a clone', async () => {
  const resource = createTestRoot(root.directory)
  const name = `graphql_test_${randomUUID().replaceAll('-', '')}`
  const marker = `graphql-test:${template.token}:template:${template.hash}`
  try {
    await expect(createTestDatabase(admin, resource, { template: { ...template, hash: '0'.repeat(64) }, name }))
      .rejects.toThrow('identity mismatch')
    await admin.query(`comment on database "${template.name}" is 'foreign-template-owner'`)
    await expect(createTestDatabase(admin, resource, { template, name })).rejects.toThrow('ownership or migration contents mismatch')
    expect((await admin.query('select datname from pg_database where datname=$1', [name])).rows).toEqual([])
  } finally {
    await admin.query(`comment on database "${template.name}" is '${marker}'`)
    removeTestRoot(resource)
  }
})
