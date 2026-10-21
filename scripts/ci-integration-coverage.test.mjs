import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { affectedSnapshot, selectAffectedFiles } from './ci-affected.mjs'

const source = 'apps/api/src/feature.ts'
const other = 'apps/api/src/other.ts'
const first = 'apps/api/test/feature.integration.test.ts'
const second = 'apps/api/test/other.integration.test.ts'
const bootstrap = 'apps/api/src/app.ts'
const sources = new Map([
  [source, 'export const feature = () => 1'],
  [other, 'export const other = () => 2'],
  [bootstrap, "import './feature.js'; import './other.js'"],
  [first, "import '../src/app.js'"],
  [second, "import '../src/app.js'"],
])
const coverageMap = { version: 1, commit: 'a'.repeat(40), testFiles: [first, second],
  coverage: { [first]: [source, bootstrap], [second]: [other, bootstrap] } }
const select = (changedFiles, extra = {}) => selectAffectedFiles({
  suite: 'integration', changedFiles, sources, coverageMap, ...extra,
})

test('coverage avoids bootstrap import fan-out and explains its selection', () => {
  const result = select([source])
  assert.equal(result.scope, 'affected')
  assert.deepEqual(result.files, [first])
  assert.match(result.reason, /coverage/i)
  assert.ok(result.reason.includes(coverageMap.commit))
})

test('coverage always includes changed tests and tests absent from the map', () => {
  const added = 'apps/api/test/added.integration.test.ts'
  assert.deepEqual(select([source, second, added], {
    sources: new Map([...sources, [added, 'export {}']]),
  }).files, [added, first, second].sort())
  assert.deepEqual(select([], { sources: new Map([...sources, [added, 'export {}']]) }).files, [added])
})

test('unrecorded changed sources use static reachability alongside coverage matches', () => {
  const added = 'apps/api/src/added.ts'
  const graph = new Map([...sources, [added, 'export const value = 3'],
    [bootstrap, "import './added.js'; import './feature.js'; import './other.js'"]])
  assert.deepEqual(select([added], { sources: graph }).files, [first, second])
  assert.match(select([added], { sources: graph }).reason, /static/i)
})

test('tests that execute child processes retain static reachability', () => {
  assert.deepEqual(select([source], { coverageMap: { ...coverageMap, staticTests: [second] } }).files,
    [first, second])
})

test('a partial map keeps coverage matches and applies missing-record fallback per test file', () => {
  const third = 'apps/api/test/third.integration.test.ts'
  const unrelated = 'apps/api/test/unreached.integration.test.ts'
  const graph = new Map([...sources, [third, "import '../src/app.js'"], [unrelated, 'export {}']])
  const partial = { ...coverageMap, testFiles: [first, second, third, unrelated],
    coverage: { [first]: [source], [third]: [other] } }
  const result = select([source], { sources: graph, coverageMap: partial })
  assert.deepEqual(result.files, [first, second])
  assert.deepEqual(result.staticFallbackFiles, [second])
  assert.match(result.reason, /missing coverage records/i)
})

test('static fallback follows fixture URLs, filesystem literals and forked source files', () => {
  for (const [input, body] of [
    ['apps/api/test/fixtures/round.json', "readFile(new URL('./fixtures/round.json', import.meta.url), 'utf8')"],
    ['apps/api/test/fixtures/process.ts', "fork(fileURLToPath(new URL('./fixtures/process.ts', import.meta.url)))"],
    ['apps/api/test/fixtures/input.txt', "readFile('test/fixtures/input.txt', 'utf8')"],
  ]) {
    const graph = new Map([...sources, [input, '{}'], [second, body]])
    assert.deepEqual(select([input], { sources: graph }).files, [second])
  }
})

test('unresolved repository runtime inputs require full integration scope', () => {
  const input = 'apps/api/test/fixtures/generated.bin'
  const graph = new Map([...sources, [input, ''], [second, 'readFile(computedFixturePath)']])
  const result = select([input], { sources: graph })
  assert.equal(result.scope, 'full')
  assert.match(result.reason, /runtime input/i)
})

