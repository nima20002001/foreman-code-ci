import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { withProductionSourceSnapshot } from './local-production-runtime.mjs'
import { publishWorkerArtifactsToGitHub } from './worker-release-artifacts.mjs'
import { apiIdentityMatches } from './dev-identity.mjs'
import { runningApiAcceptsBrowserOrigin } from './dev.mjs'
import { parity } from './acceptance/parity.mjs'
import { hasHeavyJobAdmission, isRegularIntegrationFile } from './test-integration.mjs'

async function fixture(t) {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'startup-observation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('does not erase an existing source tree after a broken repository probe', async t => {
  const root = await fixture(t)
  const repository = join(root, 'repository')
  await mkdir(repository)
  const git = args => execFileSync('git', args, { cwd: repository, stdio: 'pipe' })
  git(['init', '--quiet'])
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'])
  git(['remote', 'add', 'origin', 'https://github.com/example/project.git'])
  const directory = join(root, 'build')
  const source = join(directory, 'source')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, '.git'), 'gitdir: missing-directory\n')
  await writeFile(join(source, 'retained'), 'retained')
  await assert.rejects(withProductionSourceSnapshot(repository, directory, async () => undefined))
  assert.equal(await readFile(join(source, 'retained'), 'utf8'), 'retained')
})

for (const status of [401, 403]) {
  test(`does not create a release or retry an HTTP ${status} authentication failure`, async t => {
    const root = await fixture(t)
    const failure = Object.assign(new Error(`HTTP ${status}: authentication required`), { code: 1 })
    const calls = []
    const waits = []
    const run = async (binary, args) => {
      calls.push([binary, ...args])
      if (binary === 'gh' && args[0] === 'api') throw failure
      throw new Error(`Unexpected publication command: ${binary} ${args.join(' ')}`)
    }
    await assert.rejects(publishWorkerArtifactsToGitHub({ directory: root, name: 'example/project',
      commit: 'a'.repeat(40), artifacts: [], run, sleep: async ms => waits.push(ms) }), error => error === failure)
    assert.deepEqual(calls, [['gh', 'api', `repos/example/project/releases/tags/worker-${'a'.repeat(40)}`]])
    assert.deepEqual(waits, [])
  })
}

test('fails with a named prerequisite error when tracked startup status is missing', async t => {
  const root = await fixture(t)
  await writeFile(join(root, 'corepack'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const result = spawnSync('bash', ['scripts/ci-suite.sh'], { encoding: 'utf8',
    env: { ...process.env, PATH: `${root}:${process.env.PATH}`, CI_STATE: join(root, 'missing'),
      SUITE: 'unit', CI_HOST_RUNNER: '1', CI_WATCHDOG_ACTIVE: '1', FOREMAN_CODE_CI_TYPECHECK_CACHE: '' } })
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /db.*(missing|unavailable)|prerequisite.*db/i)
})

test('records synchronous prerequisite readiness for the following suite command', async t => {
  const root = await fixture(t)
  for (const command of ['corepack', 'codex', 'claude']) {
    await writeFile(join(root, command), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  }
  const state = join(root, 'state')
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, CI_STATE: state,
    SUITE: 'unit', CI_HOST_RUNNER: '1', CI_WATCHDOG_ACTIVE: '1', FOREMAN_CODE_CI_TYPECHECK_CACHE: '' }
  const prepare = spawnSync('bash', ['scripts/ci-suite.sh', 'prepare'], { encoding: 'utf8', env })
  assert.equal(prepare.status, 0, prepare.stderr)
  assert.equal((await readFile(join(state, 'db.exit'), 'utf8')).trim(), '0')
  assert.equal((await readFile(join(state, 'clis.exit'), 'utf8')).trim(), '0')
  const suite = spawnSync('bash', ['scripts/ci-suite.sh'], { encoding: 'utf8', env })
  assert.equal(suite.status, 0, suite.stderr)
})

test('rejects a corrupt scheduler slot count instead of silently reducing capacity', async t => {
  const root = await fixture(t)
  await mkdir(join(root, 'scripts'))
  await mkdir(join(root, 'packages', 'contracts', 'src'), { recursive: true })
  for (const name of ['heavy-job.mjs', 'heavy-job-slots.mjs', 'sleep.mjs']) {
    await copyFile(new URL(name, import.meta.url), join(root, 'scripts', name))
  }
  await copyFile(new URL('../packages/contracts/src/productEnvironment.mjs', import.meta.url),
    join(root, 'packages', 'contracts', 'src', 'productEnvironment.mjs'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  const state = join(root, '.git', 'graphql-heavy-jobs')
  await mkdir(state)
  await writeFile(join(state, 'slots'), 'invalid')
  const env = { ...process.env, TMPDIR: root, FOREMAN_CODE_HEAVY_BASE_TMPDIR: root }
  for (const key of ['FOREMAN_CODE_HEAVY_JOB_COMMON', 'GRAPHQL_HEAVY_JOB_COMMON',
    'FOREMAN_CODE_HEAVY_JOB_TOKEN', 'GRAPHQL_HEAVY_JOB_TOKEN', 'CI_HOST_RUNNER']) delete env[key]
  const result = spawnSync(process.execPath, ['scripts/heavy-job.mjs', '--', process.execPath, '-e', ''],
    { cwd: root, env, encoding: 'utf8', timeout: 5000 })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Invalid heavy-job slot count/)
})

test('reports malformed readiness output without accepting a foreign API', async t => {
  const warnings = []
  t.mock.method(console, 'warn', value => warnings.push(value))
  assert.equal(apiIdentityMatches({ installationId: 'fixture' })({ ok: true }, 'invalid-json'), false)
  assert.ok(warnings.some(value => value.includes('INVALID_READINESS_RESPONSE')))
})

test('reports malformed browser-origin readiness output', async t => {
  const warnings = []
  t.mock.method(console, 'warn', value => warnings.push(value))
  assert.equal(await runningApiAcceptsBrowserOrigin('http://127.0.0.1:1', 'http://127.0.0.1:2',
    async () => new Response('invalid-json')), false)
  assert.ok(warnings.some(value => value.includes('INVALID_READINESS_RESPONSE')))
})

test('preserves a failed parity scenario and reports secondary client cleanup failure', async t => {
  const warnings = []
  t.mock.method(console, 'warn', value => warnings.push(value))
  const primary = new Error('Scenario failed')
  class Client {
    async connect() { throw primary }
    async close() { throw Object.assign(new Error('Close failed'), { code: 'EIO' }) }
  }
  await assert.rejects(parity({ apiUrl: 'http://127.0.0.1:1', workspaceId: 'workspace',
    workflowIds: [], runId: 'run', Client, StreamableHTTPClientTransport: class {},
    access: { issue: async () => ({ principal: { id: 'fixture' }, token: 'fixture' }), revoke: async () => true } }),
  error => error === primary)
  assert.ok(warnings.some(value => value.includes('PARITY_CLIENT_CLOSE_FAILED')))
})

test('does not lose secondary slot observations after a discovery failure', async t => {
  const root = await fixture(t)
  const state = join(root, 'graphql-heavy-jobs')
  await mkdir(state)
  const running = join(state, 'running')
  await symlink(running, running)
  assert.throws(() => hasHeavyJobAdmission({}, root), { code: 'ELOOP' })
})

test('does not turn inaccessible test discovery into an absent file', async t => {
  const root = await fixture(t)
  const loop = join(root, 'loop')
  await symlink(loop, loop)
  assert.throws(() => isRegularIntegrationFile(loop, 'apps/api/test/feature.integration.test.ts'), { code: 'ELOOP' })
})
