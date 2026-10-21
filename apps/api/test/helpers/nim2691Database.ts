import { createMigratedFixtureDatabase, dropFixtureDatabase } from './testResources.js'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { privateFixtureDirectory, withPrivateFixtureDirectories } from './privateFixtureDirectory.js'
import { registerTestResourceCleanup } from '../../../../scripts/test-resources.mjs'

/** A fresh database and directory for this workstream only. Neither the admin
 * database nor an existing application database is migrated or cleaned. */
export async function nim2691TaskDatabase<T>(work: (pool: pg.Pool, directory: string, connectionString: string) => Promise<T>): Promise<T> {
  assert.equal(process.env.NIM2691_POSTGRES, '1')
  const configured = process.env.NIM2691_ADMIN_DATABASE_URL
  assert.ok(configured, 'NIM2691_ADMIN_DATABASE_URL is required')
  const url = new URL(configured)
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol))
  const name = `nim2691_${randomBytes(12).toString('hex')}`
  const admin = new pg.Client({ connectionString: configured, connectionTimeoutMillis: 10000 })
  let pool: pg.Pool | undefined
  let created = false
  const invocation = { directory: process.env.FOREMAN_CODE_TEST_ROOT!, token: process.env.FOREMAN_CODE_TEST_OWNER! }
  let outcome: { value: T } | { error: unknown }
  try {
    await admin.connect()
    assert.equal((await admin.query<{ server_version_num: string }>('show server_version_num')).rows[0]?.server_version_num.startsWith('17'), true)
    await createMigratedFixtureDatabase(admin, name)
    created = true
    registerTestResourceCleanup(invocation, { kind: 'fixture-database', name })
    url.pathname = `/${name}`
    pool = new pg.Pool({ connectionString: url.toString(), max: 5 })
    assert.equal((await pool.query<{ name: string }>('select current_database() as name')).rows[0]?.name, name)
    const ownedPool = pool
    outcome = { value: await withPrivateFixtureDirectories(async () => {
      const directory = await privateFixtureDirectory('workflow-native-')
      return work(ownedPool, directory, url.toString())
    }) }
  } catch (error) {
    outcome = { error }
  }
  const cleanupErrors: unknown[] = []
  try { await pool?.end() }
  catch (error) { cleanupErrors.push(error) }
  try {
    if (created) {
      const deadline = Date.now() + 2000
      let callers = await admin.query<{ count: number }>(
        'select count(*)::int as count from pg_stat_activity where datname=$1', [name])
      // Local socket closure can finish before PostgreSQL removes its backend.
      while (callers.rows[0]?.count !== 0 && Date.now() < deadline) {
        await delay(20)
        callers = await admin.query<{ count: number }>(
          'select count(*)::int as count from pg_stat_activity where datname=$1', [name])
      }
      if (callers.rows[0]?.count !== 0) {
        cleanupErrors.push(new Error('Native fixture database still had active callers during teardown.'))
      }
    }
  } catch (error) { cleanupErrors.push(error) }
  try {
    if (created) {
      await dropFixtureDatabase(admin, name)
    }
  }
  catch (error) { cleanupErrors.push(error) }
  try { await admin.end() }
  catch (error) { cleanupErrors.push(error) }
  if (cleanupErrors.length) {
    if ('error' in outcome) cleanupErrors.unshift(outcome.error)
    throw new AggregateError(cleanupErrors, 'Task database execution or cleanup failed.',
      { cause: 'error' in outcome ? outcome.error : cleanupErrors[0] })
  }
  if ('error' in outcome) throw outcome.error
  return outcome.value
}
