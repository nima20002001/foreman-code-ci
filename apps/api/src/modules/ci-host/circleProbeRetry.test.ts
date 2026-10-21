import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CircleStandby } from './circleStandby.js'
import { CircleCreditCache } from './circleCreditCache.js'
import { fixture } from './cloud.testSupport.js'

it.each([
  { label: 'confirmed-unsent rejection', message: 'error: API returned 401: invalid token' },
  { label: 'confirmed-unsent rate limit', message: 'error: API returned 429: too many requests' },
])('lets the owning probe retry a $label across restart while excluding other runs', async ({ message }) => {
  const f = await fixture({}, { provider: 'circleci', account: 'alpha' })
  const path = join(f.root, 'quota', 'usage.json')
  const selector = () => new CircleStandby(async () => [
    { owner: 'alpha', circleAccountId: 'default', role: 'primary', ready: true, mirrorNames: new Set(['site-ci']) },
    { owner: 'delta', circleAccountId: 'reserve', role: 'standby', ready: true, mirrorNames: new Set(['site-ci']) },
  ], { reading: async () => ({ credits: null }) }, new CircleCreditCache(path), () => f.ports.now().getTime())
  await selector().recordCreditRefusal('alpha')
  f.advance(5 * 60_000)
  let attempts = 0
  const original = f.ports.run
  f.ports.run = async (file, args, options) => {
    if (file === 'circleci' && args[0] === 'run' && args[1] === 'trigger') {
      attempts++
      if (attempts <= 2) return { code: 1, stdout: '', stderr: message }
    }
    return original(file, args, options)
  }
  f.cloud.setCircleStandby(selector())
  const runId = randomUUID()
  const start = { operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' } as const
  expect(await f.cloud.handle(start)).toMatchObject({ run: { state: 'starting', finishedAt: null } })
  expect(attempts).toBe(1)
  expect(f.circle.triggered).toEqual([])
  const recovered = f.reopen()
  recovered.setCircleStandby(selector())
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 } as const
  for (const expectedAttempts of [2, 3]) {
    await expect(recovered.handle({ ...start, runId: randomUUID() }))
      .rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE' })
    expect(await selector().eligible('delta', 'reserve', 'site-ci')).toBe(true)
    f.advance(74_999)
    expect(await recovered.handle(read)).toMatchObject({ run: { state: 'starting', finishedAt: null } })
    expect(attempts).toBe(expectedAttempts - 1)
    f.advance(1)
    expect(await recovered.handle(read)).toMatchObject({ run: { state: 'starting', finishedAt: null } })
    expect(attempts).toBe(expectedAttempts)
    expect(await selector().reading('alpha')).toMatchObject({ schedulingRole: 'exhausted' })
  }
  expect(f.circle.triggered).toHaveLength(1)
  f.advance(4_000)
  expect(await recovered.handle(read)).toMatchObject({ run: { state: 'running' } })
  expect(await selector().eligible('alpha', 'default', 'site-ci')).toBe(true)
  expect(await selector().eligible('delta', 'reserve', 'site-ci')).toBe(false)
})

it('does not reuse an owning probe claim to dispatch another pipeline after a sent probe did not run', async () => {
  const f = await fixture({}, { provider: 'circleci', account: 'alpha' })
  const policy = new CircleStandby(async () => [
    { owner: 'alpha', circleAccountId: 'default', role: 'primary', ready: true, mirrorNames: new Set(['site-ci']) },
    { owner: 'delta', circleAccountId: 'reserve', role: 'standby', ready: true, mirrorNames: new Set(['site-ci']) },
  ], { reading: async () => ({ credits: null }) }, new CircleCreditCache(), () => f.ports.now().getTime())
  await policy.recordCreditRefusal('alpha')
  f.advance(5 * 60_000)
  f.cloud.setCircleStandby(policy)
  f.circle.runView = { phase: 'ended', current_outcome: 'not_run', notStarted: true, workflows: [] }
  const runId = randomUUID()
  expect(await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' }))
    .toMatchObject({ run: { state: 'starting' } })
  f.advance(75_000)
  expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }))
    .toMatchObject({ run: { state: 'failed', testsStarted: false } })
  expect(f.circle.triggered).toHaveLength(1)
  expect(await policy.eligible('delta', 'reserve', 'site-ci')).toBe(true)
})
