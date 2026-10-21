import { migratedDatabase } from './helpers/migratedDatabase.js'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createFixtureDatabase, createFixtureSchema, dropFixtureDatabase, dropFixtureSchema } from './helpers/testResources.js'
import { assertOwnedExecutionDestinations } from './helpers/testResources.js'
import { candidateFor, seedAgent3 } from './helpers/wave25Agent3.js'
import { createTestDatabase, createTestRoot, dropTestDatabase, removeTestRoot, resetTestDatabase,
  testAdminPool, testAdminUrl } from '../../../scripts/test-resources.mjs'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { AgentConfigurationVersionSchema, HarnessExecutionSchema } from '@foreman-code/contracts'

let destinationFixture: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { destinationFixture = await migratedDatabase() })
afterAll(async () => { await destinationFixture?.close() })

it('queues administrative queries without consuming their connection acquisition deadline', async () => {
  const admin = await testAdminPool()
  try {
    const results = await Promise.allSettled([
      admin.query('select pg_sleep(11)'),
      admin.query('select 42 as value'),
    ])
    expect(results[0].status).toBe('fulfilled')
    expect(results[1]).toMatchObject({ status: 'fulfilled', value: { rows: [{ value: 42 }] } })
    await expect(admin.query('select 1 / 0')).rejects.toMatchObject({ code: '22012' })
    expect((await admin.query('select 43 as value')).rows).toEqual([{ value: 43 }])
  } finally {
    await admin.end()
  }
})

it('retains the owned database when a reset cannot create its replacement', async () => {
  const admin = await testAdminPool()
  const root = createTestRoot(process.env.FOREMAN_CODE_TEST_ROOT)
  let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined
  let pool: pg.Pool | undefined
  try {
    database = await createTestDatabase(admin, root)
    pool = new pg.Pool({ connectionString: database.databaseUrl, max: 1 })
    await pool.query('create table reset_sentinel(value text)')
    await pool.query('insert into reset_sentinel values ($1)', ['retained'])
    const name = `graphql_test_template_${'1'.repeat(12)}_${root.token.replaceAll('-', '').slice(0, 12)}`
    const template = {
      ...root, name, hash: '0'.repeat(64), databaseUrl: new URL(`/${name}`, testAdminUrl).href,
      timings: { importMs: 0, migrationMs: 0, setupMs: 0 },
    }
    await expect(resetTestDatabase(admin, { ...database, template })).rejects.toThrow('identity mismatch')
    expect((await admin.query('select datname from pg_database where datname=$1', [database.name])).rows)
      .toEqual([{ datname: database.name }])
    expect((await pool.query('select value from reset_sentinel')).rows).toEqual([{ value: 'retained' }])
  } finally {
    await pool?.end()
    if (database) {
      const exists = await admin.query('select datname from pg_database where datname=$1', [database.name])
      if (exists.rows.length) await dropTestDatabase(admin, database)
    }
    await admin.end()
    removeTestRoot(root)
  }
})

it('rejects connections to the app PostgreSQL endpoint before connecting', async () => {
  const client = new pg.Client({ connectionString: 'postgresql://graphql:graphql@127.0.0.1:5432/graphql' })
  await expect(client.connect()).rejects.toThrow('dedicated disposable test instance')
  await client.end()
})

it('requires database and schema markers for destructive cleanup and excludes public lookup', async () => {
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL!, max: 1 })
  const suffix = randomUUID().replaceAll('-', '')
  const schema = `isolation_${suffix}`
  const database = `isolation_test_${suffix}`
  const sentinel = `sentinel_${suffix}`
  let pool: pg.Pool | undefined
  let databaseCreated = false
  try {
    await createFixtureSchema(admin, schema)
    await admin.query(`create table public.${sentinel}(value text)`)
    await admin.query(`insert into public.${sentinel} values ('retained')`)
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL!, options: `-c search_path=${schema}` })
    await expect(pool.query(`select * from ${sentinel}`)).rejects.toMatchObject({ code: '42P01' })
    await admin.query(`comment on schema ${schema} is 'another-owner'`)
    await expect(dropFixtureSchema(admin, schema)).rejects.toThrow('ownership mismatch')
    expect((await admin.query(`select value from public.${sentinel}`)).rows).toEqual([{ value: 'retained' }])
    await admin.query(`comment on schema ${schema} is 'graphql-test:${process.env.FOREMAN_CODE_TEST_OWNER}'`)
    await createFixtureDatabase(admin, database)
    databaseCreated = true
    await admin.query(`comment on database ${database} is 'another-owner'`)
    await expect(dropFixtureDatabase(admin, database)).rejects.toThrow('ownership mismatch')
    expect((await admin.query('select datname from pg_database where datname=$1', [database])).rows).toHaveLength(1)
    await admin.query(`comment on database ${database} is 'graphql-test:${process.env.FOREMAN_CODE_TEST_OWNER}'`)
  } finally {
    await pool?.end()
    if (databaseCreated) await dropFixtureDatabase(admin, database)
    await dropFixtureSchema(admin, schema)
    await admin.query(`drop table if exists public.${sentinel}`)
    await admin.end()
  }
})

