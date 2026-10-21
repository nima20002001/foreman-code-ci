import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { buildProductionSource } from './local-production-runtime.mjs'

const script = fileURLToPath(new URL('./ci-suite.sh', import.meta.url))
const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
const compiler = require.resolve('typescript/bin/tsc')

function fixture(t, suite, project = 'apps/api') {
  const base = join(homedir(), '.cache', 'foreman-tmp')
  mkdirSync(base, { recursive: true })
  const root = mkdtempSync(join(base, 'ci-typecheck-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'checkout')
  const bin = join(root, 'bin')
  mkdirSync(join(source, project), { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(source, project, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, incremental: true, skipLibCheck: true,
      tsBuildInfoFile: 'node_modules/.cache/tsc/typecheck.tsbuildinfo' },
    files: ['value.ts'],
  }))
  writeFileSync(join(source, project, 'value.ts'), 'export const value: number = 1\n')
  writeFileSync(join(bin, 'pnpm'), `#!${process.execPath}
const { spawnSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const args = process.argv.slice(2)
if (args.includes('build')) process.exit(0)
console.log('cache=' + existsSync(join(${JSON.stringify(project)}, 'node_modules/.cache/tsc/typecheck.tsbuildinfo')))
const result = spawnSync(process.execPath, [${JSON.stringify(compiler)}, '-p', ${JSON.stringify(project)}],
  { stdio: 'inherit' })
process.exit(result.status ?? 1)
`, { mode: 0o755 })
  const run = () => spawnSync('bash', [script], { cwd: source, encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, SUITE: suite, SCOPE: 'full',
      SELECTED_FILES: '', CI_HOST_RUNNER: '0', CI_EXPECTED_DURATION_MS: '',
      FOREMAN_CODE_CI_TYPECHECK_CACHE: join(root, 'cache'), FOREMAN_CODE_CI_TYPECHECK_CACHE_ACTIVE: '',
      CI_STATE: join(root, 'state') },
  })
  const replaceDependencies = () => rmSync(join(source, project, 'node_modules'), { recursive: true, force: true })
  return { run, source, project, replaceDependencies }
}

for (const [suite, project] of [
  ['typecheck-api', 'apps/api'],
  ['typecheck-other', 'apps/web'],
  ['typecheck-other', 'packages/contracts'],
  ['typecheck', 'apps/api'],
]) {
  test(`${suite} restores ${project} state after dependency replacement and reports changed-source errors`, t => {
    const f = fixture(t, suite, project)
    const first = f.run()
    assert.equal(first.status, 0, first.stdout + first.stderr)
    assert.match(first.stdout, /cache=false/)
    f.replaceDependencies()
    const second = f.run()
    assert.equal(second.status, 0, second.stdout + second.stderr)
    assert.match(second.stdout, /cache=true/)
    writeFileSync(join(f.source, f.project, 'value.ts'), 'export const value: number = "invalid"\n')
    f.replaceDependencies()
    const changed = f.run()
    assert.notEqual(changed.status, 0)
    assert.match(changed.stdout, /TS2322/)
    f.replaceDependencies()
    const repeated = f.run()
    assert.notEqual(repeated.status, 0)
    assert.match(repeated.stdout, /TS2322/)
    writeFileSync(join(f.source, f.project, 'value.ts'), 'export const value: number = 2\n')
    f.replaceDependencies()
    const fixed = f.run()
    assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr)
  })
}

test('a fresh checkout without cached build info still reports all type errors', t => {
  const f = fixture(t, 'typecheck-api')
  writeFileSync(join(f.source, f.project, 'value.ts'), 'export const value: number = "invalid"\n')
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /cache=false/)
  assert.match(result.stdout, /TS2322/)
})

for (const suite of ['typecheck-api', 'typecheck']) {
  test(`${suite} runs the deploy's API production build check and fails when it fails`, async t => {
    const deployChecks = []
    await buildProductionSource(async (command, args) => {
      if (args.includes('--noEmit')) deployChecks.push(args)
    })
    assert.equal(deployChecks.length, 1)
    const [, ...deployCheck] = deployChecks[0]
    const base = join(homedir(), '.cache', 'foreman-tmp')
    mkdirSync(base, { recursive: true })
    const root = mkdtempSync(join(base, 'ci-build-check-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const bin = join(root, 'bin')
    const calls = join(root, 'calls.jsonl')
    mkdirSync(bin)
    writeFileSync(join(bin, 'pnpm'), `#!${process.execPath}
const args = process.argv.slice(2)
require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n')
process.exit(args.includes('--noEmit') && process.env.FAIL_BUILD_CHECK === '1' ? 2 : 0)
`, { mode: 0o755 })
    const run = fail => {
      rmSync(calls, { force: true })
      const result = spawnSync('bash', [script], { cwd: root, encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, SUITE: suite, SCOPE: 'full',
          SELECTED_FILES: '', CI_HOST_RUNNER: '0', CI_EXPECTED_DURATION_MS: '', FAIL_BUILD_CHECK: fail ? '1' : '0',
          FOREMAN_CODE_CI_TYPECHECK_CACHE: join(root, 'cache'), FOREMAN_CODE_CI_TYPECHECK_CACHE_ACTIVE: '',
          CI_STATE: join(root, 'state') },
      })
      return { result, calls: readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)) }
    }
    const passed = run(false)
    assert.equal(passed.result.status, 0, passed.result.stdout + passed.result.stderr)
    assert.deepEqual(passed.calls.at(-1), deployCheck)
    const failed = run(true)
    assert.notEqual(failed.result.status, 0)
    assert.deepEqual(failed.calls.at(-1), deployCheck)
  })
}
