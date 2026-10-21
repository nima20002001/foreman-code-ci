import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { executeCommand } from './dense-process.mjs'
import { scheduleQueue } from './dense-scheduler.mjs'
import { createDenseItems, denseSummary, executeDenseItem, runDense } from './test-dense.mjs'
import { portionPath, writeReport } from './verification-reports.mjs'

const keys = ['packages/contracts:test', 'apps/api:test', 'apps/web:test:unit',
  'apps/web:test:run-graph-smoke', 'apps/worker:test', 'root:test:scripts']
const inventory = keys.map((key, index) => ({ key, kind: index < 3 ? 'vitest' : 'node',
  files: [`portion-${index}/first.test.mjs`, `portion-${index}/second.test.mjs`] }))
const metrics = { durationMs: 10, peakRssBytes: 1024, cpuSeconds: 0.01 }

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dense-gate-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, directory: join(root, 'reports'), integrationFiles: ['integration-file'] }
}

function writeUnitReport(item, { omit = false, skipped = false } = {}) {
  const directory = item.env.FOREMAN_CODE_VERIFICATION_REPORT_DIR
  const key = item.portion.key
  const files = omit ? item.portion.files.slice(1) : item.portion.files
  writeReport(portionPath(directory, key, 'command.json'), { key, code: 0,
    startedAt: new Date(1).toISOString(), finishedAt: new Date(11).toISOString() }, 4096)
  if (item.portion.kind === 'vitest') {
    writeReport(portionPath(directory, key, 'vitest.json'), {
      success: true, numTotalTestSuites: files.length, numPassedTestSuites: files.length,
      numFailedTestSuites: 0, numPendingTestSuites: 0, numTotalTests: files.length,
      numPassedTests: skipped ? 0 : files.length, numFailedTests: 0,
      numPendingTests: skipped ? files.length : 0, numTodoTests: 0,
      testResults: files.map(file => ({ name: join(item.cwd, file), status: 'passed', startTime: 1, endTime: 11,
        assertionResults: [{ fullName: 'case', status: skipped ? 'pending' : 'passed', duration: 10 }] })),
    }, 16384)
    return
  }
  const counts = { tests: files.length, passed: files.length, failed: 0, skipped: 0, todo: 0, cancelled: 0 }
  const events = files.flatMap(file => [
    { type: 'test:start', file: join(item.cwd, file), name: 'case', nesting: 0, timestamp: 1 },
    { type: 'test:pass', file: join(item.cwd, file), name: 'case', nesting: 0, duration: 10, timestamp: 11 },
    { type: 'test:summary', file: join(item.cwd, file), success: true, timestamp: 11 },
  ])
  events.push({ type: 'test:summary', success: true, counts })
  writeReport(portionPath(directory, key, 'node.ndjson'), events.map(event => JSON.stringify(event)).join('\n'), 16384)
}

function fakeExecutor({ failOnce, omit, skipped, calls = [] } = {}) {
  return async (item, context, options) => {
    calls.push({ item, context, options })
    writeFileSync(item.log, 'bounded fake command log\n')
    if (item.portion) writeUnitReport(item, { omit: item.id === omit, skipped: item.id === skipped })
    const code = item.id === failOnce && context.attempt === 1 ? 1 : 0
    return { code, complete: true, metrics, log: item.log,
      reason: code ? 'fixture command failed <once>' : undefined, output: { bytes: 25, discardedBytes: 0 } }
  }
}

