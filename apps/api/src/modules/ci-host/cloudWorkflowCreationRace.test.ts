import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { fixture } from './cloud.testSupport.js'

afterEach(() => vi.restoreAllMocks())

it('keeps a late CircleCI workflow owned until cancellation is confirmed across restart', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  f.circle.phantoms = 1
  f.circle.cancelError = 'no active workflows'
  const runId = randomUUID()
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 } as const
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })

  f.advance(75_000)
  expect(await f.cloud.handle(read)).toMatchObject({ run: { state: 'starting', finishedAt: null } })
  expect(f.circle.triggered).toHaveLength(1)
  // Work appears during the empty-pipeline verification window, so cancellation must be retried.
  f.circle.runView = { phase: 'started', workflows: [{ phase: 'started', jobs: [{ id: 'job-1' }] }] }
  f.circle.cancelError = ''
  f.advance(4_000)
  expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'starting', finishedAt: null } })
  expect(f.circle.canceled).toEqual(['run-1', 'run-1'])
  expect(f.circle.triggered).toHaveLength(1)
  f.circle.runView = { phase: 'ended', current_outcome: 'canceled', workflows: [] }
  f.advance(4_000)
  expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'starting' } })
  expect(f.circle.triggered).toHaveLength(2)
})

it('dispatches a replacement only after CircleCI confirms the unstarted pipeline ended', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  f.circle.phantoms = 1
  const original = f.ports.run.bind(f.ports)
  let stopped = false
  vi.spyOn(f.ports, 'run').mockImplementation(async (file, args, options) => {
    if (file === 'circleci' && args[0] === 'run' && args[2] === 'run-1') {
      if (args[1] === 'cancel') stopped = true
      if (args[1] === 'get' && stopped) {
        return { code: 0, stderr: '', stdout: JSON.stringify({
          phase: 'ended', current_outcome: 'canceled', workflows: [],
        }) }
      }
    }
    if (file === 'circleci' && args[0] === 'run' && args[1] === 'trigger'
      && f.circle.triggered.length > 0) expect(stopped).toBe(true)
    return original(file, args, options)
  })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
  f.advance(75_000)
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 } as const
  await f.cloud.handle(read)
  expect(f.circle.triggered).toHaveLength(2)
  expect(f.circle.canceled).toEqual(['run-1'])
  expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'running' } })
})

it('retries Stop when a CircleCI workflow appears after a no-active-workflows response', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  f.circle.phantoms = 1
  f.circle.cancelError = 'no active workflows'
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
  expect(await f.cloud.handle({ operation: 'cancel', runId }))
    .toMatchObject({ run: { state: 'starting', finishedAt: null } })
  expect(f.circle.canceled).toEqual(['run-1'])

  f.circle.runView = { phase: 'started', workflows: [{ phase: 'started', jobs: [{ id: 'job-1' }] }] }
  f.circle.cancelError = ''
  const original = f.ports.run.bind(f.ports)
  vi.spyOn(f.ports, 'run').mockImplementation(async (file, args, options) => {
    const result = await original(file, args, options)
    if (file === 'circleci' && args[0] === 'run' && args[1] === 'cancel') {
      f.circle.runView = { phase: 'ended', current_outcome: 'canceled', workflows: [] }
    }
    return result
  })
  f.advance(75_000)
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1 } as const
  expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'canceled' } })
  expect(f.circle.canceled).toEqual(['run-1', 'run-1'])
  expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'canceled' } })
  expect(f.circle.triggered).toHaveLength(1)
})
