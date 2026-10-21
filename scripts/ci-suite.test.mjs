import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const script = fileURLToPath(new URL('./ci-suite.sh', import.meta.url))

test('concurrent host jobs start and remove separate disposable database servers on distinct loopback ports', t => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ci-databases-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const callsFile = join(directory, 'docker-calls.jsonl')
  writeFileSync(callsFile, '')
  writeFileSync(join(directory, 'docker'), `#!${process.execPath}
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.CALLS_FILE, JSON.stringify({ args, port: process.env.FOREMAN_CODE_CI_DATABASE_PORT }) + '\\n')
if (args.includes('port')) console.log('127.0.0.1:' + process.env.FIXTURE_PORT)
`, { mode: 0o755 })
  const projects = []
  const urls = []
  for (const port of [55001, 55002]) {
    const runId = randomUUID()
    const temporary = join(directory, runId)
    mkdirSync(temporary)
    const environment = { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}`, TMPDIR: temporary,
      FOREMAN_CODE_CI_HOST_RUN_ID: runId, FOREMAN_CODE_VERIFICATION_ENVIRONMENT: '',
      CI_HOST_RUNNER: '0',
      FIXTURE_PORT: String(port), CALLS_FILE: callsFile }
    for (const action of ['up', 'down']) {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('./test-db.mjs', import.meta.url)), action],
        { env: environment, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    const url = new URL(readFileSync(join(temporary, 'test-database-url'), 'utf8'))
    assert.equal(url.hostname, '127.0.0.1')
    assert.equal(url.port, String(port))
    urls.push(url.href)
    projects.push(`foreman-ci-${runId}`)
  }
  assert.equal(new Set(urls).size, 2)
  const calls = readFileSync(callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  for (const project of projects) {
    assert.ok(calls.some(({ args, port }) => args.includes(project) && args.includes('up') && port === '0'))
    assert.ok(calls.some(({ args }) => args.includes(project) && args.includes('down') && args.includes('--volumes')))
  }
})

function runSuite(t, suite, failCommand = '', scope = 'full', action = '', installedClis = true, selection = undefined,
  hostRunner = false, sourceEnvironment = process.env) {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  mkdirSync(cache, { recursive: true })
  const directory = mkdtempSync(join(cache, 'ci-suite-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  for (const project of ['apps/api', 'apps/worker']) mkdirSync(join(directory, project), { recursive: true })
  mkdirSync(join(directory, 'scripts'))
  for (const reporter of ['ci-progress-reporter.mjs', 'ci-node-test-reporter.mjs']) {
    writeFileSync(join(directory, 'scripts', reporter), 'export {}\n')
  }
  const callsFile = join(directory, 'calls.jsonl')
  writeFileSync(callsFile, '')
  writeFileSync(join(directory, 'pnpm'), `#!${process.execPath}
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.CALLS_FILE, JSON.stringify(args) + '\\n')
if (args.at(-1) === process.env.FAIL_COMMAND) process.exit(9)
`, { mode: 0o755 })
  writeFileSync(join(directory, 'node'), `#!${process.execPath}
require('node:fs').appendFileSync(process.env.CALLS_FILE, JSON.stringify(process.argv.slice(2)) + '\\n')
if (process.argv[2] === 'scripts/ci-contracts.mjs' && process.argv[3] === 'ready') {
  process.exit(process.env.CONTRACTS_READY === 'true' ? 0 : 1)
}
if (process.argv[2] === 'scripts/ci-selection.mjs') {
  const selection = JSON.parse(process.env.RUNNER_SELECTION)
  if (process.env.BASE_COMMIT) {
    require('node:fs').appendFileSync(process.env.CALLS_FILE, JSON.stringify(['baseCommit', process.env.BASE_COMMIT]) + '\\n')
  }
  require('node:fs').writeFileSync(process.argv.at(-1), JSON.stringify(selection.files))
  console.error(selection.scope === 'full' ? 'Running full suite: ' + (selection.reason || 'Shared CI infrastructure changed.') : 'Selected affected files.')
  console.log(selection.scope)
}
`, { mode: 0o755 })
  writeFileSync(join(directory, 'corepack'), `#!${process.execPath}
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.CALLS_FILE, JSON.stringify(args) + '\\n')
if (args.at(-1) === process.env.FAIL_COMMAND) process.exit(9)
`, { mode: 0o755 })
  if (installedClis) {
    for (const cli of ['codex', 'claude']) {
      writeFileSync(join(directory, cli), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
    }
  } else {
    for (const command of ['bash', 'date', 'mkdir', 'cat']) symlinkSync(`/bin/${command}`, join(directory, command))
    writeFileSync(join(directory, 'npm'), `#!${process.execPath}
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.CALLS_FILE, JSON.stringify(['npm', ...args]) + '\\n')
if (args.at(-1) === process.env.FAIL_COMMAND) process.exit(9)
`, { mode: 0o755 })
  }
  if (selection && !selection.missingSelector) {
    mkdirSync(join(directory, 'scripts'), { recursive: true })
    writeFileSync(join(directory, 'scripts/ci-affected.mjs'), 'export {}')
    writeFileSync(join(directory, 'git'), `#!${process.execPath}
