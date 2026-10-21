import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CircleStandby, circleOrgKey, type CircleOrganization } from './circleStandby.js'
import { CircleCreditCache } from './circleCreditCache.js'
import type { CircleCreditsReading } from './circleCredits.js'

function fixture(cache = new CircleCreditCache()) {
  let now = Date.parse('2026-10-17T12:00:00Z')
  const orgs: CircleOrganization[] = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map((owner, index) => ({
    owner, circleAccountId: index < 3 ? 'default' : 'reserve', role: index < 3 ? 'primary' : 'standby',
    mirrorNames: new Set(['site-ci']), ready: true,
  }))
  const remaining = new Map(orgs.map(org => [org.owner, 400_000 as number | null]))
  const readings = { reading: async (owner?: string): Promise<CircleCreditsReading> => {
    const value = remaining.get(owner!)
    return value === null || value === undefined ? { credits: null, creditsUnavailable: 'Usage unavailable.' }
      : { credits: { total: 400_000, used: 400_000 - value, remaining: value, asOf: new Date(now).toISOString() } }
  } }
  const selector = () => new CircleStandby(async () => orgs, readings, cache, () => now)
  const standby = selector()
  const roles = async (mirror = 'site-ci') => {
    const result = await standby.roles(mirror)
    return orgs.map(org => result.get(circleOrgKey(org.owner, org.circleAccountId))!.schedulingRole)
  }
  return { orgs, remaining, standby, roles, selector, setTime: (value: string) => { now = Date.parse(value) } }
}

it('replaces provider-refused primaries one for one in normalized owner order, regardless of estimates', async () => {
  const f = fixture()
  expect(await f.roles()).toEqual(['active', 'active', 'active', 'standby', 'standby', 'standby'])
  f.remaining.set('alpha', 20_001)
  expect(await f.roles()).toEqual(['active', 'active', 'active', 'standby', 'standby', 'standby'])
  f.remaining.set('alpha', 20_000)
  expect(await f.roles()).toEqual(['active', 'active', 'active', 'standby', 'standby', 'standby'])
  await f.standby.recordCreditRefusal('alpha')
  expect(await f.roles()).toEqual(['exhausted', 'active', 'active', 'active', 'standby', 'standby'])
  f.remaining.set('beta', 1)
  await f.standby.recordCreditRefusal('beta')
  expect(await f.roles()).toEqual(['exhausted', 'exhausted', 'active', 'active', 'active', 'standby'])
  f.remaining.set('gamma', 0)
  await f.standby.recordCreditRefusal('gamma')
  expect(await f.roles()).toEqual(['exhausted', 'exhausted', 'exhausted', 'active', 'active', 'active'])
})

it('requires mirror availability and authentication independently of usage reports for standby activation', async () => {
  const f = fixture()
  f.remaining.set('alpha', 0)
  await f.standby.recordCreditRefusal('alpha')
  f.orgs[3]!.mirrorNames = new Set()
  f.orgs[4]!.ready = false
  f.remaining.set('zeta', null)
  expect(await f.roles()).toEqual(['exhausted', 'active', 'active', 'standby', 'standby', 'active'])
  f.remaining.set('zeta', 20_001)
  expect((await f.roles())[5]).toBe('active')
  expect(await f.roles('another-ci')).not.toContain('active')
})

it('does not activate overflow for unknown primary usage or a failed primary credential', async () => {
  const f = fixture()
  f.remaining.set('alpha', null)
  f.orgs[0]!.ready = false
  expect(await f.roles()).toEqual(['active', 'active', 'active', 'standby', 'standby', 'standby'])
})

it('retains exhaustion and an activated replacement through stale reads and service recreation', async () => {
  const f = fixture()
  f.remaining.set('alpha', 20_000)
  await f.standby.recordCreditRefusal('alpha')
  await f.roles()
  f.remaining.set('alpha', null)
  f.remaining.set('delta', null)
  const result = await f.selector().roles('site-ci')
  expect(result.get(circleOrgKey('alpha'))).toMatchObject({ schedulingRole: 'exhausted', credits: null })
  expect(result.get(circleOrgKey('delta', 'reserve'))).toMatchObject({ schedulingRole: 'active', credits: null,
    creditsUnavailable: 'Usage unavailable.' })
  f.remaining.set('alpha', 25_000)
  expect(await f.standby.eligible('alpha')).toBe(false)
  f.setTime('2026-10-17T12:05:00Z')
  expect(await f.roles()).toEqual(['exhausted', 'active', 'active', 'active', 'standby', 'standby'])
  expect(await f.standby.admitStart('alpha', 'default', 'site-ci', 'probe')).toBe(true)
  await f.standby.recordCreditAcceptance('alpha', 'default', 'probe')
  expect(await f.roles()).toEqual(['active', 'active', 'active', 'standby', 'standby', 'standby'])
})

