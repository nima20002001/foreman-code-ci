import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fixture } from './cloud.testSupport.js'
import { GitHubActionsProvider, type CloudRun } from './cloudProviders.js'
import { systemHostCiPorts } from './runner.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile), open: vi.fn(actual.open) }
})
afterEach(() => vi.restoreAllMocks())

it('limits pruning across terminal ticket reads and still removes released branches on the next sweep', async () => {
  const f = await fixture()
  let sweeps = 0
  f.cloud.setActiveRunLookup(async () => {
    sweeps++
    return { ids: new Set<string>(), readAt: 0 }
  })
  f.mirrorGit('update-ref', 'refs/heads/ci/retired-run', 'main')
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site',
    commit: f.commit, suite: 'lint', scope: 'full' })
  await expect.poll(() => sweeps).toBe(1)
  await expect.poll(() => f.mirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/ci/'))
    .not.toContain('refs/heads/ci/retired-run')
  f.github.listed = [{ databaseId: 8, displayTitle: `ci ${runId}` }]
  f.github.status = 'completed'
  f.github.conclusion = 'success'
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1 }
  expect(await f.cloud.handle(read)).toMatchObject({ run: { state: 'passed' } })
  await Promise.all(Array.from({ length: 12 }, () => f.cloud.handle(read)))
  expect(sweeps).toBe(1)
  f.advance(5 * 60_000)
  await f.cloud.handle(read)
  await expect.poll(() => f.mirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/ci/')).toBe('')
  expect(sweeps).toBe(2)
})

it('reads only the requested cloud log range with UTF-8 byte cursors and a metadata-only read', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site',
    commit: f.commit, suite: 'lint', scope: 'full' })
  const path = join(f.root, 'ci-cloud', 'runs', runId, 'log')
  const prefix = 'x'.repeat(2 * 1024 * 1024)
  const bytes = Buffer.from(`${prefix}café 🚀\n`)
  await fs.writeFile(path, bytes)
  vi.mocked(fs.readFile).mockClear()
  vi.mocked(fs.open).mockClear()
  const rangeReads: number[] = []
  const open = vi.mocked(fs.open).getMockImplementation()!
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (args[0] === path) {
      const read = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementation(((buffer: Buffer, offset: number, length: number, position: number) => {
        rangeReads.push(buffer.length)
        return read(buffer, offset, length, position)
      }) as typeof handle.read)
    }
    return handle
  })
  expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: prefix.length + 4, maxBytes: 6 }))
    .toMatchObject({ text: ' 🚀', nextOffset: prefix.length + 10, run: { logBytes: bytes.length } })
  expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 0 }))
    .toMatchObject({ text: '', nextOffset: 0, run: { logBytes: bytes.length } })
  expect(vi.mocked(fs.readFile).mock.calls.filter(([file]) => file === path)).toHaveLength(0)
  expect(rangeReads).toEqual([6])
})

it('shares a CircleCI pipeline read across discovery, status and final collection within one poll', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site',
    commit: f.commit, suite: 'lint', scope: 'full' })
  f.advance(4_000)
  f.circle.outcome = 'succeeded'
  const calls = vi.spyOn(f.ports, 'run')
  expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 100 }))
    .toMatchObject({ run: { state: 'passed', collection: 'complete' }, text: expect.stringContaining('all green') })
  expect(calls.mock.calls.filter(([file, args]) => file === 'circleci' && args[0] === 'run' && args[1] === 'get'))
    .toHaveLength(1)
})

it('refreshes the CircleCI pipeline on the next poll and shares that read with final collection', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site',
    commit: f.commit, suite: 'lint', scope: 'full' })
  const calls = vi.spyOn(f.ports, 'run')
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 100 }
  expect(await f.cloud.handle(read)).toMatchObject({ run: { state: 'running' } })
  expect(calls.mock.calls.filter(([file, args]) => file === 'circleci' && args[0] === 'run' && args[1] === 'get'))
    .toHaveLength(1)

  f.advance(4_000)
  f.circle.runView = { phase: 'ended', outcome: 'succeeded', workflows: [{ jobs: [{ id: 'job-1' }] }] }
  f.circle.outcome = 'succeeded'
  f.circle.durations = {}
  expect(await f.cloud.handle(read)).toMatchObject({
    run: { state: 'passed', collection: 'complete' },
    text: 'Suite\nall green\n',
  })
  expect(calls.mock.calls.filter(([file, args]) => file === 'circleci' && args[0] === 'run' && args[1] === 'get'))
    .toHaveLength(2)
})

it.each(['succeeded', 'failed'])('completes and persists CircleCI collection without artifacts: %s', async outcome => {
  const f = await fixture({}, { provider: 'circleci' })
  const runId = randomUUID()
  await f.cloud.handle({
    operation: 'start',
    workspaceId: 'ci-workspace',
    runId,
    repository: 'octo/site',
    commit: f.commit,
    suite: 'lint',
    scope: 'full',
  })
  f.circle.outcome = outcome
  f.advance(4_000)
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 100 }
  const state = outcome === 'succeeded' ? 'passed' : 'failed'
  expect(await f.cloud.handle(read)).toMatchObject({
    run: { state, collection: 'complete' },
    text: 'Suite\nall green\n',
  })
  expect(f.circle.downloaded).toEqual([])
  f.circle.artifactError = 'artifact service is unavailable'
  expect(await f.reopen().handle(read)).toMatchObject({
    run: { state, collection: 'complete' },
    text: 'Suite\nall green\n',
  })
})

it('shares concurrent GitHub branch listings while keeping each ticket match and refreshing the next poll', async () => {
  let reads = 0
  const records = [{ databaseId: 1, displayTitle: 'ci first', headSha: 'a'.repeat(40) },
    { databaseId: 2, displayTitle: 'ci second', headSha: 'a'.repeat(40) }]
  const provider = new GitHubActionsProvider({ ...systemHostCiPorts(), run: async (_file, args) => {
    if (args[0] === 'auth' && args[1] === 'token') return { code: 1, stdout: '', stderr: '' }
    reads++
    await Promise.resolve()
    return { code: 0, stdout: JSON.stringify(records), stderr: '' }
  } })
  const run: CloudRun = { runId: 'first', repository: 'example/project', mirror: 'example/project-ci',
    commit: 'a'.repeat(40), suite: 'lint', startedAt: '2026-10-13T00:00:00Z', providerRunId: null,
    state: 'starting', finishedAt: null, exitCode: null, message: null }
  expect(await Promise.all([provider.find(run), provider.find({ ...run, runId: 'second' })])).toEqual(['1', '2'])
  expect(reads).toBe(1)
  records.push({ databaseId: 3, displayTitle: 'ci third', headSha: run.commit })
  expect(await provider.find({ ...run, runId: 'third' })).toBe('3')
  expect(reads).toBe(2)
})
