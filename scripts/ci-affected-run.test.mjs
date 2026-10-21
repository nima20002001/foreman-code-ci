import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { ciTestResults } from './ci-test-results.mjs'

for (const files of [
  ['scripts/missing.test.mjs'],
  ['scripts/missing.test.mjs', 'apps/web/src/missing.test.tsx'],
]) {
  test(`affected unit selection reports missing files: ${files.join(', ')}`, t => {
    const base = join(homedir(), '.cache', 'foreman-tmp')
    mkdirSync(base, { recursive: true })
    const root = mkdtempSync(join(base, 'affected-missing-files-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const selection = join(root, 'selected.json')
    writeFileSync(selection, JSON.stringify(files))

    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./ci-affected-run.mjs', import.meta.url)),
      'unit', '--files-from', selection], { cwd: root, encoding: 'utf8' })

    assert.equal(result.status, 1)
    assert.ok(result.stderr.includes(`CI selection must contain existing repository files: ${files.join(', ')}`),
      result.stderr)
    assert.doesNotMatch(result.stderr, /ENOENT/)
  })
}

for (const failing of [false, true]) {
  test(`affected Node tests retain reports and exit with the ${failing ? 'failing' : 'passing'} suite outcome`, t => {
    const base = join(homedir(), '.cache', 'foreman-tmp')
    mkdirSync(base, { recursive: true })
    const root = mkdtempSync(join(base, 'affected-node-reporter-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    mkdirSync(join(root, 'scripts'))
    mkdirSync(join(root, 'reports'))
    for (const name of ['ci-node-test-reporter.mjs', 'ci-progress-reporter.mjs']) {
      symlinkSync(fileURLToPath(new URL(name, import.meta.url)), join(root, 'scripts', name))
    }
    writeFileSync(join(root, 'corepack'), `#!${process.execPath}\nprocess.exit(0)\n`, { mode: 0o755 })
    const file = 'scripts/value.test.mjs'
    writeFileSync(join(root, file), `import { test } from 'node:test'
import assert from 'node:assert/strict'
test('passes', () => assert.equal(1, 1))
test('second case', () => assert.equal(1, ${failing ? 2 : 1}))
`)
    const selection = join(root, 'selected.json')
    writeFileSync(selection, JSON.stringify([file]))
    const progress = join(root, 'reports', 'progress.jsonl')
    const environment = { ...process.env, PATH: `${root}${delimiter}${process.env.PATH}`,
      CI_PROGRESS_FILE: progress, CI_REPOSITORY_ROOT: root }
    // The child suite needs its own reporters rather than the parent test IPC channel.
    delete environment.NODE_TEST_CONTEXT
    delete environment.TEST_RESULTS_OUTPUT
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./ci-affected-run.mjs', import.meta.url)),
      'unit', '--files-from', selection], { cwd: root, env: environment, encoding: 'utf8' })
    assert.equal(result.status, failing ? 1 : 0, result.stderr)
    assert.doesNotMatch(result.stderr, /EINVAL|Unhandled 'error' event/)
    const report = JSON.parse(readFileSync(`${progress}.node-report.json`, 'utf8'))
    const results = ciTestResults([report], root)
    assert.deepEqual(results.summary, { passed: failing ? 1 : 2, failed: failing ? 1 : 0, skipped: 0 })
    assert.equal(results.files.length, 1)
    assert.equal(results.files[0].status, failing ? 'failed' : 'passed')
    assert.deepEqual(results.files[0].tests.map(({ name, status }) => [name, status]).sort(),
      [['passes', 'passed'], ['second case', failing ? 'failed' : 'passed']])
    if (failing) assert.match(results.files[0].tests.find(item => item.status === 'failed').message, /Expected values/)
    const events = readFileSync(progress, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(events.filter(event => event.type === 'finish' && event.kind === 'test')
      .map(event => event.name).sort(), ['passes', 'second case'])
  })
}

test('affected Node tests publish structured results when results are requested', t => {
  const base = join(homedir(), '.cache', 'foreman-tmp')
  mkdirSync(base, { recursive: true })
  const root = mkdtempSync(join(base, 'affected-node-results-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'scripts'))
  symlinkSync(fileURLToPath(new URL('ci-node-test-reporter.mjs', import.meta.url)), join(root, 'scripts', 'ci-node-test-reporter.mjs'))
  symlinkSync(fileURLToPath(new URL('ci-progress-reporter.mjs', import.meta.url)), join(root, 'scripts', 'ci-progress-reporter.mjs'))
  writeFileSync(join(root, 'corepack'), `#!${process.execPath}\nprocess.exit(0)\n`, { mode: 0o755 })
  const file = 'scripts/value.test.mjs'
  writeFileSync(join(root, file), `import { test } from 'node:test'
import assert from 'node:assert/strict'
test('passes', () => assert.equal(1, 1))
`)
  const selection = join(root, 'selected.json')
  writeFileSync(selection, JSON.stringify([file]))
  const output = join(root, 'test-results.json')
  const environment = { ...process.env, PATH: `${root}${delimiter}${process.env.PATH}`, TEST_RESULTS_OUTPUT: output }
  delete environment.NODE_TEST_CONTEXT
  delete environment.CI_PROGRESS_FILE
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./ci-affected-run.mjs', import.meta.url)),
    'unit', '--files-from', selection], { cwd: root, env: environment, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const results = JSON.parse(readFileSync(output, 'utf8'))
  assert.deepEqual(results.summary, { passed: 1, failed: 0, skipped: 0 })
  assert.equal(results.files.length, 1)
  assert.ok(results.files[0].file.endsWith(file), results.files[0].file)
})
