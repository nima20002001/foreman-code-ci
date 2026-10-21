import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

function fixture(t) {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, 'build-cache-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'scripts'))
  for (const name of ['heavy-job.mjs', 'heavy-job-slots.mjs', 'sleep.mjs']) {
    copyFileSync(new URL(name, import.meta.url), join(root, 'scripts', name))
  }
  mkdirSync(join(root, 'packages/contracts/src'), { recursive: true })
  copyFileSync(new URL('../packages/contracts/src/productEnvironment.mjs', import.meta.url),
    join(root, 'packages/contracts/src/productEnvironment.mjs'))
  mkdirSync(join(root, 'packages/contracts/node_modules/typescript'), { recursive: true })
  writeFileSync(join(root, 'packages/contracts/node_modules/typescript/index.js'), 'module.exports = {}')
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n.logs/\ndist/\n')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('GIT_') && !/^(?:GRAPHQL|FOREMAN_CODE)_HEAVY_/.test(key)))
  Object.assign(env, { FOREMAN_CODE_HEAVY_BASE_TMPDIR: parent, GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1', FOREMAN_CODE_VERIFICATION_ROOT: '' })
  delete env.CI_HOST_RUNNER
  delete env.FOREMAN_CODE_CI_CONTRACTS_CACHE
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root, env }).status, 0)
  assert.equal(spawnSync('git', ['add', '.'], { cwd: root, env }).status, 0)
  const build = () => spawnSync(process.execPath, ['scripts/heavy-job.mjs', '--build', 'contracts', '--',
    process.execPath, '-e', 'require("node:fs").mkdirSync("packages/contracts/dist",{recursive:true});require("node:fs").writeFileSync("packages/contracts/dist/index.js","built")'],
  { cwd: root, env, encoding: 'utf8', timeout: 15000 })
  return { root, build }
}

test('corrupt build metadata warns and retains rebuild status in the command log', t => {
  const f = fixture(t)
  const first = f.build()
  assert.equal(first.status, 0, first.stderr)
  writeFileSync(join(f.root, '.logs/heavy-build-contracts.json'), '{')
  const second = f.build()
  assert.equal(second.status, 0, second.stderr)
  const lines = (second.stdout + second.stderr).split('\n')
  const warning = lines.find(line => line.includes('Build cache unavailable'))
  assert.ok(warning, second.stdout + second.stderr)
  assert.match(warning, /lastError/)
  assert.match(warning, /rebuildCount/)
  const status = JSON.parse(readFileSync(join(f.root, '.logs/heavy-cache-contracts.json'), 'utf8'))
  assert.equal(status.status, 'invalid')
  assert.equal(status.lastError, 'Build cache metadata is invalid.')
  assert.equal(status.missCount, 2)
  assert.equal(status.rebuildCount, 2)
})
