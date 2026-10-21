import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { fixture } from './cloud.testSupport.js'
import { GitHubActionsProvider } from './cloudProviders.js'
import { systemHostCiPorts, type HostCiPorts } from './runner.js'
import { CircleStandby } from './circleStandby.js'

it('keeps authenticated standby readiness separate from its scheduling role', async () => {
  const f = await fixture({}, { provider: 'circleci', account: 'reserve-org' })
  f.cloud.setCircleStandby(new CircleStandby(async () => [
    { owner: 'primary-org', circleAccountId: 'default', role: 'primary', ready: true, mirrorNames: new Set(['site-ci']) },
    { owner: 'reserve-org', circleAccountId: 'default', role: 'standby', ready: true, mirrorNames: new Set(['site-ci']) },
  ], { reading: async () => ({ credits: { total: 400_000, used: 0, remaining: 400_000, asOf: new Date().toISOString() } }) }))
  expect(await f.cloud.handle({ operation: 'status' })).toMatchObject({ ready: true })
  await expect(f.cloud.handle({ operation: 'start', runId: randomUUID(), workspaceId: 'ci-workspace',
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' }))
    .rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE', message: expect.stringMatching(/standby/i) })
  expect(f.circle.triggered).toEqual([])
})

it.each(['github', 'circleci'] as const)(
  'answers every %s slot readiness while one recovery sweep is blocked', async provider => {
    const f = await fixture({}, { provider })
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
      repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
    const path = join(f.root, 'ci-cloud', 'runs', runId, 'meta.json')
    const run = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...run, providerRunId: run.providerRunId ?? 'fixture-run',
      state: 'canceled', finishedAt: run.startedAt,
      cancellation: { at: run.startedAt, canceledIds: [] } }))
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const cancel = vi.spyOn(f.cloud.provider, 'cancel').mockImplementation(() => blocked)
    let timer: NodeJS.Timeout | undefined
    const statuses = Promise.all(f.cloud.computers().map(() => f.cloud.handle({ operation: 'status' })))
    try {
      const result = await Promise.race([statuses, new Promise<'blocked'>(resolve => {
        timer = setTimeout(() => resolve('blocked'), 500)
      })])
      expect(result).not.toBe('blocked')
      expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ operation: 'status', ready: true })]))
      await expect.poll(() => cancel.mock.calls.length).toBe(1)
    } finally {
      clearTimeout(timer)
      release()
      await statuses
      await f.cloud.reconcile()
    }
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await readFile(path, 'utf8')).cancellation.canceledIds).toHaveLength(1)
  },
)

it('shares one readiness probe between concurrent slots and keeps the last good answer when a refresh fails', async () => {
  const f = await fixture()
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const probe = vi.spyOn(f.cloud.provider, 'ready').mockResolvedValue(true)
    expect(await Promise.all([f.cloud.ready(), f.cloud.ready(), f.cloud.ready()])).toEqual([true, true, true])
    expect(probe).toHaveBeenCalledTimes(1)

    vi.setSystemTime(Date.now() + 61_000)
    probe.mockRejectedValue(new Error('gh auth status timed out'))
    expect(await Promise.all([f.cloud.ready(), f.cloud.ready(), f.cloud.ready()])).toEqual([true, true, true])
    expect(probe).toHaveBeenCalledTimes(2)

    probe.mockResolvedValue(false)
    expect(await f.cloud.ready()).toBe(false)
  } finally {
    vi.useRealTimers()
  }
})

it('reports a timed out login probe as a failed check, not a logged-out account', async () => {
  const ports: HostCiPorts = { ...systemHostCiPorts(), run: async () => ({ code: 1, stdout: '', stderr: '', timedOut: true }) }
  await expect(new GitHubActionsProvider(ports).ready()).rejects.toThrow(/timed out/)
})
