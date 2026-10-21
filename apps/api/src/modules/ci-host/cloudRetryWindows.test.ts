import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { DomainError } from '../errors.js'
import { fixture } from './cloud.testSupport.js'

afterEach(() => vi.restoreAllMocks())

async function finishedFixture() {
  const f = await fixture()
  const runId = randomUUID()
  vi.spyOn(f.cloud.provider, 'find').mockResolvedValue('provider-run')
  vi.spyOn(f.cloud.provider, 'status').mockImplementation(async () => ({
    done: true, conclusion: 'failure', finishedAt: f.ports.now().toISOString(),
  }))
  const logs = vi.spyOn(f.cloud.provider, 'log').mockRejectedValue(new Error('Log unavailable'))
  const artifacts = vi.spyOn(f.cloud.provider, 'artifacts').mockRejectedValue(new Error('Artifacts unavailable'))
  await f.cloud.handle({ operation: 'start', runId, workspaceId: 'ci-workspace',
    repository: 'octo/site', commit: f.commit, suite: 'unit', scope: 'full' })
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 100, testResults: true }
  return { ...f, runId, read, logs, artifacts }
}

it('collects once per pass, keeps its retry schedule across restart, and stops after the recovery window', async () => {
  const f = await finishedFixture()
  expect(await f.cloud.handle(f.read)).toMatchObject({ run: { state: 'failed', collection: 'pending' } })
  expect(f.logs).toHaveBeenCalledTimes(1)
  expect(f.artifacts).toHaveBeenCalledTimes(1)
  f.advance(4_000)
  await f.cloud.handle(f.read)
  expect(f.logs).toHaveBeenCalledTimes(2)
  expect(f.artifacts).toHaveBeenCalledTimes(2)
  const reopened = f.reopen()
  f.advance(4_000)
  await reopened.handle(f.read)
  expect(f.logs).toHaveBeenCalledTimes(2)
  expect(f.artifacts).toHaveBeenCalledTimes(2)
  f.advance(15 * 60_000)
  expect(await reopened.handle(f.read)).toMatchObject({ run: { state: 'failed', collection: 'unsupported' } })
  const calls = [f.logs.mock.calls.length, f.artifacts.mock.calls.length]
  f.advance(60_000)
  await f.reopen().reconcile()
  expect(await f.reopen().handle(f.read)).toMatchObject({ run: { collection: 'unsupported' } })
  expect([f.logs.mock.calls.length, f.artifacts.mock.calls.length]).toEqual(calls)
})

it.each(['log', 'artifacts'] as const)('propagates final %s rate limits to provider polling', async source => {
  const f = await finishedFixture()
  f.logs.mockResolvedValue('Final output\n')
  const limited = new DomainError('CI_CLOUD_RATE_LIMITED', 'Rate limit reached', 503)
  if (source === 'log') f.logs.mockRejectedValue(limited)
  else f.artifacts.mockRejectedValue(limited)
  await f.cloud.handle(f.read)
  const calls = [f.logs.mock.calls.length, f.artifacts.mock.calls.length]
  f.advance(4_000)
  await f.cloud.handle(f.read)
  expect([f.logs.mock.calls.length, f.artifacts.mock.calls.length]).toEqual(calls)
})

it('recovers artifacts within the collection window without downloading the retained log again', async () => {
  const f = await finishedFixture()
  f.logs.mockResolvedValue('Final output\n')
  expect(await f.cloud.handle(f.read)).toMatchObject({ run: { state: 'failed', collection: 'pending' } })
  const results = { summary: { passed: 1, failed: 0, skipped: 0 }, files: [], truncated: false }
  f.artifacts.mockResolvedValue({ durations: null, testResults: results })
  f.advance(4_000)
  expect(await f.reopen().handle(f.read)).toMatchObject({
    run: { state: 'failed', collection: 'complete' }, testResults: results, text: 'Final output\n',
  })
  expect(f.logs).toHaveBeenCalledTimes(1)
  expect(f.artifacts).toHaveBeenCalledTimes(2)
})

it('finishes cancellation discovery after allowing late attempts to appear, including across restart', async () => {
  const f = await fixture()
  const runId = randomUUID()
  const discover = vi.spyOn(f.cloud.provider, 'discover').mockResolvedValue(['first-attempt'])
  const cancel = vi.spyOn(f.cloud.provider, 'cancel').mockResolvedValue()
  await f.cloud.handle({ operation: 'start', runId, workspaceId: 'ci-workspace',
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
  await f.cloud.handle({ operation: 'cancel', runId })
  expect(cancel.mock.calls.map(([run]) => run.providerRunId)).toEqual(['first-attempt'])
  discover.mockResolvedValue(['first-attempt', 'late-attempt'])
  f.advance(4_000)
  await f.reopen().reconcile()
  expect(cancel.mock.calls.map(([run]) => run.providerRunId)).toEqual(['first-attempt', 'late-attempt'])
  f.advance(80_000)
  Object.assign(f.github, { status: 'completed', conclusion: 'cancelled' })
  await f.reopen().reconcile()
  const calls = discover.mock.calls.length
  for (let pass = 0; pass < 3; pass++) {
    f.advance(4_000)
    const reopened = f.reopen()
    await reopened.reconcile()
    await reopened.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 })
    await reopened.handle({ operation: 'cancel', runId })
  }
  expect(discover).toHaveBeenCalledTimes(calls)
  expect(cancel).toHaveBeenCalledTimes(2)
})

it('finishes result collection when mirror publication fails before dispatch', async () => {
  const f = await fixture()
  vi.spyOn(f.git, 'git').mockRejectedValue(new Error('Mirror publication unavailable'))
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', runId, workspaceId: 'ci-workspace',
    repository: 'octo/site', commit: f.commit, suite: 'unit', scope: 'full', deferMirror: true })
  await f.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
  expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1, testResults: true }))
    .toMatchObject({ run: { state: 'failed', collection: 'unsupported', mirrorPublication: { state: 'failed' } } })
  expect(f.dispatched).toHaveLength(0)
})
