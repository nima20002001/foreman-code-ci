import { createTestPool } from './helpers/testPool.mjs'
import { readUntil } from './helpers/observableCondition.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import { expect, it } from 'vitest'
import { assertTestDatabase, completeTestResourceCleanup, dropFixtureDatabase, provisionTestResources,
  registerTestResourceCleanup, removeFixtureDirectory, testAdminPool } from '../../../scripts/test-resources.mjs'
import { groupUsed, stopGroup } from '../../../scripts/integration-process.mjs'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { agent3Database } from './helpers/wave25Agent3.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(import.meta.url)
const registryModule = pathToFileURL(join(root, 'apps/api/src/modules/harnesses/recovery/processRegistry.ts')).href
const resourcesModule = pathToFileURL(join(root, 'scripts/test-resources.mjs')).href
const wrapper = join(root, 'scripts/test-command.mjs')

function exit(child: ChildProcess): Promise<number | null> {
  return once(child, 'exit').then(([code]) => code as number | null)
}

it('retains fixture rows and native state until pending qualification closure is confirmed', async () => {
  const fixture = await agent3Database()
  const registryDirectory = join(fixture.directory, 'native-processes')
  const registry = new NativeProcessRegistry(registryDirectory)
  const owner = 'unfinished-schedule-qualification'
  const invocation = { directory: process.env.FOREMAN_CODE_TEST_ROOT!, token: process.env.FOREMAN_CODE_TEST_OWNER! }
  const cleanupId = registerTestResourceCleanup(invocation, {
    kind: 'native-qualification', root: fixture.directory, registryDirectory, schema: fixture.schema,
    databaseUrl: fixture.pool.options.connectionString!,
  })
  const saved = join(fixture.directory, 'recovery-note.txt')
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL!, max: 1 })
  const inspection = createTestPool({ connectionString: fixture.pool.options.connectionString, max: 1 })
  const fixtureDatabase = (await fixture.pool.query<{ name: string }>(
    'select current_database() as name')).rows[0]!.name
  try {
    try {
      expect((await inspection.query('select current_database() as name')).rows)
        .toEqual([{ name: fixtureDatabase }])
      await fixture.pool.query('create table retained_fixture(value text)')
      await fixture.pool.query('insert into retained_fixture values($1)', ['preserved'])
      await writeFile(saved, 'pending closure')
      const recovery = await registry.reserveLaunch(owner)
      await expect(registry.closeOwner(owner)).rejects.toThrow('closure remains unconfirmed')
      await expect(fixture.close()).rejects.toThrow('cleanup remains unconfirmed')
      expect((await inspection.query(`select value from ${fixture.schema}.retained_fixture`)).rows)
        .toEqual([{ value: 'preserved' }])
      expect(await readFile(saved, 'utf8')).toBe('pending closure')
      expect(await registry.abandonReservedLaunch(recovery)).toBe(true)
      expect(await new NativeProcessRegistry(registryDirectory).closeOwner(owner)).toBe(true)
      completeTestResourceCleanup(invocation, cleanupId)
    } finally {
      await inspection.end()
    }
    await dropFixtureDatabase(admin, fixtureDatabase)
    await removeFixtureDirectory(fixture.directory)
    expect(existsSync(fixture.directory)).toBe(false)
    expect((await admin.query('select datname from pg_database where datname=$1', [fixtureDatabase])).rows)
      .toEqual([])
  } finally {
    await admin.end()
  }
}, 30_000)

async function waitForFile(file: string, child: ChildProcess): Promise<void> {
  await readUntil(async () => {
    if (existsSync(file)) return true
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Owned test child did not report readiness')
    }
    return false
  }, value => value, { timeoutMs: 20_000, description: 'owned test child readiness' })
}

