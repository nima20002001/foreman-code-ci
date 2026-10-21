import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CiPart, CiSuite } from '@foreman-code/contracts'
import { describe, expect, it, vi } from 'vitest'
import { selectByIndexes } from '../../../../../scripts/ci-files.mjs'
import { affectedSnapshot } from '../../../../../scripts/ci-affected.mjs'
import { executionSelection } from '../../../../../scripts/ci-selection.mjs'
import { cloudService } from './cloudService.testSupport.js'
import { cloudSuiteRunner } from './cloudRunner.testSupport.js'

import { confirmCancellation, fixture } from './cloud.testSupport.js'
import { expectCliRunMessage } from './cloudAssertions.testSupport.js'
import { deferred } from '../../../test/helpers/deferred.js'

function confirmCircleCiCancellation(f: Awaited<ReturnType<typeof fixture>>) {
  const original = f.ports.run.bind(f.ports)
  vi.spyOn(f.ports, 'run').mockImplementation(async (file, args, options) => {
    if (file === 'circleci' && args[0] === 'run' && args[1] === 'get'
      && f.circle.canceled.includes(args[2]!)) {
      return { code: 0, stderr: '', stdout: JSON.stringify({
        phase: 'ended', current_outcome: 'canceled', workflows: [],
      }) }
    }
    return original(file, args, options)
  })
}

it.each([false, true])('keeps a first-pass CircleCI file failure in Main when its retest passes: report=%s', async reported => {
  const f = await fixture({}, { provider: 'circleci' })
  const runId = randomUUID()
  const reply = await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full' })
  if (reply.operation !== 'start') throw new Error('Expected a start reply')
  const main = cloudService(f.cloud, reply.run, f.commit)
  const file = 'apps/api/test/a.integration.test.ts'
  const passing = { file, status: 'passed', durationMs: 40,
    tests: [{ name: 'saves a record', status: 'passed', durationMs: 20 }] }
  f.circle.artifacts = {
    'durations/test-results.json': { summary: { passed: reported ? 1 : 0, failed: 0, skipped: 0 },
      truncated: false, files: reported ? [passing] : [] },
    'integration-logs/run/summary.json': { schemaVersion: 1, suite: 'integration',
      totals: { total: reported ? 1 : 0, passed: reported ? 1 : 0, failed: 0, skipped: 0 },
      files: [{ file, code: 1, complete: reported, elapsedMs: 90, reason: 'First-pass process failed' }],
      retests: [{ file, code: 0, complete: true }] },
    'integration-logs/run/slots/slot-1/a.log': 'unneeded slot output',
    'integration-logs/run/logs.tar.gz': 'unneeded archive',
  }
  f.circle.outcome = 'failed'
  await main.service.dispatch()
  expect(await main.read(['failed'])).toMatchObject({ run: { state: 'failed', collection: 'complete' },
    tests: { summary: { passed: reported ? 1 : 0, failed: 0, skipped: 0 },
      files: [{ file, status: 'failed', tests: [] }] } })
  expect(f.circle.downloaded).toEqual(['https://artifacts.example/durations/test-results.json',
    'https://artifacts.example/integration-logs/run/summary.json'])
  const reopened = await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1, testResults: true })
  expect(reopened).toMatchObject({ testResults: { files: [{ file, status: 'failed' }] } })
})

it.each(['integration', 'unit-api', 'unit-web'] as const)(
  'persists CircleCI %s test failures in Main without a durations artifact', async part => {
    const f = await fixture({}, { provider: 'circleci' })
    const runId = randomUUID()
    const selection: { suite: CiSuite; part?: CiPart } = part === 'integration'
      ? { suite: 'integration' } : { suite: 'unit', part }
    const reply = await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
      repository: 'octo/site', commit: f.commit, scope: 'full', ...selection })
    if (reply.operation !== 'start') throw new Error('Expected a start reply')
    const files = { integration: 'apps/api/test/a.integration.test.ts',
      'unit-api': 'apps/api/src/value.test.ts', 'unit-web': 'apps/web/src/value.test.tsx' }
    const file = files[part]
    const failed = { file, status: 'failed', durationMs: 90,
      tests: [{ name: 'rejects an invalid record', status: 'failed', durationMs: 20,
        message: 'expected 1 to be 2', location: `${file}:12:3` }] }
    const testResults = { summary: { passed: 0, failed: 1, skipped: 0 }, truncated: false, files: [failed] }
    f.circle.artifacts = { 'durations/test-results.json': testResults }
    f.circle.outcome = 'failed'
    const main = cloudService(f.cloud, reply.run, f.commit, selection)
    await main.service.dispatch()
    expect(await main.read(['failed'])).toMatchObject({ run: { state: 'failed' }, tests: testResults })
    expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1, testResults: true }))
      .toMatchObject({ testResults })
  },
)

it.each([false, true])('keeps CircleCI Suite failure output beyond the rendered step log: artifact=%s', async artifact => {
  const f = await fixture({}, { provider: 'circleci' })
  const runId = randomUUID()
  const reply = await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full' })
  if (reply.operation !== 'start') throw new Error('Expected a start reply')
  const main = cloudService(f.cloud, reply.run, f.commit)
  const failure = '[integration] FAIL apps/api/test/a.integration.test.ts (slot 1, exit 1)\n'
    + '[integration]   × rejects an invalid record\n'
  f.circle.steps = [{ num: 108, name: 'Suite', phase: 'ended', outcome: 'failed' }]
  f.circle.log = 'rendered step output\n'.repeat(3_000)
  f.circle.rawOutput = `${'test progress\n'.repeat(6_000)}${failure}`
  if (artifact) f.circle.artifacts = { 'durations/suite.log': f.circle.rawOutput }
  f.circle.outcome = 'failed'
  await main.service.dispatch()
  expect(await main.read()).toMatchObject({ run: { state: 'failed' }, logTail: expect.stringContaining(failure) })
  const first = await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 })
  if (first.operation !== 'read') throw new Error('Expected a read reply')
  expect(first.run.logBytes).toBeGreaterThan(65_536)
  const read = { operation: 'read' as const, runId,
    afterOffset: first.run.logBytes - 32_768, maxBytes: 32_768 }
  expect(await f.cloud.handle(read)).toMatchObject({ text: expect.stringContaining(failure) })
  expect(await f.reopen().handle(read)).toMatchObject({ text: expect.stringContaining(failure) })
})

it.each([
  { outcome: 'succeeded', state: 'passed', exitCode: 0 },
  { outcome: 'failed', state: 'failed', exitCode: 1 },
  { outcome: 'canceled', state: 'canceled', exitCode: 1 },
])('settles ended CircleCI pipelines without workflows as $state', async ({ outcome, state, exitCode }) => {
  const f = await fixture({}, { provider: 'circleci' })
  for (const started of [false, true]) {
    f.circle.runView = started ? null : { phase: 'created', workflows: [] }
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site',
      commit: f.commit, suite: 'integration', scope: 'full' })
    f.circle.runView = { phase: 'ended', current_outcome: outcome, stopped_at: '2026-10-11T02:00:00Z', workflows: [] }
    expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }))
      .toMatchObject({ run: { state, exitCode, finishedAt: '2026-10-11T02:00:00Z' } })
    expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
      .toMatchObject({ run: { state, exitCode } })
  }
  expect(f.circle.triggered).toHaveLength(2)
})

it.each(['pipeline', 'workflow'] as const)('uses an ended CircleCI %s despite stale child status', async ended => {
  const f = await fixture({}, { provider: 'circleci' })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site',
    commit: f.commit, suite: 'integration', scope: 'full' })
  f.circle.runView = ended === 'pipeline'
    ? { phase: 'ended', outcome: 'failed', workflows: [{ phase: 'started', jobs: [{ id: 'job-1' }] }] }
    : { phase: 'started', workflows: [{ phase: 'ended', outcome: 'canceled', jobs: [{ id: 'job-1' }] }] }
  expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }))
    .toMatchObject({ run: { state: ended === 'pipeline' ? 'failed' : 'canceled', exitCode: 1 } })
})

