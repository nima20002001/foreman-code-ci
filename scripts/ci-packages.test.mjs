import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { nativeProviderFixture } from './fixtures/native-provider.mjs'

const script = fileURLToPath(new URL('./ci-packages.mjs', import.meta.url))
const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
const { parse } = require('yaml')
const projects = ['apps/api', 'apps/web', 'apps/worker', 'packages/contracts']

function fixture(t) {
  const base = join(homedir(), '.cache', 'foreman-tmp')
  mkdirSync(base, { recursive: true })
  const root = mkdtempSync(join(base, 'ci-packages-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  mkdirSync(join(root, '.logs'))
  writeFileSync(join(root, 'package.json'), '{"packageManager":"pnpm@11.27.0"}')
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 2880\n')
  writeFileSync(join(root, '.npmrc'), 'auto-install-peers=false\n')
  for (const project of projects) {
    mkdirSync(join(root, project), { recursive: true })
    writeFileSync(join(root, project, 'package.json'), '{}')
  }
  const calls = join(root, 'calls.jsonl')
  writeFileSync(calls, '')
  writeFileSync(join(bin, 'corepack'), '#!/bin/sh\n[ "$1" = pnpm ] || exit 2\nshift\nexec pnpm "$@"\n',
    { mode: 0o755 })
  writeFileSync(join(bin, 'pnpm'), `#!${process.execPath}
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.CALLS_FILE, JSON.stringify(args) + '\\n')
if (args.includes('--offline') && process.env.FAIL_OFFLINE === 'true') process.exit(9)
mkdirSync('node_modules/.pnpm', { recursive: true })
writeFileSync('node_modules/.modules.yaml', 'installed')
for (const project of ${JSON.stringify(projects)}) mkdirSync(project + '/node_modules', { recursive: true })
`, { mode: 0o755 })
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, CALLS_FILE: calls,
    CI_PNPM_STORE_CACHE_HIT: '', FAIL_OFFLINE: '' }
  const run = (extra = {}) => spawnSync(process.execPath, [script, 'install', root],
    { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' })
  const key = () => spawnSync(process.execPath, [script, 'key', root], { env, encoding: 'utf8' })
  const commands = () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  const clear = () => writeFileSync(calls, '')
  return { root, env, run, key, commands, clear }
}

for (const provider of ['github', 'circleci']) {
  test(`${provider} skips installation on a complete packages cache hit`, t => {
    const f = fixture(t)
    const configPath = provider === 'github' ? '../.github/workflows/ci.yml' : '../.circleci/config.yml'
    const config = parse(readFileSync(new URL(configPath, import.meta.url), 'utf8'))
    const step = config.jobs.ci.steps.find(value => value.name === 'Install from cached store'
      || value.run?.name === 'Install from cached store'
      || typeof value.run === 'string' && value.run.includes('pnpm install'))
    const configuredCommand = typeof step.run === 'string' ? step.run : step.run.command
    const command = configuredCommand.replace('node scripts/ci-packages.mjs', `node "${script}"`)
    const render = value => value.replace(/\$\{\{ steps\.(packages|store)\.outputs\.cache-hit \}\}/g, 'true')
    const extra = Object.fromEntries(Object.entries(step.env ?? {}).map(([name, value]) => [name, render(value)]))
    // Prime installed state through the same public command, then simulate restoring it on another part.
    const execute = () => spawnSync('bash', ['-ec', render(command)], {
      cwd: f.root, env: { ...f.env, ...extra, HOME: f.root }, encoding: 'utf8',
    })
    const first = execute()
    assert.equal(first.status, 0, first.stdout + first.stderr)
    f.clear()
    const second = execute()
    assert.equal(second.status, 0, second.stdout + second.stderr)
    assert.deepEqual(f.commands(), [])
  })
}

test('packages installation falls back online on a cold cache and skips unchanged installed state', t => {
  const f = fixture(t)
  const first = f.run({ FAIL_OFFLINE: 'true' })
  assert.equal(first.status, 0, first.stdout + first.stderr)
  assert.equal(f.commands().length, 2)
  assert.equal(f.commands()[0].includes('--offline'), true)
  assert.equal(f.commands()[1].includes('--offline'), false)
  f.clear()
  const second = f.run()
  assert.equal(second.status, 0, second.stdout + second.stderr)
  assert.deepEqual(f.commands(), [])
})

test('a restored store installation failure stays a failure instead of using the network', t => {
  const f = fixture(t)
  const result = f.run({ FAIL_OFFLINE: 'true', CI_PNPM_STORE_CACHE_HIT: 'true' })
  assert.equal(result.status, 9)
  assert.equal(f.commands().length, 1)
})

for (const input of ['package.json', 'apps/api/package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']) {
  test(`packages cache invalidates when ${input} changes`, t => {
    const f = fixture(t)
    const first = f.run()
    assert.equal(first.status, 0, first.stderr)
    const before = f.key()
    assert.equal(before.status, 0, before.stderr)
    writeFileSync(join(f.root, input), readFileSync(join(f.root, input), 'utf8') + '\n')
    const after = f.key()
    assert.equal(after.status, 0, after.stderr)
    assert.notEqual(before.stdout, after.stdout)
    f.clear()
    assert.equal(f.run().status, 0)
    assert.equal(f.commands().length, 1)
  })
}

test('an incomplete packages restore is repaired rather than treated as an installation hit', t => {
  const f = fixture(t)
  assert.equal(f.run().status, 0)
  rmSync(join(f.root, 'apps/web/node_modules'), { recursive: true })
  f.clear()
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(f.commands().length, 1)
})

test('publishes the prefetched store and publication cache locations on install and cache reuse', t => {
  const f = fixture(t)
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = f.run()
    assert.equal(result.status, 0, result.stderr)
    const paths = JSON.parse(readFileSync(join(f.root, '.logs/ci-package-paths.json'), 'utf8'))
    assert.deepEqual(paths, { storeDir: join(f.root, 'node_modules/.pnpm-store'),
      cacheDir: join(f.root, '.logs/pnpm-metadata') })
  }
})

for (const restored of [false, true]) {
  test(`rejects a missing required native payload after pnpm succeeds (restored: ${restored})`, t => {
    const f = fixture(t)
    const provider = nativeProviderFixture(f.root)
    if (restored) assert.equal(f.run().status, 0)
    rmSync(provider.payload)
    const result = f.run()
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stderr, /CI_NATIVE_PAYLOAD_UNAVAILABLE/)
    assert.ok(result.stderr.includes(provider.name), result.stderr)
    assert.equal(existsSync(join(f.root, 'node_modules/.ci-packages-key')), false)
    assert.equal(existsSync(join(f.root, '.logs/ci-packages-restored')), false)
  })
}
