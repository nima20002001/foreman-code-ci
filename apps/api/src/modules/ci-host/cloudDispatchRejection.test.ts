import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { fixture } from './cloud.testSupport.js'

afterEach(() => vi.restoreAllMocks())

const lookupTimeout = 'Get "https://api.github.com/repos/octo/site-ci/actions/workflows/ci.yml": '
  + 'dial tcp 192.0.2.1:443: i/o timeout'

async function githubFixture() {
  const f = await fixture()
  const runId = randomUUID()
  const start = { operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' } as const
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 } as const
  const original = f.ports.run
  const control = { failure: lookupTimeout, attempts: 0, discoveryFailure: false }
  vi.spyOn(f.ports, 'run').mockImplementation(async (file, args, options) => {
    const listing = args[0] === 'run' && args[1] === 'list'
      || args[0] === 'api' && args[1]?.includes('/actions/workflows/ci.yml/runs?')
    if (file === 'gh' && listing && control.discoveryFailure) {
      throw new Error('Provider discovery is unavailable')
    }
    if (file === 'gh' && args[0] === 'workflow') {
      control.attempts++
      if (control.failure) return { code: 1, stdout: '', stderr: control.failure }
    }
    return original(file, args, options)
  })
  return { ...f, runId, start, read, control }
}

it('retries a GitHub workflow lookup timeout after restart and adopts the successful dispatch', async () => {
  const f = await githubFixture()
  await expect(f.cloud.handle(f.start)).resolves.toMatchObject({ run: {
    state: 'starting', finishedAt: null, message: expect.stringContaining('i/o timeout'),
  } })
  expect(f.dispatched).toEqual([])
  f.control.failure = ''
  f.advance(74_999)
  expect(await f.reopen().handle(f.read)).toMatchObject({ run: { state: 'starting', finishedAt: null } })
  expect(f.control.attempts).toBe(1)
  f.advance(1)
  expect(await f.reopen().handle(f.read)).toMatchObject({ run: { state: 'starting' } })
  expect(f.control.attempts).toBe(2)
  expect(f.dispatched).toHaveLength(1)
  f.github.listed = [{ databaseId: 91, displayTitle: `ci ${f.runId}` }]
  expect(await f.reopen().handle(f.read)).toMatchObject({ run: { state: 'running' } })
  expect(f.control.attempts).toBe(2)
})

it('bounds GitHub lookup retries and finishes cleanup when no dispatch was sent', async () => {
  const f = await githubFixture()
  await expect(f.cloud.handle(f.start)).resolves.toMatchObject({ run: { state: 'starting' } })
  for (let attempts = 2; attempts <= 3; attempts++) {
    f.advance(75_000)
    expect(await f.reopen().handle(f.read)).toMatchObject({ run: {
      state: 'starting', finishedAt: null, message: expect.stringContaining('i/o timeout'),
    } })
    expect(f.control.attempts).toBe(attempts)
  }
  f.advance(75_000)
  expect(await f.reopen().handle(f.read)).toMatchObject({ run: {
    state: 'queued', finishedAt: null, message: expect.stringContaining('retries exhausted'),
  } })
  f.advance(74_999)
  expect(await f.reopen().handle(f.read)).toMatchObject({ run: { state: 'queued' } })
  f.advance(4_001)
  expect(await f.reopen().handle({ operation: 'cancel', runId: f.runId }))
    .toMatchObject({ run: { state: 'queued' } })
  const reads = vi.spyOn(f.ports, 'run')
  reads.mockClear()
  f.advance(75_000)
  expect(await f.reopen().handle(f.read)).toMatchObject({ run: { state: 'queued' } })
  expect(reads.mock.calls.filter(([file, args]) => file === 'gh' && args[0] === 'run')).toEqual([])
  expect(f.control.attempts).toBe(3)
  expect(f.dispatched).toEqual([])
  expect(f.github.canceled).toEqual([])
})

it('confirms cancellation of an unsent GitHub dispatch after the discovery window', async () => {
  const f = await githubFixture()
  await expect(f.cloud.handle(f.start)).resolves.toMatchObject({ run: { state: 'starting' } })
  const cancel = { operation: 'cancel', runId: f.runId } as const
  expect(await f.reopen().handle(cancel)).toMatchObject({ run: { state: 'starting', finishedAt: null } })
  f.advance(74_999)
  expect(await f.reopen().handle(f.read)).toMatchObject({ run: { state: 'starting', finishedAt: null } })
  f.advance(1)
  expect(await f.reopen().handle(cancel)).toMatchObject({ run: { state: 'canceled', finishedAt: expect.any(String) } })
  expect(await f.reopen().handle(f.read)).toMatchObject({ run: { state: 'canceled' } })
  expect(f.control.attempts).toBe(1)
  expect(f.dispatched).toEqual([])
})