it.each(['same invocation', 'nested invocation'])(
  'retains databases and native state after failed closure in the %s, then recovers in a fresh process', async mode => {
  const environment = { ...process.env }
  delete environment.FOREMAN_CODE_TEST_ROOT
  delete environment.FOREMAN_CODE_TEST_OWNER
  const program = `
    import { join } from 'node:path';
    import { NativeProcessRegistry } from ${JSON.stringify(registryModule)};
    import { createTestDatabase, createTestRoot, registerTestResourceCleanup, testAdminPool }
      from ${JSON.stringify(resourcesModule)};
    const parent = { directory: process.env.FOREMAN_CODE_TEST_ROOT, token: process.env.FOREMAN_CODE_TEST_OWNER,
      databaseUrl: process.env.TEST_DATABASE_URL, name: new URL(process.env.TEST_DATABASE_URL).pathname.slice(1) };
    let resource = parent;
    if (${JSON.stringify(mode)} === 'nested invocation') {
      const admin = await testAdminPool();
      try { resource = await createTestDatabase(admin, createTestRoot()); }
      finally { await admin.end(); }
    }
    const registryDirectory = join(resource.directory, 'qualification-registry');
    const owner = 'unfinished-native-qualification';
    const registry = new NativeProcessRegistry(registryDirectory);
    const cleanupId = registerTestResourceCleanup(resource, { kind: 'native-qualification', registryDirectory, owner });
    await registry.reserveLaunch(owner);
    console.log('RECOVERY_RESOURCE ' + JSON.stringify({ parent, resource, registryDirectory, owner, cleanupId }));
    await registry.closeOwner(owner);
  `
  const child = spawn(process.execPath, [wrapper, '--', process.execPath, '--import', require.resolve('tsx'),
    '--input-type=module', '-e', program], { cwd: root, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr?.resume()
  let retained: { resource: { directory: string; token: string; databaseUrl: string; name: string };
    parent: { directory: string; token: string; databaseUrl: string; name: string };
    registryDirectory: string; owner: string; cleanupId: string } | undefined
  try {
    expect(await exit(child)).not.toBe(0)
    const line = output.split('\n').find(value => value.startsWith('RECOVERY_RESOURCE '))
    if (!line) throw new Error('Native recovery identity was not reported')
    retained = JSON.parse(line.slice('RECOVERY_RESOURCE '.length)) as NonNullable<typeof retained>
    expect(existsSync(retained.registryDirectory)).toBe(true)
    const admin = await testAdminPool()
    try {
      await assertTestDatabase(admin, retained.parent)
      await assertTestDatabase(admin, retained.resource)
    }
    finally { await admin.end() }
    const pool = new pg.Pool({ connectionString: retained.resource.databaseUrl, max: 1 })
    try { expect((await pool.query('select 1 as retained')).rows).toEqual([{ retained: 1 }]) }
    finally { await pool.end() }
    const recovery = spawn(process.execPath, ['--import', require.resolve('tsx'), '--input-type=module', '-e', `
      import { NativeProcessRegistry } from ${JSON.stringify(registryModule)};
      import { completeTestResourceCleanup, cleanupTestResources } from ${JSON.stringify(resourcesModule)};
      const saved = ${JSON.stringify(retained)};
      if (!await new NativeProcessRegistry(saved.registryDirectory).closeOwner(saved.owner)) {
        throw new Error('Native recovery closure remains unconfirmed');
      }
      completeTestResourceCleanup(saved.resource, saved.cleanupId);
      await cleanupTestResources(saved.resource);
      if (saved.parent.directory !== saved.resource.directory) await cleanupTestResources(saved.parent);
    `], { cwd: root, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    recovery.stdout?.resume()
    recovery.stderr?.resume()
    try { expect(await exit(recovery)).toBe(0) }
    finally { await stopGroup(recovery.pid) }
    expect(existsSync(retained.resource.directory)).toBe(false)
    expect(existsSync(retained.parent.directory)).toBe(false)
    const check = await testAdminPool()
    try {
      expect((await check.query('select datname from pg_database where datname=$1', [retained.resource.name])).rows).toEqual([])
      expect((await check.query('select datname from pg_database where datname=$1', [retained.parent.name])).rows).toEqual([])
    } finally { await check.end() }
  } finally {
    await stopGroup(child.pid)
    // Unconfirmed native state stays available if the recovery assertion fails.
  }
}, 60_000)

it.each(['SIGINT', 'SIGTERM'] as const)('escalates %s for an ignoring detached suite group and retains a nonzero result', async signal => {
  const resources = await provisionTestResources({ PATH: process.env.PATH })
  const ready = join(resources.environment.FOREMAN_CODE_TEST_ROOT!, 'child-ready.json')
  const program = `
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => {});
    const descendant = spawn(process.execPath, ['-e',
      'process.on("SIGINT",()=>{});process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
    writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pgid: process.pid, descendant: descendant.pid }));
    setInterval(() => {}, 1000);
  `
  const child = spawn(process.execPath, [wrapper, '--', process.execPath, '-e', program], {
    cwd: root, env: resources.environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.resume()
  child.stderr?.resume()
  const ended = exit(child)
  let pgid: number | undefined
  try {
    await waitForFile(ready, child)
    pgid = (JSON.parse(await readFile(ready, 'utf8')) as { pgid: number }).pgid
    child.kill(signal)
    expect(await ended).toBe(signal === 'SIGINT' ? 130 : 143)
    expect(groupUsed(pgid)).toBe(false)
    await resources.close()
    expect(existsSync(resources.environment.FOREMAN_CODE_TEST_ROOT!)).toBe(false)
  } finally {
    await stopGroup(child.pid)
    await stopGroup(pgid)
  }
}, 30_000)