it.each(['unknown outcome', 'no active workflows'] as const)('keeps a CircleCI run with %s pending until success', async reason => {
  const f = await fixture({}, { provider: 'circleci' })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site',
    commit: f.commit, suite: 'integration', scope: 'full' })
  if (reason === 'unknown outcome') f.circle.runView = { phase: 'ended', workflows: [] }
  else f.circle.lookupError = 'error: Run run-1 has no active workflows'
  expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }))
    .toMatchObject({ run: { state: 'running', exitCode: null, finishedAt: null } })
  expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
    .toMatchObject({ run: { state: 'running', exitCode: null, finishedAt: null } })
  f.circle.lookupError = ''
  f.circle.runView = null
  f.circle.outcome = 'succeeded'
  f.circle.durations = { 'apps/api/test/a.integration.test.ts': 90 }
  f.advance(4_001)
  expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
    .toMatchObject({ run: { state: 'passed', exitCode: 0 } })
  expect(f.circle.triggered).toHaveLength(1)
})

it.each([false, true])('settles CircleCI cancellation when nothing is active, lookup also ended: %s', async lookupEnded => {
  const f = await fixture({}, { provider: 'circleci' })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site',
    commit: f.commit, suite: 'integration', scope: 'full' })
  f.circle.cancelError = 'error: Run run-1 has no active workflows to cancel.'
  if (lookupEnded) f.circle.lookupError = 'error: Run run-1 has no active workflows to cancel.'
  if (lookupEnded) {
    await expect(f.cloud.handle({ operation: 'cancel', runId })).rejects.toMatchObject({ code: 'CI_CLOUD_RUN_UNREADABLE' })
    f.circle.lookupError = ''
  }
  expect(await confirmCancellation(f, runId))
    .toMatchObject({ operation: 'cancel', run: { state: 'canceled', finishedAt: expect.any(String) } })
  expect(await f.reopen().handle({ operation: 'cancel', runId })).toMatchObject({ run: { state: 'canceled' } })
  expect(f.circle.canceled).toEqual(lookupEnded ? ['run-1', 'run-1'] : ['run-1'])
  expect(f.circle.triggered).toHaveLength(1)
})

it('keeps an accepted CircleCI cancellation while the workflow remains active across restarts', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
  const cancel = { operation: 'cancel', runId } as const
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1 } as const
  await f.cloud.handle(cancel)
  await f.reopen().handle(read)
  await f.reopen().handle(cancel)
  expect(f.circle.canceled).toEqual(['run-1'])
  f.advance(74_999)
  await f.reopen().handle(read)
  expect(f.circle.canceled).toEqual(['run-1'])

  f.advance(1)
  expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'running', finishedAt: null } })
  expect(f.circle.canceled).toEqual(['run-1'])
  f.advance(75_000)
  expect(await f.reopen().handle(cancel)).toMatchObject({ run: { state: 'running', finishedAt: null } })
  expect(f.circle.canceled).toEqual(['run-1'])
  f.circle.runView = { phase: 'ended', current_outcome: 'canceled', workflows: [] }
  f.advance(4_000)
  expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'canceled' } })
  expect(await f.reopen().handle(cancel)).toMatchObject({ run: { state: 'canceled' } })
  expect(f.circle.canceled).toEqual(['run-1'])
  expect(f.circle.triggered).toHaveLength(1)
})

it('retries a CircleCI cancellation that had no active workflow without marking it accepted', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  f.circle.phantoms = 1
  f.circle.cancelError = 'no active workflows'
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
  const cancel = { operation: 'cancel', runId } as const
  expect(await f.cloud.handle(cancel)).toMatchObject({ run: { state: 'starting' } })
  f.circle.cancelError = ''
  await f.reopen().handle(cancel)
  expect(f.circle.canceled).toEqual(['run-1', 'run-1'])
  f.circle.runView = { phase: 'ended', current_outcome: 'canceled', workflows: [] }
  f.advance(75_000)
  expect(await f.reopen().handle(cancel)).toMatchObject({ run: { state: 'canceled' } })
  expect(f.circle.canceled).toEqual(['run-1', 'run-1'])
  expect(f.circle.triggered).toHaveLength(1)
})

it('does not resend an accepted cancellation while waiting for CircleCI workflow creation', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  f.circle.phantoms = 1
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1 } as const
  f.advance(75_000)
  expect(await f.cloud.handle(read)).toMatchObject({ run: { state: 'starting' } })
  expect(f.circle.canceled).toEqual(['run-1'])
  f.advance(4_000)
  expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'starting' } })
  expect(f.circle.canceled).toEqual(['run-1'])
  expect(f.circle.triggered).toHaveLength(1)
})


