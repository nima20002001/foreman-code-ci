import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as resources from './test-resources.mjs'

const resourcesModule = new URL('./test-resources.mjs', import.meta.url).href

const visibleProcesses = new Set()

function fixture(t) {
  visibleProcesses.clear()
  visibleProcesses.add(String(process.pid))
  const readDirectory = fs.readdirSync
  t.mock.method(fs, 'readdirSync', (path, ...args) => path === '/proc'
    ? [...visibleProcesses] : readDirectory(path, ...args))
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  mkdirSync(cache, { recursive: true, mode: 0o700 })
  const directory = mkdtempSync(join(cache, 'test-root-recovery-'))
  const parent = join(directory, 'parent-link')
  mkdirSync(join(directory, 'parent'))
  symlinkSync('parent', parent)
  t.after(() => {
    const writable = directory => {
      chmodSync(directory, 0o700)
      for (const name of readdirSync(directory)) {
        const path = join(directory, name)
        if (lstatSync(path).isDirectory()) writable(path)
      }
    }
    writable(parent)
    const roots = []
    const collect = directory => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name)
        if (lstatSync(path).isDirectory()) collect(path)
      }
      const marker = join(directory, '.graphql-test-owner.json')
      if (existsSync(marker)) roots.push(JSON.parse(readFileSync(marker, 'utf8')))
    }
    collect(parent)
    for (const resource of roots) {
      for (const name of existsSync(join(resource.directory, '.graphql-test-cleanup'))
        ? readdirCleanup(resource.directory) : []) {
        resources.completeTestResourceCleanup(resource, name.slice(0, -5))
      }
      resources.removeTestRoot(resource)
    }
    rmSync(directory, { recursive: true, force: true })
  })
  return parent
}

