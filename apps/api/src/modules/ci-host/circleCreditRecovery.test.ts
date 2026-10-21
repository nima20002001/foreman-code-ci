import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CircleCreditCache, circleCreditKey, circleMonthStart } from './circleCreditCache.js'
import { CircleCreditUsage } from './circleCredits.js'
import { CircleStandby, type CircleOrganization } from './circleStandby.js'
import { fixture } from './cloud.testSupport.js'

const organizations: CircleOrganization[] = [
  { owner: 'alpha', circleAccountId: 'default', role: 'primary', ready: true, mirrorNames: new Set(['site-ci']) },
  { owner: 'delta', circleAccountId: 'reserve', role: 'standby', ready: true, mirrorNames: new Set(['site-ci']) },
]

it('activates a ready replacement while legacy usage reports wait for their scheduled refresh', async () => {
  const now = Date.now()
  const cache = new CircleCreditCache()
  await cache.transaction(states => {
    for (const org of organizations) states[circleCreditKey(org.owner, org.circleAccountId)] = {
      attempts: [now], lastAttemptAt: now, snapshot: { used: 400_000,
        asOf: new Date(now).toISOString(), windowEnd: new Date(now).toISOString(), periodStart: circleMonthStart(now) },
    }
  })
  const usage = new CircleCreditUsage(() => { throw new Error('Export interval has not elapsed') }, {
    allowance: async () => ({ defaultMonthlyCredits: 400_000, accounts: {} }), primaryOwner: async () => 'alpha',
  }, { cache, now: () => now })
  const selector = new CircleStandby(async () => organizations, usage, cache, () => now)
  try {
    expect((await usage.reading('delta', 'reserve')).credits).toBeNull()
    await selector.recordCreditRefusal('alpha')
    expect(await selector.eligible('delta', 'reserve', 'site-ci')).toBe(true)
    expect(await selector.eligible('alpha', 'default', 'site-ci')).toBe(false)
  } finally {
    await usage.close()
  }
})

it('coordinates one persisted probe across concurrent starts and restores admission only after its job starts', async () => {
  const f = await fixture({}, { provider: 'circleci', account: 'alpha' })
  const path = join(f.root, 'quota', 'usage.json')
  const selector = () => new CircleStandby(async () => organizations, { reading: async () => ({ credits: null }) },
    new CircleCreditCache(path), () => f.ports.now().getTime())
  const policy = selector()
  await policy.recordCreditRefusal('alpha')
  f.advance(5 * 60_000)
  f.circle.runView = { phase: 'created', workflows: [] }
  const starts = [randomUUID(), randomUUID(), randomUUID()]
  const clouds = starts.map(() => {
    const cloud = f.reopen()
    cloud.setCircleStandby(selector())
    return cloud
  })
  const start = (runId: string) => ({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' } as const)
  const results = await Promise.allSettled(clouds.map((cloud, index) => cloud.handle(start(starts[index]!))))
  expect(f.circle.triggered).toHaveLength(1)
  expect(results.filter(result => result.status === 'fulfilled'
    && ['starting', 'running'].includes((result.value as { run: { state: string } }).run.state))).toHaveLength(1)
  expect(await selector().reading('alpha')).toMatchObject({ schedulingRole: 'exhausted' })
  expect(await selector().eligible('delta', 'reserve', 'site-ci')).toBe(true)
  const runId = f.circle.triggered[0]!.find(value => value.startsWith('run_id='))!.slice('run_id='.length)
  const recovered = f.reopen()
  recovered.setCircleStandby(selector())
  f.circle.runView = { workflows: [{ jobs: [{ id: 'job-1' }] }] }
  f.circle.jobDetails['job-1'] = { phase: 'queued', executions: [] }
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 } as const
  f.advance(4_000)
  await recovered.handle(read)
  expect(await selector().reading('alpha')).toMatchObject({ schedulingRole: 'exhausted' })
  expect(await selector().eligible('delta', 'reserve', 'site-ci')).toBe(true)
  await expect(recovered.handle(start(randomUUID()))).rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE' })
  f.circle.jobDetails['job-1'] = { phase: 'started', executions: [] }
  f.advance(4_000)
  await recovered.handle(read)
  expect(await selector().eligible('alpha', 'default', 'site-ci')).toBe(true)
  expect(await selector().eligible('delta', 'reserve', 'site-ci')).toBe(false)
  expect(await recovered.handle(start(randomUUID()))).toMatchObject({ run: { state: 'running' } })
  expect(f.circle.triggered).toHaveLength(2)
})

it('keeps the replacement active after a rejected probe and observes another complete cooldown', async () => {
  const f = await fixture({}, { provider: 'circleci', account: 'alpha' })
  const policy = new CircleStandby(async () => organizations, { reading: async () => ({ credits: null }) },
    new CircleCreditCache(), () => f.ports.now().getTime())
  f.cloud.setCircleStandby(policy)
  await policy.recordCreditRefusal('alpha')
  f.advance(5 * 60_000)
  expect(await policy.eligible('delta', 'reserve', 'site-ci')).toBe(true)
  f.circle.runView = { phase: 'ended', current_outcome: 'not_run', workflows: [], errors: [
    { type: 'plan-no-credits-available', message: 'No credits are available on your plan.' },
  ] }
  const start = () => ({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(),
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' } as const)
  expect(await f.cloud.handle(start())).toMatchObject({ run: { state: 'failed', testsStarted: false } })
  f.advance(5 * 60_000 - 1)
  await expect(f.cloud.handle(start())).rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE' })
  expect(f.circle.triggered).toHaveLength(1)
  expect(await policy.eligible('delta', 'reserve', 'site-ci')).toBe(true)
  f.advance(1)
  expect(await f.cloud.handle(start())).toMatchObject({ run: { state: 'failed', testsStarted: false } })
  expect(f.circle.triggered).toHaveLength(2)
  expect(await policy.eligible('delta', 'reserve', 'site-ci')).toBe(true)
})

it('preserves a provider refusal and its replacement when a cooldown crosses UTC month start', async () => {
  let now = Date.parse('2026-10-31T23:59:00Z')
  const policy = new CircleStandby(async () => organizations, { reading: async () => ({ credits: null }) },
    new CircleCreditCache(), () => now)
  await policy.recordCreditRefusal('alpha')
  now = Date.parse('2026-11-01T00:04:00Z')
  expect(await policy.reading('alpha')).toMatchObject({ schedulingRole: 'exhausted' })
  expect(await policy.eligible('delta', 'reserve', 'site-ci')).toBe(true)
})
