import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { fixture } from './cloud.testSupport.js'
import { CircleCiProvider, GitHubActionsProvider, type CloudRun } from './cloudProviders.js'
import type { HostCiPorts } from './runner.js'

it.each([false, true])('completes CircleCI cancellation without a value, pipeline already ended: %s', async ended => {
  const run: CloudRun = {
    runId: randomUUID(), repository: 'octo/site', mirror: 'octo/site-ci', commit: 'a'.repeat(40), suite: 'lint',
    startedAt: '2026-10-01T00:00:00Z', providerRunId: 'pipeline', state: 'running',
    finishedAt: null, exitCode: null, message: null,
  }
  const commands: string[][] = []
  const ports: HostCiPorts = {
    cpus: 4, memoryBytes: 2 ** 30, now: () => new Date('2026-10-01T00:00:00Z'),
    run: async (_file, args) => {
      commands.push([...args])
      const view = ended ? { phase: 'ended', current_outcome: 'canceled', workflows: [] }
        : { phase: 'started', workflows: [{ phase: 'started', jobs: [] }] }
      return { code: 0, stderr: '', stdout: args[1] === 'get' ? JSON.stringify(view) : '' }
    },
  }
  const provider = new CircleCiProvider(ports, { circleToken: async () => null })
  await expect(provider.cancel(run)).resolves.toBeUndefined()
  expect(commands.filter(args => args[1] === 'cancel')).toEqual(ended ? [] : [['run', 'cancel', 'pipeline', '--force']])
})

it('does not retry GitHub cancellation of a completed run after reopening', async () => {
  const f = await fixture()
  const runId = randomUUID()
  const started = await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
  if (started.operation !== 'start') throw new Error('Expected a start reply')
  f.github.listed = [{ databaseId: 8, displayTitle: `ci ${runId}`,
    headSha: started.run.provenance!.workflowCommit }]
  Object.assign(f.github, { status: 'completed', conclusion: 'cancelled' })
  const originalRun = f.ports.run
  const cancellations: string[] = []
  vi.spyOn(f.ports, 'run').mockImplementation(async (file, args, options) => {
    if (file === 'gh' && args[0] === 'run' && args[1] === 'cancel') {
      cancellations.push(args[2]!)
      return { code: 1, stdout: '', stderr: 'Cannot cancel a workflow run that is completed\n' }
    }
    return originalRun(file, args, options)
  })

  await expect(f.cloud.handle({ operation: 'cancel', runId }))
    .resolves.toMatchObject({ operation: 'cancel', run: { state: 'starting', finishedAt: null } })
  f.advance(75_001)
  await expect(f.cloud.handle({ operation: 'cancel', runId }))
    .resolves.toMatchObject({ operation: 'cancel', run: { state: 'canceled' } })
  for (let poll = 0; poll < 2; poll++) {
    f.advance(4_000)
    const reopened = f.reopen()
    await expect(reopened.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
      .resolves.toMatchObject({ run: { state: 'canceled' } })
    await expect(reopened.handle({ operation: 'cancel', runId }))
      .resolves.toMatchObject({ run: { state: 'canceled' } })
  }
  expect(cancellations).toEqual(['8'])
})

it.each([
  { stderr: 'permission denied', code: 'CI_CLOUD_FAILED' },
  { stderr: 'API rate limit exceeded', code: 'CI_CLOUD_RATE_LIMITED' },
])('still rejects GitHub cancellation errors: $stderr', async ({ stderr, code }) => {
  const ports: HostCiPorts = {
    run: vi.fn(async () => ({ code: 1, stdout: '', stderr })),
    now: () => new Date('2026-10-01T00:00:00Z'), cpus: 4, memoryBytes: 2 ** 30,
  }
  const run: CloudRun = {
    runId: 'ticket', repository: 'octo/site', mirror: 'octo/site-ci', commit: 'abc', suite: 'lint',
    startedAt: '2026-10-01T00:00:00Z', providerRunId: '42', state: 'running',
    finishedAt: null, exitCode: null, message: null,
  }
  await expect(new GitHubActionsProvider(ports).cancel(run)).rejects.toMatchObject({ code })
})