function abandonedRoot(parent, program = '') {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { join } from 'node:path';
    import { mkdirSync, writeFileSync } from 'node:fs';
    import * as resources from ${JSON.stringify(resourcesModule)};
    const resource = resources.createTestRoot(${JSON.stringify(parent)});
    ${program}
    console.log(JSON.stringify(resource));
  `], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  return JSON.parse(child.stdout)
}

function adminWithoutDatabases() {
  let first = true
  return { query: async () => {
    if (!first) return { rows: [] }
    first = false
    return { rows: [{ acquired: true }] }
  } }
}

const noContainers = () => ''

test('test roots record the owning process identity for later recovery', t => {
  const resource = resources.createTestRoot(fixture(t))
  const marker = JSON.parse(readFileSync(join(resource.directory, '.graphql-test-owner.json'), 'utf8'))
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8')
  const startTicks = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19]
  assert.deepEqual(marker.process, { pid: process.pid, startTicks,
    boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() })
})

test('recovery removes fresh abandoned nested roots and writable copies without following symlinks', async t => {
  const parent = fixture(t)
  const outside = join(parent, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'preserved'), 'outside data')
  const resource = abandonedRoot(parent, `
    const child = resources.createTestRoot(resource.directory, 'slot-');
    mkdirSync(join(child.directory, 'readonly'));
    writeFileSync(join(child.directory, 'readonly', 'data'), 'disposable');
  `)
  const childDirectory = JSON.parse(readFileSync(join(resource.directory, '.graphql-test-cleanup',
    readdirCleanup(resource.directory)[0]), 'utf8')).directory
  chmodSync(join(childDirectory, 'readonly'), 0o500)
  symlinkSync(outside, join(childDirectory, 'outside-link'))
  const recovered = await resources.recoverAbandonedTestRoots(adminWithoutDatabases(), { parent, containers: noContainers })
  assert.deepEqual(recovered.retained, [])
  assert.equal(existsSync(resource.directory), false)
  assert.equal(readFileSync(join(outside, 'preserved'), 'utf8'), 'outside data')
})

function readdirCleanup(directory) {
  return readdirSync(join(directory, '.graphql-test-cleanup'))
}

test('recovery preserves old live roots and roots without a confirmed process identity', async t => {
  const parent = fixture(t)
  const live = resources.createTestRoot(parent)
  const unknown = abandonedRoot(parent)
  const markerPath = join(unknown.directory, '.graphql-test-owner.json')
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
  delete marker.process
  writeFileSync(markerPath, JSON.stringify(marker))
  utimesSync(join(live.directory, '.graphql-test-owner.json'), 1, 1)
  await resources.recoverAbandonedTestRoots(adminWithoutDatabases(), { parent, containers: noContainers })
  assert.equal(existsSync(live.directory), true)
  assert.equal(existsSync(unknown.directory), true)
})

test('recovery distinguishes a reused PID from the original owning process', async t => {
  const parent = fixture(t)
  const resource = abandonedRoot(parent)
  const markerPath = join(resource.directory, '.graphql-test-owner.json')
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
  marker.process = { pid: process.pid, startTicks: '0',
    boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() }
  writeFileSync(markerPath, JSON.stringify(marker))
  const recovered = await resources.recoverAbandonedTestRoots(adminWithoutDatabases(), { parent, containers: noContainers })
  assert.deepEqual(recovered.retained, [])
  assert.equal(existsSync(resource.directory), false)
})

test('an unknown cleanup stays recorded while recovery continues with other dead roots', async t => {
  const parent = fixture(t)
  const retained = abandonedRoot(parent, `
    resources.registerTestResourceCleanup(resource, { kind: 'unrecognized-resource' });
  `)
  const removable = abandonedRoot(parent)
  const result = await resources.recoverAbandonedTestRoots(adminWithoutDatabases(), { parent, containers: noContainers })
  assert.equal(existsSync(removable.directory), false)
  assert.equal(readdirCleanup(retained.directory).length, 1)
  assert.equal(result.retained.length, 1)
})

test('recovery preserves running bind-mounted containers and retries stopped disposable containers', async t => {
  const parent = fixture(t)
  const resource = abandonedRoot(parent)
  const containerId = 'a'.repeat(64)
  let running = true
  let removed = false
  let removalFails = false
  const containers = args => {
    if (args[0] === 'ps') return removed ? '' : containerId
    if (args[0] === 'inspect') return JSON.stringify([{ Id: containerId, State: { Running: running },
      Config: { Labels: { 'graphql.test-owner': 'disposable-tests' } },
      Mounts: [{ Type: 'bind', Source: resource.directory }] }])
    if (args[0] === 'rm') {
      if (removalFails) throw new Error('container cleanup unavailable')
      removed = true
      return containerId
    }
    throw new Error('Unexpected container operation')
  }
  await resources.recoverAbandonedTestRoots(adminWithoutDatabases(), { parent, containers })
  assert.equal(existsSync(resource.directory), true)
  assert.equal(removed, false)
  running = false
  removalFails = true
  await resources.recoverAbandonedTestRoots(adminWithoutDatabases(), { parent, containers })
  assert.equal(existsSync(resource.directory), true)
  removalFails = false
  await resources.recoverAbandonedTestRoots(adminWithoutDatabases(), { parent, containers })
  assert.equal(removed, true)
  assert.equal(existsSync(resource.directory), false)
})

test('normal cleanup also removes read-only owned directories', t => {
  const resource = resources.createTestRoot(fixture(t))
  const directory = join(resource.directory, 'readonly')
  mkdirSync(directory)
  writeFileSync(join(directory, 'data'), 'disposable')
  chmodSync(directory, 0o500)
  resources.removeTestRoot(resource)
  assert.equal(existsSync(resource.directory), false)
})

test('recovery keeps an abandoned root while a surviving process holds its working directory', async t => {
  const parent = fixture(t)
  const resource = abandonedRoot(parent)
  const { spawn } = await import('node:child_process')
  const { once } = await import('node:events')
  const child = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"],
    { cwd: resource.directory, stdio: ['ignore', 'pipe', 'inherit'] })
  visibleProcesses.add(String(child.pid))
  const exited = once(child, 'exit')
  try {
    await once(child.stdout, 'data')
    await resources.recoverAbandonedTestRoots(adminWithoutDatabases(), { parent, containers: noContainers })
    assert.equal(existsSync(resource.directory), true)
  } finally {
    child.kill()
    await exited
  }
  const recovered = await resources.recoverAbandonedTestRoots(adminWithoutDatabases(), { parent, containers: noContainers })
  assert.deepEqual(recovered.retained, [])
  assert.equal(existsSync(resource.directory), false)
})

test('recovery closes a dead callers native reservation before removing its nested root', async t => {
  const parent = fixture(t)
  const registryModule = new URL('../apps/api/src/modules/harnesses/recovery/processRegistry.ts', import.meta.url).href
  const child = spawnSync(process.execPath, ['--import', createRequire(new URL('../apps/api/package.json', import.meta.url)).resolve('tsx'), '--input-type=module', '-e', `
    import { join } from 'node:path';
    import * as resources from ${JSON.stringify(resourcesModule)};
    import { NativeProcessRegistry } from ${JSON.stringify(registryModule)};
    const root = resources.createTestRoot(${JSON.stringify(parent)});
    const slot = resources.createTestRoot(root.directory, 'slot-');
    const registryDirectory = join(slot.directory, 'native-registry');
    await new NativeProcessRegistry(registryDirectory).reserveLaunch('abandoned-provider');
    resources.registerTestResourceCleanup(slot, { kind: 'native-qualification', registryDirectory });
    resources.registerTestResourceCleanup(slot, { kind: 'suite-process-group', wrapperPid: process.pid });
    console.log(JSON.stringify(root));
  `], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  const root = JSON.parse(child.stdout)
  const result = await resources.recoverAbandonedTestRoots(adminWithoutDatabases(), { parent, containers: noContainers })
  assert.deepEqual(result.retained, [])
  assert.deepEqual(result.removed, [root.directory])
  assert.equal(existsSync(root.directory), false)
})

test('recovery retains a root when a visible process cannot be inspected', async t => {
  const parent = fixture(t)
  const resource = abandonedRoot(parent)
  const read = fs.readFileSync
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (path === `/proc/${process.pid}/environ`) {
      throw Object.assign(new Error('Process environment unavailable'), { code: 'EACCES' })
    }
    return read(path, ...args)
  })
  syncBuiltinESMExports()
  const recovered = await resources.recoverAbandonedTestRoots(adminWithoutDatabases(), { parent, containers: noContainers })
  assert.deepEqual(recovered.removed, [])
  assert.deepEqual(recovered.retained, [{ directory: resource.directory, reason: 'Process environment unavailable' }])
  assert.equal(existsSync(resource.directory), true)
})

test('recovery ignores a process whose protected environment belongs to another user', async t => {
  const parent = fixture(t)
  const resource = abandonedRoot(parent)
  const stat = fs.lstatSync
  const read = fs.readFileSync
  const environmentPath = `/proc/${process.pid}/environ`
  t.mock.method(fs, 'lstatSync', (path, ...args) => {
    const result = stat(path, ...args)
    if (path === environmentPath) return { ...result, uid: process.getuid() + 1 }
    return result
  })
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (path === environmentPath) {
      throw Object.assign(new Error('Protected process environment'), { code: 'EACCES' })
    }
    return read(path, ...args)
  })
  syncBuiltinESMExports()

  const recovered = await resources.recoverAbandonedTestRoots(adminWithoutDatabases(), {
    parent, containers: noContainers,
  })
  assert.deepEqual(recovered.retained, [])
  assert.deepEqual(recovered.removed, [resource.directory])
  assert.equal(existsSync(resource.directory), false)
})
