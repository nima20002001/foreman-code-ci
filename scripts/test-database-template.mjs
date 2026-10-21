import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { assertTestRoot, createTestDatabase, createTestRoot, dropTestDatabase, requireTestServerUrl,
  testAdminUrl } from './test-resources.mjs'
import { createTestPool } from '../apps/api/test/helpers/testPool.mjs'

const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
const templates = new Map()
let migrationModule

export function migrationContentsHash(migrations) {
  return createHash('sha256').update(JSON.stringify(migrations.map(({ version, sql }) => ({ version, sql })))).digest('hex')
}

function templateIdentifier(name) {
  if (!/^graphql_test_template_[a-f0-9]{12}_[a-f0-9]{12}$/.test(name)) {
    throw new Error('Invalid test database template name')
  }
  return `"${name}"`
}

export async function assertTestDatabaseTemplate(admin, template) {
  assertTestRoot(template.directory, template.token)
  templateIdentifier(template.name)
  const url = requireTestServerUrl(template.databaseUrl)
  if (!/^[a-f0-9]{64}$/.test(template.hash) || url.pathname !== `/${template.name}`
    || template.name !== `graphql_test_template_${template.hash.slice(0, 12)}_${template.token.replaceAll('-', '').slice(0, 12)}`) {
    throw new Error('Test database template identity mismatch')
  }
  const result = await admin.query(`select datallowconn, shobj_description(oid, 'pg_database') as marker
    from pg_database where datname=$1`, [template.name])
  if (result.rows[0]?.datallowconn !== false
    || result.rows[0]?.marker !== `graphql-test:${template.token}:template:${template.hash}`) {
    throw new Error('Test database template ownership or migration contents mismatch')
  }
}

export async function createTestDatabaseTemplate(admin, resource, { cacheDirectory } = {}) {
  assertTestRoot(resource.directory, resource.token)
  const importStarted = performance.now()
  const { tsImport } = require('tsx/esm/api')
  migrationModule ??= tsImport('../apps/api/src/infrastructure/migrations.ts', import.meta.url)
  const { migrations, applyApplicationMigrations } = await migrationModule
  const importMs = performance.now() - importStarted
  const hash = migrationContentsHash(migrations)
  if (cacheDirectory) {
    try {
      return await cachedTemplate(admin, cacheDirectory, { hash, importMs, applyApplicationMigrations })
    } catch (error) {
      console.error(`[test-db] template cache unavailable; migrating job template: ${error.message}`)
    }
  }
  const key = `${resource.token}:${hash}`
  if (!templates.has(key)) {
    templates.set(key, migrateTemplate(admin, resource, { hash, importMs, applyApplicationMigrations }))
  }
  try { return await templates.get(key) }
  catch (error) { templates.delete(key); throw error }
}

async function cachedTemplate(admin, cacheDirectory, migration) {
  const started = performance.now()
  const serverKey = createHash('sha256').update(testAdminUrl).digest('hex').slice(0, 16)
  const directory = resolve(cacheDirectory, `server-${serverKey}`)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const manifest = join(directory, `${migration.hash}.json`)
  const lock = `ci-template:${directory}:${migration.hash}`
  await admin.query('select pg_advisory_lock(hashtext($1))', [lock])
  try {
    let root
    if (existsSync(manifest)) {
      root = JSON.parse(readFileSync(manifest, 'utf8'))
      assertTestRoot(root.directory, root.token)
    } else {
      root = createTestRoot(directory, `${migration.hash.slice(0, 12)}-`)
      const temporary = `${manifest}.${root.token}`
      writeFileSync(temporary, JSON.stringify(root), { mode: 0o600, flag: 'wx' })
      renameSync(temporary, manifest)
    }
    const name = `graphql_test_template_${migration.hash.slice(0, 12)}_${root.token.replaceAll('-', '').slice(0, 12)}`
    const url = new URL(testAdminUrl)
    url.pathname = `/${name}`
    const template = { ...root, name, databaseUrl: url.toString(), hash: migration.hash }
    const existing = await admin.query('select datname from pg_database where datname=$1', [name])
    if (existing.rows.length) {
      await assertTestDatabaseTemplate(admin, template)
      return { ...template, persistent: true,
        timings: { importMs: migration.importMs, migrationMs: 0, setupMs: performance.now() - started } }
    }
    return { ...await migrateTemplate(admin, root, migration), persistent: true }
  } finally {
    await admin.query('select pg_advisory_unlock(hashtext($1))', [lock])
  }
}

async function migrateTemplate(admin, resource, { hash, importMs, applyApplicationMigrations }) {
  const started = performance.now()
  const name = `graphql_test_template_${hash.slice(0, 12)}_${resource.token.replaceAll('-', '').slice(0, 12)}`
  const database = await createTestDatabase(admin, resource, { name })
  const pool = createTestPool({ connectionString: database.databaseUrl, max: 1,
    options: '-c statement_timeout=60000 -c lock_timeout=10000' })
  const migrationStarted = performance.now()
  try {
    try { await applyApplicationMigrations(pool) }
    finally { await pool.end() }
    const migrationMs = performance.now() - migrationStarted
    // A template has no clients or test writes; every fixture gets its own writable copy.
    await admin.query(`alter database ${templateIdentifier(name)} allow_connections false`)
    await admin.query(`comment on database ${templateIdentifier(name)} is 'graphql-test:${resource.token}:template:${hash}'`)
    return { ...database, hash, timings: { importMs, migrationMs, setupMs: performance.now() - started } }
  } catch (error) {
    await dropTestDatabase(admin, database)
    throw error
  }
}

export async function dropTestDatabaseTemplate(admin, template) {
  await assertTestDatabaseTemplate(admin, template)
  await admin.query(`drop database ${templateIdentifier(template.name)}`)
  templates.delete(`${template.token}:${template.hash}`)
}