require('node:fs').appendFileSync(process.env.CALLS_FILE, JSON.stringify(['git', ...process.argv.slice(2)]) + '\\n')
if (process.argv[2] === 'rev-parse') console.log('false')
`, { mode: 0o755 })
  }
  if (!action) {
    const state = join(directory, 'state')
    mkdirSync(state)
    for (const name of ['db', 'clis']) {
      writeFileSync(join(state, `${name}.log`), '')
      writeFileSync(join(state, `${name}.exit`), '0')
    }
  }
  if (selection?.databaseFailure) {
    const state = join(directory, 'state')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'db.log'), 'Database unavailable.\n')
    writeFileSync(join(state, 'db.exit'), '9')
  }
  const result = spawnSync('bash', [script, action], {
    encoding: 'utf8',
    cwd: directory,
    env: { ...sourceEnvironment, BASH_ENV: '',
      FOREMAN_CODE_CI_TYPECHECK_CACHE: '', FOREMAN_CODE_CI_TYPECHECK_CACHE_ACTIVE: '',
      SUITE: suite, SCOPE: selection?.omitScope ? undefined : scope,
      SELECTED_FILES: selection ? '' : 's:1', DEFAULT_BRANCH: 'release/stable', CI_STATE: join(directory, 'state'),
      RUNNER_SELECTION: JSON.stringify(selection),
      BASE_COMMIT: selection?.baseCommit ?? '',
      CI_HOST_RUNNER: hostRunner ? '1' : '0', FOREMAN_CODE_CI_CLIS_PREFIX: '',
      FOREMAN_CODE_CI_CONTRACTS_CACHE: selection?.contractsCache ? '.logs/contracts-cache' : '',
      CONTRACTS_READY: String(selection?.contractsReady ?? false),
      CI_USER_SYSTEMD: '0', CI_EXPECTED_DURATION_MS: '', CI_WATCHDOG_ACTIVE: '', CI_PROGRESS_FILE: '',
      PATH: installedClis ? `${directory}${delimiter}${sourceEnvironment.PATH}` : directory,
      CALLS_FILE: callsFile, FAIL_COMMAND: failCommand },
  })
  const calls = readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { result, calls }
}

const contractsBuild = ['--filter', '@foreman-code/contracts', 'build']
test('suite command assertions are independent of runner typecheck cache and shell startup', t => {
  const directory = mkdtempSync(join(homedir(), '.cache', 'foreman-tmp', 'ci-suite-environment-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const shellEnvironment = join(directory, 'shell-environment')
  writeFileSync(shellEnvironment, 'export FOREMAN_CODE_CI_TYPECHECK_CACHE="$RUNNER_CACHE"\n')
  const { result, calls } = runSuite(t, 'typecheck-api', '', 'full', '', true, undefined, false, {
    ...process.env, FOREMAN_CODE_CI_TYPECHECK_CACHE: directory, FOREMAN_CODE_CI_TYPECHECK_CACHE_ACTIVE: '',
    BASH_ENV: shellEnvironment, RUNNER_CACHE: directory,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(calls, [contractsBuild, ['--filter', '@foreman-code/api', 'typecheck']])
})

test('cloud suites forward an explicit base to selection without fetching the default branch', t => {
  const baseCommit = 'a'.repeat(40)
  const { result, calls } = runSuite(t, 'typecheck-api', '', 'affected', '', true,
    { scope: 'affected', files: ['apps/api/src/value.ts'], baseCommit })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(calls[0], ['git', 'rev-parse', '--is-shallow-repository'])
  assert.deepEqual(calls[2], ['baseCommit', baseCommit])
  assert.equal(calls.some(call => call[0] === 'git' && call[1] === 'fetch'), false)
  assert.deepEqual(calls[3], ['scripts/ci-affected-run.mjs', 'typecheck', '--files-from', calls[1].at(-1)])
})

test('an invalid explicit base logs the reason and runs the full cloud suite part', t => {
  const reason = 'baseCommit is unavailable or is not an ancestor of the resolved commit.'
  const { result, calls } = runSuite(t, 'typecheck-api', '', 'affected', '', true,
    { scope: 'full', files: [], baseCommit: 'a'.repeat(40), reason })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stderr.includes(`Running full suite: ${reason}`))
  assert.deepEqual(calls.slice(3), [contractsBuild, ['--filter', '@foreman-code/api', 'typecheck']])
})

test('omitted scope derives affected files on the cloud runner using the workspace default branch', t => {
  const { result, calls } = runSuite(t, 'typecheck-api', '', 'affected', '', true,
    { scope: 'affected', files: ['apps/api/src/value.ts'], omitScope: true })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(calls.slice(0, 2), [
    ['git', 'rev-parse', '--is-shallow-repository'],
    ['git', 'fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/release/stable:refs/remotes/origin/release/stable'],
  ])
  assert.equal(calls[2][0], 'scripts/ci-selection.mjs')
  assert.equal(calls[2][1], 'typecheck-api')
  assert.equal(calls[2][2], 'refs/remotes/origin/release/stable')
  assert.deepEqual(calls[3], ['scripts/ci-affected-run.mjs', 'typecheck', '--files-from', calls[2].at(-1)])
})
test('a shared infrastructure fallback runs the complete cloud suite part and logs the reason', t => {
  const { result, calls } = runSuite(t, 'typecheck-api', '', 'affected', '', true,
    { scope: 'full', files: [] })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /Running full suite: Shared CI infrastructure changed/)
  assert.deepEqual(calls.slice(3), [contractsBuild, ['--filter', '@foreman-code/api', 'typecheck']])
})
test('a repository without a selector runs the full cloud part and logs the reason', t => {
  const { result, calls } = runSuite(t, 'typecheck-api', '', 'affected', '', true,
    { missingSelector: true, omitScope: true })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Running full suite: The repository has no affected selector/)
  assert.deepEqual(calls, [contractsBuild, ['--filter', '@foreman-code/api', 'typecheck']])
})
test('explicit full scope bypasses runner selection and runs the complete cloud part', t => {
  const { result, calls } = runSuite(t, 'typecheck-api', '', 'full', '', true,
    { scope: 'affected', files: ['apps/api/src/value.ts'] })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(calls, [contractsBuild, ['--filter', '@foreman-code/api', 'typecheck']])
})
test('a host CI part uses Corepack and the already delegated host service', t => {
  const { result, calls } = runSuite(t, 'unit-api', '', 'full', '', true, undefined, true)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(calls[0], ['pnpm', ...contractsBuild])
  assert.deepEqual(calls[1], ['scripts/ci-unit-files.mjs', 'select', 'unit-api', ''])
  assert.deepEqual(calls[2].slice(0, 2), ['pnpm', 'test'])
})
test('host preparation installs missing harness CLIs with the cloud package age policy', t => {
  const { result, calls } = runSuite(t, 'unit-api', '', 'full', 'prepare', false)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(calls[0], ['pnpm', 'db:up'])
  assert.equal(calls.length, 2)
  const [command, ...args] = calls[1]
  assert.equal(command, 'npm')
  assert.deepEqual(args.slice(0, 3), ['install', '--global', '--silent'])
  assert.match(args[3], /^--before=\d{4}-\d{2}-\d{2}T/)
  const cutoff = Date.parse(args[3].slice('--before='.length))
  assert.ok(Math.abs(Date.now() - cutoff - 48 * 60 * 60 * 1000) < 60_000)
  assert.deepEqual(args.slice(4), ['@openai/codex', '@anthropic-ai/claude-code'])
})
test('host preparation propagates a missing harness installation failure', t => {
  const { result, calls } = runSuite(t, 'integration', '@anthropic-ai/claude-code', 'full', 'prepare', false)
  assert.equal(result.status, 9)
  assert.equal(calls.length, 2)
})
for (const suite of ['unit', 'unit-api', 'unit-other', 'integration']) {
  test(`${suite} prepares the host database and reuses installed harness CLIs`, t => {
    const { result, calls } = runSuite(t, suite, '', 'full', 'prepare')
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(calls, [['pnpm', 'db:up']])
  })
  test(`${suite} fails preparation when the database cannot start`, t => {
    const { result, calls } = runSuite(t, suite, 'db:up', 'full', 'prepare')
    assert.equal(result.status, 9)
    assert.deepEqual(calls, [['pnpm', 'db:up']])
  })
}
for (const suite of ['unit-other']) {
  test(`${suite} prepares its disposable database without installing harness CLIs`, t => {
    const { result, calls } = runSuite(t, suite, '', 'affected', 'prepare', false)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(calls, [['pnpm', 'db:up']])
  })
  test(`${suite} stops before affected tests when its database preparation failed`, t => {
    const { result, calls } = runSuite(t, suite, '', 'affected', '', true,
      { scope: 'affected', files: ['apps/web/src/example.test.tsx'], databaseFailure: true })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stdout, /Database unavailable/)
    assert.equal(calls.some(call => call[0] === 'scripts/ci-affected-run.mjs'), false)
  })
}
for (const suite of ['unit-web', 'unit-web-heavy']) {
  for (const action of ['start', 'prepare']) {
    test(`${suite} ${action} needs no PostgreSQL or harness installation`, t => {
      const { result, calls } = runSuite(t, suite, '', 'full', action, false)
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(calls, [])
    })
  }
  test(`${suite} runs affected browser tests independently of PostgreSQL`, t => {
    const { result, calls } = runSuite(t, suite, '', 'affected', '', true,
      { scope: 'affected', files: ['apps/web/src/example.test.tsx'], databaseFailure: true })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(calls.some(call => call[0] === 'scripts/ci-affected-run.mjs'))
  })
}
for (const suite of ['install', 'lint-api', 'typecheck-other', 'build-api']) {
  test(`${suite} needs no host database or harness preparation`, t => {
    const { result, calls } = runSuite(t, suite, '', 'full', 'prepare')
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(calls, [])
  })
}
for (const suite of ['unit-web', 'unit-web-heavy', 'unit-other', 'lint-api', 'lint-other', 'typecheck-api', 'typecheck-other']) {
  test(`${suite} forwards its affected selection to the parent suite runner`, t => {
    const { result, calls } = runSuite(t, suite, '', 'affected')
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(calls, [['scripts/ci-affected-run.mjs', suite.split('-')[0], '--indexes', 's:1']])
  })
}
const parts = [
  ['typecheck-api', [contractsBuild, ['--filter', '@foreman-code/api', 'typecheck']]],
  ['typecheck-other', [contractsBuild, ['-r', '--filter', '!@foreman-code/api', '--if-present', 'typecheck']]],
  ['build-api', [contractsBuild, ['--filter', '@foreman-code/api', 'build']]],
  ['build-other', [['-r', '--filter', '!@foreman-code/api', '--if-present', 'build']]],
]

for (const [suite, expected] of parts) {
  test(`${suite} selects its packages and builds contracts once`, t => {
    const { result, calls } = runSuite(t, suite)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(calls, expected)
  })
}

for (const suite of ['typecheck-api', 'typecheck-other', 'build-api']) {
  test(`${suite} stops when the contracts build fails`, t => {
    const { result, calls } = runSuite(t, suite, 'build')
    assert.equal(result.status, 9)
    assert.deepEqual(calls, [contractsBuild])
  })
}

for (const suite of ['typecheck', 'build']) {
  test(`${suite} retains the complete root suite and its failure status`, t => {
    const { result, calls } = runSuite(t, suite, suite)
    assert.equal(result.status, 9)
    assert.deepEqual(calls, [[suite]])
  })
}

function runNodeBootstrap(t, failedAttempts, restoredNode = false) {
  const base = join(homedir(), '.cache', 'foreman-tmp')
  mkdirSync(base, { recursive: true })
  const directory = mkdtempSync(join(base, 'ci-node-bootstrap-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const home = join(directory, 'home')
  mkdirSync(home)
  mkdirSync(join(directory, '.logs'))
  if (restoredNode) {
    const bin = join(home, '.nvm/versions/node/v22.23.2/bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'node'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
  }
  const callsFile = join(directory, 'calls')
  const shellEnvironment = join(directory, 'shell-environment')
  writeFileSync(callsFile, '')
  writeFileSync(shellEnvironment, '')
  const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
  const { parse } = require('yaml')
  const configuration = parse(readFileSync(new URL('../.circleci/config.yml', import.meta.url), 'utf8'))
  const command = configuration.jobs.ci.steps.find(step => step.run?.name === 'Node and pnpm').run.command
  const fixture = `
    attempts=0
    nvm() {
      printf '%s\\n' "nvm $*" >> "$CALLS_FILE"
      if [ "$1" = install ]; then
        attempts=$((attempts + 1))
        if [ "$attempts" -le "$FAILED_ATTEMPTS" ]; then
          echo "Version '$2' not found" >&2
          return 3
        fi
      elif [ "$1" = which ]; then
        printf '%s\\n' "$NODE_BINARY"
      fi
    }
    corepack() { printf '%s\\n' "corepack $*" >> "$CALLS_FILE"; }
    node() { printf '%s\\n' "node $*" >> "$CALLS_FILE"; }
    sleep() { printf '%s\\n' "sleep $*" >> "$CALLS_FILE"; }
    chmod() { :; }
    mkdir() { :; }
    export -f nvm corepack node sleep chmod mkdir
  `
  const result = spawnSync('bash', ['-ec', fixture + command], {
    cwd: directory, encoding: 'utf8',
    env: { ...process.env, SUITE: 'install', CALLS_FILE: callsFile, FAILED_ATTEMPTS: String(failedAttempts),
      NODE_BINARY: process.execPath, BASH_ENV: shellEnvironment, HOME: home },
  })
  return { result, calls: readFileSync(callsFile, 'utf8').trim().split('\n'),
    shellEnvironment: readFileSync(shellEnvironment, 'utf8') }
}

test('cloud Node bootstrap recovers from a transient version lookup failure using the same pinned version', t => {
  const { result, calls, shellEnvironment } = runNodeBootstrap(t, 1)
  assert.equal(result.status, 0, result.stderr)
  const installs = calls.filter(call => call.startsWith('nvm install '))
  assert.deepEqual(installs, ['nvm install 22.23.2', 'nvm install 22.23.2'])
  assert.ok(calls.includes('nvm which 22.23.2'))
  assert.ok(calls.includes('corepack enable'))
  assert.ok(calls.includes('node --version'))
  assert.ok(shellEnvironment.includes(process.execPath.slice(0, process.execPath.lastIndexOf('/'))))
})

test('cloud Node bootstrap stops after three failed installs before enabling the package manager', t => {
  const { result, calls, shellEnvironment } = runNodeBootstrap(t, 10)
  assert.equal(result.status, 3)
  assert.equal(calls.filter(call => call === 'nvm install 22.23.2').length, 3)
  assert.equal(calls.some(call => call.startsWith('corepack ')), false)
  assert.equal(shellEnvironment, '')
  assert.match(result.stderr, /Version '22\.23\.2' not found/)
})

for (const provider of ['github', 'circleci', 'circleci-ssh']) {
  test(`${provider} checkout retains only the tested commit and its comparison base`, t => {
    const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ci-checkout-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const origin = join(directory, 'origin')
    const checkout = join(directory, 'checkout')
    mkdirSync(origin)
    mkdirSync(checkout)
    const environment = { ...process.env, BASH_ENV: '', GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.org', GIT_COMMITTER_EMAIL: 'fixture@example.org' }
    const git = (cwd, ...args) => {
      const result = spawnSync('git', args, { cwd, env: environment, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.trim()
    }
    git(origin, 'init', '-q', '-b', 'main')
    git(origin, 'commit', '--allow-empty', '-qm', 'old history')
    const stale = git(origin, 'rev-parse', 'HEAD')
    git(origin, 'branch', 'ci/stale', stale)
    git(origin, 'commit', '--allow-empty', '-qm', 'comparison base')
    const base = git(origin, 'rev-parse', 'HEAD')
    git(origin, 'commit', '--allow-empty', '-qm', 'tested commit')
    const commit = git(origin, 'rev-parse', 'HEAD')
    git(origin, 'branch', 'ci/tested', commit)
    git(origin, 'commit', '--allow-empty', '-qm', 'default branch advances')
    const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
    const { parse } = require('yaml')
    if (provider === 'github') {
      const configuration = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
      const action = configuration.jobs.ci.steps.find(step => step.uses?.startsWith('actions/checkout@'))
      // Execute the documented checkout action ref/depth contract against the fixture remote.
      const inputs = { ref: commit, base_commit: base }
      const refInput = action.with.ref
      const selectedRef = refInput.startsWith('${{')
        ? Function('inputs', `return (${refInput.slice(3, -2)})`)(inputs) : refInput
      const depthInput = action.with['fetch-depth']
      const depth = typeof depthInput === 'number' ? depthInput
        : Function('inputs', `return (${depthInput.slice(3, -2)})`)(inputs)
      git(checkout, 'init', '-q')
      git(checkout, 'remote', 'add', 'origin', `file://${origin}`)
      if (depth === 0) git(checkout, 'fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*')
      else git(checkout, 'fetch', '--no-tags', `--depth=${depth}`, 'origin', selectedRef)
      git(checkout, 'checkout', '--detach', 'FETCH_HEAD')
    } else {
      const configuration = parse(readFileSync(new URL('../.circleci/config.yml', import.meta.url), 'utf8'))
      const step = configuration.jobs.ci.steps[0]
      if (step === 'checkout') {
        git(directory, 'clone', '-q', `file://${origin}`, checkout)
        git(checkout, 'checkout', '--detach', commit)
      } else {
        let repositoryUrl = `file://${origin}`
        const bin = join(directory, 'bin')
        mkdirSync(bin)
        if (provider === 'circleci-ssh') {
          repositoryUrl = 'git@github.com:octo/site-ci.git'
          writeFileSync(join(bin, 'git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args.includes('git@github.com:octo/site-ci.git')) process.exit(42)
const mapped = args.map(value => value === 'https://github.com/octo/site-ci.git' ? process.env.FIXTURE_ORIGIN : value)
const result = spawnSync(process.env.FIXTURE_GIT, mapped, { stdio: 'inherit' })
process.exit(result.status ?? 1)
`, { mode: 0o755 })
        }
        const gitExecutable = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8', env: environment }).stdout.trim()
        const result = spawnSync('bash', ['-ec', step.run.command], { cwd: checkout, encoding: 'utf8',
          env: { ...environment, PATH: `${bin}${delimiter}${process.env.PATH}`, FIXTURE_GIT: gitExecutable,
            FIXTURE_ORIGIN: `file://${origin}`, CIRCLE_REPOSITORY_URL: repositoryUrl,
            CIRCLE_SHA1: commit, BASE_COMMIT: base } })
        assert.equal(result.status, 0, result.stderr)
      }
    }
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), commit)
    assert.equal(git(checkout, 'for-each-ref', '--format=%(refname)', 'refs/remotes/'), '')
    assert.equal(git(checkout, 'rev-list', '--count', 'HEAD'), '2')
    assert.equal(git(checkout, 'merge-base', base, 'HEAD'), base)
    assert.equal(spawnSync('git', ['cat-file', '-e', stale], { cwd: checkout }).status, 1)
  })
}

