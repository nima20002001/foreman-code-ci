import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { copyVerificationRuntime, desktopLaunchEnvironment, hasNativeTurnStarted, localProductionEnvironment, preserveOperatorConfiguration, publish, readEnvironment,
  removeUninstalledRelease, renderEnvironment,
  pruneReleases, shouldOpenDashboardAfterInstall, waitForProductionReady, withInstallationLock } from './local-production-runtime.mjs'
import { readProductEnvironment } from '../packages/contracts/src/productEnvironment.mjs'
import * as production from './local-production-runtime.mjs'

test('an interactive first install opens the dashboard', () => {
  assert.equal(shouldOpenDashboardAfterInstall({
    previousRelease: undefined, stdin: { isTTY: true }, stdout: { isTTY: true },
  }), true)
})

test('upgrades do not open the dashboard even from an interactive terminal', () => {
  assert.equal(shouldOpenDashboardAfterInstall({
    previousRelease: '/installed/release', stdin: { isTTY: true }, stdout: { isTTY: true },
  }), false)
})

test('first installs do not open the dashboard when input or output is non-interactive', () => {
  for (const isTTY of [false, undefined]) {
    for (const [stdin, stdout] of [
      [{ isTTY }, { isTTY: true }],
      [{ isTTY: true }, { isTTY }],
      [{ isTTY }, { isTTY }],
    ]) {
      assert.equal(shouldOpenDashboardAfterInstall({ previousRelease: undefined, stdin, stdout }), false)
    }
  }
})

test('desktop launch preserves the normal user environment without job ownership', () => {
  const source = { PATH: '/user/bin', HOME: '/user', TMPDIR: '/user/tmp' }
  const environment = desktopLaunchEnvironment(source)
  assert.deepEqual(environment, source)
  assert.notEqual(environment, source)
})

test('desktop launch drops job temporary overrides when no original directory was recorded', () => {
  const source = { PATH: '/user/bin', TMPDIR: '/job/tmp', TMP: '/job/tmp', TEMP: '/job/tmp',
    FOREMAN_CODE_HEAVY_JOB_TOKEN: 'owned-job', GRAPHQL_HEAVY_JOB_TOKEN: 'owned-job' }
  assert.deepEqual(desktopLaunchEnvironment(source), { PATH: '/user/bin' })
  assert.equal(source.TMPDIR, '/job/tmp')
})

test('a desktop child can create temporary files after its launching build job is removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'production-desktop-environment-'))
  const base = join(directory, 'base')
  const job = join(directory, 'job')
  let child
  try {
    await mkdir(base)
    await mkdir(job)
    const environment = desktopLaunchEnvironment({ ...process.env,
      TMPDIR: job, TMP: job, TEMP: job,
      FOREMAN_CODE_HEAVY_JOB_TOKEN: 'owned-job', GRAPHQL_HEAVY_JOB_TOKEN: 'owned-job',
      FOREMAN_CODE_HEAVY_BASE_TMPDIR: base, GRAPHQL_HEAVY_BASE_TMPDIR: base,
    })
    child = spawn(process.execPath, ['-e', `
      const { mkdirSync, mkdtempSync } = require('node:fs');
      const { tmpdir } = require('node:os');
      const { join } = require('node:path');
      process.on('message', () => {
        mkdirSync(tmpdir(), { recursive: true });
        const directory = mkdtempSync(join(tmpdir(), 'desktop-'));
        process.send({ directory, ownsJob: Object.keys(process.env).some(key => /^(FOREMAN_CODE|GRAPHQL)_HEAVY_/.test(key)) });
      });
    `], { env: environment, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    await once(child, 'spawn')
    await rm(job, { recursive: true })
    const message = once(child, 'message')
    child.send('create')
    const [result] = await message
    assert.equal(result.ownsJob, false)
    assert.equal((await stat(result.directory)).isDirectory(), true)
    await assert.rejects(stat(job), { code: 'ENOENT' })
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await exited
    }
    await rm(directory, { recursive: true, force: true })
  }
})

