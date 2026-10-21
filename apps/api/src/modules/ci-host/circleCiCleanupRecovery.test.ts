import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fixture } from './cloud.testSupport.js'
import { readCloudRun, saveCloudRun } from './cloudJournal.js'

afterEach(() => vi.restoreAllMocks())

it.each([true, undefined])('resolves a lost CircleCI submission after complete empty discovery, uncertainty flag: %s', async uncertainty => {
  const f = await fixture({}, { provider: 'circleci' })
  const runId = randomUUID()
  const original = f.ports.run
  vi.spyOn(f.ports, 'run').mockImplementation(async (file, args, options) => {
    if (file === 'circleci' && args[0] === 'run' && args[1] === 'trigger') {
      return { code: 1, stdout: '', stderr: 'connection closed while sending trigger' }
    }
    if (file === 'circleci' && args[0] === 'api') {
      return { code: 0, stdout: JSON.stringify({ items: [], next_page_token: null }), stderr: '' }
    }
    return original(file, args, options)
  })
  await expect(f.cloud.handle({ operation: 'start', runId, workspaceId: 'ci-workspace',
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' }))
    .rejects.toMatchObject({ code: 'CI_CLOUD_FAILED' })
  const path = join(f.root, 'ci-cloud', 'runs', runId, 'meta.json')
  const saved = await readCloudRun(path)
  const dispatch = { ...saved.dispatch! }
  if (uncertainty === undefined) delete dispatch.uncertain
  await saveCloudRun(path, { ...saved, dispatch })
  const cancel = { operation: 'cancel', runId } as const
  expect(await f.cloud.handle(cancel)).toMatchObject({ run: { state: 'starting', finishedAt: null } })
  f.advance(74_999)
  expect(await f.reopen().handle(cancel)).toMatchObject({ run: { state: 'starting', finishedAt: null } })
  f.advance(1)
  expect(await f.reopen().handle(cancel)).toMatchObject({ run: { state: 'canceled', executorCleanupPending: false } })
  expect(f.circle.triggered).toEqual([])
})

async function terminalAttempt() {
  const f = await fixture({}, { provider: 'circleci' })
  const access = { readable: true }
  const original = f.ports.run
  vi.spyOn(f.ports, 'run').mockImplementation(async (file, args, options) => {
    if (file === 'circleci' && args[0] === 'api' && args[1] === 'api/v2/project/gh/octo/site-ci') {
      return access.readable ? { code: 0, stdout: JSON.stringify({ slug: 'gh/octo/site-ci' }), stderr: '' }
        : { code: 1, stdout: '', stderr: 'HTTP 403 Forbidden' }
    }
    return original(file, args, options)
  })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', runId, workspaceId: 'ci-workspace',
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
  const path = join(f.root, 'ci-cloud', 'runs', runId, 'meta.json')
  const run = await readCloudRun(path)
  await saveCloudRun(path, { ...run, state: 'canceled', finishedAt: run.startedAt,
    cancellation: { at: run.startedAt, canceledIds: ['run-1'], completedAt: run.startedAt },
    emptyPipelineCancellations: { 'run-1': run.startedAt } })
  f.advance(75_001)
  return { ...f, access, runId, path, finishedAt: run.startedAt, cancel: { operation: 'cancel', runId } as const }
}

it.each(['finished', 'missing'] as const)('rechecks terminal CircleCI ownership when the pipeline is %s', async outcome => {
  const f = await terminalAttempt()
  if (outcome === 'missing') f.circle.lookupError = '{"error":true,"code":"run.not_found"}'
  else f.circle.runView = { phase: 'ended', current_outcome: 'canceled', workflows: [] }
  expect(await f.reopen().handle(f.cancel)).toMatchObject({ run: {
    state: 'canceled', finishedAt: f.finishedAt, executorCleanupPending: false,
  } })
  expect((await readCloudRun(f.path)).dispatchHistory)
    .toContainEqual({ at: expect.any(String), providerRunId: 'run-1', terminated: true })
  expect(f.circle.canceled).toEqual([])
})

it.each(['running', 'created'] as const)('retains terminal CircleCI ownership while a pipeline is %s', async state => {
  const f = await terminalAttempt()
  f.circle.runView = state === 'created' ? { state: 'created', workflows: [] }
    : { phase: 'started', workflows: [{ phase: 'started', jobs: [{ id: 'job-1' }] }] }
  expect(await f.reopen().handle(f.cancel)).toMatchObject({ run: {
    state: 'canceled', finishedAt: f.finishedAt, executorCleanupPending: true,
  } })
  expect((await readCloudRun(f.path)).dispatchHistory?.some(attempt => attempt.terminated)).toBe(false)
})

it('keeps terminal CircleCI ownership when pipeline access is denied', async () => {
  const f = await terminalAttempt()
  f.circle.lookupError = 'permission denied'
  await expect(f.reopen().handle(f.cancel)).rejects.toMatchObject({ code: 'CI_CLOUD_RUN_UNREADABLE' })
  expect((await readCloudRun(f.path)).dispatchHistory?.some(attempt => attempt.terminated)).toBe(false)
})

it('retains a missing CircleCI pipeline when its project is no longer readable', async () => {
  const f = await terminalAttempt()
  f.circle.lookupError = '{"error":true,"code":"run.not_found"}'
  f.access.readable = false
  await expect(f.reopen().handle(f.cancel)).rejects.toMatchObject({ code: 'CI_CLOUD_FAILED' })
  expect((await readCloudRun(f.path)).dispatchHistory?.some(attempt => attempt.terminated)).toBe(false)
})
