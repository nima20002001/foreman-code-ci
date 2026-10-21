import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { fixture } from './cloud.testSupport.js'
import { cloudService } from './cloudService.testSupport.js'
import { ciExecutionRunId } from './executionAttempt.js'

it('starts a fresh attempt on the original provider after confirmed queue reassignment', async () => {
  const provider = 'github'
  const f = await fixture()
  const runId = randomUUID()
  const start = { operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' } as const
  const started = await f.cloud.handle(start)
  if (started.operation !== 'start') throw new Error('Expected start')
  f.github.listed = [{ databaseId: 91, displayTitle: `ci ${runId}` }]
  f.github.status = 'queued'
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024, reassign: true } as const
  const queued = await f.cloud.handle(read)
  if (queued.operation !== 'read') throw new Error('Expected read')
  // Main last observed the provider queue before requesting reassignment.
  const main = cloudService(f.cloud, queued.run, f.commit, { suite: 'lint' })
  f.advance(75_001)
  await f.cloud.handle(read)
  Object.assign(f.github, { status: 'completed', conclusion: 'cancelled' })
  f.advance(4_001)
  expect(await f.cloud.handle(read)).toMatchObject({ run: { state: 'queued' } })
  await main.service.dispatch()
  const requeued = await main.read()
  expect(requeued.run).toMatchObject({ id: runId, state: 'queued', computer: null })
  const attemptId = ciExecutionRunId(requeued.run)
  expect(attemptId).not.toBe(runId)
  expect(requeued.run.unstartedProviders ?? []).not.toContain(provider)
  expect(ciExecutionRunId((await main.read()).run)).toBe(attemptId)

  Object.assign(f.github, { status: 'in_progress', conclusion: '' })
  expect(await f.reopen().handle({ ...start, runId: attemptId }))
    .toMatchObject({ run: { runId: attemptId, state: 'starting' } })
  expect(f.dispatched).toHaveLength(2)
  expect(await f.reopen().handle(read)).toMatchObject({ run: { runId, state: 'queued' } })
})