test('failed release cleanup removes only uninstalled staging and retains the active release through aliases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'production-release-cleanup-'))
  const installed = join(directory, 'installed')
  const failed = join(directory, 'failed')
  const current = join(directory, 'current')
  const alias = join(directory, 'alias')
  try {
    await mkdir(installed)
    await mkdir(failed)
    await writeFile(join(installed, 'retained'), 'installed production')
    await writeFile(join(failed, 'partial'), 'incomplete staging')
    await symlink(installed, current)
    await symlink(directory, alias)
    await removeUninstalledRelease(join(alias, 'installed'), current)
    assert.equal(await readFile(join(installed, 'retained'), 'utf8'), 'installed production')
    await removeUninstalledRelease(failed, current)
    await assert.rejects(stat(failed), { code: 'ENOENT' })
    assert.equal(await readFile(join(current, 'retained'), 'utf8'), 'installed production')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('native startup requires a live provider event on the bound execution and session', () => {
  const execution = { id: 'execution', nativeSessionId: 'session' }
  const codex = { executionId: execution.id, type: 'turn.started', payload: { threadId: 'session' } }
  const claude = { executionId: execution.id, type: 'claude.text',
    payload: { role: 'assistant', text: 'native answer', nativeSessionId: 'session' } }
  assert.equal(hasNativeTurnStarted('codex', execution, codex), true)
  assert.equal(hasNativeTurnStarted('claude', execution, claude), true)
  for (const [harness, event] of [['codex', codex], ['claude', claude]]) {
    assert.equal(hasNativeTurnStarted(harness, { id: execution.id }, event), false)
    assert.equal(hasNativeTurnStarted(harness, execution, { ...event, executionId: 'other' }), false)
    assert.equal(hasNativeTurnStarted(harness, { ...execution, nativeSessionId: 'other' }, event), false)
    assert.equal(hasNativeTurnStarted(harness, execution, { ...event, connectionId: 'history-replay' }), false)
  }
  assert.equal(hasNativeTurnStarted('claude', execution,
    { ...claude, payload: { role: 'user', text: 'input', nativeSessionId: 'session' } }), false)
  assert.equal(hasNativeTurnStarted('claude', execution,
    { ...claude, type: 'claude.session' }), false)
})

test('production updates retire the browser-access setting while retaining native settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'production-retired-settings-'))
  const path = join(directory, 'operator.json')
  const owned = localProductionEnvironment('/owner/home', 'a'.repeat(64))
  const native = { CODEX_BINARY: '/opt/owner/codex' }
  const retired = { FOREMAN_CODE_DEV_BROWSER_ACCESS: '0', GRAPHQL_DEV_BROWSER_ACCESS: '1' }
  try {
    assert.equal(Object.hasOwn(owned, 'FOREMAN_CODE_DEV_BROWSER_ACCESS'), false)
    const first = await preserveOperatorConfiguration(path, { ...owned, ...native, ...retired }, owned, () => {})
    assert.deepEqual(first, { ...native, ...owned })
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), native)
    await writeFile(path, JSON.stringify({ ...native, ...retired }))
    const updated = await preserveOperatorConfiguration(path, first, owned, () => {})
    assert.deepEqual(updated, first)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), native)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('renamed installer settings retain operator values and the existing database credential', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'production-renamed-settings-'))
  const path = join(directory, 'operator.json')
  const password = 'a'.repeat(64)
  const owned = { FOREMAN_CODE_LOCAL_PRODUCTION: '1', FOREMAN_CODE_APP_MCP_DIRECTORY: '/installed/mcp',
    GRAPHQL_PRODUCTION_DB_PASSWORD: password }
  const previous = { GRAPHQL_LOCAL_PRODUCTION: '1', GRAPHQL_APP_MCP_DIRECTORY: '/installed/mcp',
    FOREMAN_CODE_PRODUCTION_DB_PASSWORD: password, GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '0',
    CODEX_BINARY: '/opt/owner cli/codex' }
  const validate = environment => {
    assert.equal(readProductEnvironment(environment, 'LOCAL_PRODUCTION'), '1')
    assert.equal(readProductEnvironment(environment, 'APP_MCP_DIRECTORY'), '/installed/mcp')
    assert.equal(readProductEnvironment(environment, 'PRODUCTION_DB_PASSWORD'), password)
    assert.equal(readProductEnvironment(environment, 'ENABLE_EXPERIMENTAL_CODEX_APP_SERVER'), '0')
  }
  try {
    const environment = await preserveOperatorConfiguration(path, previous, owned, validate)
    assert.deepEqual(environment, { ...owned, GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '0',
      CODEX_BINARY: previous.CODEX_BINARY })
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '0', CODEX_BINARY: previous.CODEX_BINARY,
    })
    for (const name of ['GRAPHQL_LOCAL_PRODUCTION', 'FOREMAN_CODE_LOCAL_PRODUCTION',
      'GRAPHQL_PRODUCTION_DB_PASSWORD', 'FOREMAN_CODE_PRODUCTION_DB_PASSWORD']) {
      await writeFile(path, JSON.stringify({ [name]: 'override' }))
      await assert.rejects(preserveOperatorConfiguration(path, previous, owned, validate), /managed by the installer/)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('configuration aliases reject conflicts before publishing and retain matching operator spellings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'production-alias-conflicts-'))
  const path = join(directory, 'operator.json')
  const owned = { FOREMAN_CODE_LOCAL_PRODUCTION: '1' }
  const settings = { GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '0', FOREMAN_CODE_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '0' }
  try {
    await preserveOperatorConfiguration(path, settings, owned, () => undefined)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), settings)
    const before = await readFile(path, 'utf8')
    await assert.rejects(preserveOperatorConfiguration(path,
      { GRAPHQL_PRODUCTION_DB_PASSWORD: 'old-secret', FOREMAN_CODE_PRODUCTION_DB_PASSWORD: 'new-secret' },
      owned, () => undefined), error => {
        assert.match(error.message, /FOREMAN_CODE_PRODUCTION_DB_PASSWORD conflicts with GRAPHQL_PRODUCTION_DB_PASSWORD/)
        assert.ok(!error.message.includes('old-secret') && !error.message.includes('new-secret'))
        return true
      })
    assert.equal(await readFile(path, 'utf8'), before)
    await writeFile(path, JSON.stringify({ ...settings, FOREMAN_CODE_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '1' }))
    await assert.rejects(preserveOperatorConfiguration(path, undefined, owned, () => undefined), /conflicts/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('updates retain operator settings separately from installer isolation settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'production-settings-'))
  const path = join(directory, 'operator.json')
  const owned = { HOST: '127.0.0.1', NODE_ENV: 'production', GRAPHQL_PRODUCTION_DB_PASSWORD: 'a'.repeat(64) }
  const previous = { ...owned, HOST: '0.0.0.0', GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '1',
    CODEX_BINARY: '/opt/native CLI/codex', HARNESS_TIMEOUT_MS: '600000' }
  const validate = environment => {
    assert.equal(environment.HOST, '127.0.0.1')
    assert.equal(environment.GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER, '1')
    assert.equal(environment.HARNESS_TIMEOUT_MS, '600000')
  }
  try {
    const first = await preserveOperatorConfiguration(path, previous, owned, validate)
    await publish(join(directory, 'production.env'), renderEnvironment(first))
    const next = await preserveOperatorConfiguration(path, await readEnvironment(join(directory, 'production.env')),
      { ...owned, GRAPHQL_LOCAL_PRODUCTION: '1' }, validate)
    assert.equal(next.CODEX_BINARY, previous.CODEX_BINARY)
    assert.equal(next.GRAPHQL_PRODUCTION_DB_PASSWORD, owned.GRAPHQL_PRODUCTION_DB_PASSWORD)
    assert.equal(next.GRAPHQL_LOCAL_PRODUCTION, '1')
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '1', CODEX_BINARY: previous.CODEX_BINARY,
      HARNESS_TIMEOUT_MS: '600000',
    })
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    const before = await readFile(path, 'utf8')
    await assert.rejects(preserveOperatorConfiguration(path, previous, owned, () => {
      throw new Error('Invalid configuration')
    }), /Invalid configuration/)
    assert.equal(await readFile(path, 'utf8'), before)
    await writeFile(path, JSON.stringify({ HOST: '0.0.0.0' }))
    await assert.rejects(preserveOperatorConfiguration(path, previous, owned, validate), /managed by the installer/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('first migration and later updates preserve quoted, escaped and multiline operator values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'production-escaped-settings-'))
  const path = join(directory, 'operator.json')
  const envFile = join(directory, 'production.env')
  const owned = { HOST: '127.0.0.1', GRAPHQL_PRODUCTION_DB_PASSWORD: 'a'.repeat(64) }
  const settings = {
    CODEX_BINARY: '/opt/native "qualified"/codex',
    PROVIDER_API_KEY: " space\\slash\"quote'single$literal`tick\nsecond line\\ ",
    LITERAL_NEWLINE: '\\n',
    TRAILING_BACKSLASH: 'end\\',
    EMPTY_SETTING: '',
  }
  const validate = environment => {
    for (const [key, value] of Object.entries(settings)) assert.equal(environment[key], value)
    assert.equal(environment.HOST, owned.HOST)
  }
  try {
    await publish(envFile, renderEnvironment({ ...settings, ...owned }))
    const previous = await readEnvironment(envFile)
    assert.deepEqual(previous, { ...settings, ...owned })
    const migrated = await preserveOperatorConfiguration(path, previous, owned, validate)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), settings)
    await publish(envFile, renderEnvironment(migrated))
    assert.deepEqual(await readEnvironment(envFile), { ...settings, ...owned })
    const updated = await preserveOperatorConfiguration(path, await readEnvironment(envFile),
      { ...owned, GRAPHQL_LOCAL_PRODUCTION: '1' }, validate)
    await publish(envFile, renderEnvironment(updated))
    assert.deepEqual(await readEnvironment(envFile), { ...settings, ...owned, GRAPHQL_LOCAL_PRODUCTION: '1' })
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), settings)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('environment migration reads systemd quoting, continuations and duplicate assignments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'production-environment-'))
  const path = join(directory, 'production.env')
  try {
    await writeFile(path, [
      '# ignored comment', '; also ignored', 'HOST=first', 'HOST = 127.0.0.1  ',
      'UNQUOTED=path\\ with\\ spaces\\\\suffix', "SINGLE='literal\\path\nnext line'",
      'DOUBLE="quote\\\" slash\\\\ dollar\\$ tick\\` other\\q"',
      'CONTINUED=one\\\ntwo', 'QUOTED_CONTINUED="one\\\ntwo"', 'EMPTY=',
    ].join('\n'))
    assert.deepEqual(await readEnvironment(path), {
      HOST: '127.0.0.1', UNQUOTED: 'path with spaces\\suffix', SINGLE: 'literal\\path\nnext line',
      DOUBLE: 'quote" slash\\ dollar$ tick` other\\q', CONTINUED: 'onetwo',
      QUOTED_CONTINUED: 'onetwo', EMPTY: '',
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('concurrent publishers expose one complete file and clean their exclusive temporary files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'production-publish-'))
  const target = join(directory, 'environment')
  const contents = Array.from({ length: 20 }, (_, index) => `${index}:` + 'x'.repeat(8192))
  try {
    await Promise.all(contents.map(content => publish(target, content)))
    assert.ok(contents.includes(await readFile(target, 'utf8')))
    assert.deepEqual(await readdir(directory), ['environment'])
    assert.equal((await stat(target)).mode & 0o777, 0o600)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('installation lock serializes independent processes and releases after failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'production-lock-'))
  const lock = join(directory, 'install.lock')
  const counter = join(directory, 'counter')
  const children = []
  try {
    await writeFile(counter, '0')
    const code = `
      import { readFile, writeFile } from 'node:fs/promises';
      import { setTimeout as delay } from 'node:timers/promises';
      import { withInstallationLock } from ${JSON.stringify(new URL('./local-production-runtime.mjs', import.meta.url).href)};
      await withInstallationLock(process.argv[1], async () => {
        const value = Number(await readFile(process.argv[2], 'utf8'));
        await delay(50);
        await writeFile(process.argv[2], String(value + 1));
      });
    `
    const completions = Array.from({ length: 3 }, () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, lock, counter], { stdio: 'inherit' })
      children.push(child)
      return once(child, 'exit').then(([status]) => assert.equal(status, 0))
    })
    await Promise.all(completions)
    assert.equal(await readFile(counter, 'utf8'), '3')
    await assert.rejects(withInstallationLock(lock, () => { throw new Error('Installation interrupted') }), /interrupted/)
    assert.equal(await withInstallationLock(lock, () => 'released'), 'released')
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
    await rm(directory, { recursive: true, force: true })
  }
})

test('readiness rejects conflicting installations and releases despite healthy API and compiled HTML', async () => {
  const expected = { installationId: 'installation', checkoutId: 'release', databaseId: 'database' }
  let actual = expected
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/health/identity') response.end(JSON.stringify(actual))
    else if (request.url === '/health/ready') response.end(JSON.stringify({ service: 'graphql-api',
      checks: { database: 'ok', checkpoints: 'ok' } }))
    else response.end('<html><script src="/assets/app.js"></script></html>')
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const origin = `http://127.0.0.1:${server.address().port}`
    for (const key of Object.keys(expected)) {
      actual = { ...expected, [key]: 'conflicting' }
      await assert.rejects(waitForProductionReady({ origin, expected, timeoutMs: 30 }), /different database installation or release/)
    }
    actual = expected
    await waitForProductionReady({ origin, expected, timeoutMs: 1000 })
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('staged verification runtime imports without invoking a CLI or requiring the source checkout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'production-verification-runtime-'))
  try {
    await copyVerificationRuntime(new URL('..', import.meta.url).pathname, directory)
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e',
        'const runtime = await import(process.argv[1]); console.log(typeof runtime.finalizeVerification)',
        new URL(`file://${join(directory, 'scripts/verification-runner.mjs')}`).href],
      { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', bytes => { stdout += bytes })
      child.stderr.on('data', bytes => { stderr += bytes })
      child.once('error', reject)
      child.once('exit', code => resolve({ code, stdout, stderr }))
    })
    assert.deepEqual(result, { code: 0, stdout: 'function\n', stderr: '' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('install keeps only the current and previous release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'releases-'))
  try {
    for (const name of ['release-old1', 'release-old2', 'release-prev', 'release-now', 'notes']) await mkdir(join(root, name))
    const removed = await pruneReleases(root, [join(root, 'release-now'), join(root, 'release-prev')])
    assert.deepEqual(removed.map((path) => path.slice(root.length + 1)).sort(), ['release-old1', 'release-old2'])
    assert.deepEqual((await readdir(root)).sort(), ['notes', 'release-now', 'release-prev'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('background work after an install runs in its own systemd unit so it outlives the install unit', () => {
  const calls = []
  const spawnProcess = (file, args, options) => { calls.push({ file, args, options }); return { unref() {} } }
  // A detached child still died with the install's systemd unit: the GitHub upload and old-release deletion never finished.
  production.startBackground('foreman-worker-publish', '/release/node', ['publish.mjs', 'a b'],
    { logFile: '/state/publish.log', systemdRun: '/usr/bin/systemd-run', spawnProcess })
  assert.equal(calls[0].file, '/usr/bin/systemd-run')
  const args = calls[0].args
  assert.deepEqual(args.slice(0, 3), ['--user', '--collect', '--quiet'])
  assert.match(args.find(arg => arg.startsWith('--unit=')), /^--unit=foreman-worker-publish-[0-9a-f]{8}$/)
  assert.ok(args.includes('--property=StandardOutput=append:/state/publish.log'))
  assert.ok(args.includes(`--setenv=PATH=${process.env.PATH}`))
  assert.deepEqual(args.slice(-3), ['/release/node', 'publish.mjs', 'a b'])
  production.startBackground('foreman-prune', 'rm', ['-rf', '--', '/x'], { systemdRun: null, spawnProcess })
  assert.equal(calls[1].file, 'rm')
  assert.equal(calls[1].options.detached, true)
})

test('install moves pruned releases aside and deletes them without waiting', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'releases-'))
  const root = join(parent, 'releases')
  try {
    for (const name of ['release-old', 'release-prev', 'release-now']) await mkdir(join(root, name), { recursive: true })
    await writeFile(join(root, 'release-old', 'dependency'), 'x')
    const background = []
    // Deleting an old release's dependency tree took ~20 s of every install.
    const removed = await pruneReleases(root, [join(root, 'release-now'), join(root, 'release-prev')],
      { removeInBackground: directory => background.push(directory) })
    assert.deepEqual(removed.map(path => path.slice(root.length + 1)), ['release-old'])
    assert.deepEqual((await readdir(root)).sort(), ['release-now', 'release-prev'])
    assert.equal(background.length, 1)
    const moved = await readdir(background[0])
    assert.equal(moved.length, 1)
    assert.match(moved[0], /^release-old/)
    assert.equal(await readFile(join(background[0], moved[0], 'dependency'), 'utf8'), 'x')
  } finally { await rm(parent, { recursive: true, force: true }) }
})

async function installFixture(t) {
  const parent = process.env.FOREMAN_CODE_TEST_ROOT ?? join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'production-install-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'installation'))
  const installation = join(directory, 'installation-link')
  await symlink('installation', installation)
  return installation
}

async function cutoverFixture(t, pendingMigrations) {
  const directory = await installFixture(t)
  const events = []
  const release = join(directory, 'candidate')
  const previousRelease = join(directory, 'previous')
  const current = join(directory, 'current')
  const stateFile = join(directory, 'deployment.json')
  await mkdir(release)
  await mkdir(previousRelease)
  await symlink(previousRelease, current)
  let running = true
  let data = 'before migration'
  const steps = {
    pendingMigrations: async value => {
      assert.equal(value, release)
      assert.equal(running, true)
      events.push('pending migrations')
      return pendingMigrations
    },
    backup: async () => { assert.fail('Cutover must never run pg_dump') },
    restore: async () => { assert.fail('Cutover must never run pg_restore') },
    stop: async () => { events.push('stop'); running = false },
    migrate: async () => { events.push('migrate'); data = 'after migration' },
    upgradeLauncher: async () => { events.push('launcher') },
    activate: async value => {
      events.push('activate')
      await rm(current)
      if (value) await symlink(value, current)
    },
    enable: async () => { events.push('enable') },
    start: async () => { events.push('start'); running = true },
    ready: async value => {
      events.push('ready')
      assert.equal(running, true)
      assert.equal(await production.readReleaseSelection(current), await realpath(value))
    },
  }
  return { release, previousRelease, current, stateFile, steps, events,
    running: () => running, data: () => data }
}

for (const pending of [[], [3]]) {
  test(`cutover never dumps or restores with ${pending.length} pending migrations`, async t => {
    const fixture = await cutoverFixture(t, pending)
    await production.runReleaseCutover(fixture)
    assert.deepEqual(fixture.events, ['pending migrations', 'stop', ...(pending.length ? ['migrate'] : []),
      'launcher', 'activate', 'enable', 'start', 'ready'])
    assert.equal(await production.readReleaseSelection(fixture.current), await realpath(fixture.release))
    assert.equal(fixture.running(), true)
    assert.equal(fixture.data(), pending.length ? 'after migration' : 'before migration')
    assert.equal(JSON.parse(await readFile(fixture.stateFile, 'utf8')).phase, 'ready')
  })
}

test('a failed transactional migration keeps the previous release and saved data without a dump or restore', async t => {
  const fixture = await cutoverFixture(t, [3])
  fixture.steps.migrate = async () => {
    fixture.events.push('migrate')
    // A rejected migration transaction leaves committed data unchanged.
    throw new Error('migration failed')
  }
  await assert.rejects(production.runReleaseCutover(fixture), /migration failed/)
  assert.deepEqual(fixture.events, ['pending migrations', 'stop', 'migrate', 'stop', 'activate', 'start', 'ready'])
  assert.equal(await production.readReleaseSelection(fixture.current), await realpath(fixture.previousRelease))
  assert.equal(fixture.data(), 'before migration')
  assert.equal(fixture.running(), true)
  assert.equal(JSON.parse(await readFile(fixture.stateFile, 'utf8')).phase, 'recovered')
})

for (const pending of [[], [3]]) {
  for (const failure of ['launcher', 'readiness', 'smoke']) {
    test(`rolls back code only after ${failure} failure with ${pending.length} pending migrations`, async t => {
      const fixture = await cutoverFixture(t, pending)
      if (failure === 'launcher') {
        fixture.steps.upgradeLauncher = async () => { throw new Error('launcher failed') }
      } else if (failure === 'readiness') {
        const ready = fixture.steps.ready
        fixture.steps.ready = async value => {
          if (value === fixture.release) throw new Error('readiness failed')
          await ready(value)
        }
      } else {
        fixture.steps.checkReady = async (_release, { start, rollback }) => {
          await start()
          const error = new Error('smoke failed')
          await rollback(error)
          throw error
        }
      }
      await assert.rejects(production.runReleaseCutover(fixture), new RegExp(`${failure} failed`))
      assert.equal(await production.readReleaseSelection(fixture.current), await realpath(fixture.previousRelease))
      assert.equal(fixture.running(), true)
      assert.equal(fixture.data(), pending.length ? 'after migration' : 'before migration')
      const state = JSON.parse(await readFile(fixture.stateFile, 'utf8'))
      assert.equal(state.phase, 'recovered')
      assert.equal(state.failure, `${failure} failed`)
    })
  }
}

test('restart recovery before the API stop does not interrupt the running release', async t => {
  const fixture = await cutoverFixture(t, [3])
  await writeFile(fixture.stateFile, JSON.stringify({ phase: 'checking-migrations',
    previousRelease: fixture.previousRelease, apiMayHaveStopped: false }))
  await production.recoverReleaseCutover(fixture)
  assert.deepEqual(fixture.events, [])
  assert.equal(fixture.running(), true)
  assert.equal(JSON.parse(await readFile(fixture.stateFile, 'utf8')).phase, 'recovered')
})

for (const phase of ['migrating', 'migrated', 'checking-readiness']) {
  test(`restart recovery during ${phase} reactivates the previous code without a dump or restore`, async t => {
    const fixture = await cutoverFixture(t, [3])
    await fixture.steps.migrate()
    await fixture.steps.activate(fixture.release)
    await writeFile(fixture.stateFile, JSON.stringify({ phase,
      previousRelease: fixture.previousRelease, apiMayHaveStopped: true }))
    fixture.events.length = 0
    await production.recoverReleaseCutover(fixture)
    assert.deepEqual(fixture.events, ['stop', 'activate', 'start', 'ready'])
    assert.equal(await production.readReleaseSelection(fixture.current), await realpath(fixture.previousRelease))
    assert.equal(fixture.running(), true)
    assert.equal(fixture.data(), 'after migration')
    assert.equal(JSON.parse(await readFile(fixture.stateFile, 'utf8')).phase, 'recovered')
  })
}

test('pending migrations compare each release version with applied versions rather than the latest id', async () => {
  const migrations = [{ version: 1 }, { version: 3 }, { version: 2 }]
  for (const [applied, expected] of [[[1, 2, 3, 9], []], [[1, 3, 9], [2]]]) {
    const responses = [{ rows: [{ present: true }] }, { rows: applied.map(version => ({ version })) }]
    assert.deepEqual(await production.findPendingMigrations({ migrations,
      query: async () => responses.shift() }), expected)
    assert.equal(responses.length, 0)
  }
})

test('a database without migration bookkeeping has every release migration pending', async () => {
  let queries = 0
  assert.deepEqual(await production.findPendingMigrations({ migrations: [{ version: 1 }, { version: 3 }],
    query: async () => { queries++; return { rows: [{ present: false }] } } }), [1, 3])
  assert.equal(queries, 1)
})

for (const failure of ['stop', 'application migration', 'checkpoint setup',
  'launcher upgrade', 'activation', 'enable', 'start', 'readiness']) {
  test(`recovers the previous service after a ${failure} failure and can retry cutover`, async t => {
    const fixture = await cutoverFixture(t, [3])
    let injected = false
    const inject = name => {
      if (name === failure && !injected) {
        injected = true
        throw new Error(`Injected ${name} failure`)
      }
    }
    for (const [step, name] of [['stop', 'stop'], ['upgradeLauncher', 'launcher upgrade'],
      ['activate', 'activation'], ['enable', 'enable'], ['start', 'start'], ['ready', 'readiness']]) {
      const action = fixture.steps[step]
      fixture.steps[step] = async (...args) => { await action(...args); inject(name) }
    }
    const migrate = fixture.steps.migrate
    fixture.steps.migrate = async () => {
      inject('application migration')
      inject('checkpoint setup')
      await migrate()
    }
    await assert.rejects(production.runReleaseCutover(fixture), new RegExp(`Injected ${failure} failure`))
    assert.equal(fixture.running(), true)
    const migrated = !['stop', 'application migration', 'checkpoint setup'].includes(failure)
    assert.equal(fixture.data(), migrated ? 'after migration' : 'before migration')
    assert.equal(await production.readReleaseSelection(fixture.current), await realpath(fixture.previousRelease))
    assert.equal(JSON.parse(await readFile(fixture.stateFile, 'utf8')).phase, 'recovered')
    assert.equal((await stat(fixture.release)).isDirectory(), true)
    await production.runReleaseCutover(fixture)
    assert.equal(await production.readReleaseSelection(fixture.current), await realpath(fixture.release))
    assert.equal(fixture.data(), 'after migration')
    assert.equal(fixture.running(), true)
    assert.equal(JSON.parse(await readFile(fixture.stateFile, 'utf8')).phase, 'ready')
  })
}

test('retains interrupted deployment details until code recovery succeeds on retry', async t => {
  const fixture = await cutoverFixture(t, [3])
  fixture.steps.migrate = async () => { throw new Error('migration failed') }
  const activate = fixture.steps.activate
  fixture.steps.activate = async () => { throw new Error('previous release unavailable') }
  await assert.rejects(production.runReleaseCutover(fixture), /recovery failed/i)
  const interrupted = JSON.parse(await readFile(fixture.stateFile, 'utf8'))
  assert.equal(interrupted.phase, 'recovery-failed')
  assert.match(interrupted.failure, /migration failed/)
  assert.match(interrupted.recoveryFailure, /previous release unavailable/)
  assert.equal(fixture.running(), false)
  assert.equal((await stat(fixture.release)).isDirectory(), true)
  fixture.steps.activate = activate
  await production.recoverReleaseCutover(fixture)
  assert.equal(await production.readReleaseSelection(fixture.current), await realpath(fixture.previousRelease))
  assert.equal(fixture.running(), true)
  assert.equal(fixture.data(), 'before migration')
  assert.equal(JSON.parse(await readFile(fixture.stateFile, 'utf8')).phase, 'recovered')
})

test('a failed first installation retries startup defaults independently of configuration publication', async t => {
  const directory = await installFixture(t)
  const stateFile = join(directory, 'installation.json')
  const environment = join(directory, 'production.env')
  assert.equal(await production.needsStartupConfiguration(stateFile), true)
  await writeFile(environment, 'DATABASE_URL="configured"\n')
  assert.equal(await production.needsStartupConfiguration(stateFile), true)
  const paths = production.productionIntegrationPaths(directory, {})
  const calls = []
  const configure = async () => {
    const firstInstall = await production.needsStartupConfiguration(stateFile)
    await production.publishDesktopIntegration(paths, { firstInstall, icon: 'icon', desktop: 'desktop', autostart: 'startup' })
    await production.enableProductionServices(async (_command, args) => { calls.push(args) },
      ['database.service', 'api.service'], { firstInstall })
    await production.recordStartupConfiguration(stateFile)
  }
  await configure()
  assert.deepEqual(calls, [['--user', 'enable', 'database.service', 'api.service']])
  assert.equal(await readFile(paths.autostart, 'utf8'), 'startup')
  await rm(paths.autostart)
  calls.length = 0
  await configure()
  assert.deepEqual(calls, [])
  await assert.rejects(stat(paths.autostart), { code: 'ENOENT' })
  const upgraded = join(directory, 'existing-installation.json')
  assert.equal(await production.needsStartupConfiguration(upgraded, { previousRelease: '/release/installed' }), false)
})

test('captures one committed source for API, browser and Worker builds despite source checkout changes', async t => {
  const directory = await installFixture(t)
  const repository = join(directory, 'repository')
  await mkdir(repository)
  const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  const git = args => execFileSync('git', args, { cwd: repository, env: gitEnvironment, encoding: 'utf8' }).trim()
  await mkdir(join(repository, 'packages/contracts'), { recursive: true })
  const contract = join(repository, 'packages/contracts/value.mjs')
  await writeFile(contract, 'export const value = () => "committed"\n')
  git(['init', '-q'])
  git(['add', '.'])
  git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
  git(['remote', 'add', 'origin', 'https://github.com/example/fixture.git'])
  const commit = git(['rev-parse', 'HEAD'])
  await writeFile(contract, 'export const value = () => "dirty"\n')
  let snapshotPath
  const values = await production.withProductionSourceSnapshot(repository, directory, async ({ source, commit: captured }) => {
    snapshotPath = source
    assert.equal(captured, commit)
    const builtContract = await import(new URL(`file://${join(source, 'packages/contracts/value.mjs')}`).href)
    const api = builtContract.value()
    await writeFile(contract, 'export const value = () => "later checkout"\n')
    git(['add', '.'])
    git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'later source'])
    const capturedGit = args => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim()
    assert.equal(capturedGit(['rev-parse', 'HEAD']), commit)
    assert.equal(capturedGit(['remote', 'get-url', 'origin']), 'https://github.com/example/fixture.git')
    const worker = await import(new URL(`file://${join(source, 'packages/contracts/value.mjs')}?worker`).href)
    return { api, browser: builtContract.value(), worker: worker.value() }
  })
  assert.deepEqual(values, { api: 'committed', browser: 'committed', worker: 'committed' })
  // The build tree persists so the next install reuses dependencies and incremental TypeScript output.
  assert.equal((await stat(snapshotPath)).isDirectory(), true)
})

test('reuses one build tree reset to the exact next commit with dependencies and current build output kept', async t => {
  const directory = await installFixture(t)
  const repository = join(directory, 'repository')
  await mkdir(join(repository, 'apps/api/src'), { recursive: true })
  const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  const git = args => execFileSync('git', args, { cwd: repository, env: gitEnvironment, encoding: 'utf8' }).trim()
  const commitAll = message => { git(['add', '-A']); git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message]) }
  await writeFile(join(repository, 'apps/api/src/kept.ts'), 'export const kept = 1\n')
  await writeFile(join(repository, 'apps/api/src/removed.ts'), 'export const removed = 1\n')
  await writeFile(join(repository, '.gitignore'), 'node_modules/\ndist/\n*.tsbuildinfo\n')
  git(['init', '-q'])
  commitAll('first')
  git(['remote', 'add', 'origin', 'https://github.com/example/fixture.git'])
  const first = await production.withProductionSourceSnapshot(repository, directory, async ({ source }) => {
    await mkdir(join(source, 'node_modules/dependency'), { recursive: true })
    await writeFile(join(source, 'node_modules/dependency/index.js'), 'installed')
    await mkdir(join(source, 'apps/api/dist'), { recursive: true })
    for (const name of ['kept.js', 'kept.d.ts', 'removed.js', 'removed.js.map', '.tsbuildinfo']) {
      await writeFile(join(source, 'apps/api/dist', name), 'built')
    }
    await writeFile(join(source, 'apps/api/src/kept.ts'), 'locally edited\n')
    await writeFile(join(source, 'stray.txt'), 'untracked')
    return source
  })
  await rm(join(repository, 'apps/api/src/removed.ts'))
  commitAll('second')
  const second = git(['rev-parse', 'HEAD'])
  await production.withProductionSourceSnapshot(repository, directory, async ({ source, commit }) => {
    assert.equal(source, first)
    assert.equal(commit, second)
    const sourceGit = args => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim()
    assert.equal(sourceGit(['rev-parse', 'HEAD']), second)
    assert.equal(sourceGit(['status', '--porcelain']), '')
    assert.equal(await readFile(join(source, 'apps/api/src/kept.ts'), 'utf8'), 'export const kept = 1\n')
    await assert.rejects(stat(join(source, 'stray.txt')), { code: 'ENOENT' })
    assert.equal(await readFile(join(source, 'node_modules/dependency/index.js'), 'utf8'), 'installed')
    // Output of a deleted source must not reach the release; output of current sources stays for tsc --incremental.
    assert.deepEqual((await readdir(join(source, 'apps/api/dist'))).sort(), ['.tsbuildinfo', 'kept.d.ts', 'kept.js'])
  })
})

/** A build source whose fake pnpm deploy writes the API package and a dependency tree like legacy pnpm deploy. */
async function apiBuildSource(directory) {
  const source = join(directory, 'source')
  for (const path of ['apps/api/dist', 'packages/contracts/dist']) await mkdir(join(source, path), { recursive: true })
  await writeFile(join(source, 'pnpm-lock.yaml'), 'lock: 1\n')
  await writeFile(join(source, 'apps/api/package.json'), '{"name":"@foreman-code/api"}\n')
  await writeFile(join(source, 'apps/api/README.md'), 'api\n')
  await writeFile(join(source, 'apps/api/dist/server.js'), 'build 1\n')
  await writeFile(join(source, 'packages/contracts/package.json'), '{"name":"@foreman-code/contracts"}\n')
  await writeFile(join(source, 'packages/contracts/dist/index.js'), 'contracts 1\n')
  const deploys = []
  const run = async (command, args) => {
    if (!args.includes('deploy')) return
    const destination = args.at(-1)
    deploys.push(destination)
    const store = join(destination, 'node_modules/.pnpm/@foreman-code+contracts/node_modules/@foreman-code/contracts')
    await mkdir(join(store, 'dist'), { recursive: true })
    await writeFile(join(store, 'dist/index.js'), await readFile(join(source, 'packages/contracts/dist/index.js')))
    await mkdir(join(destination, 'node_modules/@foreman-code'), { recursive: true })
    await symlink('../.pnpm/@foreman-code+contracts/node_modules/@foreman-code/contracts', join(destination, 'node_modules/@foreman-code/contracts'))
    await mkdir(join(destination, 'node_modules/fastify'), { recursive: true })
    await writeFile(join(destination, 'node_modules/fastify/index.js'), 'fastify')
    await mkdir(join(destination, 'dist'), { recursive: true })
    await writeFile(join(destination, 'dist/server.js'), await readFile(join(source, 'apps/api/dist/server.js')))
    await writeFile(join(destination, 'package.json'), '{"name":"@foreman-code/api","deployed":true}\n')
    await writeFile(join(destination, 'README.md'), 'api\n')
  }
  return { source, run, deploys }
}

test('releases reuse installed dependencies while freezing their own contracts output', async t => {
  const directory = await installFixture(t)
  const { source, run, deploys } = await apiBuildSource(directory)
  const dependencies = { root: join(directory, 'api-dependencies'), source }
  const first = join(directory, 'releases/release-a/apps/api')
  await production.deployProductionApi(run, first, { dependencies })
  assert.equal(deploys.length, 1)
  await writeFile(join(source, 'apps/api/dist/server.js'), 'build 2\n')
  const second = join(directory, 'releases/release-b/apps/api')
  // Copying ~800 MB of dependencies took 25-35 s per deploy, and 334 s on a loaded computer.
  await production.deployProductionApi(run, second, { dependencies })
  assert.equal(deploys.length, 1)
  assert.equal(await realpath(join(second, 'node_modules/fastify')), await realpath(join(first, 'node_modules/fastify')))
  assert.equal(await readFile(join(second, 'dist/server.js'), 'utf8'), 'build 2\n')
  assert.equal(await readFile(join(first, 'dist/server.js'), 'utf8'), 'build 1\n')
  assert.equal(await readFile(join(second, 'package.json'), 'utf8'), '{"name":"@foreman-code/api","deployed":true}\n')
  assert.equal(await readFile(join(second, 'node_modules/fastify/index.js'), 'utf8'), 'fastify')

  // Contracts builds change independently of installed dependencies; each release freezes its own output.
  await writeFile(join(source, 'packages/contracts/dist/index.js'), 'contracts 2\n')
  const third = join(directory, 'releases/release-c/apps/api')
  await production.deployProductionApi(run, third, { dependencies })
  assert.equal(deploys.length, 1)
  assert.equal(await realpath(join(third, 'node_modules/fastify')), await realpath(join(second, 'node_modules/fastify')))
  assert.equal(await readFile(join(third, 'node_modules/@foreman-code/contracts/dist/index.js'), 'utf8'), 'contracts 2\n')
  assert.equal(await readFile(join(second, 'node_modules/@foreman-code/contracts/dist/index.js'), 'utf8'), 'contracts 1\n')

  // Trees no kept release links to are removed; the ones in use stay.
  const removed = []
  await production.pruneApiDependencies(dependencies.root, [first, third].map(path => join(path, '../..')),
    { removeInBackground: path => removed.push(path) })
  assert.equal(removed.length, 0)
  await writeFile(join(source, 'pnpm-lock.yaml'), 'lock: 2\n')
  const fourth = join(directory, 'releases/release-d/apps/api')
  await production.deployProductionApi(run, fourth, { dependencies })
  assert.equal(deploys.length, 2)
  await production.pruneApiDependencies(dependencies.root, [fourth].map(path => join(path, '../..')),
    { removeInBackground: path => removed.push(path) })
  assert.equal(removed.length, 1)
  assert.equal(await readFile(join(fourth, 'node_modules/fastify/index.js'), 'utf8'), 'fastify')
})

test('pruning protects retained and selected releases through installation aliases', async t => {
  const directory = await installFixture(t)
  const physical = join(directory, 'physical')
  const alias = join(directory, 'alias')
  const releases = join(physical, 'releases')
  await mkdir(releases, { recursive: true })
  for (const name of ['release-previous', 'release-candidate', 'release-active', 'release-old']) {
    await mkdir(join(releases, name))
  }
  await symlink(physical, alias)
  const current = join(alias, 'current')
  await symlink(join(releases, 'release-active'), current)
  await pruneReleases(join(alias, 'releases'), [join(releases, 'release-previous'),
    join(alias, 'releases/release-candidate')], { current })
  assert.deepEqual((await readdir(releases)).sort(), ['release-active', 'release-candidate', 'release-previous'])
})

test('pruning fails closed before deleting anything when a retained release or current link is unresolved', async t => {
  const directory = await installFixture(t)
  const releases = join(directory, 'releases')
  const current = join(directory, 'current')
  await mkdir(releases)
  await mkdir(join(releases, 'release-retained'))
  await mkdir(join(releases, 'release-old'))
  await symlink(join(releases, 'release-missing'), current)
  await assert.rejects(pruneReleases(releases, [join(releases, 'release-retained')], { current }), /release|ENOENT/i)
  assert.deepEqual((await readdir(releases)).sort(), ['release-old', 'release-retained'])
  await rm(current)
  await symlink(join(releases, 'release-retained'), current)
  await assert.rejects(pruneReleases(releases, [join(releases, 'release-missing')], { current }), /release|ENOENT/i)
  assert.deepEqual((await readdir(releases)).sort(), ['release-old', 'release-retained'])
})

test('idle-wait minutes accept the default, numeric durations and an explicit zero', () => {
  assert.equal(production.parseRunWaitMinutes(undefined), 120 * 60_000)
  assert.equal(production.parseRunWaitMinutes('2.5'), 150_000)
  assert.equal(production.parseRunWaitMinutes('0'), 0)
})

for (const value of ['-1', '2h', 'NaN', 'Infinity', '', ' ', '1e999']) {
  test(`invalid idle-wait minutes ${JSON.stringify(value)} fail and release the installation lock`, async t => {
    const directory = await installFixture(t)
    const lock = join(directory, 'install.lock')
    let staged = false
    await assert.rejects(withInstallationLock(lock, async () => {
      production.parseRunWaitMinutes(value)
      staged = true
    }), /FOREMAN_INSTALL_RUN_WAIT_MINUTES.*finite.*nonnegative/i)
    assert.equal(staged, false)
    assert.equal(await withInstallationLock(lock, async () => 'launcher acquired', { timeoutMs: 1000 }), 'launcher acquired')
  })
}

for (const failure of ['CI setup: missing package metadata', 'API response timed out', 'second ci_run timed out', 'new API start failed']) {
  test(`install rolls back a healthy release when smoke reports ${failure}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'production-ci-rollback-'))
    const current = join(directory, 'current')
    const expected = { installationId: 'installation', checkoutId: 'release', databaseId: 'database' }
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/health/identity') response.end(JSON.stringify(expected))
      else if (request.url === '/health/ready') response.end(JSON.stringify({ service: 'graphql-api',
        checks: { database: 'ok', checkpoints: 'ok' } }))
      else response.end('<html><script src="/assets/app.js"></script></html>')
    })
    try {
      await symlink('previous-release', join(directory, 'previous'))
      await symlink('broken-release', current)
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const origin = `http://127.0.0.1:${server.address().port}`
      let reported
      try {
        await waitForProductionReady({ origin, expected, timeoutMs: 1000,
          [failure === 'new API start failed' ? 'start' : 'smoke']: async () => { throw new Error(failure) },
          rollback: () => rename(join(directory, 'previous'), current) })
      } catch (error) { reported = error.message }
      assert.equal(await readlink(current), 'previous-release', 'A broken CI release must not stay active')
      assert.equal(reported, failure)
    } finally {
      await new Promise(resolve => server.close(resolve))
      await rm(directory, { recursive: true, force: true })
    }
  })
}


test('source snapshots keep unchanged source timestamps and API build info across commits', async t => {
  const directory = await installFixture(t)
  const repository = join(directory, 'repository')
  await mkdir(join(repository, 'apps/api/src'), { recursive: true })
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  const git = args => execFileSync('git', args, { cwd: repository, env: environment, encoding: 'utf8' }).trim()
  const commit = message => {
    git(['add', '-A'])
    git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message])
  }
  await writeFile(join(repository, 'apps/api/src/kept.ts'), 'export const kept = 1\n')
  await writeFile(join(repository, 'apps/api/src/changed.ts'), 'export const changed = 1\n')
  await writeFile(join(repository, '.gitignore'), 'node_modules/\ndist/\n*.tsbuildinfo\n')
  git(['init', '-q'])
  commit('first')
  git(['remote', 'add', 'origin', 'https://github.com/example/fixture.git'])
  let timestamp
  await production.withProductionSourceSnapshot(repository, directory, async ({ source }) => {
    const kept = join(source, 'apps/api/src/kept.ts')
    await utimes(kept, 1_000_000, 1_000_000)
    timestamp = (await stat(kept)).mtimeMs
    await mkdir(join(source, 'apps/api/dist'), { recursive: true })
    await writeFile(join(source, 'apps/api/dist/.tsbuildinfo'), 'incremental build state')
    await writeFile(join(source, 'apps/api/dist/kept.js'), 'emitted kept')
    await writeFile(join(source, 'apps/api/src/added.ts'), 'untracked collision')
  })
  await writeFile(join(repository, 'apps/api/src/added.ts'), 'export const added = 1\n')
  await writeFile(join(repository, 'apps/api/src/changed.ts'), 'export const changed = 2\n')
  commit('second')
  await production.withProductionSourceSnapshot(repository, directory, async ({ source }) => {
    assert.equal((await stat(join(source, 'apps/api/src/kept.ts'))).mtimeMs, timestamp)
    assert.equal(await readFile(join(source, 'apps/api/src/added.ts'), 'utf8'), 'export const added = 1\n')
    assert.equal(await readFile(join(source, 'apps/api/src/changed.ts'), 'utf8'), 'export const changed = 2\n')
    assert.equal(await readFile(join(source, 'apps/api/dist/.tsbuildinfo'), 'utf8'), 'incremental build state')
    assert.equal(await readFile(join(source, 'apps/api/dist/kept.js'), 'utf8'), 'emitted kept')
  })
})

