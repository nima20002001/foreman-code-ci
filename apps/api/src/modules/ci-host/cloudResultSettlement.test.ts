import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { fixture } from './cloud.testSupport.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function finishedFixture() {
  const f = await fixture()
  const runId = randomUUID()
  vi.spyOn(f.cloud.provider, 'find').mockResolvedValue('provider-run')
  vi.spyOn(f.cloud.provider, 'status').mockImplementation(async () => ({
    done: true, conclusion: 'failure', finishedAt: f.ports.now().toISOString(),
  }))
  const logs = vi.spyOn(f.cloud.provider, 'log')
  const artifacts = vi.spyOn(f.cloud.provider, 'artifacts')
  await f.cloud.handle({ operation: 'start', runId, workspaceId: 'ci-workspace',
    repository: 'octo/site', commit: f.commit, suite: 'unit', scope: 'full' })
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1000, testResults: true }
  return { ...f, runId, read, logs, artifacts }
}

const results = { summary: { passed: 1, failed: 0, skipped: 0 }, files: [], truncated: false }

it('settles results from the artifacts without downloading the provider log they replace', async () => {
  const f = await finishedFixture()
  f.logs.mockResolvedValue('Provider output\n')
  f.artifacts.mockResolvedValue({ durations: null, testResults: results, suiteLog: 'Suite output\n' })
  expect(await f.cloud.handle(f.read)).toMatchObject({
    run: { state: 'failed', collection: 'complete' }, testResults: results, text: 'Suite output\n',
  })
  expect(f.logs).not.toHaveBeenCalled()
})

it('answers while a slow provider log downloads and keeps the collected results', async () => {
  const f = await finishedFixture()
  const download = deferred<string>()
  f.logs.mockReturnValue(download.promise)
  f.artifacts.mockResolvedValue({ durations: null, testResults: results })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let first: Awaited<ReturnType<typeof f.cloud.handle>> | undefined
  let settled = false
  const pending = f.cloud.handle(f.read).then(reply => { first = reply }).finally(() => { settled = true })
  // Provider and journal work run on real I/O, so the log wait starts after an unbounded number of turns.
  while (!settled) {
    await vi.advanceTimersByTimeAsync(1_000)
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  await pending
  expect(first).toMatchObject({ run: { state: 'failed', collection: 'pending' }, testResults: results })
  vi.useRealTimers()
  download.resolve('Provider output\n')
  f.advance(4_001)
  await vi.waitFor(async () => {
    expect(await f.reopen().handle(f.read)).toMatchObject({
      run: { state: 'failed', collection: 'complete' }, testResults: results, text: 'Provider output\n',
    })
  })
  expect(f.logs).toHaveBeenCalledTimes(1)
})

it('settles a GitHub result from the uploaded suite log when the provider log cannot be read', async () => {
  const f = await fixture()
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', runId, workspaceId: 'ci-workspace',
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
  f.github.listed = [{ databaseId: 91, displayTitle: `ci ${runId}` }]
  Object.assign(f.github, { status: 'completed', conclusion: 'failure', durations: {},
    suiteLog: 'Suite output\n', logError: 'logs are expired' })
  expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1000 }))
    .toMatchObject({ run: { state: 'failed', collection: 'complete' }, text: 'Suite output\n' })
})
