import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = fileURLToPath(new URL('./ci-contracts.mjs', import.meta.url))

function fixture(t) {
  const base = process.env.TMPDIR ?? join(homedir(), '.cache/foreman-code/tests')
  mkdirSync(base, { recursive: true })
  const directory = mkdtempSync(join(base, 'contracts-cache-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = join(directory, 'source')
  const cache = join(directory, 'cache')
  mkdirSync(join(root, 'packages/contracts/src'), { recursive: true })
  mkdirSync(join(root, 'apps/api'), { recursive: true })
  writeFileSync(join(root, 'packages/contracts/src/index.ts'), 'export const value = 1')
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'dependencies-one')
  writeFileSync(join(root, '.gitignore'), 'packages/contracts/dist/\n')
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Test Author', GIT_COMMITTER_NAME: 'Test Author',
    GIT_AUTHOR_EMAIL: 'author@example.test', GIT_COMMITTER_EMAIL: 'author@example.test' }
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  git('init', '-q', '-b', 'main')
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture inputs') }
  commit()
  const compiler = join(directory, 'compiler.cjs')
  const count = join(directory, 'compilations')
  writeFileSync(compiler, `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(count)}, 'build\\n');
fs.mkdirSync('packages/contracts/dist', { recursive: true });
fs.writeFileSync('packages/contracts/dist/index.js', fs.readFileSync('packages/contracts/src/index.ts'));
process.exit(Number(process.env.COMPILER_EXIT || 0));
`)
  const build = (compilerExit = 0) => spawnSync(process.execPath,
    [script, 'build', root, cache, '--', process.execPath, compiler],
    { cwd: root, env: { ...env, COMPILER_EXIT: String(compilerExit) }, encoding: 'utf8' })
  const builds = () => readFileSync(count, 'utf8').trim().split('\n').length
  const other = join(directory, 'other')
  git('worktree', 'add', '-q', '--detach', other)
  const buildAsync = source => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, 'build', source, cache, '--', process.execPath, compiler],
      { cwd: source, env: { ...env, COMPILER_EXIT: '0' } })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    child.once('error', reject)
    child.once('exit', status => resolve({ status, output }))
  })
  const ready = () => spawnSync(process.execPath, [script, 'ready', root], { cwd: root, env, encoding: 'utf8' })
  return { root, other, build, buildAsync, builds, commit, ready }
}

test('restores contracts for unchanged inputs and rebuilds for contracts or dependency changes', t => {
  const f = fixture(t)
  assert.equal(f.build().status, 0)
  rmSync(join(f.root, 'packages/contracts/dist'), { recursive: true })
  writeFileSync(join(f.root, 'apps/api/feature.ts'), 'application change')
  f.commit()
  assert.equal(f.build().status, 0)
  assert.equal(f.builds(), 1)
  assert.equal(readFileSync(join(f.root, 'packages/contracts/dist/index.js'), 'utf8'), 'export const value = 1')
  rmSync(join(f.root, 'packages/contracts/dist'), { recursive: true })
  writeFileSync(join(f.root, 'packages/contracts/src/index.ts'), 'export const value = 2')
  f.commit()
  assert.equal(f.build().status, 0)
  assert.equal(f.builds(), 2)
  writeFileSync(join(f.root, 'pnpm-lock.yaml'), 'dependencies-two')
  f.commit()
  assert.equal(f.build().status, 0)
  assert.equal(f.builds(), 3)
})

test('never reuses output from a failed contracts compiler', t => {
  const f = fixture(t)
  assert.equal(f.build(9).status, 9)
  assert.equal(f.build().status, 0)
  assert.equal(f.builds(), 2)
})

test('concurrent worktrees compile once and restore independent contracts outputs', async t => {
  const f = fixture(t)
  const results = await Promise.all([f.buildAsync(f.root), f.buildAsync(f.other)])
  for (const result of results) assert.equal(result.status, 0, result.output)
  assert.equal(f.builds(), 1)
  writeFileSync(join(f.root, 'packages/contracts/dist/index.js'), 'changed by a job')
  assert.equal(readFileSync(join(f.other, 'packages/contracts/dist/index.js'), 'utf8'), 'export const value = 1')
  rmSync(join(f.root, 'packages/contracts/dist'), { recursive: true })
  assert.equal(f.build().status, 0)
  assert.equal(readFileSync(join(f.root, 'packages/contracts/dist/index.js'), 'utf8'), 'export const value = 1')
  assert.equal(f.builds(), 1)
})

test('contracts readiness accepts matching output and rejects missing or changed inputs', t => {
  const f = fixture(t)
  assert.equal(f.ready().status, 1)
  assert.equal(f.build().status, 0)
  assert.equal(f.ready().status, 0)
  rmSync(join(f.root, 'packages/contracts/dist/index.js'))
  assert.equal(f.ready().status, 1)
  assert.equal(f.build().status, 0)
  writeFileSync(join(f.root, 'packages/contracts/src/index.ts'), 'export const value = 3')
  f.commit()
  assert.equal(f.ready().status, 1)
  assert.equal(f.build().status, 0)
  assert.equal(f.ready().status, 0)
})