it('rejects a prepared acceptance API bound to a different database before starting work', async () => {
  const { default: Fastify } = await import('fastify')
  const { assertOwnedTestApi } = await import('./helpers/testResources.js')
  const schema = `api_isolation_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL!, max: 1 })
  let pool: pg.Pool | undefined
  const app = Fastify()
  app.get('/health/identity', () => ({ checkoutId: 'a'.repeat(64), databaseId: 'b'.repeat(64),
    installationId: randomUUID() }))
  try {
    await createFixtureSchema(admin, schema)
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL!, options: `-c search_path=${schema}` })
    await pool.query('create table application_installation(singleton boolean, id uuid)')
    await pool.query('insert into application_installation values(true,$1)', [randomUUID()])
    const origin = new URL(await app.listen({ host: '127.0.0.1', port: 0 }))
    await expect(assertOwnedTestApi(origin, pool)).rejects.toThrow('does not own the disposable test database')
  } finally {
    await app.close()
    await pool?.end()
    await dropFixtureSchema(admin, schema)
    await admin.end()
  }
})

it('checks persisted execution destinations again after reconnecting to the prepared database', async () => {
  const fixture = destinationFixture
  const outside = createTestRoot(dirname(process.env.FOREMAN_CODE_TEST_ROOT!))
  let restarted: pg.Pool | undefined
  try {
    const saved = await seedAgent3(fixture.pool, fixture.directory,
      makeCurrentWorkflowFixture(randomUUID(), 'single'), { run: false })
    const selection = { workspaceId: saved.scope.workspaceId,
      agentConfigurationVersionIds: saved.configurations.map(configuration => configuration.id) }
    await assertOwnedExecutionDestinations(fixture.pool, selection)
    await fixture.pool.query('update workspaces set execution_location=$2::jsonb where id=$1',
      [selection.workspaceId, JSON.stringify({ runnerId: 'local', rootPath: outside.directory })])
    restarted = new pg.Pool({ connectionString: fixture.databaseUrl,
      options: `-c search_path=${fixture.schema}`, max: 1 })
    const persisted = await restarted.query('select execution_location from workspaces where id=$1',
      [selection.workspaceId])
    expect(persisted.rows).toEqual([{ execution_location: { runnerId: 'local', rootPath: outside.directory } }])
    await expect(assertOwnedExecutionDestinations(restarted, selection)).rejects.toThrow('owned root')
    expect((await restarted.query('select count(*)::int as count from runs')).rows[0].count).toBe(0)
    await restarted.query('update workspaces set execution_location=$2::jsonb where id=$1',
      [selection.workspaceId, JSON.stringify({ runnerId: 'local', rootPath: fixture.directory })])
    await assertOwnedExecutionDestinations(restarted, selection)
    const configuration = AgentConfigurationVersionSchema.parse({ ...saved.configurations[0], harness: {
      harness: 'claude', model: 'claude-sonnet-4-6', authMode: 'subscription', configDirectory: outside.directory,
      permissionMode: 'default', sandbox: 'workspace-write', tools: [], permissionRules: [], instructions: '', mcpServers: {},
    } })
    await restarted.query('update agent_configuration_versions set record=$2::jsonb where id=$1',
      [configuration.id, JSON.stringify(configuration)])
    await expect(assertOwnedExecutionDestinations(restarted, selection)).rejects.toThrow('owned root')
    await restarted.query('update agent_configuration_versions set record=$2::jsonb where id=$1',
      [configuration.id, JSON.stringify(saved.configurations[0])])
    await assertOwnedExecutionDestinations(restarted, selection)
  } finally {
    try { await restarted?.end() }
    finally { removeTestRoot(outside) }
  }
})

it('checks accepted Run locations and native directories independently of the current workspace location', async () => {
  const fixture = destinationFixture
  const outside = createTestRoot(dirname(process.env.FOREMAN_CODE_TEST_ROOT!))
  try {
    const outsideRun = await seedAgent3(fixture.pool, outside.directory,
      makeCurrentWorkflowFixture(randomUUID(), 'single'))
    await fixture.pool.query('update workspaces set execution_location=$2::jsonb where id=$1',
      [outsideRun.scope.workspaceId, JSON.stringify({ runnerId: 'local', rootPath: fixture.directory })])
    await expect(assertOwnedExecutionDestinations(fixture.pool, {
      workspaceId: outsideRun.scope.workspaceId, runId: outsideRun.run.id,
    })).rejects.toThrow('owned root')
    const saved = await seedAgent3(fixture.pool, fixture.directory, makeCurrentWorkflowFixture(randomUUID(), 'single'))
    const selection = { workspaceId: saved.scope.workspaceId, runId: saved.run.id }
    await assertOwnedExecutionDestinations(fixture.pool, selection)
    const execution = HarnessExecutionSchema.parse({ ...candidateFor(saved),
      workingDirectory: fixture.directory, runtimeDirectory: outside.directory })
    await fixture.pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
      values($1,$2,$3,$4,$5,$6::jsonb)`, [execution.id, execution.runId, execution.workflowNodeId,
      execution.agentId, execution.attempt, JSON.stringify(execution)])
    await expect(assertOwnedExecutionDestinations(fixture.pool, selection)).rejects.toThrow('owned root')
    await fixture.pool.query('update harness_executions set record=$2::jsonb where id=$1',
      [execution.id, JSON.stringify({ ...execution, runtimeDirectory: fixture.directory, workingDirectory: outside.directory })])
    await expect(assertOwnedExecutionDestinations(fixture.pool, selection)).rejects.toThrow('owned root')
    await fixture.pool.query('update harness_executions set record=$2::jsonb where id=$1',
      [execution.id, JSON.stringify({ ...execution, runtimeDirectory: fixture.directory })])
    await assertOwnedExecutionDestinations(fixture.pool, selection)
  } finally {
    removeTestRoot(outside)
  }
})
