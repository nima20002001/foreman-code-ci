import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { fixture } from './cloud.testSupport.js'
import { expectCliRunMessage } from './cloudAssertions.testSupport.js'

it.each((['github', 'circleci'] as const).flatMap(provider => [
  { provider, testsStarted: false },
  { provider, testsStarted: true },
]))('persists whether tests started before a watchdog failure on $provider: $testsStarted', async options => {
  const f = await fixture({}, options)
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'unit', scope: 'full' })
  const message = 'CI hang watchdog: exceeded part deadline 120000 ms; running: module setup/teardown'
  f.github.listed = [{ databaseId: 91, displayTitle: `ci ${runId}` }]
  f.github.status = 'completed'
  f.github.conclusion = 'failure'
  f.github.watchdogFailure = { message, testsStarted: options.testsStarted }
  f.circle.outcome = 'failed'
  f.circle.watchdogFailure = f.github.watchdogFailure
  const request = { operation: 'read' as const, runId, afterOffset: 0, maxBytes: 1024 }
  for (const cloud of [f.cloud, f.reopen()]) {
    const reply = await cloud.handle(request)
    expect(reply).toMatchObject({ run: { state: 'failed', testsStarted: options.testsStarted } })
    if (reply.operation !== 'read') throw new Error('Expected a read reply')
    expectCliRunMessage(reply.run, message)
  }
})

it.each(['github', 'circleci'] as const)('reports %s setup failure when the Suite step never ran', async provider => {
  const f = await fixture({}, { provider })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'unit', scope: 'full' })
  f.github.listed = [{ databaseId: 91, displayTitle: `ci ${runId}` }]
  f.github.status = 'completed'
  f.github.conclusion = 'failure'
  f.github.steps = [
    { number: 1, name: 'Install', status: 'completed', conclusion: 'failure' },
    { number: 2, name: 'Suite', status: 'completed', conclusion: 'skipped' },
  ]
  f.circle.outcome = 'failed'
  f.circle.steps = [
    { num: 1, name: 'Install', phase: 'ended', outcome: 'failed' },
    { num: 2, name: 'Suite', phase: 'ended', outcome: 'skipped' },
  ]
  expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }))
    .toMatchObject({ run: { state: 'failed', testsStarted: false, message: expect.stringContaining('Install') } })
})