test('the other unit phase passes a recursive script-test glob to Node', t => {
  const { result, calls } = runSuite(t, 'unit-other')
  assert.equal(result.status, 0, result.stderr)
  const scriptTests = calls.find(args => args.includes('--test') && args.includes('scripts/**/*.test.mjs'))
  assert.ok(scriptTests, 'The script-test phase must discover top-level and nested test files')
})

for (const suite of ['typecheck-api', 'typecheck-other', 'build-api']) {
  test(`${suite} skips the package-manager build when restored contracts match the checkout`, t => {
    const { result, calls } = runSuite(t, suite, '', 'full', '', true,
      { contractsCache: true, contractsReady: true })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(calls[0][0], 'scripts/ci-contracts.mjs')
    assert.equal(calls[0][1], 'ready')
    assert.equal(calls.some(args => JSON.stringify(args) === JSON.stringify(contractsBuild)), false)
    assert.equal(calls.at(-1).at(-1), suite.startsWith('typecheck') ? 'typecheck' : 'build')
  })
}

test('a missing or stale contracts cache still builds and propagates compiler failure', t => {
  const { result, calls } = runSuite(t, 'typecheck-api', 'build', 'full', '', true,
    { contractsCache: true, contractsReady: false })
  assert.equal(result.status, 9)
  assert.deepEqual(calls.at(-1), contractsBuild)
})

