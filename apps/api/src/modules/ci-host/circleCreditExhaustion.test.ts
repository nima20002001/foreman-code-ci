import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { CircleCreditCache, circleCreditKey, circleMonthStart } from './circleCreditCache.js'
import { CircleStandby } from './circleStandby.js'
import { fixture } from './cloud.testSupport.js'

function selector(cache = new CircleCreditCache(), now = () => Date.now()) {
  return new CircleStandby(async () => [
    { owner: 'alpha', circleAccountId: 'default', role: 'primary', ready: true, mirrorNames: new Set(['site-ci']) },
    { owner: 'delta', circleAccountId: 'reserve', role: 'standby', ready: true, mirrorNames: new Set(['site-ci']) },
  ], { reading: async () => ({ credits: { total: 400_000, used: 552_142, remaining: 0,
    asOf: new Date(now()).toISOString() } }) }, cache, now)
}

it('admits CircleCI starts above the estimated OSS allowance and clears inferred cached exhaustion', async () => {
  const cache = new CircleCreditCache()
  await cache.transaction(states => {
    states[circleCreditKey('alpha')] = { attempts: [], policy: {
      month: circleMonthStart(Date.now()), exhausted: true, activated: false,
    } }
  })
  const standby = selector(cache)
  expect(await standby.eligible('alpha', 'default', 'site-ci')).toBe(true)
  const f = await fixture({}, { provider: 'circleci', account: 'alpha' })
  f.cloud.setCircleStandby(standby)
  expect(await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(),
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' }))
    .toMatchObject({ run: { state: 'running' } })
  expect(f.circle.triggered).toHaveLength(1)
  expect(await standby.reading('alpha')).toMatchObject({ schedulingRole: 'active', credits: { remaining: 0 } })
})

it.each(['initial lookup', 'later poll'])(
  'uses a provider credit refusal at %s to activate one replacement and retries after five minutes', async stage => {
    const f = await fixture({}, { provider: 'circleci', account: 'alpha' })
    let now = Date.now()
    const cache = new CircleCreditCache()
    const standby = selector(cache, () => now)
    // Healthy estimates cannot overrule CircleCI refusing a job.
    const healthy = new CircleStandby(async () => [
      { owner: 'alpha', circleAccountId: 'default', role: 'primary', ready: true, mirrorNames: new Set(['site-ci']) },
      { owner: 'delta', circleAccountId: 'reserve', role: 'standby', ready: true, mirrorNames: new Set(['site-ci']) },
    ], { reading: async () => ({ credits: { total: 400_000, used: 1, remaining: 399_999,
      asOf: new Date(now).toISOString() } }) }, cache, () => now)
    f.cloud.setCircleStandby(healthy)
    const refusal = { phase: 'ended', current_outcome: 'not_run', errors: [
      { type: 'plan-no-credits-available', message: 'This job has been blocked because no credits are available on your plan.' },
    ], workflows: [] }
    if (stage === 'initial lookup') f.circle.runView = refusal
    const runId = randomUUID()
    const start = { operation: 'start', workspaceId: 'ci-workspace', runId,
      repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' } as const
    const first = await f.cloud.handle(start)
    if (stage === 'later poll') {
      expect(first).toMatchObject({ run: { state: 'running' } })
      f.circle.runView = refusal
      f.advance(4_000)
    }
    expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }))
      .toMatchObject({ run: { state: 'failed', testsStarted: false }, text: expect.stringContaining('no credits') })
    expect(await healthy.reading('alpha')).toMatchObject({ schedulingRole: 'exhausted' })
    expect(await healthy.eligible('delta', 'reserve', 'site-ci')).toBe(true)
    await expect(f.cloud.handle({ ...start, runId: randomUUID() })).rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE' })
    expect(f.circle.triggered).toHaveLength(1)
    now += 5 * 60_000 - 1
    expect(await standby.eligible('alpha', 'default', 'site-ci')).toBe(false)
    now++
    expect(await standby.reading('alpha', 'default', 'site-ci')).toMatchObject({
      schedulingRole: 'exhausted', creditProbeAvailable: true,
    })
    expect(await standby.eligible('delta', 'reserve', 'site-ci')).toBe(true)
  },
)

it.each([
  { type: 'config', message: 'Invalid configuration referencing credits.' },
  { type: 'error', message: 'Job was not run because a dependency failed.' },
])('keeps non-credit provider failures out of exhaustion decisions: $type', async error => {
  const f = await fixture({}, { provider: 'circleci', account: 'alpha' })
  const standby = selector()
  f.cloud.setCircleStandby(standby)
  f.circle.runView = { phase: 'ended', current_outcome: 'not_run', errors: [error], workflows: [] }
  expect(await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(),
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' }))
    .toMatchObject({ run: { state: 'failed', testsStarted: false } })
  expect(await standby.eligible('alpha', 'default', 'site-ci')).toBe(true)
  expect(await standby.eligible('delta', 'reserve', 'site-ci')).toBe(false)
})
