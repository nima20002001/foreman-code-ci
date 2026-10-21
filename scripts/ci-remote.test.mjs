import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { awaitTickets, requestedTestFiles, snapshot } from './ci-remote.mjs'

const script = new URL('./ci-remote.mjs', import.meta.url).pathname

function repository() {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ci-remote-'))
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com' }
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main'); writeFileSync(join(root, 'a.txt'), 'one\n'); git('add', '.'); git('commit', '-qm', 'first')
  return { root, git }
}

test('snapshots uncommitted and untracked changes as a commit on HEAD without touching the index or branch', t => {
  const { root, git } = repository()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const head = git('rev-parse', 'HEAD')
  assert.equal(snapshot(root), head)
  writeFileSync(join(root, 'a.txt'), 'two\n'); writeFileSync(join(root, 'new.txt'), 'new\n')
  const commit = snapshot(root)
  assert.notEqual(commit, head)
  assert.equal(git('rev-parse', `${commit}^`), head)
  assert.equal(git('show', `${commit}:a.txt`), 'two')
  assert.equal(git('show', `${commit}:new.txt`), 'new')
  assert.equal(git('rev-parse', 'HEAD'), head)
  assert.equal(git('status', '--porcelain'), 'M a.txt\n?? new.txt')
})

test('runs the local command on a CI machine and keeps its exit code', () => {
  const run = spawnSync(process.execPath, [script, 'unit', '--', process.execPath, '-e', 'process.exit(3)'],
    { env: { ...process.env, CI: 'true' } })
  assert.equal(run.status, 3)
})

test('refuses to run tests on a developer machine when Main is unreachable, and says how to proceed', () => {
  const run = spawnSync(process.execPath, [script, 'unit', '--', process.execPath, '-e', 'process.exit(0)'],
    { env: { ...process.env, CI: '', FOREMAN_CODE_CI_LOCAL: '', FOREMAN_CODE_MAIN_URL: 'http://127.0.0.1:9',
      FOREMAN_CODE_OPERATOR_TOKEN: 'test-token' }, encoding: 'utf8' })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /FOREMAN_CODE_CI_LOCAL=1/)
})

test('sends test files named on the command line, relative to the repository root', t => {
  const { root } = repository()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'apps/api/test'), { recursive: true })
  writeFileSync(join(root, 'apps/api/test/one.test.ts'), '')
  const args = ['vitest', 'run', '--exclude', '**/*.integration.test.ts', 'test/one.test.ts', 'test/missing.test.ts', 'one']
  assert.deepEqual(requestedTestFiles(args, join(root, 'apps/api')), ['apps/api/test/one.test.ts'])
})

const open = run => ['queued', 'starting', 'running'].includes(run.state)

/** A fake ci_get over fixed ticket states: a group wait reports its group, settled once every ticket is terminal
 * with its results collected. */
const reader = (runs, calls = []) => async (name, input) => {
  calls.push({ name, input })
  const run = runs[input.ticketId]
  if (name === 'ci_get' && input.waitUntil) {
    const group = run.group ? run.group.map(id => runs[id]) : [run]
    const settled = group.filter(value => !open(value) && value.collection !== 'pending')
    return { run, ...(group.length > 1 ? { partitions: group } : {}),
      wait: { until: 'group-terminal', status: settled.length === group.length ? 'settled' : 'still-running',
        tickets: group.length, settledTickets: settled.length } }
  }
  if (name === 'ci_get' && !input.testStatus) return { run, ...(run.group ? { partitions: run.group.map(id => runs[id]) } : {}) }
  return name === 'ci_logs_read' ? { text: '' } : { tests: { files: [] } }
}

test('follows a ticket superseded by a newer commit to its replacement tickets instead of failing', async () => {
  const runs = {
    old: { id: 'old', suite: 'unit', state: 'canceled', supersededBy: 'new-1' },
    'new-1': { id: 'new-1', suite: 'unit', state: 'passed', group: ['new-1', 'new-2'] },
    'new-2': { id: 'new-2', suite: 'unit', state: 'passed' },
  }
  const finished = await awaitTickets(reader(runs), 'workspace', ['old'])
  assert.deepEqual(finished.map(run => [run.id, run.state]), [['new-1', 'passed'], ['new-2', 'passed']])
})

