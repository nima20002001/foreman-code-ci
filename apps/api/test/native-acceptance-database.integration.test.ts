import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { expect, it } from 'vitest'
import { nim2691TaskDatabase } from './helpers/nim2691Database.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { completeTestResourceCleanup, dropFixtureDatabase, ownedTestDatabaseUrl,
  registerTestResourceCleanup, createTestDatabase, provisionTestResources,
  testAdminPool } from '../../../scripts/test-resources.mjs'


async function disposeRetainedBootstrap(admin: pg.Pool, name: string): Promise<void> {
  const invocation = { directory: process.env.FOREMAN_CODE_TEST_ROOT!, token: process.env.FOREMAN_CODE_TEST_OWNER! }
  const folder = join(invocation.directory, '.graphql-test-cleanup')
  for (const file of await readdir(folder)) {
    const pending = JSON.parse(await readFile(join(folder, file), 'utf8')) as {
      id: string; kind: string; name?: string
    }
    if (pending.kind === 'native-acceptance-database' && pending.name === name) {
      await dropFixtureDatabase(admin, name)
      completeTestResourceCleanup(invocation, pending.id)
      return
    }
  }
  throw new Error('Retained bootstrap cleanup record is missing.')
}

it('suite teardown removes registered child databases only after their callers close and preserves foreign ownership', async () => {
  const environment = { ...process.env }
  delete environment.FOREMAN_CODE_TEST_ROOT
  delete environment.FOREMAN_CODE_TEST_OWNER
  const suite = await provisionTestResources(environment)
  const resource = { directory: suite.environment.FOREMAN_CODE_TEST_ROOT!,
    token: suite.environment.FOREMAN_CODE_TEST_OWNER!, databaseUrl: suite.environment.TEST_DATABASE_URL! }
  const admin = await testAdminPool()
  let caller: pg.Client | undefined
  let foreignCleanup: string | undefined
  try {
    const child = await createTestDatabase(admin, resource)
    registerTestResourceCleanup(resource, { kind: 'fixture-database', name: child.name })
    caller = new pg.Client({ connectionString: child.databaseUrl })
    await caller.connect()
    await expect(suite.close()).rejects.toThrow('ownership or closure is unconfirmed')
    expect((await caller.query('select 1')).rowCount).toBe(1)
    await caller.end()
    caller = undefined
    foreignCleanup = registerTestResourceCleanup(resource, { kind: 'fixture-database',
      name: new URL(ownedTestDatabaseUrl()).pathname.slice(1) })
    await expect(suite.close()).rejects.toThrow('ownership or closure is unconfirmed')
    expect((await admin.query('select 1 from pg_database where datname=$1',
      [new URL(ownedTestDatabaseUrl()).pathname.slice(1)])).rows).toHaveLength(1)
    completeTestResourceCleanup(resource, foreignCleanup)
    foreignCleanup = undefined
    await suite.close()
    expect((await admin.query('select 1 from pg_database where datname=$1', [child.name])).rows).toEqual([])
    await expect(access(resource.directory)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await caller?.end()
    if (foreignCleanup) completeTestResourceCleanup(resource, foreignCleanup)
    try {
      const retained = await access(resource.directory).then(() => true, () => false)
      if (retained) await suite.close()
    } finally { await admin.end() }
  }
}, 30_000)

it('acceptance bootstrap supplies an isolated database and removes it after success and failure', async () => {
  const script = new URL('../../../scripts/test-native-acceptance.mjs', import.meta.url).href
  const { withNativeAcceptanceDatabase } = await import(script)
  const configured = process.env.TEST_DATABASE_URL
  if (!configured) throw new Error('TEST_DATABASE_URL is required')
  const admin = new pg.Pool({ connectionString: ownedTestDatabaseUrl(), max: 1 })
  const directory = await mkdtemp(join(tmpdir(), 'native-bootstrap-'))
  const ownedNames = new Set<string>()
  try {
    for (const exitCode of [0, 1]) {
      const record = await withNativeAcceptanceDatabase(configured, directory,
        async ({ databaseUrl }: { databaseUrl: string }) => {
          expect(databaseUrl).not.toBe(configured)
          expect(new URL(databaseUrl).hostname).toBe(new URL(configured).hostname)
          expect(new URL(databaseUrl).pathname.endsWith('_test')).toBe(true)
          const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })
          try {
            expect((await pool.query('select current_schema() as name')).rows[0].name).toBe('native_acceptance')
            await pool.query('create table retained_result (value text)')
            await pool.query('insert into retained_result values ($1)', ['native bootstrap'])
            expect((await pool.query('select value from retained_result')).rows).toEqual([{ value: 'native bootstrap' }])
            return exitCode
          } finally {
            await pool.end()
          }
        })
      expect(record).toMatchObject({ created: true, removed: true, exitCode })
      expect(record.name).toMatch(/^foreman_code_native_[a-f0-9]{32}_test$/)
      expect(ownedNames.has(record.name)).toBe(false)
      ownedNames.add(record.name)
      expect((await admin.query('select 1 from pg_database where datname=$1', [record.name])).rowCount).toBe(0)
      expect(JSON.parse(await readFile(join(directory, record.name, 'database.json'), 'utf8'))).toEqual(record)
      expect((await admin.query('select 1 from pg_database where datname=$1',
        [decodeURIComponent(new URL(configured).pathname.slice(1))])).rowCount).toBe(1)
    }
    await expect(withNativeAcceptanceDatabase('postgresql://graphql_production:invalid@127.0.0.1:55440/graphql_production',
      directory, async () => { throw new Error('Unowned callback must not run') })).rejects.toThrow('owned test database')
    await expect(withNativeAcceptanceDatabase(configured, directory, async () => {
      throw new Error('Native launch failed')
    })).rejects.toThrow('Native launch failed')
    for (const name of await readdir(directory)) {
      const record = JSON.parse(await readFile(join(directory, name, 'database.json'), 'utf8')) as {
        created: boolean; removed: boolean
      }
      expect(record).toMatchObject({ created: true, removed: true })
      expect((await admin.query('select 1 from pg_database where datname=$1', [name])).rowCount).toBe(0)
    }
  } finally {
    await admin.end()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

it.each([false, true])('reports leaked workflow callers and removes owned resources (work failed: %s)', async failed => {
  const configured = process.env.NIM2691_ADMIN_DATABASE_URL
  if (!configured) throw new Error('NIM2691_ADMIN_DATABASE_URL is required')
  const admin = new pg.Pool({ connectionString: configured, max: 1 })
  const failure = new Error('Workflow verification failed')
  const directories: string[] = []
  const connectionErrors: unknown[] = []
  let client: pg.Client | undefined
  let ownedName = ''
  try {
    const work = nim2691TaskDatabase(async (_pool, directory, databaseUrl) => {
      directories.push(directory, await privateFixtureDirectory('native-cleanup-'))
      ownedName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1))
      client = new pg.Client({ connectionString: databaseUrl })
      client.on('error', error => { connectionErrors.push(error) })
      await client.connect()
      await client.query('select 1')
      if (failed) throw failure
      return 'completed'
    })
    await expect(work).rejects.toMatchObject({
      name: 'AggregateError', errors: expect.arrayContaining([
        expect.objectContaining({ message: 'Native fixture database still had active callers during teardown.' }),
        ...(failed ? [failure] : []),
      ]), ...(failed ? { cause: failure } : {}),
    })
    expect((await admin.query('select 1 from pg_database where datname=$1', [ownedName])).rowCount).toBe(1)
    await expect(client!.query('select 1')).resolves.toMatchObject({ rowCount: 1 })
    await client!.end()
    expect(connectionErrors).toEqual([])
    await dropFixtureDatabase(admin, ownedName)
    expect((await admin.query('select 1 from pg_database where datname=$1', [ownedName])).rowCount).toBe(0)
    await expect(client!.query('select 1')).rejects.toThrow()
    expect(directories).toHaveLength(2)
    for (const directory of directories) await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await admin.query('select 1 from pg_database where datname=$1',
      [decodeURIComponent(new URL(configured).pathname.slice(1))])).rowCount).toBe(1)
  } finally {
    await client?.end()
    await admin.end()
  }
}, 30_000)

