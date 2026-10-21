import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { executionFiles, executionSelection } from './ci-selection.mjs'

function repository(t) {
  const cwd = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ci-selection-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const environment = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.org', GIT_COMMITTER_EMAIL: 'fixture@example.org' }
  const git = (...args) => execFileSync('git', args, { cwd, env: environment, encoding: 'utf8' }).trim()
  const write = (file, text) => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true })
    writeFileSync(join(cwd, file), text)
  }
  const files = {
    'apps/api/src/value.ts': 'export const value = 1',
    'apps/api/src/value.test.ts': "import './value.js'",
    'apps/api/test/value.integration.test.ts': "import '../src/value.js'",
    'apps/api/test/other.integration.test.ts': 'export {}',
    'apps/web/src/value.test.tsx': "import '../../api/src/value.js'",
    'apps/web/src/value.integration.test.tsx': "import '../../api/src/value.js'",
    'apps/web/heavy-tests.json': JSON.stringify({ files: ['src/*.integration.test.tsx'] }),
    'packages/contracts/src/other.test.ts': 'export {}',
  }
  for (const [file, text] of Object.entries(files)) write(file, text)
  git('init', '-q', '-b', 'stable')
  git('add', '.')
  git('commit', '-qm', 'base')
  git('update-ref', 'refs/remotes/origin/stable', 'HEAD')
  return { cwd, git, write, files: Object.keys(files) }
}

test('filters the same affected selection into API, fast web, heavy web and other parts', t => {
  const f = repository(t)
  assert.deepEqual(executionFiles(f.files, 'unit-api', f.cwd), f.files.filter(file => file.startsWith('apps/api/')))
  assert.deepEqual(executionFiles(f.files, 'unit-web', f.cwd),
    ['apps/web/src/value.test.tsx', 'apps/web/heavy-tests.json'])
  assert.deepEqual(executionFiles(f.files, 'unit-web-heavy', f.cwd), ['apps/web/src/value.integration.test.tsx'])
  assert.deepEqual(executionFiles(f.files, 'unit-other', f.cwd), ['packages/contracts/src/other.test.ts'])
})

test('an explicit base selects release changes even at the default branch head and without a default ref', t => {
  const f = repository(t)
  const baseCommit = f.git('rev-parse', 'HEAD')
  f.write('apps/api/src/value.ts', 'export const value = 2')
  f.git('add', '.')
  f.git('commit', '-qm', 'release changes')
  f.git('update-ref', 'refs/remotes/origin/stable', 'HEAD')
  for (const defaultRef of ['origin/stable', 'origin/unavailable']) {
    assert.deepEqual(executionSelection({ commit: 'HEAD', baseCommit, executionSuite: 'unit-api', defaultRef,
      cwd: f.cwd }).files, ['apps/api/src/value.test.ts'])
    const slices = [0, 1].map(index => executionSelection({ commit: 'HEAD', baseCommit,
      executionSuite: 'integration', defaultRef, partition: { index, count: 2 }, cwd: f.cwd }))
    assert.ok(slices.every(slice => slice.scope === 'affected'))
    assert.deepEqual(slices.flatMap(slice => slice.files), ['apps/api/test/value.integration.test.ts'])
  }
  const empty = executionSelection({ commit: 'HEAD', baseCommit: f.git('rev-parse', 'HEAD'),
    executionSuite: 'unit-api', cwd: f.cwd })
  assert.equal(empty.scope, 'affected')
  assert.deepEqual(empty.files, [])
})

test('unavailable and non-ancestor bases fall back to full with a reason and retain integration partition coverage', t => {
  const f = repository(t)
  const commit = f.git('rev-parse', 'HEAD')
  f.git('commit', '--allow-empty', '-qm', 'later commit')
  const laterCommit = f.git('rev-parse', 'HEAD')
  for (const baseCommit of ['f'.repeat(40), laterCommit]) {
    const selections = [0, 1].map(index => executionSelection({ commit, baseCommit, executionSuite: 'integration',
      partition: { index, count: 2 }, cwd: f.cwd }))
    assert.ok(selections.every(selection => selection.scope === 'full'
      && selection.reason === 'baseCommit is unavailable or is not an ancestor of the resolved commit.'))
    assert.deepEqual(selections.flatMap(selection => selection.files).sort(),
      ['apps/api/test/other.integration.test.ts', 'apps/api/test/value.integration.test.ts'])
  }
})

test('selects and partitions affected tests against a non-main default branch, including empty shards', t => {
  const f = repository(t)
  f.write('apps/api/src/value.ts', 'export const value = 2')
  f.git('add', '.')
  f.git('commit', '-qm', 'feature')
  for (const executionSuite of ['unit-api', 'integration']) {
    const slices = [0, 1].map(index => executionSelection({ commit: 'HEAD', executionSuite,
      defaultRef: 'origin/stable', partition: { index, count: 2 }, cwd: f.cwd }))
    assert.ok(slices.every(slice => slice.scope === 'affected'))
    assert.deepEqual(slices.map(slice => slice.files.length), [1, 0])
    assert.deepEqual(slices.flatMap(slice => slice.files), [executionSuite === 'unit-api'
      ? 'apps/api/src/value.test.ts' : 'apps/api/test/value.integration.test.ts'])
  }
})

test('full fallback partitions cover every integration test when the commit is the default head', t => {
  const f = repository(t)
  const selections = [0, 1].map(index => executionSelection({ commit: 'HEAD', executionSuite: 'integration',
    defaultRef: 'origin/stable', partition: { index, count: 2 }, cwd: f.cwd }))
  assert.ok(selections.every(selection => selection.scope === 'full' && /default branch head/.test(selection.reason)))
  assert.deepEqual(selections.flatMap(selection => selection.files).sort(),
    ['apps/api/test/other.integration.test.ts', 'apps/api/test/value.integration.test.ts'])
})

test('shared infrastructure falls back to full and unrelated documentation produces an empty selection', t => {
  const f = repository(t)
  f.write('README.md', 'documentation')
  f.git('add', '.')
  f.git('commit', '-qm', 'documentation')
  assert.deepEqual(executionSelection({ commit: 'HEAD', executionSuite: 'unit-api', defaultRef: 'origin/stable', cwd: f.cwd }).files, [])
  f.write('package.json', '{}')
  f.git('add', '.')
  f.git('commit', '-qm', 'infrastructure')
  assert.equal(executionSelection({ commit: 'HEAD', executionSuite: 'unit-api', defaultRef: 'origin/stable', cwd: f.cwd }).scope, 'full')
})