async function fakeIntegration(_argv, options) {
  const integrationItem = { id: 'integration-file', command: 'fixture' }
  const scheduled = await scheduleQueue([integrationItem, ...options.extraItems], {
    maxConcurrency: 2, pollIntervalMs: 1, samplePressure: () => ({ cpuUtilization: 0,
      cpuPressure: 0, memoryPressure: 0, memoryUtilization: 0, totalMemoryBytes: 2 ** 30, cpuCount: 4 }),
    execute: (item, context) => item === integrationItem
      ? Promise.resolve({ code: 0, complete: true, metrics })
      : options.executeExtra(item, context, { shouldStop: () => false }),
  })
  return { code: Number(scheduled.results.some(result => result.status !== 'PASSED')),
    selectedFiles: [integrationItem.id], results: scheduled.results,
    report: { totals: { total: 1, passed: 1, failed: 0, skipped: 0 } },
    reportDirectory: join(options.reportDirectory, 'parts', 'integration') }
}

test('dense queue covers every unit portion and pinned command gate with one exclusive build', () => {
  const items = createDenseItems({ root: '/repository', env: {}, inventory })
  assert.equal(items.length, 9)
  assert.deepEqual(items.filter(item => item.portion).map(item => item.portion), inventory)
  assert.ok(items.every(item => item.command === 'corepack' && item.args[0] === 'pnpm'))
  assert.ok(items.filter(item => item.portion).every(item => item.args.includes('/repository/scripts/test-command.mjs')))
  assert.deepEqual(items.filter(item => !item.portion).map(item => item.args),
    [['pnpm', '-r', '--no-bail', '--no-sort', '--if-present', 'lint'],
      ['pnpm', '-r', '--if-present', 'typecheck'], ['pnpm', 'build']])
  assert.deepEqual(items.filter(item => item.exclusive).map(item => item.id), ['gate:build'])
  assert.ok(items.every(item => item.env.FOREMAN_CODE_VERIFICATION_UNIT_WORKERS === '2'))
  assert.ok(items.every(item => item.timeoutMs === 1_800_000 && item.idleTimeoutMs === 60_000))
})

test('dense queue validates worker and supervision bounds and refuses missing portions', () => {
  for (const env of [{ GRAPHQL_DENSE_UNIT_WORKERS: '0' }, { GRAPHQL_DENSE_ITEM_TIMEOUT_MS: '0' },
    { GRAPHQL_DENSE_IDLE_TIMEOUT_MS: 'NaN' }]) {
    assert.throws(() => createDenseItems({ env, inventory }), /must be a positive integer/)
  }
  assert.throws(() => createDenseItems({ env: {}, inventory: inventory.slice(1) }), /Missing dense unit inventory/)
  const [item] = createDenseItems({ env: { GRAPHQL_DENSE_UNIT_WORKERS: '1',
    GRAPHQL_DENSE_ITEM_TIMEOUT_MS: '1234', GRAPHQL_DENSE_IDLE_TIMEOUT_MS: '234' }, inventory })
  assert.equal(item.env.FOREMAN_CODE_VERIFICATION_UNIT_WORKERS, '1')
  assert.equal(item.timeoutMs, 1234)
  assert.equal(item.idleTimeoutMs, 234)
})

test('full dense gate refuses integration subset selectors from either environment prefix', async () => {
  for (const name of ['INTEGRATION_START_AT', 'INTEGRATION_FAILED_LOG', 'INTEGRATION_TEST_NAME_PATTERN']) {
    for (const prefix of ['GRAPHQL_', 'FOREMAN_CODE_']) {
      await assert.rejects(runDense([], { env: { [`${prefix}${name}`]: 'subset' }, inventory,
        integrationRunner: async () => { assert.fail('partial gate must not run') } }), /requires full integration coverage/)
    }
  }
})