describe('GitHub Actions CI on a public mirror', () => {
  it('shares one publication across concurrent starts of the same commit', async () => {
    const f = await fixture()
    const git = vi.spyOn(f.git, 'git')
    const services = [f.cloud, f.reopen()]
    const replies = await Promise.all(Array.from({ length: 8 }, (_, index) => services[index % services.length]!.handle({
      operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site',
      commit: f.commit, suite: 'lint', scope: 'full',
    })))
    expect(replies).toHaveLength(8)
    for (const reply of replies) expect(reply).toMatchObject({ operation: 'start', run: { state: 'starting' } })
    expect(f.dispatched).toHaveLength(8)
    const publications = git.mock.calls.filter(([args]) => args[0] === 'push' && args.includes('--force'))
    expect(publications).toHaveLength(1)
  })

  it('dispatches every concurrent start while stale-branch pruning is blocked', async () => {
    const f = await fixture()
    f.mirrorGit('update-ref', 'refs/heads/ci/retired-run', 'main')
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    let pruning = false
    f.cloud.setActiveRunLookup(async () => {
      pruning = true
      await blocked
      return { ids: new Set<string>(), readAt: 0 }
    })
    let completed = 0
    const starts = Promise.all(Array.from({ length: 8 }, () => f.cloud.handle({
      operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site',
      commit: f.commit, suite: 'lint', scope: 'full',
    }).then(reply => {
      completed++
      return reply
    })))
    try {
      await expect.poll(() => pruning, { timeout: 5_000 }).toBe(true)
      await expect.poll(() => f.dispatched.length, { timeout: 5_000 }).toBe(8)
      await expect.poll(() => completed, { timeout: 5_000 }).toBe(8)
    } finally {
      release()
      await starts
    }
    await expect.poll(() => f.mirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/ci/'), { timeout: 5_000 })
      .not.toContain('refs/heads/ci/retired-run')
    expect(f.mirrorGit('rev-parse', `refs/heads/ci/${f.commit}`)).toMatch(/^[a-f0-9]{40}$/)
  })

  it('limits background pruning to once every five minutes per mirror', async () => {
    const f = await fixture()
    f.mirrorGit('update-ref', 'refs/heads/ci/retired-run', 'main')
    let sweeps = 0
    f.cloud.setActiveRunLookup(async () => {
      sweeps++
      return { ids: new Set<string>(), readAt: 0 }
    })
    const start = () => f.cloud.handle({
      operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site',
      commit: f.commit, suite: 'lint', scope: 'full',
    })
    await start()
    await expect.poll(() => sweeps, { timeout: 5_000 }).toBe(1)
    await expect.poll(() => f.mirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/ci/'), { timeout: 5_000 })
      .not.toContain('refs/heads/ci/retired-run')
    await Promise.all(Array.from({ length: 8 }, start))
    expect(sweeps).toBe(1)
    f.advance(5 * 60_000)
    await start()
    await expect.poll(() => sweeps, { timeout: 5_000 }).toBe(2)
  })

  it('uses the admitted mirror even when the workspace settings no longer provide one', async () => {
    const f = await fixture({}, { mirror: false })
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', ciMirror: 'octo/site-ci',
      runId: randomUUID(), repository: 'octo/site', commit: f.commit, suite: 'unit' })
    expect(f.dispatched[0]).toContain('octo/site-ci')
  })

  it('refuses cloud publication when admission explicitly recorded no mirror', async () => {
    const f = await fixture()
    await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', ciMirror: null,
      runId: randomUUID(), repository: 'octo/site', commit: f.commit, suite: 'unit' }))
      .rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE' })
    expect(f.dispatched).toEqual([])
  })

  it.each([
    ['github', 'unit'], ['github', 'integration'], ['circleci', 'unit'], ['circleci', 'integration'],
  ] as const)('runs oversized fragmented %s %s selections with the complete file list', async (provider, suite) => {
    const candidates = Array.from({ length: 600 }, (_, index) =>
      `apps/api/test/fragment${String(index).padStart(3, '0')}.${suite === 'integration' ? 'integration.' : ''}test.ts`)
    const f = await fixture(Object.fromEntries(candidates.map(file => [file, ''])), { provider })
    const runId = randomUUID()
    const files = candidates.filter((_, index) => index % 2 === 0)
    const request = { operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
      suite, scope: 'affected', files }
    const started = await f.cloud.handle(request)
    expect(started).toMatchObject({ run: { state: provider === 'github' ? 'starting' : 'running' } })
    const dispatches = provider === 'github' ? f.dispatched : f.circle.triggered
    expect(dispatches).toHaveLength(1)
    const command = dispatches[0]!
    const ref = command[command.indexOf(provider === 'github' ? '--ref' : '--branch') + 1]!
    const checkout = await f.checkoutMirror(ref)
    const inline = command.find(value => value.startsWith(suite === 'unit' ? 'files=' : 'slice='))
    if (provider === 'github') expect(inline!.slice(inline!.indexOf('=') + 1).length).toBeGreaterThan(500)
    else {
      expect(command.find(value => value.startsWith('partition='))).toMatch(/^partition=sha256:[a-f0-9]{64}$/)
      const manifest = JSON.parse(await readFile(join(checkout, 'ci-dispatch-inputs.json'), 'utf8'))
      expect(manifest[suite === 'unit' ? 'files' : 'slice'].length).toBeGreaterThan(500)
    }
    const runner = await cloudSuiteRunner(checkout, command, provider)
    const result = runner.run()
    expect(result.status, result.stderr).toBe(0)
    const calls = (await readFile(runner.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(calls).toEqual(suite === 'integration' ? [['pnpm', 'test:integration', '--files', ...files]] : [
      ['pnpm', '--filter', '@foreman-code/contracts', 'build'],
      ['--', 'corepack', 'pnpm', '--dir', 'apps/api', 'exec', 'vitest', 'run',
        ...files.map(file => file.slice('apps/api/'.length))],
    ])
    expect(await f.reopen().handle(request)).toMatchObject({ run: { runId } })
    expect(dispatches).toHaveLength(1)
  })

  it('rejects oversized CircleCI inline dispatch parameters before sending a trigger', async () => {
    const f = await fixture({}, { provider: 'circleci' })
    const runId = randomUUID()
    const durations = JSON.stringify({ ['apps/api/test/' + 'sample'.repeat(90) + '.integration.test.ts']: 1 })
    expect(durations.length).toBeGreaterThan(500)
    await expect(f.cloud.provider.dispatch({ mirror: 'octo/site-ci', branch: 'main', runId,
      suite: 'integration', slice: '', durations })).rejects.toMatchObject({
      code: 'CI_CLOUD_UNAVAILABLE', message: expect.stringContaining('durations longer than 500 characters'),
    })
    expect(f.circle.triggered).toEqual([])
    const file = 'apps/api/test/a.integration.test.ts'
    expect(await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
      repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'affected', files: [file] }))
      .toMatchObject({ run: { state: 'running' } })
    expect(f.circle.triggered).toHaveLength(1)
    expect(f.circle.triggered[0]).toContain('slice=s:0')
  })

  it.each(['unit', 'integration'] as const)('starts a sparse %s selection on CircleCI that is too long to list index by index', async suite => {
    const candidates = Array.from({ length: 3000 }, (_, index) =>
      `apps/api/test/spread${String(index).padStart(4, '0')}.${suite === 'integration' ? 'integration.' : ''}test.ts`)
    const f = await fixture(Object.fromEntries(candidates.map(file => [file, ''])), { provider: 'circleci' })
    const files = candidates.filter((_, index) => index % 20 === 7 || index % 400 < 3)
    expect(files.length).toBeGreaterThan(150)
    await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(),
      repository: 'octo/site', commit: f.commit, suite, scope: 'affected', files })).resolves.toMatchObject({ run: { state: 'running' } })
    expect(f.circle.triggered).toHaveLength(1)
    const input = f.circle.triggered[0]!.find(value => value.startsWith(suite === 'unit' ? 'files=' : 'slice='))!
    expect(input.length).toBeLessThanOrEqual(500)
    const inventory = f.run('ls-tree', '-r', '--name-only', 'HEAD').split('\n').sort()
      .filter(file => suite === 'unit' || file.endsWith('.integration.test.ts'))
    expect(selectByIndexes(inventory, input.slice(input.indexOf('=') + 1))).toEqual(files)
  })

  it.each([
    ['started', false], ['failed', false], ['started', true], ['failed', true],
  ] as const)('waits for the second CircleCI job when it is %s in a separate workflow: %s', async (phase, separate) => {
    const f = await fixture({}, { provider: 'circleci' })
    f.circle.runView = { workflows: separate ? [{ jobs: [{ id: 'first' }] }, { jobs: [{ id: 'second' }] }]
      : [{ jobs: [{ id: 'first' }, { id: 'second' }] }] }
    f.circle.jobDetails.first = { phase: 'ended', outcome: 'succeeded' }
    f.circle.jobDetails.second = phase === 'started' ? { phase: 'started' } : { phase: 'ended', outcome: 'failed' }
    const runId = randomUUID()
    const started = await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full' })
    if (started.operation !== 'start') throw new Error('Expected a start reply')
    const main = cloudService(f.cloud, started.run, f.commit)
    const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }
    await main.service.dispatch()
    expect(await main.read()).toMatchObject({ run: { state: phase === 'started' ? 'running' : 'failed' } })
    if (phase === 'started') {
      f.circle.jobDetails.second = { phase: 'ended', outcome: 'failed' }
      f.advance(4_000)
      expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'failed', exitCode: 1 } })
    }
  })

  it('settles a terminal jobless CircleCI workflow instead of waiting forever', async () => {
    const f = await fixture({}, { provider: 'circleci' })
    f.circle.runView = { phase: 'ended', outcome: 'failed', workflows: [{ phase: 'ended', outcome: 'failed', jobs: [] }] }
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full' })
    expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }))
      .toMatchObject({ run: { state: 'failed', exitCode: 1 } })
  })

  it.each(['github', 'circleci'] as const)('selects changes since an explicit base on the %s runner without publishing private history', async provider => {
    const source = 'apps/api/test/value.ts'
    const test = 'apps/api/test/value.integration.test.ts'
    const f = await fixture({ [source]: 'export const value = 1', [test]: "import './value.js'" }, { provider })
    const baseCommit = f.commit
    await f.write(source, 'export const value = 2')
    f.run('add', '.')
    f.run('commit', '-qm', 'change since release')
    const commit = f.run('rev-parse', 'HEAD')
    f.push('main')
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit,
      baseCommit, suite: 'integration', scope: 'affected', defaultBranch: 'unavailable-branch' })
    const command = (provider === 'github' ? f.dispatched : f.circle.triggered)[0]!
    expect(command).toContain('scope=affected')
    expect(command).toContain('slice=')
    expect(command.some(value => value.startsWith('default_branch='))).toBe(false)
    const runnerBaseCommit = command.find(value => value.startsWith('base_commit='))!.slice('base_commit='.length)
    expect(runnerBaseCommit).toMatch(/^[a-f0-9]{40}$/)
    expect(runnerBaseCommit).not.toBe(baseCommit)
    const checkout = await f.checkoutMirror(`refs/heads/ci/${commit}-${baseCommit}`)
    expect(executionSelection({ commit: 'HEAD', baseCommit: runnerBaseCommit, executionSuite: 'integration',
      defaultRef: 'origin/unavailable-branch', cwd: checkout })).toMatchObject({ scope: 'affected', files: [test] })
    expect(f.mirrorGit('log', '--all', '--format=%s')).not.toContain('private history')
    for (const original of [commit, baseCommit]) expect(() => f.mirrorGit('cat-file', '-e', original)).toThrow()
  })

  it.each(['github', 'circleci'] as const)('dispatches a full suite with a persisted reason for invalid bases on %s', async provider => {
    const f = await fixture({}, { provider })
    f.run('commit', '--allow-empty', '-qm', 'later commit')
    const laterCommit = f.run('rev-parse', 'HEAD')
    f.push('main')
    for (const baseCommit of ['f'.repeat(40), laterCommit]) {
      const runId = randomUUID()
      const started = await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
        baseCommit, suite: 'integration', scope: 'affected' })
      if (started.operation !== 'start') throw new Error('Expected a start reply')
      const reason = 'Running full suite: baseCommit is unavailable or is not an ancestor of the resolved commit.'
      if (provider === 'github' && baseCommit === 'f'.repeat(40)) {
        expect(started.run.message).toBe(reason)
        expect(started.run.transport).toBeUndefined()
      } else {
        expectCliRunMessage(started.run, reason)
      }
      const command = (provider === 'github' ? f.dispatched : f.circle.triggered).at(-1)!
      expect(command).toContain('scope=full')
      expect(command.some(value => value.startsWith('base_commit='))).toBe(false)
      const read = await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1024 })
      if (read.operation !== 'read') throw new Error('Expected a read reply')
      expectCliRunMessage(read.run, reason)
    }
  })

  it('selects no changes on a cloud runner when the explicit base equals the resolved commit', async () => {
    const f = await fixture()
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      baseCommit: f.commit, suite: 'integration', scope: 'affected' })
    const command = f.dispatched[0]!
    expect(command).toContain('scope=affected')
    const baseCommit = command.find(value => value.startsWith('base_commit='))!.slice('base_commit='.length)
    const checkout = await f.checkoutMirror(`refs/heads/ci/${f.commit}-${f.commit}`)
    expect(executionSelection({ commit: 'HEAD', baseCommit, executionSuite: 'integration', cwd: checkout }))
      .toMatchObject({ scope: 'affected', files: [] })
  })

  it('retries a CircleCI pipeline with no workflow and follows only the replacement workflow', async () => {
    const f = await fixture({}, { provider: 'circleci' })
    confirmCircleCiCancellation(f)
    f.circle.phantoms = 1
    const runId = randomUUID()
    const start = { operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full', partition: { index: 0, count: 2 } }
    const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 }
    expect(await f.cloud.handle(start)).toMatchObject({ run: { state: 'starting', step: 'dispatch' } })
    f.advance(74_999)
    expect(await f.cloud.handle(read)).toMatchObject({ run: { state: 'starting' } })
    expect(f.circle.triggered).toHaveLength(1)
    f.advance(1)
    await Promise.all([f.cloud.handle(read), f.cloud.handle(read), f.cloud.handle(start)])
    expect(f.circle.triggered).toHaveLength(2)
    expect(f.circle.triggered[1]).toEqual(f.circle.triggered[0])
    expect(await f.cloud.handle(read)).toMatchObject({ run: { state: 'running', step: 'integration' },
      text: expect.stringContaining('Retrying dispatch (2/3)') })
    f.circle.outcome = 'succeeded'
    f.advance(4_000)
    expect(await f.cloud.handle(read)).toMatchObject({ run: { state: 'passed', exitCode: 0 } })
    expect(f.circle.triggered).toHaveLength(2)
  })

  it.each(['github', 'circleci'] as const)('requeues %s after three dispatches create no workflow', async provider => {
    const f = await fixture({}, { provider })
    if (provider === 'circleci') confirmCircleCiCancellation(f)
    f.circle.phantoms = Number.POSITIVE_INFINITY
    const runId = randomUUID()
    const start = { operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full' }
    const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 }
    await f.cloud.handle(start)
    let cloud = f.cloud
    for (let attempt = 0; attempt < 3; attempt++) {
      f.advance(75_000)
      cloud = f.reopen()
      await cloud.handle(read)
    }
    expect(await cloud.handle(read)).toMatchObject({ run: { state: 'queued', step: null, exitCode: null,
      finishedAt: null, message: expect.stringContaining('queued for another computer') },
      text: expect.stringContaining('Dispatch retries exhausted') })
    await cloud.handle(start)
    expect(provider === 'github' ? f.dispatched : f.circle.triggered).toHaveLength(3)
  })

  it('adopts one GitHub run after retrying and cancels duplicate provider runs', async () => {
    const f = await fixture()
    const runId = randomUUID()
    const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 }
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full' })
    f.advance(75_000)
    await f.cloud.handle(read)
    expect(f.dispatched).toHaveLength(2)
    f.github.listed = [{ databaseId: 9, displayTitle: `ci ${runId}` }, { databaseId: 8, displayTitle: `ci ${runId}` }]
    expect(await f.cloud.handle(read)).toMatchObject({ run: { state: 'running' } })
    expect(f.github.canceled).toEqual(['9'])
    f.advance(75_000)
    expect(await f.cloud.handle(read)).toMatchObject({ run: { state: 'running' } })
    expect(f.dispatched).toHaveLength(2)
  })

  it('adopts a GitHub run that appears at the timeout without dispatching again', async () => {
    const f = await fixture()
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full' })
    f.advance(75_000)
    f.github.listed = [{ databaseId: 8, displayTitle: `ci ${runId}` }]
    expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
      .toMatchObject({ run: { state: 'running' } })
    expect(f.dispatched).toHaveLength(1)
  })

  it.each(['github', 'circleci'] as const)('cancels an unstarted %s dispatch without triggering a retry', async provider => {
    const f = await fixture({}, { provider })
    f.circle.phantoms = Number.POSITIVE_INFINITY
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full' })
    f.advance(75_000)
    expect(await confirmCancellation(f, runId)).toMatchObject({ run: { state: 'canceled' } })
    expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
      .toMatchObject({ run: { state: 'canceled' } })
    expect(provider === 'github' ? f.dispatched : f.circle.triggered).toHaveLength(1)
  })

  it('waits for mirror cleanup and its queued cancellation sweep before disposing the fixture', async () => {
    const f = await fixture()
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    let sweeps = 0
    f.cloud.setActiveRunLookup(async () => {
      sweeps++
      await blocked
      return { ids: new Set<string>(), readAt: 0 }
    })
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
      repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full' })
    await expect.poll(() => sweeps).toBe(1)
    f.advance(5 * 60_000)
    await confirmCancellation(f, runId)
    const disposal = f.dispose()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const waiting = await Promise.race([
        disposal.then(() => false),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), 1_000) }),
      ])
      expect(waiting).toBe(true)
    } finally {
      clearTimeout(timer)
      release()
      await disposal
    }
    expect(sweeps).toBe(2)
    expect(f.dispatched).toHaveLength(1)
  })

  it.each(['github', 'circleci'] as const)('leaves omitted files for the %s runner and mirrors the default-branch merge-base without private history', async provider => {
    const source = 'apps/api/test/value.ts'
    const test = 'apps/api/test/value.integration.test.ts'
    const f = await fixture({ [source]: 'export const value = 1', [test]: "import './value.js'" }, { provider })
    f.run('branch', 'release/stable')
    f.push('release/stable')
    f.run('checkout', '-qb', 'feature')
    await f.write(source, 'export const value = 2')
    f.run('add', '.')
    f.run('commit', '-qm', 'feature change')
    const commit = f.run('rev-parse', 'HEAD')
    f.push('feature')
    const partition = { index: 1, count: 2, weights: [2, 1] }
    const durations = { [test]: 500 }
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit,
      suite: 'integration', defaultBranch: 'release/stable', partition, durations })
    const command = (provider === 'github' ? f.dispatched : f.circle.triggered)[0]!
    expect(command).toContain('scope=affected')
    expect(command).toContain('slice=')
    expect(command).toContain(`default_branch=ci-default/${commit}`)
    expect(command).toContain(`partition=${JSON.stringify(partition)}`)
    expect(command).toContain(`durations=${JSON.stringify(durations)}`)
    expect(command.some(value => value.startsWith('files='))).toBe(false)
    const branch = `refs/heads/ci/${commit}`
    const defaultBranch = `refs/heads/ci-default/${commit}`
    const base = f.mirrorGit('merge-base', branch, defaultBranch)
    expect(f.mirrorGit('diff', '--name-only', base, branch)).toBe(source)
    expect(f.mirrorGit('log', '--all', '--format=%s')).not.toContain('private history')
    expect(() => f.mirrorGit('cat-file', '-e', commit)).toThrow()
    const checkout = await f.checkoutMirror(branch)
    expect(affectedSnapshot('HEAD', 'integration', checkout, `origin/ci-default/${commit}`))
      .toMatchObject({ scope: 'affected', files: [test] })
  })

  it('mirrors the default branch head as the same comparison commit so the cloud selector reports a full run', async () => {
    const f = await fixture()
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'integration' })
    const branch = `refs/heads/ci/${f.commit}`
    expect(f.mirrorGit('rev-parse', branch)).toBe(f.mirrorGit('rev-parse', `refs/heads/ci-default/${f.commit}`))
    const checkout = await f.checkoutMirror(branch)
    expect(affectedSnapshot('HEAD', 'integration', checkout, `origin/ci-default/${f.commit}`))
      .toMatchObject({ scope: 'full', reason: 'The commit is the workspace default branch head.' })
  })

  it.each(['github', 'circleci'] as const)('declines %s when its mirror lacks workflow files without publishing', async provider => {
    const f = await fixture({}, { provider, mirrorWorkflows: false })
    const head = f.mirrorGit('rev-parse', 'main')
    await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site',
      commit: f.commit, suite: 'integration' })).rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE' })
    expect(f.dispatched).toHaveLength(0)
    expect(f.circle.triggered).toHaveLength(0)
    expect(f.mirrorGit('rev-parse', 'main')).toBe(head)
  })

  it.each(['github', 'circleci'] as const)('preserves both mirror workflows for a repository without them on %s', async provider => {
    const manifest = JSON.stringify({ scripts: { build: 'node build.mjs', lint: 'node lint.mjs', unit: 'node unit.mjs' } })
    const f = await fixture({ 'package.json': manifest }, { provider, sourceWorkflows: false })
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site',
      commit: f.commit, suite: provider === 'github' ? 'build' : 'integration' })
    const commands = provider === 'github' ? f.dispatched : f.circle.triggered
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain(`suite=${provider === 'github' ? 'build' : 'integration'}`)
    expect(commands[0]).toContain('slice=')
    expect(f.mirrorGit('show', 'main:package.json')).toBe(manifest)
    expect(f.mirrorGit('show', 'main:.github/workflows/ci.yml')).toBe('name: CI\non: workflow_dispatch')
    expect(f.mirrorGit('show', 'main:.circleci/config.yml')).toBe('version: 2.1')
    expect(() => f.mirrorGit('cat-file', '-e', f.commit)).toThrow()
  })

  it.each(['github', 'circleci'] as const)('refuses a host partition on %s before publishing or dispatching', async provider => {
    const f = await fixture({}, { provider, userSystemd: false })
    const head = f.mirrorGit('rev-parse', 'main')
    await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site',
      commit: f.commit, suite: 'integration', scope: 'full',
      partition: { index: 0, count: 2, hostIndexes: [0] } })).rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE' })
    expect(f.dispatched).toHaveLength(0)
    expect(f.circle.triggered).toHaveLength(0)
    expect(f.mirrorGit('rev-parse', 'main')).toBe(head)
  })

  it.each(['github', 'circleci'] as const)('runs installed Worker fixtures but excludes user-systemd files on %s', async provider => {
    const systemd = [
      'apps/api/test/workflow-systemd-installed-service.integration.test.ts',
      'apps/api/test/workflow-systemd-active-recovery.integration.test.ts',
      'apps/api/test/workflow-systemd-writable-source-recovery.integration.test.ts',
      'apps/api/test/workflow-systemd-restart-unit-cleanup.integration.test.ts',
      'apps/api/test/native-service-restart.integration.test.ts',
    ]
    const cloud = [
      'apps/api/test/workflow-systemd-restart.integration.test.ts',
      'apps/api/test/remote-review-production-main-crash.integration.test.ts',
    ]
    const f = await fixture(Object.fromEntries([...systemd, ...cloud].map(file => [file, ''])), { provider })
    const ordinary = [...cloud, ...['a', 'b', 'c', 'd'].map(name => `apps/api/test/${name}.integration.test.ts`)]
    const inventory = [...ordinary, ...systemd].sort()
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full', partition: { index: 1, count: 2, hostIndexes: [0] } })
    const commands = provider === 'github' ? f.dispatched : f.circle.triggered
    expect(commands).toHaveLength(1)
    const slice = selectByIndexes(inventory, commands[0]!.find(value => value.startsWith('slice='))!.slice('slice='.length))
    // Ordinary work is balanced over every slice, but the user-systemd files stay on the build computer's slice.
    expect(slice).toEqual(expect.arrayContaining(cloud))
    expect(slice.filter(file => systemd.includes(file))).toEqual([])
    expect(slice.every(file => ordinary.includes(file))).toBe(true)
  })

  it.each(['github', 'circleci'] as const)('rejects user-systemd files without host metadata on %s', async provider => {
    const file = 'apps/api/test/native-service-restart.integration.test.ts'
    const f = await fixture({ [file]: '' }, { provider, userSystemd: false })
    await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site',
      commit: f.commit, suite: 'integration', scope: 'affected', files: [file] }))
      .rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE' })
    await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site',
      commit: f.commit, suite: 'integration', scope: 'affected', files: [file], partition: { index: 0, count: 2 } }))
      .rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE' })
    expect(f.dispatched).toHaveLength(0)
    expect(f.circle.triggered).toHaveLength(0)
  })

  it.each(['github', 'circleci'] as const)('dispatches systemd slices and single files when %s declares support', async provider => {
    const file = 'apps/api/test/native-service-restart.integration.test.ts'
    const f = await fixture({ [file]: '' }, { provider })
    expect(f.cloud.computers()[0]?.userSystemd).toEqual({ supported: true, reason: null })
    expect(await f.cloud.handle({ operation: 'status' }))
      .toMatchObject({ userSystemd: { supported: true, reason: null } })
    for (const partition of [undefined, { index: 0, count: 2, hostIndexes: [0] }]) {
      await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site',
        commit: f.commit, suite: 'integration', scope: 'affected', files: [file],
        ...(partition ? { partition } : {}) })
    }
    const commands = provider === 'github' ? f.dispatched : f.circle.triggered
    expect(commands).toHaveLength(2)
    for (const command of commands) {
      const slice = command.find(value => value.startsWith('slice='))!.slice('slice='.length)
      const inventory = ['a', 'b', 'c', 'd', 'native-service-restart']
        .map(name => `apps/api/test/${name}.integration.test.ts`).sort()
      expect(selectByIndexes(inventory, slice)).toEqual([file])
    }
  })

  it.each(['github', 'circleci'] as const)('spreads heavy integration files across every %s slice', async provider => {
    const heavy = [
      'apps/api/test/remote-review-production-main-crash.integration.test.ts',
      'apps/api/test/computer-workflow-save.regression-directories.integration.test.ts',
      'apps/api/test/local-human-native.integration.test.ts',
      'apps/api/test/native-stream-lifecycle.integration.test.ts',
    ]
    const f = await fixture(Object.fromEntries(heavy.map(file => [file, ''])), { provider })
    const inventory = [...['a', 'b', 'c', 'd'].map(name => `apps/api/test/${name}.integration.test.ts`), ...heavy].sort()
    const durations = Object.fromEntries(heavy.map((file, index) => [file, 80 - index * 20]))
    for (const index of [0, 1, 2, 3]) {
      await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
        suite: 'integration', scope: 'full', durations, partition: { index, count: 4, weights: [8, 1, 1, 1] } })
    }
    const commands = provider === 'github' ? f.dispatched : f.circle.triggered
    const slices = commands.map(command => selectByIndexes(inventory,
      command.find(value => value.startsWith('slice='))!.slice('slice='.length)))
    expect(slices.flat().sort()).toEqual(inventory)
    expect(slices.map(slice => slice.filter(file => heavy.includes(file)).length)).toEqual([1, 1, 1, 1])
    expect(slices[0]).toContain(heavy[0])
    expect(slices[1]).toContain(heavy[1])
  })

  it.each(['github'] as const)('dispatches unit part names and one-based shards through %s', async provider => {
    const f = await fixture({}, { provider })
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'unit', scope: 'full', part: 'unit-web', partition: { index: 1, count: 3 } })
    const command = provider === 'github' ? f.dispatched[0]! : f.circle.triggered[0]!
    expect(command).toContain('suite=unit-web')
    expect(command).toContain('slice=2/3')
  })

  it.each(['github'] as const)('passes already sharded affected files to the unit part through %s', async provider => {
    const f = await fixture({ 'apps/api/test/feature.test.ts': 'export {}' }, { provider })
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'unit', part: 'unit-api', scope: 'affected', files: ['apps/api/test/feature.test.ts'],
      partition: { index: 1, count: 2 } })
    const command = provider === 'github' ? f.dispatched[0]! : f.circle.triggered[0]!
    expect(command).toContain('suite=unit-api')
    expect(command).toContain('slice=')
    expect(command).toContain('scope=affected')
    expect(command).toContain('files=s:6')
  })

  it.each(['github'] as const)('reads measured unit durations from %s artifacts', async provider => {
    const f = await fixture({}, { provider })
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
      suite: 'unit', scope: 'full', part: 'unit-api', partition: { index: 0, count: 5 } })
    const durations = { 'apps/api/test/feature.test.ts': 250 }
    f.github.listed = [{ databaseId: 8, displayTitle: `ci ${runId}` }]
    f.github.status = 'completed'
    f.github.conclusion = 'success'
    f.github.durations = durations
    f.circle.outcome = 'succeeded'
    f.circle.durations = durations
    expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536, durations: true }))
      .toMatchObject({ run: { state: 'passed', step: 'unit-api' }, durations })
  })
  it.each(['github', 'circleci'] as const)('reads integration test results from %s artifacts', async provider => {
    const f = await fixture({}, { provider })
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full' })
    const durations = { 'apps/api/test/a.integration.test.ts': 250 }
    const testResults = { summary: { passed: 0, failed: 1, skipped: 0 }, truncated: false, files: [
      { file: 'apps/api/test/a.integration.test.ts', status: 'failed', durationMs: 250,
        tests: [{ name: 'a saves', status: 'failed', durationMs: 20, message: 'expected 1 to be 2' }] }] }
    f.github.listed = [{ databaseId: 9, displayTitle: `ci ${runId}` }]
    f.github.status = 'completed'
    f.github.conclusion = 'failure'
    f.circle.outcome = 'failed'
    for (const service of [f.github, f.circle]) Object.assign(service, { durations, testResults })
    const read = await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536, durations: true,
      testResults: true })
    expect(read).toMatchObject({ run: { state: 'failed' }, durations, testResults })
    // A restarted Main still answers from the kept result; a read that does not ask for test results stays lean.
    const plain = await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1, durations: true })
    expect(plain.operation === 'read' && 'testResults' in plain).toBe(false)
    expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1, testResults: true }))
      .toMatchObject({ testResults })
  })

  it('encodes affected integration files against the complete commit inventory before partitioning', async () => {
    const f = await fixture()
    const files = ['apps/api/test/b.integration.test.ts', 'apps/api/test/d.integration.test.ts']
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'affected', files, partition: { index: 0, count: 2 } })
    expect(f.dispatched[0]).toContain('slice=s:1')
    expect(f.dispatched[0]).toContain('scope=affected')
  })

  it.each(['github'] as const)('passes affected unit scope and compact file indexes through %s', async provider => {
    const f = await fixture({ 'apps/api/test/feature.test.ts': 'export {}' }, { provider })
    const files = ['apps/api/test/feature.test.ts']
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'unit', scope: 'affected', files })
    const command = provider === 'github' ? f.dispatched[0]! : f.circle.triggered[0]!
    expect(command).toContain('scope=affected')
    expect(command).toContain('files=s:6')
  })
  it('keeps a newly accepted CircleCI pipeline starting until its run becomes visible', async () => {
    const f = await fixture({}, { provider: 'circleci' })
    f.circle.lookupError = 'run.not_found'
    const runId = randomUUID()
    expect(await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full' })).toMatchObject({ run: { state: 'starting' } })
    f.advance(74_999)
    expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
      .toMatchObject({ run: { state: 'starting' } })
    expect(f.circle.triggered).toHaveLength(1)
    f.circle.lookupError = ''
    f.advance(4_000)
    expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
      .toMatchObject({ run: { state: 'running' } })
  })

  it('waits for status-triggered CircleCI recovery before the cloud fixture dispatch settles', async () => {
    const f = await fixture({}, { provider: 'circleci' })
    f.circle.lookupError = 'run.not_found'
    const runId = randomUUID()
    const started = await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
      repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full' })
    if (started.operation !== 'start') throw new Error('Expected a start reply')
    const main = cloudService(f.cloud, started.run, f.commit)
    await main.service.dispatch()
    await f.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
    const lookupEntered = deferred()
    const releaseLookup = deferred()
    const cancellationEntered = deferred()
    const releaseCancellation = deferred()
    const run = f.ports.run.bind(f.ports)
    vi.spyOn(f.ports, 'run').mockImplementation(async (file, args, options) => {
      if (file === 'circleci' && args[0] === 'run' && args[1] === 'get') {
        lookupEntered.resolve()
        await releaseLookup.promise
      }
      const result = await run(file, args, options)
      if (file === 'circleci' && args[0] === 'run' && args[1] === 'cancel') {
        cancellationEntered.resolve()
        await releaseCancellation.promise
      }
      return result
    })
    f.advance(75_000)
    await f.cloud.handle({ operation: 'status' })
    await lookupEntered.promise
    const dispatching = main.service.dispatch()
    try {
      // Main can finish its journal observation while the status-triggered provider read is blocked.
      await main.service.drain()
      releaseLookup.resolve()
      const first = await Promise.race([
        dispatching.then(() => 'dispatch'),
        cancellationEntered.promise.then(() => 'cancel'),
      ])
      expect(first).toBe('cancel')
      expect(f.circle.canceled).toEqual(['run-1'])
    } finally {
      releaseLookup.resolve()
      releaseCancellation.resolve()
      await dispatching
      await main.service.close()
      await f.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
    }
  })

  it('requeues an unreadable unstarted CircleCI ticket and releases its Main slot', async () => {
    const f = await fixture({}, { provider: 'circleci' })
    f.circle.lookupError = 'run.not_found'
    const runId = randomUUID()
    const started = await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
      repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full' })
    if (started.operation !== 'start') throw new Error('Expected a start reply')
    const main = cloudService(f.cloud, started.run, f.commit)
    const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 }
    await main.service.dispatch()
    expect(await main.read()).toMatchObject({ run: { state: 'starting', computer: { label: 'CircleCI' } } })
    f.advance(70_000)
    await main.service.dispatch()
    expect(await main.read()).toMatchObject({ run: { state: 'starting', computer: { label: 'CircleCI' } } })
    expect(f.circle.canceled).toEqual([])
    f.advance(5_000)
    await main.service.dispatch()
    expect(await main.read()).toMatchObject({ run: { state: 'starting', computer: { label: 'CircleCI' } } })
    expect(f.circle.canceled).toEqual(['run-1'])
    f.circle.lookupError = ''
    f.circle.runView = { phase: 'ended', current_outcome: 'canceled', workflows: [] }
    f.advance(75_001)
    await main.service.dispatch()
    expect(await main.read()).toMatchObject({ run: { state: 'queued', computer: null,
      startedAt: null, finishedAt: null, exitCode: null, unstartedProviders: ['circleci'],
      messageHistory: expect.arrayContaining([expect.stringContaining('queued for another computer')]) } })
    expect(f.circle.triggered).toHaveLength(1)
    expect(f.circle.canceled).toEqual(['run-1'])
    expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'queued',
      message: expect.stringContaining('queued for another computer') } })
    await main.service.dispatch()
    expect(await main.read()).toMatchObject({ run: { state: 'queued', computer: null } })
    expect(f.circle.triggered).toHaveLength(1)
    expect(f.circle.canceled).toEqual(['run-1'])
  })

  it('recovers a transiently missing CircleCI lookup before its reconciliation budget is spent', async () => {
    const f = await fixture({}, { provider: 'circleci' })
    f.circle.lookupError = 'run.not_found'
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full' })
    const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }
    f.advance(40_000)
    expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'starting', finishedAt: null,
      message: expect.stringContaining('could not be reconciled') } })
    f.advance(30_000)
    expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'starting', finishedAt: null } })
    expect(f.circle.canceled).toEqual([])
    f.circle.lookupError = ''
    f.circle.outcome = 'failed'
    f.advance(4_000)
    expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'failed', exitCode: 1 } })
    expect(f.circle.triggered).toHaveLength(1)
    expect(f.circle.canceled).toEqual([])
  })

  it.each(['starting', 'running'] as const)(
    'cancels the known CircleCI pipeline from %s when discovery is unavailable and persists the cancellation',
    async state => {
      const f = await fixture({}, { provider: 'circleci' })
      if (state === 'starting') f.circle.phantoms = Number.POSITIVE_INFINITY
      const runId = randomUUID()
      expect(await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
        repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full' }))
        .toMatchObject({ run: { state } })
      f.circle.lookupError = 'run.not_found'
      f.advance(75_000)
      const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }
      expect(await f.reopen().handle(read)).toMatchObject({ run: { state, finishedAt: null } })
      await expect(f.reopen().handle({ operation: 'cancel', runId })).rejects.toMatchObject({ code: 'CI_CLOUD_RUN_NOT_FOUND' })
      expect(f.circle.canceled).toEqual(['run-1'])
      f.circle.lookupError = ''
      const canceled = await confirmCancellation(f, runId)
      expect(canceled).toMatchObject({ operation: 'cancel', run: { state: 'canceled' } })
      if (canceled.operation !== 'cancel') throw new Error('Expected a cancel reply')
      expectCliRunMessage(canceled.run, 'Canceled.')
      expect(f.circle.canceled).toEqual(['run-1'])
      expect(await f.reopen().handle({ operation: 'cancel', runId }))
        .toMatchObject({ run: { state: 'canceled' } })
      f.advance(4_000)
      expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'canceled' } })
      expect(f.circle.canceled).toEqual(['run-1'])
      expect(f.circle.triggered).toHaveLength(1)
    },
  )

  it('retains ownership within the visibility window and requeues a disappeared CircleCI pipeline', async () => {
    const f = await fixture({}, { provider: 'circleci' })
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full' })
    f.circle.lookupError = 'run.not_found'
    const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }
    for (let attempt = 0; attempt < 3; attempt++) {
      f.advance(4_000)
      expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'running', finishedAt: null,
        message: expect.stringContaining('could not be reconciled') } })
    }
    expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'running',
      message: expect.stringContaining('Retrying lookup') } })
    expect(f.circle.triggered).toHaveLength(1)
    expect(f.circle.canceled).toEqual([])
    f.advance(75_000)
    expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'running', finishedAt: null } })
    expect(f.circle.canceled).toEqual(['run-1'])
    f.circle.lookupError = ''
    f.circle.runView = { phase: 'ended', current_outcome: 'canceled', workflows: [] }
    f.advance(75_001)
    expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'queued', finishedAt: null } })
    expect(f.circle.canceled).toEqual(['run-1'])
    expect(f.circle.triggered).toHaveLength(1)
  })

  it('does not suppress CircleCI permission failures', async () => {
    const f = await fixture({}, { provider: 'circleci' })
    f.circle.lookupError = 'permission denied'
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full' })
    await expect(f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
      .resolves.toMatchObject({ run: { state: 'starting', finishedAt: null,
        message: expect.stringContaining('permission denied') } })
    await expect(f.reopen().handle({ operation: 'cancel', runId }))
      .rejects.toMatchObject({ code: 'CI_CLOUD_RUN_UNREADABLE' })
    f.circle.lookupError = ''
    await expect(confirmCancellation(f, runId)).resolves.toMatchObject({ run: { state: 'canceled' } })
  })

  it('publishes only the commit files, then dispatches one run with its partition slice', async () => {
    const f = await fixture()
    const runId = randomUUID()
    const started = await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
      suite: 'integration', scope: 'full', partition: { index: 0, count: 2 } })
    expect(started).toMatchObject({ operation: 'start', run: { runId, state: 'starting' } })
    const branch = `refs/heads/ci/${f.commit}`
    // Same files, one new commit on the mirror's import; the private history never leaves.
    expect(f.mirrorGit('rev-parse', `${branch}^{tree}`)).toBe(f.run('rev-parse', 'HEAD^{tree}'))
    expect(f.mirrorGit('rev-list', '--count', branch)).toBe('2')
    expect(() => f.mirrorGit('cat-file', '-e', f.commit)).toThrow()
    expect(f.mirrorGit('rev-parse', 'refs/heads/main')).toBe(f.mirrorGit('rev-parse', branch))
    const workflowRef = `ci-snapshot/${f.mirrorGit('rev-parse', branch)}`
    expect(f.dispatched).toEqual([['workflow', 'run', 'ci.yml', '-R', 'octo/site-ci', '--ref', workflowRef, '-f', `ref=${workflowRef}`,
      '-f', `run_id=${runId}`, '-f', 'suite=integration',
      '-f', 'slice=s:0,2', '-f', 'expected_duration_ms=0', '-f', 'scope=full']])
    // A retried start returns the same run without dispatching again.
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full',
      partition: { index: 0, count: 2 } })
    expect(f.dispatched).toHaveLength(1)
  })

  it('publishes concurrent runs of different commits from two services to one mirror without losing a push', async () => {
    const f = await fixture()
    const commits: string[] = []
    for (const name of ['one', 'two', 'three', 'four', 'five', 'six']) {
      await f.write(`${name}.txt`, `${name}\n`); f.run('add', '.'); f.run('commit', '-qm', name)
      commits.push(f.run('rev-parse', 'HEAD')); f.push(`HEAD:refs/heads/${name}`)
    }
    const other = f.reopen()
    const started = await Promise.allSettled(commits.map((commit, index) => (index % 2 ? other : f.cloud).handle({
      operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit, suite: 'unit' })))
    expect(started.map(result => result.status === 'rejected' ? String(result.reason) : 'started'))
      .toEqual(commits.map(() => 'started'))
    for (const commit of commits) {
      expect(f.mirrorGit('rev-parse', `refs/heads/ci/${commit}^{tree}`)).toBe(f.run('rev-parse', `${commit}^{tree}`))
    }
    expect(commits.map(commit => f.mirrorGit('rev-parse', `refs/heads/ci/${commit}`)))
      .toContain(f.mirrorGit('rev-parse', 'refs/heads/main'))
  })

  it('finds the default-branch merge-base through shallow caches after the default branch moved on', async () => {
    const source = 'apps/api/test/value.ts'
    const test = 'apps/api/test/value.integration.test.ts'
    const f = await fixture({ [source]: 'export const value = 1', [test]: "import './value.js'" })
    const fixtureGit = f.git.git
    // Main's git cache clones and fetches shallowly, so the branch tip alone shares no history with the feature.
    f.git.git = (args, options) => fixtureGit(args[0] === 'clone' ? ['clone', '--no-local', '--depth=1', ...args.slice(1)]
      : args[0] === 'fetch' && args.includes('origin') ? ['fetch', '--depth=1', ...args.slice(1)] : args, options)
    f.run('checkout', '-qb', 'feature')
    await f.write(source, 'export const value = 2')
    f.run('add', '.')
    f.run('commit', '-qm', 'feature change')
    const commit = f.run('rev-parse', 'HEAD')
    f.push('feature')
    f.run('checkout', '-q', 'main')
    for (const name of ['one', 'two', 'three']) {
      await f.write(`${name}.txt`, name)
      f.run('add', '.')
      f.run('commit', '-qm', name)
    }
    f.push('main')
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit,
      suite: 'integration', defaultBranch: 'main' })
    const command = f.dispatched[0]!
    expect(command).toContain('scope=affected')
    expect(command).toContain(`default_branch=ci-default/${commit}`)
  })

  it('verifies an explicit base through shallow caches', async () => {
    const source = 'apps/api/test/value.ts'
    const test = 'apps/api/test/value.integration.test.ts'
    const f = await fixture({ [source]: 'export const value = 1', [test]: "import './value.js'" })
    const fixtureGit = f.git.git
    f.git.git = (args, options) => fixtureGit(args[0] === 'clone' ? ['clone', '--no-local', '--depth=1', ...args.slice(1)]
      : args[0] === 'fetch' && args.includes('origin') ? ['fetch', '--depth=1', ...args.slice(1)] : args, options)
    const baseCommit = f.commit
    await f.write(source, 'export const value = 2')
    f.run('add', '.')
    f.run('commit', '-qm', 'change since release')
    const commit = f.run('rev-parse', 'HEAD')
    f.push('main')
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit,
      baseCommit, suite: 'integration', scope: 'affected' })
    const command = f.dispatched[0]!
    expect(command).toContain('scope=affected')
    expect(command.some(value => value.startsWith('base_commit='))).toBe(true)
  })

  it('publishes again from a shallow source clone after the mirror moved on', async () => {
    const f = await fixture()
    const fixtureGit = f.git.git
    // Main's git cache clones and fetches shallowly.
    f.git.git = (args, options) => fixtureGit(args[0] === 'clone' ? ['clone', '--no-local', '--depth=1', ...args.slice(1)]
      : args[0] === 'fetch' && args.includes('origin') ? ['fetch', '--depth=1', ...args.slice(1)] : args, options)
    const start = (commit: string) => f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(),
      repository: 'octo/site', commit, suite: 'unit' })
    await start(f.commit)
    // Another computer publishes to the same mirror.
    f.mirrorGit('update-ref', 'refs/heads/main', f.mirrorGit('commit-tree', 'main^{tree}', '-p', 'main', '-m', 'elsewhere'))
    const commits: string[] = []
    for (const name of ['two', 'three']) {
      await f.write(`${name}.txt`, `${name}\n`); f.run('add', '.'); f.run('commit', '-qm', name); f.push('HEAD:refs/heads/main')
      commits.push(f.run('rev-parse', 'HEAD'))
      await expect(start(commits.at(-1)!)).resolves.toMatchObject({ operation: 'start', run: { state: 'starting' } })
    }
    for (const commit of commits) {
      expect(f.mirrorGit('rev-parse', `refs/heads/ci/${commit}^{tree}`)).toBe(f.run('rev-parse', `${commit}^{tree}`))
    }
    // The persistent mirror clone reaches only objects it owns.
    expect(await fixtureGit(['fsck', '--connectivity-only'], { cwd: join(f.root, 'clones', 'octo', 'site-ci'),
      signal: AbortSignal.timeout(30_000) })).toMatchObject({ code: 0 })
  })

  it("reports git's reason when the mirror cannot be read", async () => {
    const f = await fixture()
    f.mirrorGit('update-ref', '-d', 'refs/heads/main')
    await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'unit' })).rejects.toMatchObject({ code: 'CI_CLOUD_FAILED',
      message: expect.stringMatching(/^git fetch failed for the CI mirror\. .*main/) })
    expect(f.dispatched).toEqual([])
  })

  it('follows the GitHub run to its result, log and measured durations', async () => {
    const f = await fixture()
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full',
      partition: { index: 1, count: 2 } })
    const read = () => f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536, durations: true })
    expect(await read()).toMatchObject({ run: { state: 'starting' } })
    f.github.listed = [{ databaseId: 7, displayTitle: 'ci another' }, { databaseId: 8, displayTitle: `ci ${runId}` }]
    expect(await read()).toMatchObject({ run: { state: 'running', step: 'integration' } })
    f.github.status = 'completed'; f.github.conclusion = 'success'
    f.github.durations = { 'apps/api/test/b.integration.test.ts': 250 }
    f.advance(4_000)
    expect(await read()).toMatchObject({ run: { state: 'passed', exitCode: 0 }, text: 'ci\tSuite\tall green\n',
      durations: { 'apps/api/test/b.integration.test.ts': 250 } })
  })

  it.each([
    ['the home path', { 'notes.md': 'see /home/owner/projects\n' }],
    ['a computer name', { 'docs.md': 'Run it on Builder first.\n' }],
    ['a Tailscale address', { 'hosts.txt': 'ssh 100.90.1.3\n' }],
    ['the tailnet domain', { 'hosts.txt': 'owner-desktop.tail0000.ts.net\n' }],
  ])('refuses to publish files naming %s', async (_kind, files) => {
    const f = await fixture(files)
    await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'unit' })).rejects.toMatchObject({ code: 'CI_MIRROR_PRIVATE_DATA', message: expect.stringContaining(Object.keys(files)[0]!) })
    expect(() => f.mirrorGit('rev-parse', '--verify', `refs/heads/ci/${f.commit}`)).toThrow()
    expect(f.dispatched).toEqual([])
  })

  it('leaves a run without a mirror to the build computers', async () => {
    const f = await fixture({}, { mirror: false })
    await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site', commit: f.commit,
      suite: 'unit' })).rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE' })
  })

  it('shows the running GitHub step live and asks GitHub again only when its jobs changed', async () => {
    const f = await fixture()
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full' })
    f.github.listed = [{ databaseId: 8, displayTitle: `ci ${runId}` }]
    f.github.steps = [{ number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' },
      { number: 2, name: 'Cache', status: 'completed', conclusion: 'skipped' },
      { number: 3, name: 'Suite', status: 'in_progress', conclusion: null }]
    const read = () => f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 })
    expect(await read()).toMatchObject({ run: { state: 'running', step: 'Suite' }, text: '==> Set up job\n==> Suite\n' })
    // Reads within the poll interval answer from the kept state without asking GitHub.
    expect(await read()).toMatchObject({ run: { step: 'Suite' } })
    expect(f.github.jobReads).toEqual(['full'])
    f.advance(4_000)
    expect(await read()).toMatchObject({ run: { step: 'Suite' }, text: '==> Set up job\n==> Suite\n' })
    expect(f.github.jobReads).toEqual(['full', 'unchanged'])
    f.github.steps[2] = { number: 3, name: 'Suite', status: 'completed', conclusion: 'failure' }
    f.github.status = 'completed'; f.github.conclusion = 'failure'
    f.advance(4_000)
    const done = await read()
    expect(done).toMatchObject({ run: { state: 'failed', step: 'integration' } })
    expect(done.operation === 'read' && done.text).toBe(
      '==> Set up job\n==> Suite\n==> Suite failed\n--- GitHub Actions log ---\nci\tSuite\tall green\n')
  })

  it('pauses polling while the service rate limit is spent and resumes after the backoff', async () => {
    const f = await fixture()
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full' })
    f.github.listed = [{ databaseId: 8, displayTitle: `ci ${runId}` }]
    const read = () => f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 })
    expect(await read()).toMatchObject({ run: { state: 'running' } })
    f.github.rateLimited = true
    f.advance(4_000)
    expect(await read()).toMatchObject({ run: { state: 'running' } })
    f.github.rateLimited = false
    f.github.status = 'completed'; f.github.conclusion = 'success'
    const reads = f.github.jobReads.length
    f.advance(29_000)
    expect(await read()).toMatchObject({ run: { state: 'running' } })
    expect(f.github.jobReads).toHaveLength(reads)
    f.advance(1_000)
    expect(await read()).toMatchObject({ run: { state: 'passed' } })
  })
})


