import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { affectedSnapshot, selectAffectedFiles } from './ci-affected.mjs'
import { affectedCommands } from './ci-affected-run.mjs'
import { selectByIndexes } from './ci-files.mjs'
import { snapshot } from './ci-remote.mjs'

const inheritedProgressFile = process.env.CI_PROGRESS_FILE
before(() => { process.env.CI_PROGRESS_FILE = '' })
after(() => {
  if (inheritedProgressFile === undefined) delete process.env.CI_PROGRESS_FILE
  else process.env.CI_PROGRESS_FILE = inheritedProgressFile
})

function affectedEnvironment(source = process.env) {
  return { ...source, CI_PROGRESS_FILE: '' }
}

const source = 'apps/api/src/feature.ts'
const unit = 'apps/api/src/feature.test.ts'
const integration = 'apps/api/test/feature.integration.test.ts'
const sources = new Map([
  [source, 'export const value = 1'],
  ['apps/api/src/bridge.ts', "export { value } from './feature.js'"],
  [unit, "import {\n value\n} from './bridge.js'"],
  [integration, "const feature = await import('../src/bridge.js')"],
  ['apps/api/test/unrelated.integration.test.ts', 'export {}'],
  ['apps/api/test/feature.acceptance.test.ts', "import '../src/feature.js'"],
  ['apps/web/src/other.test.tsx', 'export {}'],
])

test('selects transitive unit and integration dependents in their own suites', () => {
  for (const [suite, expected] of [['unit', unit], ['integration', integration]]) {
    const result = selectAffectedFiles({ suite, changedFiles: [source], sources })
    assert.equal(result.scope, 'affected')
    assert.deepEqual(result.files, [expected])
  }
  assert.deepEqual(selectAffectedFiles({ suite: 'integration', changedFiles: [integration], sources }).files, [integration])
  assert.deepEqual(selectAffectedFiles({ suite: 'unit', changedFiles: ['README.md'], sources }).files, [])
})

test('tracks contracts exports across packages and handles cycles', () => {
  const shared = 'packages/contracts/src/feature.ts'
  const graph = new Map([...sources, [shared, 'export const value = 1'],
    [source, "import { value } from '@foreman-code/contracts/feature'; import './bridge.js'"],
    ['apps/web/src/shared.test.tsx', "import { value } from '@foreman-code/contracts/feature'"]])
  const result = selectAffectedFiles({ suite: 'unit', changedFiles: [shared], sources: graph,
    exports: { './feature': { import: './dist/feature.js' } } })
  assert.deepEqual(result.files, [unit, 'apps/web/src/shared.test.tsx'])
})

test('keeps web integration-named unit tests and asset import dependents', () => {
  const asset = 'apps/web/src/icon.svg'
  const webTest = 'apps/web/src/view.integration.test.tsx'
  const graph = new Map([[asset, ''], ['apps/web/src/view.tsx', "import './icon.svg?raw'"],
    [webTest, "import './view'"]])
  assert.deepEqual(selectAffectedFiles({ suite: 'unit', changedFiles: [asset], sources: graph }).files, [webTest])
})

test('falls back to full for shared infrastructure and removed sources', () => {
  for (const file of ['package.json', 'apps/api/package.json', 'pnpm-lock.yaml',
    'apps/api/src/infrastructure/exampleMigration.ts', 'apps/api/test/helpers/common.ts',
    'scripts/test-integration.mjs', 'scripts/test-integration-process.mjs', 'scripts/test-resources.mjs',
    '.github/workflows/ci.yml', 'packages/contracts/src/index.ts',
    'apps/api/src/deleted.ts']) {
    assert.equal(selectAffectedFiles({ suite: 'integration', changedFiles: [file], sources }).scope, 'full', file)
  }
})

test('lint checks changed files and typecheck checks packages reached by imports', () => {
  const lint = selectAffectedFiles({ suite: 'lint', changedFiles: [source], sources })
  assert.deepEqual(lint.files, [source])
  const typecheck = selectAffectedFiles({ suite: 'typecheck', changedFiles: [source], sources })
  assert.ok(typecheck.files.includes(source))
  assert.deepEqual(affectedCommands('typecheck', typecheck.files), [['corepack', 'pnpm', '--dir', 'apps/api', 'typecheck']])
  assert.deepEqual(affectedCommands('unit', [unit]), [[process.execPath, 'scripts/test-command.mjs', '--',
    'corepack', 'pnpm', '--dir', 'apps/api', 'exec', 'vitest', 'run', 'src/feature.test.ts']])
  assert.deepEqual(affectedCommands('unit', ['apps/web/src/view.test.tsx', 'scripts/tool.test.mjs']), [
    ['env', 'FOREMAN_WEB_TEST_PHASE=fast', 'corepack', 'pnpm', '--dir', 'apps/web', 'exec', 'vitest', 'run', 'src/view.test.tsx'],
    [process.execPath, '--test', 'scripts/tool.test.mjs']])
  assert.deepEqual(selectByIndexes(['a', 'b', 'c'], 's:0,2'), ['a', 'c'])
  assert.throws(() => selectByIndexes(['a', 'b', 'c'], '-1'), /Invalid/)
  const names = Array.from({ length: 100 }, (_, index) => `f${index}`)
  assert.deepEqual(selectByIndexes(names, 'd:0'), ['f0'])
  assert.deepEqual(selectByIndexes(names, 'd:0.2,1,a.1,1'), ['f0', 'f1', 'f2', 'f4', 'f15', 'f16', 'f18'])
  assert.deepEqual(selectByIndexes(names, `d:${(99).toString(36)}`), ['f99'])
  assert.deepEqual(selectByIndexes(names, 'd:'), [])
  for (const bad of ['d:-1', 'd:A', 'd:1.', 'd:.1', 'd:1.2.3', `d:${(100).toString(36)}`, 'd:0.2s', 'd:50,1z']) {
    assert.throws(() => selectByIndexes(names, bad), /Invalid/, bad)
  }
})