test('production builds check the API separately from JavaScript emit and browser bundling', async () => {
  const calls = []
  await production.buildProductionSource(async (command, args) => { calls.push([command, args]) })
  assert.deepEqual(calls, [
    ['corepack', ['pnpm', '--filter', '@foreman-code/contracts', 'build']],
    ['corepack', ['pnpm', '--filter', '@foreman-code/api', 'exec', 'tsc', '-p', 'tsconfig.build.json',
      '--noEmit', '--isolatedModules', '--tsBuildInfoFile', 'node_modules/.cache/tsc/production-check.tsbuildinfo']],
    ['node', ['scripts/emit-production-api.mjs']],
    ['corepack', ['pnpm', '--filter', '@foreman-code/api', 'exec', 'node', '../../scripts/copy-api-runtime.mjs']],
    ['corepack', ['pnpm', '--filter', '@foreman-code/api', 'exec', 'node', 'dist/cli/harnessCompatibility.js']],
    ['node', ['scripts/heavy-job.mjs', '--build', 'web', '--',
      'corepack', 'pnpm', '--filter', '@foreman-code/web', 'exec', 'vite', 'build']],
  ])
})

test('production staging overlaps the full API check and cannot finish before it passes', async () => {
  let passCheck
  const checked = new Promise(resolve => { passCheck = resolve })
  let staged = false
  let finished = false
  const build = production.buildProductionSource(async (_command, args) => {
    if (args.includes('--noEmit')) await checked
  }, { stage: async () => { staged = true; return 'staged release' } })
    .then(value => { finished = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(staged, true)
  assert.equal(finished, false)
  passCheck()
  assert.equal(await build, 'staged release')
})

test('a failed API check settles staging before rejecting the installation', async () => {
  let finishStaging
  const staging = new Promise(resolve => { finishStaging = resolve })
  let staged = false
  let failed = false
  const build = production.buildProductionSource(async (_command, args) => {
    if (args.includes('--noEmit')) throw new Error('Invalid API types')
  }, { stage: async () => { await staging; staged = true } })
  const rejected = build.then(() => { failed = true; return undefined }, error => { failed = true; return error })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(failed, false)
  finishStaging()
  assert.match((await rejected).message, /Invalid API types/)
  assert.equal(staged, true)
})

test('readiness polls while the service start command is waiting and smoke waits for both', async t => {
  const expected = { installationId: 'installation', checkoutId: 'release', databaseId: 'database' }
  let finishStart
  const starting = new Promise(resolve => { finishStart = resolve })
  let observed = false
  let smoked = false
  const server = createServer((request, response) => {
    observed = true
    if (request.url === '/health/identity') response.end(JSON.stringify(expected))
    else if (request.url === '/health/ready') response.end(JSON.stringify({ service: 'graphql-api',
      checks: { database: 'ok', checkpoints: 'ok' } }))
    else response.end('<script src="/assets/dashboard.js"></script>')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const ready = waitForProductionReady({ origin: `http://127.0.0.1:${server.address().port}`, expected,
    timeoutMs: 1000, start: () => starting, smoke: async () => { smoked = true } })
  // Release start even on assertion failure so no request or server survives the test.
  try {
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(observed, true)
    assert.equal(smoked, false)
  } finally {
    finishStart()
    await ready
  }
  assert.equal(smoked, true)
})

for (const input of ['pnpm-lock.yaml', 'apps/api/package.json', 'packages/contracts/package.json',
  'pnpm-workspace.yaml', '.npmrc']) {
  test(`dependency staging invalidates when ${input} changes`, async t => {
    const directory = await installFixture(t)
    const { source, run, deploys } = await apiBuildSource(directory)
    const dependencies = { root: join(directory, 'api-dependencies'), source }
    const first = join(directory, 'releases/first/apps/api')
    await production.deployProductionApi(run, first, { dependencies })
    if (input === 'pnpm-workspace.yaml' || input === '.npmrc') {
      await writeFile(join(source, input), '# changed install policy\n')
    } else {
      await writeFile(join(source, input), (await readFile(join(source, input), 'utf8')) + ' ')
    }
    const second = join(directory, 'releases/second/apps/api')
    await production.deployProductionApi(run, second, { dependencies })
    assert.equal(deploys.length, 2)
    assert.notEqual(await realpath(join(first, 'node_modules/fastify')), await realpath(join(second, 'node_modules/fastify')))
    assert.equal(await readFile(join(first, 'node_modules/@foreman-code/contracts/dist/index.js'), 'utf8'), 'contracts 1\n')
  })
}


test('dependency pruning retains cache entries used by older symlinked releases', async t => {
  const directory = await installFixture(t)
  const root = join(directory, 'api-dependencies')
  const release = join(directory, 'releases/previous')
  await mkdir(join(root, 'installed/api/node_modules'), { recursive: true })
  await writeFile(join(root, 'installed/api/node_modules/value'), 'installed dependency')
  await mkdir(join(release, 'apps/api'), { recursive: true })
  await symlink(join(root, 'installed/api/node_modules'), join(release, 'apps/api/node_modules'))
  const removed = []
  await production.pruneApiDependencies(root, [release], { removeInBackground: path => removed.push(path) })
  assert.deepEqual(removed, [])
  assert.equal(await readFile(join(release, 'apps/api/node_modules/value'), 'utf8'), 'installed dependency')
})


test('pruning retries abandoned removals even when every release is retained', async t => {
  const parent = await installFixture(t)
  const releases = join(parent, 'releases')
  const abandoned = join(parent, '.pruned-releases-abandoned')
  const retained = join(releases, 'release-now')
  await mkdir(retained, { recursive: true })
  await mkdir(abandoned)
  await writeFile(join(abandoned, 'old-dependency'), 'old')
  const removals = []
  await pruneReleases(releases, [retained], { removeInBackground: path => removals.push(path) })
  assert.deepEqual(removals, [await realpath(abandoned)])
  assert.equal(await readFile(join(abandoned, 'old-dependency'), 'utf8'), 'old')
  assert.deepEqual(await readdir(releases), ['release-now'])
})

test('pruning preserves a selected release inside an abandoned removal directory', async t => {
  const parent = await installFixture(t)
  const releases = join(parent, 'releases')
  const abandoned = join(parent, '.pruned-releases-selected')
  const selected = join(abandoned, 'release-selected')
  await mkdir(releases)
  await mkdir(selected, { recursive: true })
  await symlink(selected, join(parent, 'current'))
  const removals = []
  await pruneReleases(releases, [], { removeInBackground: path => removals.push(path) })
  assert.deepEqual(removals, [])
  assert.equal(await realpath(join(parent, 'current')), await realpath(selected))
})
