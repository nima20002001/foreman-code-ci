import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { CI_TEST_RESULT_LIMITS, ciTestResults, writeCiTestResults } from './ci-test-results.mjs'

const temporary = t => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ci-test-results-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('merges Vitest reports into repository files with per-test status, duration and failure', () => {
  const root = resolve('results-fixture')
  const results = ciTestResults([{ testResults: [
    { name: resolve(root, 'apps/api/test/a.test.ts'), status: 'failed', startTime: 100, endTime: 350, assertionResults: [
      { fullName: 'a saves', status: 'passed', duration: 12 },
      { fullName: 'a rejects', status: 'failed', duration: 30, failureMessages: ['\u001b[31mAssertionError\u001b[39m: expected 1 to be 2\n  at a.test.ts:4'] },
    ] },
  ] }, { testResults: [
    { name: 'apps/api/test/b.integration.test.ts', status: 'passed', startTime: 0, endTime: 20, assertionResults: [
      { title: 'b waits', status: 'pending' }, { fullName: 'b later', status: 'todo' },
    ] },
  ] }], root)
  assert.deepEqual(results, { summary: { passed: 1, failed: 1, skipped: 2 }, truncated: false, files: [
    { file: 'apps/api/test/a.test.ts', status: 'failed', durationMs: 250, tests: [
      { name: 'a saves', status: 'passed', durationMs: 12 },
      { name: 'a rejects', status: 'failed', durationMs: 30, message: 'AssertionError: expected 1 to be 2\n  at a.test.ts:4' }] },
    { file: 'apps/api/test/b.integration.test.ts', status: 'skipped', durationMs: 20, tests: [
      { name: 'b waits', status: 'skipped', durationMs: null }, { name: 'b later', status: 'skipped', durationMs: null }] },
  ] })
})

test('reads the exact failure location from the full stack even when the message is clipped', () => {
  const root = resolve('results-fixture')
  const file = 'apps/web/src/a.test.tsx'
  const stack = (...frames) => `TestingLibraryElementError: Unable to find an element\n${'<div />\n'.repeat(200)}`
    + frames.map(frame => `    at ${frame}`).join('\n')
  const results = ciTestResults([{ testResults: [{ name: resolve(root, file), status: 'failed', assertionResults: [
    { fullName: 'own file', status: 'failed', failureMessages: [stack(
      `getElementError (${resolve(root, 'node_modules/.pnpm/dom/dist/config.js')}:37:19)`,
      `${resolve(root, 'apps/web/src/helpers.ts')}:12:5`, `${resolve(root, file)}:54:19`,
      `file://${resolve(root, 'node_modules/vitest/dist/run.js')}:2681:43`)] },
    { fullName: 'helper only', status: 'failed', failureMessages: [stack(`file://${resolve(root, 'apps/web/src/helpers.ts')}:8:3`)] },
    { fullName: 'outside', status: 'failed', failureMessages: [stack(`${resolve(root, '../elsewhere/x.ts')}:1:1`)] },
  ] }] }], root)
  const tests = results.files[0].tests
  assert.ok(tests[0].message.length <= CI_TEST_RESULT_LIMITS.message)
  assert.deepEqual(tests.map(test => test.location), [`${file}:54:19`, 'apps/web/src/helpers.ts:8:3', undefined])
})

test('keeps failed tests first within the bounds and still counts every test', () => {
  const passing = Array.from({ length: CI_TEST_RESULT_LIMITS.files + 20 }, (_, index) => ({
    name: `apps/web/src/p${String(index).padStart(3, '0')}.test.tsx`, status: 'passed', startTime: 0, endTime: 1,
    assertionResults: Array.from({ length: 3 }, (_, test) => ({ fullName: `p${index} case ${test} ${'x'.repeat(300)}`,
      status: 'passed', duration: 1 })) }))
  const failing = { name: 'apps/web/src/z.test.tsx', status: 'failed', startTime: 0, endTime: 1,
    assertionResults: [{ fullName: 'z breaks', status: 'failed', duration: 1, failureMessages: ['y'.repeat(1000)] }] }
  const results = ciTestResults([{ testResults: [...passing, failing] }], '/')
  const kept = results.files.flatMap(file => file.tests)
  assert.equal(results.truncated, true)
  assert.deepEqual(results.summary, { passed: passing.length * 3, failed: 1, skipped: 0 })
  assert.equal(results.files.length, CI_TEST_RESULT_LIMITS.files)
  assert.equal(results.files[0].file, 'apps/web/src/z.test.tsx')
  assert.equal(kept.length, CI_TEST_RESULT_LIMITS.tests)
  assert.equal(kept[0].name, 'z breaks')
  assert.equal(kept[0].message.length, CI_TEST_RESULT_LIMITS.message)
  assert.ok(kept.every(test => test.name.length <= CI_TEST_RESULT_LIMITS.name))
  assert.ok(Buffer.byteLength(JSON.stringify(results)) < 512 * 1024)
})