test('one queue reports integration, unit coverage, and command jobs through a fake executor', async t => {
  const f = fixture(t)
  const calls = []
  const result = await runDense([], { ...f, env: {}, inventory,
    integrationRunner: fakeIntegration, execute: fakeExecutor({ calls }) })
  assert.equal(result.code, 0)
  assert.equal(result.summary.outcome, 'passed')
  assert.equal(result.summary.expectedJobs, 10)
  assert.deepEqual(result.summary.counts, { passed: 10, failed: 0, flaky: 0, notRun: 0 })
  assert.deepEqual(result.summary.totals, { total: 13, passed: 13, failed: 0, skipped: 0 })
  assert.equal(calls.length, 9)
  const report = JSON.parse(readFileSync(join(f.directory, 'summary.json'), 'utf8'))
  assert.equal(report.results.filter(job => job.attempts[0].coverage).length, 6)
  assert.match(readFileSync(join(f.directory, 'junit.xml'), 'utf8'), /tests="10" failures="0"/)
  assert.ok(calls.every(call => readFileSync(call.item.log, 'utf8').includes('fake command log')))
})

test('isolated success retains flaky failure and both attempt logs in JSON and JUnit', async t => {
  const f = fixture(t)
  const result = await runDense([], { ...f, env: {}, inventory,
    integrationRunner: fakeIntegration, execute: fakeExecutor({ failOnce: 'gate:lint' }) })
  assert.equal(result.code, 1)
  assert.equal(result.summary.outcome, 'failed')
  const lint = result.summary.results.find(job => job.id === 'gate:lint')
  assert.equal(lint.status, 'FLAKY')
  assert.deepEqual(lint.attempts.map(attempt => attempt.code), [1, 0])
  assert.notEqual(lint.attempts[0].log, lint.attempts[1].log)
  const junit = readFileSync(join(f.directory, 'junit.xml'), 'utf8')
  assert.match(junit, /failures="1"/)
  assert.match(junit, /FLAKY/)
  assert.match(junit, /&lt;once&gt;/)
})

test('exit zero cannot hide missing unit files or skipped test cases', async t => {
  for (const failure of [{ omit: 'gate:api-unit' }, { skipped: 'gate:api-unit' }]) {
    const f = fixture(t)
    const result = await runDense([], { ...f, env: {}, inventory,
      integrationRunner: fakeIntegration, execute: fakeExecutor(failure) })
    assert.equal(result.code, 1)
    const unit = result.summary.results.find(job => job.id === 'gate:api-unit')
    assert.equal(unit.status, 'FAILED')
    assert.equal(unit.attempts.length, 2)
    assert.ok(unit.attempts.every(attempt => attempt.code === 1))
    if (failure.omit) assert.equal(result.summary.completeness, 'partial')
    if (failure.skipped) assert.equal(result.summary.totals.skipped, 2)
  }
})

test('extra commands receive integration cancellation controls and preserve signal exit codes', async t => {
  const f = fixture(t)
  const result = await runDense([], { ...f, env: {}, inventory,
    integrationRunner: async (_argv, options) => {
      const item = options.extraItems.find(candidate => candidate.id === 'gate:lint')
      const attempt = await options.executeExtra(item, { attempt: 1, timeoutScale: 1 }, { shouldStop: () => true })
      return { code: 143, results: [{ id: item.id, status: 'FAILED', attempts: [attempt] }] }
    },
    execute: async (_item, _context, options) => {
      assert.equal(options.shouldStop(), true)
      return { code: 143, complete: true, metrics, reason: 'cancelled' }
    } })
  assert.equal(result.code, 143)
  assert.equal(result.summary.outcome, 'cancelled')
  assert.equal(result.summary.counts.notRun, 9)
})