it.each((['github', 'circleci'] as const).flatMap(provider => [
  { provider, reason: 'CI hang watchdog: no test progress for 60000 ms; running: loop.test.ts > planner never returns',
    expected: 'CI hang watchdog: no test progress for 60000 ms; running: loop.test.ts > planner never returns' },
  { provider, reason: 'CI hang watchdog:\0 café 🚀\ud800', expected: 'CI hang watchdog: café 🚀\ufffd' },
]))('keeps a valid watchdog reason and expected deadline on $provider: $expected', async ({ provider, reason, expected }) => {
  const f = await fixture({}, { provider })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
    suite: 'unit', scope: 'full', expectedDurationMs: 210_000 })
  const command = provider === 'github' ? f.dispatched[0]! : f.circle.triggered[0]!
  expect(command).toContain('expected_duration_ms=210000')
  f.github.listed = [{ databaseId: 91, displayTitle: `ci ${runId}` }]
  f.github.status = 'completed'
  f.github.conclusion = 'failure'
  f.github.log = `ci\tSuite\t[ci-watchdog] ${reason}\n`
  f.github.watchdogFailure = { message: reason }
  f.circle.outcome = 'failed'
  f.circle.output = `[ci-watchdog] ${reason}\n`
  f.circle.log = f.circle.output
  f.circle.watchdogFailure = { message: reason }
  const result = await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 })
  expect(result).toMatchObject({ run: { state: 'failed' }, text: expect.stringContaining(expected) })
  if (result.operation !== 'read') throw new Error('Expected a read reply')
  expectCliRunMessage(result.run, expected)
  expect(result.text).not.toContain('\0')
  const readback = await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 })
  expect(readback).toMatchObject({ run: { state: 'failed' }, text: expect.stringContaining(expected) })
  if (readback.operation !== 'read') throw new Error('Expected a read reply')
  expectCliRunMessage(readback.run, expected)
})