test('fails expected collection without publishing partial reports', t => {
  const directory = temporary(t)
  const output = join(directory, 'out', 'test-results.json')
  assert.throws(() => writeCiTestResults(output, [join(directory, 'missing.json')]), /missing.json/)
  assert.equal(existsSync(output), false)
  writeFileSync(join(directory, 'report.json'), JSON.stringify({ testResults: [] }))
  assert.throws(() => writeCiTestResults(output, [join(directory, 'missing.json'), join(directory, 'report.json')]), /missing.json/)
  assert.equal(existsSync(output), false)
  assert.equal(writeCiTestResults(output, [join(directory, 'report.json')]), true)
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), { summary: { passed: 0, failed: 0, skipped: 0 }, truncated: false, files: [] })
})

test('a unit slice records its test results without handing the results path to the tests', t => {
  const directory = temporary(t)
  const root = fileURLToPath(new URL('..', import.meta.url))
  const output = join(directory, 'reports', 'test-results.json')
  mkdirSync(join(directory, 'reports'))
  writeFileSync(join(directory, 'pnpm'), `#!${process.execPath}
const { writeFileSync } = require('node:fs')
const { resolve } = require('node:path')
const args = process.argv.slice(2)
if (args.includes('build')) process.exit(0)
writeFileSync(process.env.SEEN_FILE, JSON.stringify(process.env.TEST_RESULTS_OUTPUT ?? null))
const report = args.find(arg => arg.startsWith('--outputFile.json=')).split('=').slice(1).join('=')
const file = args.find(arg => arg.endsWith('.test.tsx') || arg.endsWith('.test.ts'))
writeFileSync(report, JSON.stringify({ testResults: [{ name: resolve(file), startTime: 100, endTime: 175, status: 'failed',
  assertionResults: [{ fullName: 'renders', status: 'failed', duration: 9, failureMessages: ['broken'] }] }] }))
process.exit(3)
`, { mode: 0o755 })
  const result = spawnSync('bash', ['scripts/ci-suite.sh'], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, SUITE: 'unit-web', SCOPE: 'full', SLICE: '1/3',
      CI_PROGRESS_FILE: '', CI_WATCHDOG_ACTIVE: '', CI_EXPECTED_DURATION_MS: '', DURATIONS_INPUT: '',
      DURATIONS_OUTPUT: join(directory, 'reports', 'durations.json'), TEST_RESULTS_OUTPUT: output,
      CI_STATE: join(directory, 'state'), PATH: `${directory}${delimiter}${process.env.PATH}`,
      SEEN_FILE: join(directory, 'seen.json'), CI_HOST_RUNNER: '0' },
  })
  assert.equal(result.status, 3, result.stderr)
  assert.equal(JSON.parse(readFileSync(join(directory, 'seen.json'), 'utf8')), null)
  const results = JSON.parse(readFileSync(output, 'utf8'))
  assert.deepEqual(results.summary, { passed: 0, failed: 1, skipped: 0 })
  assert.equal(results.files.length, 1)
  assert.ok(results.files[0].file.startsWith('apps/web/src/'))
  assert.deepEqual(results.files[0].tests, [{ name: 'renders', status: 'failed', durationMs: 9, message: 'broken' }])
})

test('unit-other merges contracts, Worker and script results while preserving a failing exit status', t => {
  const directory = temporary(t)
  const root = fileURLToPath(new URL('..', import.meta.url))
  const output = join(directory, 'test-results.json')
  writeFileSync(join(directory, 'pnpm'), `#!${process.execPath}
const { writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (args.includes('build')) process.exit(0)
const vitest = args.find(arg => arg.startsWith('--outputFile.json='))
const destination = args.find(arg => arg.startsWith('--test-reporter-destination=') && !arg.endsWith('=stdout'))
if (!vitest && !destination) process.exit(0)
const report = (vitest ?? destination).slice((vitest ?? destination).indexOf('=') + 1)
const file = vitest ? 'packages/contracts/src/value.test.ts' : process.cwd().endsWith('/apps/worker')
  ? 'apps/worker/test/value.test.mjs' : 'scripts/value.test.mjs'
const failed = file.startsWith('apps/worker/')
writeFileSync(report, JSON.stringify({ testResults: [{ name: file, status: failed ? 'failed' : 'passed',
  assertionResults: [{ fullName: file + ' case', status: failed ? 'failed' : 'passed', duration: 1,
    failureMessages: failed ? ['worker assertion failed'] : [] }] }] }))
process.exit(failed ? 7 : 0)
`, { mode: 0o755 })
  const result = spawnSync('bash', ['scripts/ci-suite.sh'], { cwd: root, encoding: 'utf8',
    env: { ...process.env, SUITE: 'unit-other', SCOPE: 'full', CI_PREREQUISITES_UNTRACKED: '1', TEST_RESULTS_OUTPUT: output,
      CI_STATE: join(directory, 'state'), PATH: `${directory}${delimiter}${process.env.PATH}`,
      CI_HOST_RUNNER: '0', CI_EXPECTED_DURATION_MS: '', CI_PROGRESS_FILE: '', CI_WATCHDOG_ACTIVE: '', BASH_ENV: '' } })
  assert.equal(result.status, 7, result.stderr)
  const results = JSON.parse(readFileSync(output, 'utf8'))
  assert.deepEqual(results.summary, { passed: 2, failed: 1, skipped: 0 })
  assert.equal(results.files[0].file, 'apps/worker/test/value.test.mjs')
  assert.equal(results.files[0].tests[0].message, 'worker assertion failed')
})