test('Worker bundle inputs require full integration scope despite unrelated incoming dependencies', () => {
  for (const input of ['apps/worker/src/runtime.mjs', 'apps/worker/artifacts/job-quota-query.c',
    'apps/api/src/modules/harnesses/compatibility/schemaWorker.ts', 'packages/contracts/src/productEnvironment.mjs',
    'scripts/build-worker-artifact.mjs', 'scripts/graphql-mcp.mjs', 'apps/web/public/graphql.svg']) {
    const graph = new Map([...sources, [input, 'export {}'],
      ['apps/worker/src/consumer.mjs', `import '${input}'`],
      [second, 'execFile(process.execPath, [computedBuilderPath])']])
    // A literal URL gives the input an incoming edge without connecting it to the bundle test.
    graph.set('scripts/consumer.mjs', `new URL('../${input}', import.meta.url)`)
    const result = select([input], { sources: graph })
    assert.equal(result.scope, 'full', input)
    assert.match(result.reason, /worker.*bundle/i, input)
  }
})

test('Worker entrypoint dependencies require full scope while unrelated API changes retain coverage selection', () => {
  const input = 'apps/api/src/bundled.ts'
  const graph = new Map([...sources, [input, 'export {}'],
    ['apps/worker/src/workerFactory.mjs', "import '../../api/src/bundled.js'"],
    [second, 'execFile(process.execPath, [computedBuilderPath])']])
  assert.equal(select([input], { sources: graph }).scope, 'full')
  assert.deepEqual(select([source], { sources: graph }).files, [first])
})

test('missing, malformed and incomplete maps retain static selection with a reason', () => {
  for (const map of [undefined, {}, { ...coverageMap, coverage: {} }, { ...coverageMap, coverage: { [first]: [source] } },
    { ...coverageMap, coverage: { [first]: ['/private/source.ts'], [second]: [other] } }]) {
    const result = select([source], { coverageMap: map })
    assert.deepEqual(result.files, [first, second])
    assert.match(result.reason, /static/i)
  }
})

test('coverage cannot narrow shared infrastructure changes or change other suites', () => {
  for (const file of ['pnpm-lock.yaml', 'scripts/ci-suite.sh', 'apps/api/test/helpers/shared.ts']) {
    assert.equal(select([file]).scope, 'full')
  }
  const unit = 'apps/api/src/feature.test.ts'
  assert.deepEqual(select([source], { suite: 'unit',
    sources: new Map([...sources, [unit, "import './app.js'"]]) }).files, [unit])
})

test('CI orchestration changes require full scope even when recorded coverage omits CI integration consumers', () => {
  const service = 'apps/api/src/modules/ci-host/service.ts'
  const helper = 'apps/api/test/admission.ts'
  const queue = 'apps/api/test/host-ci-queue-priority.integration.test.ts'
  const cloud = 'apps/api/test/host-ci-cloud-integration.integration.test.ts'
  const graph = new Map([...sources, [service, 'export class HostCiService {}'],
    [helper, "import '../src/modules/ci-host/service.js'"],
    [queue, "import './admission.js'"], [cloud, "import './admission.js'"]])
  const recorded = { ...coverageMap, testFiles: [first, second, queue, cloud],
    coverage: { ...coverageMap.coverage, [first]: [service], [queue]: [other], [cloud]: [other] } }
  const result = select([service], { sources: graph, coverageMap: recorded })
  assert.equal(result.scope, 'full')
  assert.match(result.reason, /infrastructure/i)
})

test('CI host unit test edits retain affected integration scope', () => {
  const unit = 'apps/api/src/modules/ci-host/service.test.ts'
  const result = select([unit], { sources: new Map([...sources, [unit, 'export {}']]) })
  assert.equal(result.scope, 'affected')
  assert.deepEqual(result.files, [])
})

test('coverage recording and map validation changes require full integration scope', () => {
  for (const file of ['scripts/integration-coverage.mjs', 'packages/contracts/src/ciCoverage.mjs',
    'packages/contracts/src/ciImportGraph.mjs', 'apps/api/test/setupCoverage.ts']) {
    const result = select([file], { sources: new Map([...sources, [file, 'export {}']]) })
    assert.equal(result.scope, 'full', file)
    assert.match(result.reason, /infrastructure/i)
  }
})

