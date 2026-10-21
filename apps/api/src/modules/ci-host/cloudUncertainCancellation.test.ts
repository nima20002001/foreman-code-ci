import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { fixture } from './cloud.testSupport.js'

afterEach(() => vi.restoreAllMocks())

async function uncertainSubmission() {
  const f = await fixture()
  const runId = randomUUID()
  const original = f.ports.run
  const control = { listingError: '' }
  vi.spyOn(f.ports, 'run').mockImplementation(async (file, args, options) => {
    if (file === 'gh' && args[0] === 'workflow') {
      await original(file, args, options)
      return { code: 1, stdout: '', stderr: 'connection closed while sending dispatch' }
    }
    const listing = args[0] === 'run' && args[1] === 'list'
      || args[0] === 'api' && args[1]?.includes('/actions/workflows/ci.yml/runs?')
    if (file === 'gh' && listing && control.listingError) {
      return { code: 1, stdout: '', stderr: control.listingError }
    }
    return original(file, args, options)
  })
  await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' }))
    .rejects.toMatchObject({ code: 'CI_CLOUD_FAILED' })
  const cancel = { operation: 'cancel', runId } as const
  expect(await f.cloud.handle(cancel)).toMatchObject({ run: { state: 'starting', finishedAt: null } })
  return { ...f, runId, cancel, control }
}

it('recovers an uncertain GitHub submission absent from complete discovery after the cancellation window', async () => {
  const f = await uncertainSubmission()
  f.advance(74_999)
  expect(await f.reopen().handle(f.cancel)).toMatchObject({ run: { state: 'starting', finishedAt: null } })
  f.advance(1)
  const recovered = f.reopen()
  expect(await recovered.handle(f.cancel)).toMatchObject({ run: { state: 'canceled', finishedAt: expect.any(String) } })
  await recovered.waitForMirrorCleanup('octo/site', 'octo/site-ci')
  const reads = vi.spyOn(f.ports, 'run')
  reads.mockClear()
  expect(await f.reopen().handle(f.cancel)).toMatchObject({ run: { state: 'canceled' } })
  expect(reads.mock.calls.filter(([file, args]) => file === 'gh' && args[0] === 'run')).toEqual([])
})

it('retains an uncertain submission when discovery reaches its listing limit', async () => {
  const f = await uncertainSubmission()
  f.github.listed = Array.from({ length: 1000 }, (_, index) => ({ databaseId: index + 1,
    displayTitle: `ci ${randomUUID()}` }))
  f.advance(75_001)
  await expect(f.reopen().handle(f.cancel)).rejects.toMatchObject({ code: 'CI_CLOUD_DISCOVERY_INCOMPLETE' })
  f.github.listed = [{ databaseId: 201, displayTitle: `ci ${f.runId}` }]
  expect(await f.reopen().handle(f.cancel)).toMatchObject({ run: { state: 'starting', finishedAt: null } })
  expect(f.github.canceled).toEqual(['201'])
})

it('retains a discovered running attempt until its provider confirms completion', async () => {
  const f = await uncertainSubmission()
  f.advance(75_001)
  f.github.listed = [{ databaseId: 91, displayTitle: `ci ${f.runId}` }]
  expect(await f.reopen().handle(f.cancel)).toMatchObject({ run: { state: 'starting', finishedAt: null } })
  f.github.listed = []
  expect(await f.reopen().handle(f.cancel)).toMatchObject({ run: { state: 'starting', finishedAt: null } })
  Object.assign(f.github, { status: 'completed', conclusion: 'failure' })
  expect(await f.reopen().handle(f.cancel)).toMatchObject({ run: { state: 'canceled' } })
})

it.each(['permission denied', 'API rate limit exceeded'])('retains ownership when discovery fails: %s', async error => {
  const f = await uncertainSubmission()
  f.advance(75_001)
  f.control.listingError = error
  await expect(f.reopen().handle(f.cancel)).rejects.toMatchObject({ code: expect.stringMatching(/^CI_CLOUD_/) })
  f.control.listingError = ''
  f.github.listed = [{ databaseId: 91, displayTitle: `ci ${f.runId}` }]
  expect(await f.reopen().handle(f.cancel)).toMatchObject({ run: { state: 'starting', finishedAt: null } })
})