test('the Node reporter records passing and failing tests with their file and failure detail', t => {
  const directory = temporary(t)
  const file = join(directory, 'value.test.mjs')
  const output = join(directory, 'node.json')
  writeFileSync(file, `import { test } from 'node:test'
import assert from 'node:assert/strict'
test('passes', () => assert.equal(1, 1))
test('fails', () => assert.equal(1, 2))
test.skip('skips', () => assert.fail('skipped case ran'))
`)
  const reporter = fileURLToPath(new URL('./ci-node-test-reporter.mjs', import.meta.url))
  const environment = { ...process.env }
  // The independent suite uses its reporter instead of the parent's test IPC channel.
  delete environment.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`,
    `--test-reporter-destination=${output}`, file], { encoding: 'utf8',
      env: environment })
  assert.equal(result.status, 1, result.stderr)
  const results = ciTestResults([JSON.parse(readFileSync(output, 'utf8'))], directory)
  assert.deepEqual(results.summary, { passed: 1, failed: 1, skipped: 1 })
  assert.equal(results.files[0].file, 'value.test.mjs')
  assert.deepEqual(results.files[0].tests.map(test => [test.name, test.status]).sort(),
    [['fails', 'failed'], ['passes', 'passed'], ['skips', 'skipped']])
  assert.match(results.files[0].tests.find(test => test.status === 'failed').message, /1.*2|Expected values/)
})

for (const report of ['{broken', '{}', 'null']) {
  test(`rejects malformed or invalid expected reports: ${report}`, t => {
    const directory = temporary(t)
    const input = join(directory, 'invalid.json')
    const output = join(directory, 'results.json')
    writeFileSync(input, report)
    assert.throws(() => writeCiTestResults(output, [input]), /invalid.json/)
    assert.equal(existsSync(output), false)
    const result = spawnSync(process.execPath, ['scripts/ci-test-results.mjs', output, input], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /invalid.json/)
  })
}

test('CLI rejects an expected missing report and an empty collection', t => {
  const directory = temporary(t)
  const output = join(directory, 'results.json')
  for (const inputs of [[join(directory, 'missing.json')], []]) {
    const result = spawnSync(process.execPath, ['scripts/ci-test-results.mjs', output, ...inputs], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /report/i)
  }
})


test('missing reports fail a successful test command and preserve an existing test failure', t => {
  const directory = temporary(t)
  writeFileSync(join(directory, 'pnpm'), `#!${process.execPath}
const args = process.argv.slice(2)
process.exit(args.includes('build') ? 0 : Number(process.env.FIXTURE_EXIT))
`, { mode: 0o755 })
  for (const code of [0, 7]) {
    const result = spawnSync('bash', ['scripts/ci-suite.sh'], { encoding: 'utf8',
      env: { ...process.env, SUITE: 'unit-web', SCOPE: 'full', SLICE: '1/3', FIXTURE_EXIT: String(code),
        CI_PROGRESS_FILE: '', CI_WATCHDOG_ACTIVE: '', CI_EXPECTED_DURATION_MS: '', DURATIONS_INPUT: '',
        DURATIONS_OUTPUT: join(directory, `durations-${code}.json`),
        TEST_RESULTS_OUTPUT: join(directory, `results-${code}.json`), CI_STATE: join(directory, `state-${code}`),
        PATH: `${directory}${delimiter}${process.env.PATH}`, CI_HOST_RUNNER: '0', BASH_ENV: '' } })
    assert.equal(result.status, code || 1, result.stderr)
    assert.match(result.stderr + result.stdout, /report/i)
  }
})
