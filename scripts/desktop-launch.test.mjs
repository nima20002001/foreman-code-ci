import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  enableProductionServices, launchBrowser, launchProduction, productionIntegrationPaths,
  publishDesktopIntegration, withInstallationLock,
} from './local-production-runtime.mjs'

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('desktop activation waits for release switching and serializes duplicate launches', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-activation-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const lockPath = join(directory, 'install.lock')
  const migrated = deferred()
  const switchRelease = deferred()
  let selected = 'old'
  let running
  const starts = []
  const opened = []
  const install = withInstallationLock(lockPath, async () => {
    running = undefined
    migrated.resolve()
    await switchRelease.promise
    selected = 'new'
    running = selected
  })
  await migrated.promise
  const launch = () => launchProduction({ lockPath,
    start: async () => { starts.push(selected); running ??= selected },
    ready: async () => { assert.equal(running, selected) },
    openDashboard: async () => { opened.push(running) },
  })
  const launches = [launch(), launch()]
  // A short negative window proves launches stay blocked while migration owns the lock.
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(starts, [])
  switchRelease.resolve()
  await Promise.all([install, ...launches])
  assert.deepEqual(starts, ['new', 'new'])
  assert.deepEqual(opened, ['new', 'new'])
})

test('a failed migration releases the barrier without selecting a partial release', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-migration-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const lockPath = join(directory, 'install.lock')
  await assert.rejects(withInstallationLock(lockPath, async () => { throw new Error('Migration failed') }))
  let opened = false
  await launchProduction({ lockPath, start: async () => {}, ready: async () => {},
    openDashboard: async () => { opened = true },
  })
  assert.equal(opened, true)
})

test('activation retries both service startup and identity lookup before one browser handoff', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-recovery-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let starts = 0
  let reads = 0
  let opens = 0
  const attempts = [deferred(), deferred()]
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const launching = launchProduction({ lockPath: join(directory, 'install.lock'), timeoutMs: 5000,
    start: async () => {
      starts++
      attempts[starts - 1]?.resolve()
      if (starts === 1) throw new Error('Dependency unavailable')
    },
    ready: async () => { if (++reads === 1) throw new Error('Database identity unavailable') },
    openDashboard: async () => { opens++ },
  })
  try {
    for (const attempt of attempts) {
      await attempt.promise
      await setImmediate()
      t.mock.timers.tick(500)
    }
    await launching
  } finally {
    t.mock.timers.reset()
  }
  assert.equal(starts, 3)
  assert.equal(reads, 2)
  assert.equal(opens, 1)
})

for (const reason of ['Docker unavailable', 'Port is serving a different release']) {
  test(`permanent ${reason} ends with an actionable refusal and no browser`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'desktop-refusal-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    let opens = 0
    const attempted = deferred()
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    try {
      const rejected = assert.rejects(launchProduction({ lockPath: join(directory, 'install.lock'), timeoutMs: 20,
        start: async () => {}, ready: async () => { attempted.resolve(); throw new Error(reason) },
        openDashboard: async () => { opens++ },
      }), new RegExp(reason))
      await attempted.promise
      await setImmediate()
      t.mock.timers.tick(20)
      await rejected
    } finally {
      t.mock.timers.reset()
    }
    assert.equal(opens, 0)
  })
}

test('browser handoff accepts a successful existing-session exit and refuses spawn or startup failure', async () => {
  await launchBrowser(process.execPath, ['-e', 'process.exit(0)'])
  await assert.rejects(launchBrowser('/nonexistent/desktop-browser', []), /Chrome could not be started/)
  await assert.rejects(launchBrowser(process.execPath,
    ['-e', 'process.stderr.write("Cannot open display /private/profile fixture-secret");process.exit(2)']), error => {
    assert.match(error.message, /backend is ready.*Chrome exited \(2\).*graphical desktop/)
    assert.doesNotMatch(error.message, /private|fixture-secret/)
    return error.browserLaunchFailed === true
  })
})

test('a failed browser handoff is reported once without retrying a healthy backend', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-handoff-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let opens = 0
  await assert.rejects(launchProduction({ lockPath: join(directory, 'install.lock'),
    start: async () => {}, ready: async () => {},
    openDashboard: async () => {
      opens++
      await launchBrowser(process.execPath, ['-e', 'process.exit(1)'])
    },
  }), /backend is ready/)
  assert.equal(opens, 1)
})

test('custom XDG lookup finds installed integration and updates preserve disabled startup choices', async t => {
  const home = await mkdtemp(join(tmpdir(), 'desktop-integration-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const config = join(home, 'session-config')
  const data = join(home, 'session-data')
  const paths = productionIntegrationPaths(home, { XDG_CONFIG_HOME: config, XDG_DATA_HOME: data })
  const calls = []
  const run = async (command, args) => { calls.push({ command, args }) }
  const entries = { desktop: 'application', autostart: 'enabled', icon: '<svg/>', firstInstall: true }
  await publishDesktopIntegration(paths, entries)
  await enableProductionServices(run, ['db.service', 'api.service'], entries)
  assert.equal(await readFile(join(data, 'applications/graphql-production.desktop'), 'utf8'), 'application')
  assert.equal(await readFile(join(config, 'autostart/graphql-production.desktop'), 'utf8'), 'enabled')
  assert.equal(paths.units, join(config, 'systemd/user'))
  assert.equal(calls.length, 1)
  await writeFile(paths.autostart, '[Desktop Entry]\nHidden=true\nX-GNOME-Autostart-enabled=false\n')
  for (let update = 0; update < 2; update++) {
    await publishDesktopIntegration(paths, { ...entries, desktop: 'updated', firstInstall: false })
    await enableProductionServices(run, ['db.service', 'api.service'], { firstInstall: false })
  }
  assert.match(await readFile(paths.autostart, 'utf8'), /Hidden=true/)
  assert.equal(calls.length, 1)
  await rm(paths.autostart)
  await publishDesktopIntegration(paths, { ...entries, firstInstall: false })
  await assert.rejects(stat(paths.autostart), { code: 'ENOENT' })
  assert.equal(await readFile(paths.desktop, 'utf8'), 'application')
  assert.equal(productionIntegrationPaths(home, {}).desktop, join(home, '.local/share/applications/graphql-production.desktop'))
  assert.throws(() => productionIntegrationPaths(home, { XDG_CONFIG_HOME: 'relative' }), /absolute/)
  assert.throws(() => productionIntegrationPaths(home, { XDG_DATA_HOME: 'relative' }), /absolute/)
})