test('affected load-sensitive web suites run in the heavy phase with its workers and timeouts', () => {
  assert.deepEqual(affectedCommands('unit', ['apps/web/src/board.integration.test.tsx', 'apps/web/src/view.test.tsx']), [
    ['env', 'FOREMAN_WEB_TEST_PHASE=fast', 'corepack', 'pnpm', '--dir', 'apps/web', 'exec', 'vitest', 'run', 'src/view.test.tsx'],
    ['env', 'FOREMAN_WEB_TEST_PHASE=heavy', 'corepack', 'pnpm', '--dir', 'apps/web', 'exec', 'vitest', 'run',
      'src/board.integration.test.tsx']])
})

test('runs affected commands without leaking dispatch selections into nested commands', t => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'affected-command-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'apps/api/src'), { recursive: true })
  writeFileSync(join(root, source), 'export {}')
  const selection = join(root, 'selected.json')
  writeFileSync(selection, JSON.stringify([source]))
  writeFileSync(join(root, 'corepack'), `#!${process.execPath}\n`
    + "if (['SCOPE', 'SELECTED_FILES', 'SLICE', 'DEFAULT_BRANCH', 'CI_PARTITION', 'CI_DURATIONS'].some(key => key in process.env)) process.exit(9)\n"
    + "console.log(process.argv.slice(2).join(' '))\n", { mode: 0o755 })
  const run = spawnSync(process.execPath, [new URL('./ci-affected-run.mjs', import.meta.url).pathname,
    'lint', '--files-from', selection], { cwd: root, encoding: 'utf8', env: { ...affectedEnvironment(),
    PATH: `${root}:${process.env.PATH}`, SCOPE: 'affected', SELECTED_FILES: 's:0', SLICE: 's:0',
    DEFAULT_BRANCH: 'stable', CI_PARTITION: '{}', CI_DURATIONS: '{}' } })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /pnpm --dir apps\/api exec eslint src\/feature\.ts --max-warnings 0/)
})

for (const progress of ['', 'parent-progress.jsonl']) {
  test(`runs selected web tests independently of the parent progress reporter (${progress || 'disabled'})`, t => {
    const base = join(homedir(), '.cache', 'foreman-tmp')
    mkdirSync(base, { recursive: true })
    const root = mkdtempSync(join(base, 'affected-web-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const file = 'apps/web/src/view.test.tsx'
    mkdirSync(join(root, 'apps/web/src'), { recursive: true })
    writeFileSync(join(root, file), 'export {}')
    writeFileSync(join(root, 'apps/web/heavy-tests.json'), JSON.stringify({ files: ['src/**/*.integration.test.tsx'] }))
    const selection = join(root, 'selected.json')
    writeFileSync(selection, JSON.stringify([file]))
    writeFileSync(join(root, 'corepack'), `#!${process.execPath}\n`
      + "console.log(JSON.stringify(process.argv.slice(2)))\n", { mode: 0o755 })
    const environment = affectedEnvironment({ ...process.env,
      CI_PROGRESS_FILE: progress ? join(root, progress) : '', TEST_RESULTS_OUTPUT: '',
      PATH: `${root}:${process.env.PATH}` })
    const result = spawnSync(process.execPath, [new URL('./ci-affected-run.mjs', import.meta.url).pathname,
      'unit', '--files-from', selection], { cwd: root, encoding: 'utf8', env: environment })
    assert.equal(result.status, 0, result.stderr)
    const calls = result.stdout.trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(calls, [
      ['pnpm', '--filter', '@foreman-code/contracts', 'build'],
      ['pnpm', '--dir', 'apps/web', 'exec', 'vitest', 'run', 'src/view.test.tsx'],
    ])
  })
}

test('selects the snapshot tree against origin/main without reading later working tree edits', t => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'affected-ci-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'feature')
  for (const [file, text] of sources) {
    mkdirSync(join(root, file, '..'), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  git('add', '.')
  git('commit', '-qm', 'base')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  assert.deepEqual(affectedSnapshot('HEAD', 'unit', root), {
    scope: 'full', files: [], reason: 'The commit is the workspace default branch head.',
  })
  git('update-ref', 'refs/remotes/origin/release/stable', 'HEAD')
  writeFileSync(join(root, source), 'export const value = 2')
  const commit = snapshot(root)
  writeFileSync(join(root, unit), 'export {}')
  assert.deepEqual(affectedSnapshot(commit, 'unit', root).files, [unit])
  assert.deepEqual(affectedSnapshot(commit, 'unit', join(root, 'apps/api')).files, [unit])
  assert.deepEqual(affectedSnapshot(commit, 'unit', root, 'origin/release/stable').files, [unit])
  const merge = git('commit-tree', `${commit}^{tree}`, '-p', 'HEAD', '-p', commit, '-m', 'merge')
  assert.equal(affectedSnapshot(merge, 'unit', root).scope, 'full')
  git('update-ref', '-d', 'refs/remotes/origin/main')
  assert.equal(affectedSnapshot(commit, 'unit', root).scope, 'full')
})
