import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { stopGroup } from './integration-process.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const reporter = join(repository, 'scripts/ci-progress-reporter.mjs')
const temporary = process.env.TMPDIR ?? join(homedir(), '.cache', 'foreman-tmp')
mkdirSync(temporary, { recursive: true })

test('CI suite kills a synchronous looping Vitest test and reports its file and name', { timeout: 85_000 }, async t => {
  const directory = mkdtempSync(join(temporary, 'ci-hang-'))
  mkdirSync(join(directory, 'bin'))
  symlinkSync(join(repository, 'packages/contracts/node_modules'), join(directory, 'node_modules'))
  writeFileSync(join(directory, 'loop.test.ts'), `import { test } from 'vitest'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
test('planner never returns', () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true })
  writeFileSync('descendant.pid', String(child.pid))
  while (true) { /* synchronous planner fixture */ }
})
`)
  writeFileSync(join(directory, 'vitest.config.mjs'), `export default { test: {
    include: ['loop.test.ts'], maxWorkers: 1,
    runner: ${JSON.stringify(join(repository, 'packages/contracts/ci-test-runner.mjs'))},
    reporters: ['default', ...${existsSync(reporter) ? JSON.stringify([reporter]) : '[]'}]
  } }
`)
  writeFileSync(join(directory, 'bin/pnpm'), `#!${process.execPath}
const { spawnSync } = require('node:child_process')
if (process.argv.includes('test')) {
  const result = spawnSync(process.execPath, [process.env.FIXTURE_VITEST, 'run', '--config', 'vitest.config.mjs'],
    { cwd: process.env.FIXTURE_ROOT, stdio: 'inherit' })
  process.exit(result.status ?? 1)
}
`, { mode: 0o755 })
  const child = spawn('bash', [join(repository, 'scripts/ci-suite.sh')], {
    cwd: repository, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${directory}/bin:${process.env.PATH}`, SUITE: 'unit-other', SCOPE: 'full', CI_PREREQUISITES_UNTRACKED: '1',
      CI_HOST_RUNNER: '0', CI_USER_SYSTEMD: '0', CI_STATE: join(directory, 'state'),
      CI_EXPECTED_DURATION_MS: '1000', CI_WATCHDOG_IDLE_MS: '20000', CI_WATCHDOG_DIRECTORY: join(directory, 'watchdog'),
      CI_WATCHDOG_MESSAGE_FILE: join(directory, 'watchdog-message.json'), CI_WATCHDOG_ACTIVE: '', CI_PROGRESS_FILE: '',
      FIXTURE_ROOT: directory, FIXTURE_VITEST: join(repository, 'packages/contracts/node_modules/vitest/vitest.mjs') },
  })
  t.after(async () => {
    await stopGroup(child.pid, { graceMs: 100 })
    const pidFile = join(directory, 'descendant.pid')
    if (existsSync(pidFile)) await stopGroup(Number(readFileSync(pidFile, 'utf8')), { graceMs: 100 })
    rmSync(directory, { recursive: true, force: true })
  })
  let output = ''
  child.stdout.on('data', bytes => { output += bytes })
  child.stderr.on('data', bytes => { output += bytes })
  // This outer test remains responsive while the fixture's event loop is blocked.
  const heartbeat = setInterval(() => console.log('Waiting for the looping CI fixture to fail'), 5000)
  t.after(() => clearInterval(heartbeat))
  const deadline = setTimeout(() => {
    void stopGroup(child.pid, { graceMs: 100 })
    const pidFile = join(directory, 'descendant.pid')
    if (existsSync(pidFile)) void stopGroup(Number(readFileSync(pidFile, 'utf8')), { graceMs: 100 })
  }, 75_000)
  t.after(() => clearTimeout(deadline))
  const started = Date.now()
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  assert.equal(code, 1, output)
  assert.match(output, /CI hang watchdog: no test progress for 20000 ms/)
  assert.match(output, /loop\.test\.ts.*planner never returns/)
  assert.ok(Date.now() - started < 60_000, output)
  const pid = Number(readFileSync(join(directory, 'descendant.pid'), 'utf8'))
  if (existsSync(`/proc/${pid}/stat`)) {
    assert.equal(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[0], 'Z')
  }
})

test('CI suite leaves silent check commands such as typecheck outside the test-progress watchdog', async t => {
  const directory = mkdtempSync(join(temporary, 'ci-check-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(join(directory, 'bin'))
  writeFileSync(join(directory, 'bin/pnpm'), `#!${process.execPath}
require('node:fs').appendFileSync(process.env.FIXTURE_CALLS, process.argv.slice(2).join(' ') + '\\n')
`, { mode: 0o755 })
  for (const suite of ['typecheck-api', 'lint-other', 'build']) {
    const watchdog = join(directory, `watchdog-${suite}`)
    const calls = join(directory, `calls-${suite}`)
    const child = spawn('bash', [join(repository, 'scripts/ci-suite.sh')], {
      cwd: repository, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${directory}/bin:${process.env.PATH}`, SUITE: suite, SCOPE: 'full',
        CI_HOST_RUNNER: '0', CI_USER_SYSTEMD: '0', CI_STATE: join(directory, 'state'),
        CI_EXPECTED_DURATION_MS: '1000', CI_WATCHDOG_DIRECTORY: watchdog, CI_WATCHDOG_ACTIVE: '', CI_PROGRESS_FILE: '',
        FIXTURE_CALLS: calls },
    })
    let output = ''
    child.stdout.on('data', bytes => { output += bytes })
    child.stderr.on('data', bytes => { output += bytes })
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    assert.equal(code, 0, output)
    assert.ok(existsSync(calls), output)
    // A wrapped command would get a progress file and be killed after a minute without test events.
    assert.equal(existsSync(join(watchdog, 'progress.jsonl')), false, `${suite} ran under the test watchdog`)
  }
})