test('cleanup failure preserves completed attempts and cancellation codes in incomplete reports', async t => {
  for (const code of [1, 130, 143]) {
    const f = fixture(t)
    const result = await runDense([], { ...f, env: {}, inventory, execute: fakeExecutor(),
      integrationRunner: async (argv, options) => {
        const completed = await fakeIntegration(argv, options)
        return { ...completed, code, cleanupError: 'fixture cleanup failed',
          report: { ...completed.report, completeness: 'partial', outcome: code === 1 ? 'incomplete' : 'cancelled' } }
      } })
    assert.equal(result.code, code)
    assert.equal(result.summary.error, 'fixture cleanup failed')
    assert.equal(result.summary.completeness, 'partial')
    assert.equal(result.summary.outcome, code === 1 ? 'incomplete' : 'cancelled')
    assert.equal(result.summary.expectedJobs, 10)
    assert.equal(result.summary.completedJobs, 10)
    assert.deepEqual(result.summary.counts, { passed: 10, failed: 0, flaky: 0, notRun: 0 })
    assert.ok(result.summary.results.every(job => job.attempts.length === 1))
    const persisted = JSON.parse(readFileSync(join(f.directory, 'summary.json'), 'utf8'))
    assert.equal(persisted.completedJobs, 10)
    assert.equal(persisted.error, 'fixture cleanup failed')
    const junit = readFileSync(join(f.directory, 'junit.xml'), 'utf8')
    assert.match(junit, /errors="1"/)
    assert.match(junit, /fixture cleanup failed/)
  }
})

test('a partial integration report cannot turn completed successful jobs into a passed gate', async t => {
  const f = fixture(t)
  const result = await runDense([], { ...f, env: {}, inventory, execute: fakeExecutor(),
    integrationRunner: async (argv, options) => {
      const completed = await fakeIntegration(argv, options)
      return { ...completed, report: { ...completed.report, completeness: 'partial', outcome: 'incomplete' } }
    } })
  assert.equal(result.code, 1)
  assert.equal(result.summary.outcome, 'incomplete')
  assert.equal(result.summary.completedJobs, 10)
  assert.equal(result.summary.error, 'Integration report is incomplete')
})

test('runner death and incomplete command supervision remain failed reports', async t => {
  const f = fixture(t)
  const requiredFiles = ['first-integration-file', 'second-integration-file']
  const result = await runDense([], { ...f, env: {}, inventory, integrationFiles: requiredFiles,
    integrationRunner: async () => { throw new Error('runner died') } })
  assert.equal(result.code, 1)
  assert.equal(result.summary.error, 'runner died')
  assert.equal(result.summary.expectedJobs, 11)
  assert.equal(result.summary.counts.notRun, 11)
  assert.deepEqual(result.summary.results.slice(0, 2).map(job => ({ id: job.id, status: job.status })),
    requiredFiles.map(id => ({ id, status: 'NOT_RUN' })))
  assert.equal(result.summary.outcome, 'incomplete')
  const [item] = createDenseItems({ root: f.root, env: {}, inventory })
  const command = await executeDenseItem(item, { attempt: 1, timeoutScale: 1 }, {
    directory: f.directory, execute: async candidate => {
      writeUnitReport(candidate)
      return { code: 124, complete: false, metrics, timedOut: true, reason: 'timeout' }
    } })
  assert.equal(command.code, 124)
  assert.equal(command.complete, false)
  assert.equal(command.timedOut, true)
})

test('a real command nonzero exit produces a complete failed dense summary', async t => {
  const f = fixture(t)
  const script = join(f.root, 'failed-command.mjs')
  writeFileSync(script, 'console.error("fixture failure"); process.exitCode = 7\n')
  const item = { id: 'failed-command', command: process.execPath, args: [script], cwd: f.root,
    timeoutMs: 2000, idleTimeoutMs: 2000, log: join(f.root, 'failed-command.log') }
  const attempt = await executeCommand(item, { attempt: 1, timeoutScale: 1 }, { pollIntervalMs: 10, graceMs: 100 })
  assert.equal(attempt.code, 7)
  assert.equal(attempt.complete, true)
  const summary = denseSummary({ items: [item], integrationFiles: [],
    integration: { code: 1, results: [{ id: item.id, status: 'FAILED', attempts: [attempt] }] },
    startedAt: new Date(1).toISOString(), finishedAt: new Date(11).toISOString() })
  assert.equal(summary.completeness, 'complete')
  assert.equal(summary.outcome, 'failed')
  assert.deepEqual(summary.counts, { passed: 0, failed: 1, flaky: 0, notRun: 0 })
})
