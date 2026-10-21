import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { cloudCiLookupFixture } from '../../../test/helpers/cloudCiLookupFixture.js'
import { fixture } from './cloud.testSupport.js'

afterEach(() => vi.restoreAllMocks())

it.each(['run', 'job'])('retains lookup-recovery ownership until %s status confirms cancellation', async operation => {
  const f = await cloudCiLookupFixture('running')
  try {
    f.control.operation = operation
    f.control.error = 'permission denied'
    const read = { operation: 'read', runId: f.run.runId, afterOffset: 0, maxBytes: 1024 } as const
    await f.cloud.handle(read)
    f.advance(75_001)
    expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'running', finishedAt: null } })
    expect(f.control.canceled).toEqual(['pipeline-1'])
    f.advance(75_001)
    expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'running', finishedAt: null } })
    f.control.error = ''
    f.advance(4_001)
    expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'running', finishedAt: null } })
    f.control.outcome = 'canceled'
    f.advance(4_001)
    expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'queued', finishedAt: null, exitCode: null,
      message: expect.stringContaining('queued for another computer') } })
    expect(f.control.canceled).toEqual(['pipeline-1'])
    expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'queued' } })
  } finally {
    await f.close()
  }
})

it.each([false, true])('completes GitHub cancellation after a lost trigger reply, read before cancel: %s', async readBeforeCancel => {
  const f = await fixture()
  const runId = randomUUID()
  const original = f.ports.run
  vi.spyOn(f.ports, 'run').mockImplementation(async (file, args, options) => {
    const result = await original(file, args, options)
    if (file === 'gh' && args[0] === 'workflow') throw new Error('Trigger reply lost')
    return result
  })
  await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })).rejects.toThrow('Trigger reply lost')
  f.github.listed = [{ databaseId: 91, displayTitle: `ci ${runId}` }]
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 } as const
  if (readBeforeCancel) expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'running' } })
  expect(await f.reopen().handle({ operation: 'cancel', runId }))
    .toMatchObject({ run: { state: expect.stringMatching(/starting|running/), finishedAt: null } })
  expect(f.github.canceled).toEqual(['91'])
  Object.assign(f.github, { status: 'completed', conclusion: 'cancelled' })
  f.advance(75_001)
  expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'canceled', finishedAt: expect.any(String) } })
  expect(f.dispatched).toHaveLength(1)
  expect(f.github.canceled).toEqual(['91'])
})

it('remembers GitHub acceptance found only once during cancellation discovery', async () => {
  const f = await fixture()
  const runId = randomUUID()
  const original = f.ports.run
  let listings = 0
  vi.spyOn(f.ports, 'run').mockImplementation(async (file, args, options) => {
    const cliPage = args[0] === 'api' && args[1]?.includes('/actions/workflows/ci.yml/runs?')
    if (file === 'gh' && (args[0] === 'run' && args[1] === 'list' || cliPage)) {
      listings++
      if (listings !== 2) {
        return { code: 0, stdout: cliPage ? JSON.stringify({ total_count: 0, workflow_runs: [] }) : '[]', stderr: '' }
      }
    }
    const result = await original(file, args, options)
    if (file === 'gh' && args[0] === 'workflow') throw new Error('Trigger reply lost')
    return result
  })
  await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })).rejects.toThrow('Trigger reply lost')
  f.github.listed = [{ databaseId: 91, displayTitle: `ci ${runId}` }]
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 } as const
  expect(await f.reopen().handle({ operation: 'cancel', runId }))
    .toMatchObject({ run: { state: 'starting', finishedAt: null } })
  f.advance(4_001)
  expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'starting', finishedAt: null } })
  expect(f.github.canceled).toEqual(['91'])
  Object.assign(f.github, { status: 'completed', conclusion: 'cancelled' })
  f.advance(75_001)
  expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'canceled', finishedAt: expect.any(String) } })
  expect(f.dispatched).toHaveLength(1)
  expect(f.github.canceled).toEqual(['91'])
})