it('retires an exhausted replacement and requires accepted probes across UTC month start', async () => {
  const f = fixture()
  f.remaining.set('alpha', 0)
  await f.standby.recordCreditRefusal('alpha')
  await f.roles()
  f.remaining.set('delta', 20_000)
  await f.standby.recordCreditRefusal('delta', 'reserve')
  expect(await f.roles()).toEqual(['exhausted', 'active', 'active', 'exhausted', 'active', 'standby'])
  f.setTime('2026-11-01T00:00:00Z')
  for (const org of f.orgs) f.remaining.set(org.owner, null)
  expect(await f.roles()).toEqual(['exhausted', 'active', 'active', 'exhausted', 'active', 'standby'])
  for (const [owner, account] of [['alpha', 'default'], ['delta', 'reserve']] as const) {
    expect(await f.standby.admitStart(owner, account, 'site-ci', `probe-${owner}`)).toBe(true)
    await f.standby.recordCreditAcceptance(owner, account, `probe-${owner}`)
  }
  expect(await f.roles()).toEqual(['active', 'active', 'active', 'standby', 'standby', 'standby'])
})

it('cannot exhaust the new UTC month using a reading completed just before midnight', async () => {
  const standby = new CircleStandby(async () => [
    { owner: 'alpha', circleAccountId: 'default', role: 'primary', ready: true, mirrorNames: new Set(['site-ci']) },
    { owner: 'delta', circleAccountId: 'reserve', role: 'standby', ready: true, mirrorNames: new Set(['site-ci']) },
  ], { reading: async () => ({ credits: { total: 400_000, used: 400_000, remaining: 0,
    asOf: '2026-10-31T23:59:59.999Z' } }) }, new CircleCreditCache(), () => Date.parse('2026-11-01T00:00:00Z'))
  expect(await standby.eligible('alpha', 'default', 'site-ci')).toBe(true)
  expect(await standby.eligible('delta', 'reserve', 'site-ci')).toBe(false)
})

it('persists one globally bounded replacement across concurrent workspace selections and recreation', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'circle-assignments-'))
  try {
    const path = join(root, 'usage.json')
    const f = fixture(new CircleCreditCache(path))
    f.remaining.set('alpha', 0)
    await f.standby.recordCreditRefusal('alpha')
    for (const org of f.orgs.slice(0, 3)) org.mirrorNames = new Set(['mirror-a', 'mirror-b'])
    f.orgs[3]!.mirrorNames = new Set(['mirror-a'])
    f.orgs[4]!.mirrorNames = new Set(['mirror-b'])
    f.orgs[5]!.mirrorNames = new Set()
    const [first, second] = await Promise.all([f.standby.roles('mirror-a'), f.standby.roles('mirror-b')])
    const active = new Set([...first, ...second].filter(([, reading]) => reading.schedulingRole === 'active')
      .map(([key]) => key))
    expect([...active].sort()).toEqual([
      circleOrgKey('beta'), circleOrgKey('gamma'), circleOrgKey('delta', 'reserve'),
    ].sort())
    const restarted = fixture(new CircleCreditCache(path))
    restarted.remaining.set('alpha', 0)
    restarted.orgs.forEach((org, index) => { org.mirrorNames = f.orgs[index]!.mirrorNames })
    const roles = await restarted.standby.roles('mirror-b')
    expect(roles.get(circleOrgKey('epsilon', 'reserve'))?.schedulingRole).toBe('standby')
    expect(roles.get(circleOrgKey('delta', 'reserve'))?.schedulingRole).toBe('standby')
    expect((await restarted.standby.roles()).get(circleOrgKey('delta', 'reserve'))?.schedulingRole).toBe('active')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('selects replacement capacity independently of usage after a confirmed recovery', async () => {
  const f = fixture()
  f.remaining.set('alpha', 0)
  await f.standby.recordCreditRefusal('alpha')
  expect((await f.roles())[3]).toBe('active')
  f.remaining.set('alpha', 400_000)
  f.setTime('2026-10-17T12:05:00Z')
  expect((await f.roles())[3]).toBe('active')
  expect(await f.standby.admitStart('alpha', 'default', 'site-ci', 'probe')).toBe(true)
  await f.standby.recordCreditAcceptance('alpha', 'default', 'probe')
  expect((await f.roles())[3]).toBe('standby')
  f.remaining.set('alpha', 0)
  await f.standby.recordCreditRefusal('alpha')
  f.remaining.set('delta', null)
  expect(await f.roles()).toEqual(['exhausted', 'active', 'active', 'active', 'standby', 'standby'])
})