it('retains a queued GitHub attempt discovered after a dispatch POST timeout until it stops', async () => {
  const f = await githubFixture()
  f.control.failure = 'Post "https://api.github.com/repos/octo/site-ci/actions/workflows/ci.yml/dispatches": '
    + 'dial tcp 192.0.2.1:443: i/o timeout'
  await expect(f.cloud.handle(f.start)).rejects.toThrow('i/o timeout')
  f.advance(30 * 60_000)
  expect(await f.reopen().handle(f.read)).toMatchObject({ run: { state: 'starting', finishedAt: null } })
  expect(await f.reopen().handle({ operation: 'cancel', runId: f.runId }))
    .toMatchObject({ run: { state: 'starting', finishedAt: null } })
  f.github.listed = [{ databaseId: 91, displayTitle: `ci ${f.runId}`, headSha: f.mirrorGit('rev-parse', 'main') }]
  f.github.status = 'queued'
  f.advance(75_000)
  expect(await f.reopen().handle(f.read)).toMatchObject({ run: { state: 'starting', finishedAt: null } })
  expect(f.control.attempts).toBe(1)
  expect(f.github.canceled).toEqual(['91'])
  Object.assign(f.github, { status: 'completed', conclusion: 'cancelled' })
  f.advance(4_000)
  expect(await f.reopen().handle(f.read)).toMatchObject({ run: { state: 'canceled' } })
  expect(f.github.canceled).toEqual(['91'])
})

it.each(['retry', 'cancel'] as const)(
  'can %s a rejected GitHub dispatch without waiting for a nonexistent run', async recovery => {
    const f = await githubFixture()
    f.control.failure = 'could not create workflow dispatch event: HTTP 422: inputs are too large. '
      + '(https://api.github.com/repos/octo/site-ci/actions/workflows/123/dispatches)'
    expect(await f.cloud.handle(f.start)).toMatchObject({ run: {
      state: 'starting', finishedAt: null, message: expect.stringContaining('HTTP 422'),
    } })
    expect(f.dispatched).toEqual([])
    if (recovery === 'cancel') {
      expect(await f.reopen().handle({ operation: 'cancel', runId: f.runId }))
        .toMatchObject({ run: { state: 'starting' } })
    }
    f.control.failure = ''
    f.advance(75_000)
    expect(await f.reopen().handle(f.read)).toMatchObject({
      run: { state: recovery === 'cancel' ? 'canceled' : 'starting' },
    })
    expect(f.control.attempts).toBe(recovery === 'cancel' ? 1 : 2)
    expect(f.dispatched).toHaveLength(recovery === 'cancel' ? 0 : 1)
    expect(f.github.canceled).toEqual([])
  },
)

it.each(['retry', 'cancel'] as const)(
  'can %s a never-sent GitHub submission when provider discovery is unavailable', async recovery => {
    const f = await githubFixture()
    expect(await f.cloud.handle(f.start)).toMatchObject({ run: { state: 'starting' } })
    f.control.discoveryFailure = true
    if (recovery === 'cancel') {
      expect(await f.reopen().handle({ operation: 'cancel', runId: f.runId }))
        .toMatchObject({ run: { state: 'starting' } })
    }
    f.control.failure = ''
    f.advance(75_000)
    expect(await f.reopen().handle(f.read)).toMatchObject({
      run: { state: recovery === 'cancel' ? 'canceled' : 'starting' },
    })
    expect(f.control.attempts).toBe(recovery === 'cancel' ? 1 : 2)
    expect(f.dispatched).toHaveLength(recovery === 'cancel' ? 0 : 1)
    expect(f.github.canceled).toEqual([])
  },
)

it('keeps earlier accepted GitHub attempts owned after a later workflow lookup fails', async () => {
  const f = await githubFixture()
  f.control.failure = ''
  expect(await f.cloud.handle(f.start)).toMatchObject({ run: { state: 'starting' } })
  f.control.failure = lookupTimeout
  f.advance(75_000)
  await expect(f.reopen().handle(f.read)).resolves.toMatchObject({ run: { state: 'starting' } })
  const cancel = { operation: 'cancel', runId: f.runId } as const
  expect(await f.reopen().handle(cancel)).toMatchObject({ run: { state: 'starting', finishedAt: null } })
  f.github.listed = [{ databaseId: 91, displayTitle: `ci ${f.runId}` }]
  f.advance(75_000)
  expect(await f.reopen().handle(f.read)).toMatchObject({ run: { state: 'starting', finishedAt: null } })
  expect(f.github.canceled).toEqual(['91'])
  Object.assign(f.github, { status: 'completed', conclusion: 'cancelled' })
  f.advance(4_000)
  expect(await f.reopen().handle(f.read)).toMatchObject({ run: { state: 'canceled' } })
  expect(f.control.attempts).toBe(2)
  expect(f.dispatched).toHaveLength(1)
  expect(f.github.canceled).toEqual(['91'])
})