test('a partly superseded group still reports its replacement ticket that failed', async t => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  const runs = {
    kept: { id: 'kept', suite: 'unit', state: 'passed', group: ['kept', 'old'] },
    old: { id: 'old', suite: 'unit', state: 'canceled', supersededBy: 'replacement' },
    replacement: { id: 'replacement', suite: 'unit', state: 'failed' },
  }
  const finished = await awaitTickets(reader(runs), 'workspace', ['kept', 'old'])
  assert.deepEqual(finished.map(run => [run.id, run.state]), [['kept', 'passed'], ['replacement', 'failed']])
})

test('stops waiting at the overall deadline and returns the open tickets', async () => {
  const runs = { slow: { id: 'slow', suite: 'integration', state: 'running' } }
  const finished = await awaitTickets(reader(runs), 'workspace', ['slow'], { waitMs: 0 })
  assert.deepEqual(finished.map(run => run.state), ['running'])
})


test('reports diagnostic retrieval failures while preserving a failed test outcome', async t => {
  const lines = []
  t.mock.method(console, 'error', value => lines.push(String(value)))
  const failed = { id: 'failed-ticket', suite: 'unit', state: 'failed' }
  const call = async (name, input) => {
    if (name === 'ci_get' && input.waitUntil) return { run: failed, wait: { until: 'group-terminal', status: 'settled',
      tickets: 1, settledTickets: 1 } }
    throw new Error('private diagnostic connection details')
  }
  assert.deepEqual(await awaitTickets(call, 'workspace', [failed.id]), [failed])
  assert.ok(lines.some(line => /ci_logs_read.*failed-ticket.*unavailable/.test(line)))
  assert.ok(lines.some(line => /test results.*failed-ticket.*unavailable/.test(line)))
  assert.ok(lines.every(line => !line.includes('private diagnostic')))
})

test('waits for the whole group with one log-free read instead of polling every ticket', async () => {
  const runs = {
    a: { id: 'a', suite: 'unit', state: 'passed', group: ['a', 'b', 'c'] },
    b: { id: 'b', suite: 'unit', state: 'passed' },
    c: { id: 'c', suite: 'unit', state: 'passed' },
  }
  const calls = []
  const finished = await awaitTickets(reader(runs, calls), 'workspace', ['a', 'b', 'c'])
  assert.deepEqual(finished.map(run => run.id), ['a', 'b', 'c'])
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].input, { workspaceId: 'workspace', ticketId: 'a', waitUntil: 'group-terminal',
    waitSeconds: calls[0].input.waitSeconds, logTail: false })
  assert.ok(calls[0].input.waitSeconds > 0)
})

test('reads failure diagnostics only after the group has settled its result collection', async t => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  const runs = { a: { id: 'a', suite: 'unit', state: 'failed', collection: 'pending', group: ['a', 'b'] },
    b: { id: 'b', suite: 'unit', state: 'passed' } }
  const calls = []
  const read = reader(runs, calls)
  const call = async (name, input) => {
    const reply = await read(name, input)
    if (name === 'ci_get' && input.waitUntil && calls.filter(value => value.input.waitUntil).length === 1) delete runs.a.collection
    return reply
  }
  await awaitTickets(call, 'workspace', ['a', 'b'])
  const waits = calls.map(value => value.input.waitUntil ? 'wait' : value.name)
  assert.deepEqual(waits.slice(0, 3), ['wait', 'wait', 'ci_logs_read'])
  assert.equal(waits.filter(name => name === 'wait').length, 2)
})

test('tracks fallback siblings added while a group wait is in flight', async t => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  const original = { id: 'original', suite: 'integration', state: 'passed', group: ['original'] }
  const sibling = { id: 'fallback-sibling', suite: 'integration', state: 'failed' }
  const runs = { original }
  const calls = []
  let enter, release
  const entered = new Promise(resolve => { enter = resolve })
  const released = new Promise(resolve => { release = resolve })
  const read = reader(runs, calls)
  const call = async (name, input) => {
    if (input.waitUntil) {
      enter()
      await released
    }
    return read(name, input)
  }
  const waiting = awaitTickets(call, 'workspace', [original.id])
  await entered
  runs[sibling.id] = sibling
  original.group.push(sibling.id)
  release()
  const finished = await waiting
  assert.deepEqual(finished.map(run => [run.id, run.state]), [['original', 'passed'], ['fallback-sibling', 'failed']])
  assert.ok(calls.some(call => call.name === 'ci_logs_read' && call.input.ticketId === sibling.id))
})