function repository(t) {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  mkdirSync(cache, { recursive: true })
  const root = mkdtempSync(join(cache, 'coverage-selection-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim()
  git('init', '-q', '-b', 'main')
  const put = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  for (const [file, text] of sources) put(file, text)
  const commit = message => { git('add', '.'); git('commit', '-qm', message); return git('rev-parse', 'HEAD') }
  const base = commit('initial')
  return { root, git, put, commit, base }
}

test('snapshot uses the newest ancestor map and includes intervening changes', t => {
  const f = repository(t)
  const oldMap = { ...coverageMap, commit: f.base }
  f.put(source, 'export const feature = () => 3')
  const middle = f.commit('feature change')
  const recent = { ...coverageMap, commit: middle }
  f.put(other, 'export const other = () => 4')
  const head = f.commit('other change')
  const result = affectedSnapshot(head, 'integration', f.root, 'main', middle, [oldMap, recent])
  assert.deepEqual(result.files, [second])
  assert.ok(result.reason.includes(middle))
  const drift = affectedSnapshot(head, 'integration', f.root, 'main', middle, [oldMap])
  assert.deepEqual(drift.files, [first, second])
})

test('snapshot retains Git changes when prepared coverage falls back without a map', t => {
  const f = repository(t)
  f.put(source, 'export const feature = () => 3')
  const head = f.commit('feature change')
  const result = affectedSnapshot(head, 'integration', f.root, 'main', f.base, [], {
    changedFiles: [], coverageReason: 'No integration coverage artifacts are available.',
  })
  assert.equal(result.scope, 'affected')
  assert.deepEqual(result.files, [first, second])
})

test('snapshot combines Git changes with the changes supplied by a coverage map', t => {
  const f = repository(t)
  f.put(source, 'export const feature = () => 3')
  const head = f.commit('feature change')
  const result = affectedSnapshot(head, 'integration', f.root, 'main', f.base, [], {
    changedFiles: [other], coverageMap: { ...coverageMap, commit: f.base },
  })
  assert.equal(result.scope, 'affected')
  assert.deepEqual(result.files, [first, second])
})

test('prepared coverage fallback cannot erase an infrastructure change from Git', t => {
  const f = repository(t)
  f.put('pnpm-lock.yaml', 'changed')
  const head = f.commit('dependency change')
  const result = affectedSnapshot(head, 'integration', f.root, 'main', f.base, [], {
    changedFiles: [], coverageReason: 'No integration coverage artifacts are available.',
  })
  assert.equal(result.scope, 'full')
  assert.match(result.reason, /infrastructure/i)
})

test('snapshot rejects non-ancestors and maps predating lockfile or CI infrastructure changes', t => {
  const f = repository(t)
  const map = { ...coverageMap, commit: f.base }
  f.git('checkout', '-qb', 'side')
  f.put('README.md', 'side')
  const side = f.commit('side')
  f.git('checkout', '-q', 'main')
  f.put('pnpm-lock.yaml', 'changed')
  const middle = f.commit('dependencies')
  f.put(source, 'export const feature = () => 4')
  const head = f.commit('feature')
  for (const candidate of [map, { ...map, commit: side }]) {
    const result = affectedSnapshot(head, 'integration', f.root, 'main', middle, [candidate])
    assert.equal(result.scope, 'affected')
    assert.deepEqual(result.files, [first, second])
    assert.match(result.reason, /static/i)
  }
})

test('cheap V8 collection records executed repository files with portable paths', async t => {
  const { startFileCoverage } = await import('./integration-coverage.mjs')
  const f = repository(t)
  const file = join(f.root, 'executed.mjs')
  writeFileSync(file, 'export function value() { return 42 }')
  const stop = await startFileCoverage()
  const loaded = await import(file)
  assert.equal(loaded.value(), 42)
  const files = await stop(f.root, new Set(['executed.mjs']))
  assert.deepEqual(files, ['executed.mjs'])
})

test('V8 collection identifies child process work that needs static selection', async () => {
  const { startFileCoverage } = await import('./integration-coverage.mjs')
  const stop = await startFileCoverage()
  execFileSync(process.execPath, ['-e', 'process.exit(0)'])
  await stop(process.cwd(), new Set())
  assert.equal(stop.requiresStatic, true)
})

test('missing worker reports retain static fallback while absent partitions remain incomplete', async t => {
  const { integrationCoverageReport } = await import('./integration-coverage.mjs')
  const { completeIntegrationCoverage } = await import('../packages/contracts/src/ciCoverage.mjs')
  const f = repository(t)
  const third = 'apps/api/test/third.integration.test.ts'
  writeFileSync(join(f.root, 'feature.integration.test.ts.json'), JSON.stringify({ files: [source], requiresStatic: false }))
  const report = integrationCoverageReport(f.root, f.base, [first, second, third], [first, second])
  assert.deepEqual(report.coverage, { [first]: [source], [second]: [] })
  assert.deepEqual(report.staticTests, [second])
  assert.equal(completeIntegrationCoverage(report), false)
})
