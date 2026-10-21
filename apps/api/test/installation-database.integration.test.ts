import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished, test } from 'vitest'
import { createTestDatabase, createTestRoot, dropTestDatabase, removeTestRoot, testAdminPool }
  from '../../../scripts/test-resources.mjs'
import { createTestPool } from './helpers/testPool.mjs'
import { waitForIdleRuns } from '../../../scripts/local-production-runtime.mjs'
import { integrationShardPlan, readIntegrationResources } from '../../../scripts/test-integration.mjs'
import { withTransaction } from '../src/infrastructure/transaction.js'

async function database() {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  mkdirSync(parent, { recursive: true })
  const root = createTestRoot(parent)
  const admin = await testAdminPool()
  const cleanup: { resource?: Awaited<ReturnType<typeof createTestDatabase>>; pool?: ReturnType<typeof createTestPool> } = {}
  onTestFinished(async () => {
    try {
      await cleanup.pool?.end()
      if (cleanup.resource) await dropTestDatabase(admin, cleanup.resource)
    } finally {
      await admin.end()
      removeTestRoot(root)
    }
  })
  const resource = await createTestDatabase(admin, root)
  cleanup.resource = resource
  const pool = createTestPool({ connectionString: resource.databaseUrl, max: 8 })
  cleanup.pool = pool
  return pool
}

test('installation waits for persisted queued, running and waiting Runs, then permits terminal Runs', async () => {
  const pool = await database()
  await pool.query('create table runs (id text primary key, execution_state text not null)')
  const query = pool.query.bind(pool)
  for (const state of ['queued', 'running', 'waiting']) {
    await pool.query('insert into runs values ($1, $2)', [`run-${state}`, state])
    await assert.rejects(waitForIdleRuns({ query, timeoutMs: 0, log: () => {} }),
      new RegExp(`1 Run\\(s\\) still active \\(run-${state}\\).*FOREMAN_INSTALL_INTERRUPT_RUNS=1`))
    await pool.query('delete from runs')
  }
  for (const state of ['succeeded', 'failed', 'canceled']) {
    await pool.query('insert into runs values ($1, $2)', [`run-${state}`, state])
  }
  await waitForIdleRuns({ query, timeoutMs: 0 })
  await pool.query("insert into runs values ('run-draining', 'waiting'), ('run-finishing', 'running')")
  const pending = ['run-draining', 'run-finishing']
  const waits: number[] = []
  await waitForIdleRuns({ query, timeoutMs: 60_000, log: () => {}, sleep: async ms => {
    waits.push(ms)
    await pool.query("update runs set execution_state='succeeded' where id=$1", [pending.shift()])
  } })
  assert.deepEqual(waits, [15_000, 15_000])
  assert.deepEqual((await pool.query("select execution_state from runs where id='run-draining'")).rows,
    [{ execution_state: 'succeeded' }])
  await waitForIdleRuns({ query: async () => { assert.fail('Interrupt must bypass idle discovery') },
    timeoutMs: 0, interrupt: true })
})

test('PostgreSQL capacity discovery accounts for server reservations and held client sessions', async () => {
  const pool = await database()
  const held = await Promise.all([pool.connect(), pool.connect(), pool.connect()])
  try {
    const heldPids = await Promise.all(held.map(async client => {
      const result = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
      return result.rows[0]!.pid
    }))
    await withTransaction(pool, async client => {
      const settings = (await client.query<{ name: string; setting: number }>(`
        select name, setting::integer from pg_settings
        where name in ('max_connections', 'superuser_reserved_connections', 'reserved_connections')`)).rows
      const limits = Object.fromEntries(settings.map(row => [row.name, row.setting]))
      const sessions = (await client.query<{ pid: number }>(
        "select pid from pg_stat_activity where backend_type='client backend'")).rows
      assert.ok(heldPids.every(pid => sessions.some(row => row.pid === pid)))
      const maxConnections = limits.max_connections!
      const reservedConnections = limits.superuser_reserved_connections! + (limits.reserved_connections ?? 0)
      assert.ok(reservedConnections > 0)
      const host = { cpuCount: maxConnections, availableMemoryBytes: maxConnections * 2 ** 30 }
      const resources = await readIntegrationResources(client, host)
      assert.deepEqual(resources, { ...host, maxConnections, reservedConnections, activeConnections: sessions.length })
      assert.deepEqual(host, { cpuCount: maxConnections, availableMemoryBytes: maxConnections * 2 ** 30 })
      const expected = Math.floor((maxConnections - reservedConnections - sessions.length) / 16)
      assert.ok(expected > 0)
      assert.equal(integrationShardPlan({}, resources).shards, expected)
    }, { readOnly: true })
  } finally { held.forEach(client => client.release()) }
})