async function watchdogFixture(t, source, overrides = {}) {
  const { runCiPart } = await import('./ci-watchdog.mjs')
  const directory = mkdtempSync(join(temporary, 'ci-progress-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const messageFile = join(directory, 'message')
  const resultsFile = join(directory, 'results.json')
  const code = await runCiPart([process.execPath, '-e', source], { expectedDurationMs: 0,
    progressFile: join(directory, 'progress.jsonl'), messageFile, resultsFile,
    idleTimeoutMs: 1000, ...overrides })
  const failure = existsSync(messageFile) ? JSON.parse(readFileSync(messageFile, 'utf8')) : null
  return { code, reason: failure?.message ?? null, failure,
    results: existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, 'utf8')) : null }
}

test('the watchdog supervises commands when getconf is unavailable', async t => {
  const directory = mkdtempSync(join(temporary, 'ci-metrics-failure-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const watchdog = join(repository, 'scripts/ci-watchdog.mjs')
  for (const exitCode of [0, 7, null]) {
    const source = exitCode === null
      ? 'setInterval(() => {}, 1000)'
      : `setTimeout(() => { console.log('command completed'); process.exit(${exitCode}) }, 150)`
    const child = spawn(process.execPath, [watchdog, '--', process.execPath, '-e', source], {
      cwd: repository, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: directory, CI_EXPECTED_DURATION_MS: '0', CI_WATCHDOG_IDLE_MS: '500',
        CI_WATCHDOG_DIRECTORY: directory },
    })
    t.after(() => stopGroup(child.pid, { graceMs: 100 }))
    let output = ''
    child.stdout.on('data', bytes => { output += bytes })
    child.stderr.on('data', bytes => { output += bytes })
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    assert.equal(code, exitCode ?? 1, output)
    if (exitCode === null) assert.match(output, /no test progress for 500 ms/)
    else assert.match(output, /command completed/)
    assert.equal(output.match(/\[ci-watchdog\] Warning: process metrics unavailable/g)?.length, 1, output)
    assert.match(output, /getconf.*ENOENT/)
  }
})

test('a watchdog during module setup records that no test started', async t => {
  const result = await watchdogFixture(t, `
    const { appendFileSync } = require('node:fs')
    appendFileSync(process.env.CI_PROGRESS_FILE, JSON.stringify({ type: 'start', kind: 'module',
      id: 'module', file: 'setup.test.ts', name: '' }) + '\\n')
    setInterval(() => {}, 1000)
  `)
  assert.equal(result.code, 1)
  assert.equal(result.failure.testsStarted, false)
})

test('a setup command failure records that no test started', async t => {
  const result = await watchdogFixture(t, 'process.exit(2)')
  assert.equal(result.code, 2)
  assert.equal(result.failure?.testsStarted, false)
})

test('a fast failure after a test finishes still records that a test started', async t => {
  const result = await watchdogFixture(t, `
    const { appendFileSync } = require('node:fs')
    for (const type of ['start', 'finish']) {
      appendFileSync(process.env.CI_PROGRESS_FILE, JSON.stringify({ type, kind: 'test',
        id: 'test', file: 'completed.test.ts', name: 'runs once' }) + '\\n')
    }
    process.exit(1)
  `)
  assert.equal(result.code, 1)
  assert.equal(result.failure?.testsStarted, true)
})

test('Node test failures count as started tests instead of setup failures', async t => {
  const reporter = fileURLToPath(new URL('./ci-node-test-reporter.mjs', import.meta.url))
  const result = await watchdogFixture(t, `
    const assert = require('node:assert/strict')
    const { readFileSync, writeFileSync } = require('node:fs')
    const { join, dirname } = require('node:path')
    const { spawnSync } = require('node:child_process')
    const file = join(dirname(process.env.CI_PROGRESS_FILE), 'node-case.test.mjs')
    writeFileSync(file, "import { test } from 'node:test'; test('fails', () => { throw new Error('assertion failed') })")
    const environment = { ...process.env }
    // The independent suite needs its reporters instead of the parent test's IPC channel.
    delete environment.NODE_TEST_CONTEXT
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '--test-reporter-destination=stdout',
      '--test-reporter=' + ${JSON.stringify(reporter)}, '--test-reporter-destination=' + file + '.json', file],
      { stdio: 'inherit', env: environment })
    const report = JSON.parse(readFileSync(file + '.json', 'utf8'))
    assert.deepEqual(report.testResults.flatMap(file => file.assertionResults.map(test => [test.fullName, test.status])),
      [['fails', 'failed']])
    assert.equal(result.status, 1)
    process.exit(result.status)
  `, { idleTimeoutMs: 10_000 })
  assert.equal(result.code, 1)
  assert.equal(result.failure?.testsStarted, true)
})

test('a single quiet test may run three minutes before the idle watchdog stops it', async () => {
  const { CI_IDLE_TIMEOUT_MS } = await import('./ci-watchdog.mjs')
  // Slow unit tests on cold cloud machines legitimately stay quiet for over a minute.
  assert.equal(CI_IDLE_TIMEOUT_MS, 180_000)
})

test('CI deadlines use three known expected durations with a two minute minimum', async () => {
  const { ciPartDeadlineMs } = await import('./ci-watchdog.mjs')
  // An unknown expected duration must not turn into a two-minute deadline for a whole suite part.
  assert.equal(ciPartDeadlineMs(0), Number.POSITIVE_INFINITY)
  assert.equal(ciPartDeadlineMs(30_000), 120_000)
  assert.equal(ciPartDeadlineMs(210_000), 630_000)
})

test('test-start events identify concurrent stuck tests without resetting progress', async t => {
  const result = await watchdogFixture(t, `
    const { appendFileSync } = require('node:fs')
    let id = 0
    setInterval(() => appendFileSync(process.env.CI_PROGRESS_FILE,
      JSON.stringify({ type: 'start', kind: 'test', id: String(++id), file: 'loop.test.ts', name: 'loop ' + id }) + '\\n'), 30)
  `)
  assert.equal(result.code, 1)
  assert.match(result.reason, /no test progress for 1000 ms.*loop\.test\.ts > loop 1/)
  assert.ok(result.results.summary.failed > 1)
  assert.equal(result.results.files.length, 1)
})

test('new per-test results keep a progressing part alive', async t => {
  const result = await watchdogFixture(t, `
    const { appendFileSync } = require('node:fs')
    let id = 0
    const timer = setInterval(() => {
      appendFileSync(process.env.CI_PROGRESS_FILE, JSON.stringify({ type: 'finish', id: String(++id) }) + '\\n')
      if (id === 10) clearInterval(timer)
    }, 100)
  `)
  assert.equal(result.code, 0)
  assert.equal(result.reason, null)
})

test('the part deadline stops a process even while it keeps producing output', async t => {
  const result = await watchdogFixture(t, "setInterval(() => console.log('test output'), 30)", { deadlineMs: 500 })
  assert.equal(result.code, 1)
  assert.match(result.reason, /exceeded part deadline 500 ms/)
})


test('runner status heartbeats do not count as progress for an active test', async t => {
  const result = await watchdogFixture(t, `
    const { appendFileSync } = require('node:fs')
    appendFileSync(process.env.CI_PROGRESS_FILE, JSON.stringify({ type: 'start', kind: 'test',
      id: 'test', file: 'loop.test.ts', name: 'planner never returns' }) + '\\n')
    setInterval(() => console.log('[integration] PROGRESS: test still running'), 50)
  `, { deadlineMs: 3000 })
  assert.equal(result.code, 1)
  assert.match(result.reason, /no test progress for 1000 ms.*planner never returns/)
})

test('new per-test output keeps an active test progressing', async t => {
  const result = await watchdogFixture(t, `
    const { appendFileSync } = require('node:fs')
    appendFileSync(process.env.CI_PROGRESS_FILE, JSON.stringify({ type: 'start', kind: 'test',
      id: 'test', file: 'output.test.ts', name: 'reports progress' }) + '\\n')
    let count = 0
    const timer = setInterval(() => {
      appendFileSync(process.env.CI_PROGRESS_FILE, JSON.stringify({ type: 'output' }) + '\\n')
      if (++count === 15) clearInterval(timer)
    }, 100)
  `)
  assert.equal(result.code, 0)
  assert.equal(result.reason, null)
})