test('cloud Node bootstrap uses the cached toolchain without invoking nvm', t => {
  const { result, calls, shellEnvironment } = runNodeBootstrap(t, 10, true)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(calls.some(call => call.startsWith('nvm ')), false)
  assert.ok(calls.includes('corepack enable'))
  assert.ok(calls.includes('node --version'))
  assert.match(shellEnvironment, /\.nvm\/versions\/node\/v22\.23\.2\/bin/)
})

test('cloud startup installs the harness CLIs once into a cacheable prefix and reuses them', async t => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  mkdirSync(cache, { recursive: true })
  const directory = mkdtempSync(join(cache, 'ci-clis-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const callsFile = join(directory, 'calls.jsonl')
  const prefix = join(directory, 'clis')
  mkdirSync(join(directory, 'bin'))
  writeFileSync(join(directory, 'bin', 'npm'), `#!${process.execPath}
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const args = process.argv.slice(2)
appendFileSync(process.env.CALLS_FILE, JSON.stringify(args) + '\\n')
const bin = join(args[args.indexOf('--prefix') + 1], 'bin')
mkdirSync(bin, { recursive: true })
for (const name of ['codex', 'claude']) writeFileSync(join(bin, name), '#!/bin/bash\\n', { mode: 0o755 })
`, { mode: 0o755 })
  writeFileSync(join(directory, 'bin', 'node'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
  const start = async index => {
    const state = join(directory, `state-${index}`)
    const result = spawnSync('bash', [script, 'start'], { encoding: 'utf8', cwd: directory, env: {
      ...process.env, BASH_ENV: '', SUITE: 'integration', CI_STATE: state, CALLS_FILE: callsFile, CI_HOST_RUNNER: '0',
      FOREMAN_CODE_CI_CLIS_PREFIX: prefix, PATH: `${join(directory, 'bin')}${delimiter}${process.env.PATH}` } })
    assert.equal(result.status, 0, result.stderr)
    for (let attempt = 0; attempt < 100; attempt++) {
      try { readFileSync(join(state, 'clis.exit')); break } catch { await new Promise(resolve => setTimeout(resolve, 50)) }
    }
    assert.equal(readFileSync(join(state, 'clis.exit'), 'utf8').trim(), '0')
  }
  writeFileSync(callsFile, '')
  await start(1)
  await start(2)
  const calls = readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.equal(calls.length, 1)
  assert.ok(calls[0].some(argument => /^--before=\d{4}-\d{2}-\d{2}T/.test(argument)))
  assert.ok(readFileSync(join(prefix, 'bin', 'codex'), 'utf8'))
})
