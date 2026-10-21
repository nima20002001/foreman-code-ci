import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs'
import { chmod, mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createTestPool } from './helpers/testPool.mjs'
import * as resources from '../../../scripts/test-resources.mjs'

const require = createRequire(import.meta.url)
const resourcesModule = new URL('../../../scripts/test-resources.mjs', import.meta.url).href
const registryModule = new URL('../src/modules/harnesses/recovery/processRegistry.ts', import.meta.url).href

it('recovers abandoned nested invocations, native reservations and databases after their last caller exits', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true, mode: 0o700 })
  const parent = await mkdtemp(join(cache, 'disposable-recovery-'))
  const child = spawnSync(process.execPath, ['--import', require.resolve('tsx'), '--input-type=module', '-e', `
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import * as resources from ${JSON.stringify(resourcesModule)};
    import { NativeProcessRegistry } from ${JSON.stringify(registryModule)};
    const admin = await resources.testAdminPool();
    try {
      const root = resources.createTestRoot(${JSON.stringify(parent)});
      const slot = resources.createTestRoot(root.directory, 'slot-');
      const database = await resources.createTestDatabase(admin, slot);
      const fixture = await resources.createTestDatabase(admin, slot);
      resources.registerTestResourceCleanup(slot, { kind: 'fixture-database', name: fixture.name });
      const registryDirectory = join(slot.directory, 'native-registry');
      await new NativeProcessRegistry(registryDirectory).reserveLaunch('abandoned-qualification');
      resources.registerTestResourceCleanup(slot, { kind: 'native-qualification', registryDirectory });
      resources.registerTestResourceCleanup(slot, { kind: 'suite-process-group', wrapperPid: process.pid });
      const readonly = join(slot.directory, 'readonly');
      mkdirSync(readonly);
      writeFileSync(join(readonly, 'data'), 'disposable fixture');
      console.log(JSON.stringify({ root, slot, database, fixture, readonly }));
    } finally { await admin.end(); }
  `], { encoding: 'utf8', env: process.env, timeout: 30_000 })
  expect(child.status, child.stderr).toBe(0)
  const saved = JSON.parse(child.stdout) as {
    root: resources.TestRoot; slot: resources.TestRoot;
    database: resources.TestDatabase; fixture: resources.TestDatabase; readonly: string;
  }
  const admin = await resources.testAdminPool()
  const caller = createTestPool({ connectionString: saved.fixture.databaseUrl, max: 1 })
  let callerClosed = false
  const readDirectory = fs.readdirSync
  // Model an isolated process namespace; unrelated protected host services must stay outside this fixture.
  const inventory = vi.spyOn(fs, 'readdirSync').mockImplementation((...args) => {
    if (args[0] === '/proc') return [String(process.pid)] as never
    return readDirectory(...args)
  })
  syncBuiltinESMExports()
  try {
    await chmod(saved.readonly, 0o500)
    expect((await caller.query('select 1 as connected')).rows).toEqual([{ connected: 1 }])
    await resources.recoverAbandonedTestRoots(admin, { parent, containers: () => '' })
    expect(existsSync(saved.root.directory)).toBe(true)
    expect((await caller.query('select 1 as retained')).rows).toEqual([{ retained: 1 }])
    await caller.end()
    callerClosed = true
    await expect.poll(async () => (await admin.query(
      'select count(*)::int as callers from pg_stat_activity where datname = any($1::text[])',
      [[saved.database.name, saved.fixture.name]])).rows[0]!.callers).toBe(0)
    const heldFile = await open(join(saved.readonly, 'data'), 'r')
    try {
      const inUse = await resources.recoverAbandonedTestRoots(admin, { parent, containers: () => '' })
      expect(inUse.removed).toEqual([])
      expect(inUse.retained).toEqual([{
        directory: saved.root.directory, reason: 'Test root is still in use by a process',
      }])
      expect(existsSync(saved.root.directory)).toBe(true)
    } finally {
      await heldFile.close()
    }
    const recovered = await resources.recoverAbandonedTestRoots(admin, { parent, containers: () => '' })
    expect(recovered.retained).toEqual([])
    expect(recovered.removed).toContain(saved.root.directory)
    expect(existsSync(saved.root.directory)).toBe(false)
    const databases = await admin.query('select datname from pg_database where datname = any($1::text[])',
      [[saved.database.name, saved.fixture.name]])
    expect(databases.rows).toEqual([])
    await resources.recoverAbandonedTestRoots(admin, { parent, containers: () => '' })
    expect(existsSync(saved.slot.directory)).toBe(false)
  } finally {
    inventory.mockRestore()
    syncBuiltinESMExports()
    if (!callerClosed) await caller.end()
    if (existsSync(saved.readonly)) await chmod(saved.readonly, 0o700)
    // Preserve failed recovery journals for the orchestrator's inspection.
    if (!existsSync(saved.root.directory)) await rm(parent, { recursive: true, force: true })
    await admin.end()
  }
}, 60_000)