it('disposes only its owned database with leaked callers while retaining work failure', async () => {
  const script = new URL('../../../scripts/test-native-acceptance.mjs', import.meta.url).href
  const { withNativeAcceptanceDatabase } = await import(script)
  const configured = process.env.TEST_DATABASE_URL
  if (!configured) throw new Error('TEST_DATABASE_URL is required')
  const admin = new pg.Pool({ connectionString: ownedTestDatabaseUrl(), max: 1 })
  const directory = await mkdtemp(join(tmpdir(), 'native-bootstrap-cleanup-'))
  try {
    for (const failed of [false, true]) {
      let ownedName = ''
      let client: pg.Client | undefined
      const connectionErrors: unknown[] = []
          const failure = new Error('Native verification failed')
      const work = withNativeAcceptanceDatabase(configured, directory,
        async ({ databaseUrl }: { databaseUrl: string }) => {
          ownedName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1))
          client = new pg.Client({ connectionString: databaseUrl })
          client.on('error', error => { connectionErrors.push(error) })
          await client.connect()
          await client.query('select 1')
          if (failed) throw failure
          return 0
        })
      try {
        if (failed) await expect(work).rejects.toBe(failure)
        else await expect(work).resolves.toMatchObject({ removed: false, exitCode: 1 })
        expect(ownedName).not.toBe(decodeURIComponent(new URL(configured).pathname.slice(1)))
        expect((await admin.query('select 1 from pg_database where datname=$1', [ownedName])).rowCount).toBe(1)
        await expect(client!.query('select 1')).resolves.toMatchObject({ rowCount: 1 })
        await client!.end()
        expect(connectionErrors).toEqual([])
        await disposeRetainedBootstrap(admin, ownedName)
        expect((await admin.query('select 1 from pg_database where datname=$1', [ownedName])).rowCount).toBe(0)
        await expect(client!.query('select 1')).rejects.toThrow()
      } finally { await client?.end() }
    }
    expect((await admin.query('select 1 from pg_database where datname=$1',
      [decodeURIComponent(new URL(configured).pathname.slice(1))])).rowCount).toBe(1)
  } finally {
    await admin.end()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

it.each(['native-qualification', 'native-acceptance-process-group'])(
  'retains the native bootstrap database until registered %s cleanup is confirmed', async (kind) => {
  const script = new URL('../../../scripts/test-native-acceptance.mjs', import.meta.url).href
  const { withNativeAcceptanceDatabase } = await import(script)
  const invocation = { directory: process.env.FOREMAN_CODE_TEST_ROOT!, token: process.env.FOREMAN_CODE_TEST_OWNER! }
  const directory = await mkdtemp(join(tmpdir(), 'native-bootstrap-retained-'))
  let cleanupId: string | undefined
  let databaseName: string | undefined
  const parent = new pg.Pool({ connectionString: ownedTestDatabaseUrl(), max: 1 })
  try {
    const record = await withNativeAcceptanceDatabase(process.env.TEST_DATABASE_URL, directory,
      async () => {
        cleanupId = registerTestResourceCleanup(invocation, { kind })
        return 0
      })
    databaseName = record.name
    expect(record).toMatchObject({ created: true, removed: false, exitCode: 1 })
    expect((await parent.query('select 1 from pg_database where datname=$1', [record.name])).rowCount).toBe(1)
    completeTestResourceCleanup(invocation, cleanupId!)
    cleanupId = undefined
    const folder = join(invocation.directory, '.graphql-test-cleanup')
    for (const file of await readdir(folder)) {
      const pending = JSON.parse(await readFile(join(folder, file), 'utf8')) as {
        id: string; kind: string; name?: string
      }
      if (pending.kind === 'native-acceptance-database' && pending.name === record.name) {
        await dropFixtureDatabase(parent, record.name)
        completeTestResourceCleanup(invocation, pending.id)
        databaseName = undefined
      }
    }
    expect((await parent.query('select 1 from pg_database where datname=$1', [record.name])).rowCount).toBe(0)
  } finally {
    if (cleanupId) completeTestResourceCleanup(invocation, cleanupId)
    if (databaseName) await dropFixtureDatabase(parent, databaseName)
    await parent.end()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
