import { expect, it, vi } from 'vitest'
import { gzipSync } from 'node:zlib'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CIRCLE_CREDIT_ALLOWANCE, type CircleCreditAllowance } from '@foreman-code/contracts/management'
import { CircleCreditUsage } from './circleCredits.js'
import { CloudHttp } from './cloudHttp.js'
import type { HostCiPorts } from './runner.js'
import { CircleCreditCache, circleCreditKey } from './circleCreditCache.js'

// A CloudHttp keeps its credential per ports object, so every fixture gets its own.
const newPorts = (): HostCiPorts => ({ run: async () => ({ code: 1, stdout: '', stderr: '' }), now: () => new Date(),
  cpus: 4, memoryBytes: 2 ** 30 })
/** CircleCI's real export names its columns in capitals. */
const CSV = ['PROJECT_NAME,TOTAL_CREDITS,JOB_NAME', 'site,1000,unit',
  '"site, two",234.4,"quoted ""job"""', 'site,0.2,lint', ''].join('\r\n')

/** CircleCI's HTTP at the cloud HTTP boundary: collaborations, usage export create/read, and the signed CSV link. */
function circle(options: { states?: string[]; csv?: string; csvByOrg?: Record<string, string>; collaborations?: unknown[]; token?: string | null } = {}) {
  const calls: { method: string; path: string; authorization: string | undefined; body: string | undefined }[] = []
  const states = [...options.states ?? ['completed']]
  const fetchFake: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, authorization: headers.get('authorization') ?? undefined,
      body: typeof init?.body === 'string' ? init.body : undefined })
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    if (url.pathname === '/api/v2/me/collaborations') {
      return json(options.collaborations ?? [{ id: 'org-other', name: 'other', vcs_type: 'github' },
        { id: 'org-acme', name: 'Acme', slug: 'gh/acme', vcs_type: 'github' }])
    }
    const orgId = /\/organizations\/([^/]+)\/usage_export_job/.exec(url.pathname)?.[1]
    if (init?.method === 'POST') return json({ usage_export_job_id: `job-${orgId}`, state: 'created' }, 201)
    if (url.pathname.includes('/usage_export_job/job-')) {
      const state = states.length > 1 ? states.shift()! : states[0]!
      return json({ usage_export_job_id: `job-${orgId}`, state, download_urls: state === 'completed' ? [`https://signed.example/${orgId}.csv`] : null,
        ...(state === 'failed' ? { error_reason: 'query failed' } : {}) })
    }
    if (url.hostname === 'signed.example') return new Response(options.csvByOrg?.[url.pathname.slice(1, -4)] ?? options.csv ?? CSV)
    return json({ message: 'unexpected' }, 404)
  }
  const clock = { now: Date.parse('2026-10-17T12:00:00Z') }
  const allowance: CircleCreditAllowance = structuredClone(DEFAULT_CIRCLE_CREDIT_ALLOWANCE)
  const usage = new CircleCreditUsage(new CloudHttp(newPorts(), 'circleci', { fetch: fetchFake,
    circleToken: async () => options.token === undefined ? 'fixture-token' : options.token }),
  { allowance: async () => allowance, primaryOwner: async () => 'acme' },
  { now: () => clock.now, pollMs: 1, waitMs: 1000 })
  return { usage, calls, clock, allowance }
}
const settled = () => new Promise(resolve => setTimeout(resolve, 50))

it('estimates credits left from the month usage export and reads CircleCI only once per interval', async () => {
  const f = circle()
  expect((await f.usage.reading('acme')).credits).toBeNull()
  await settled()
  const reading = await f.usage.reading('acme')
  expect(reading).toEqual({ credits: { total: 400000, used: 1235, remaining: 398765, asOf: '2026-10-17T12:00:00.000Z' } })
  const create = f.calls.find(call => call.method === 'POST')!
  expect(JSON.parse(create.body!)).toEqual({ start: '2026-10-01T00:00:00.000Z', end: '2026-10-17T12:00:00.000Z' })
  expect(create.path).toBe('/api/v2/organizations/org-acme/usage_export_job')
  expect(f.calls.filter(call => call.authorization === 'Bearer fixture-token').length).toBeGreaterThan(0)
  const requests = f.calls.length
  f.clock.now += 9 * 60_000
  await f.usage.reading('acme')
  await f.usage.reading('acme')
  await settled()
  expect(f.calls).toHaveLength(requests)
  f.clock.now += 171 * 60_000
  await f.usage.reading('acme')
  await settled()
  expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(2)
})

it('gives each CircleCI org its own usage against its own 400,000 open-source credits', async () => {
  const f = circle({ collaborations: [{ id: 'org-acme', name: 'acme', slug: 'gh/acme', vcs_type: 'github' },
    { id: 'org-beta', name: 'beta', slug: 'gh/beta', vcs_type: 'github' }],
  csvByOrg: { 'org-acme': 'PROJECT_NAME,TOTAL_CREDITS\nsite,125000\n', 'org-beta': 'PROJECT_NAME,TOTAL_CREDITS\nsite,380000\n' } })
  await f.usage.reading('acme')
  await f.usage.reading('beta')
  await settled()
  const asOf = '2026-10-17T12:00:00.000Z'
  expect(await f.usage.reading('acme')).toEqual({ credits: { total: 400000, used: 125000, remaining: 275000, asOf } })
  expect(await f.usage.reading('beta')).toEqual({ credits: { total: 400000, used: 380000, remaining: 20000, asOf } })
})

it('applies the saved allowance to the cached usage without another CircleCI read', async () => {
  const f = circle()
  await f.usage.reading('acme')
  await settled()
  f.allowance.accounts = { ACME: 1500 }
  const requests = f.calls.length
  expect((await f.usage.reading('acme')).credits).toMatchObject({ total: 1500, used: 1235, remaining: 265 })
  expect(f.calls).toHaveLength(requests)
  f.allowance.accounts = {}
  f.allowance.defaultMonthlyCredits = 30_000
  expect((await f.usage.reading('acme')).credits).toMatchObject({ total: 30_000, used: 1235, remaining: 28_765 })
  expect(f.calls).toHaveLength(requests)
})

it('reports credits unavailable with the reason instead of a made-up number', async () => {
  const failed = circle({ states: ['failed'] })
  await failed.usage.reading('acme')
  await settled()
  expect(await failed.usage.reading('acme')).toEqual({ credits: null,
    creditsUnavailable: 'CircleCI usage export failed.' })
  const loggedOut = circle({ token: null })
  await loggedOut.usage.reading()
  await settled()
  expect(await loggedOut.usage.reading()).toEqual({ credits: null, creditsUnavailable: 'CircleCI is not logged in on Main.' })
  const unknownOrg = circle({ collaborations: [] })
  await unknownOrg.usage.reading('acme')
  await settled()
  expect((await unknownOrg.usage.reading('acme')).creditsUnavailable).toContain('acme')
})

it('drops a reading from an earlier month', async () => {
  const f = circle()
  await f.usage.reading('acme')
  await settled()
  expect((await f.usage.reading('acme')).credits).not.toBeNull()
  f.clock.now = Date.parse('2026-11-01T00:05:00Z')
  expect((await f.usage.reading('acme')).credits).toBeNull()
})

it('shares implicit and explicit primary owner reads without an unnamed bucket', async () => {
  const f = circle()
  await Promise.all([f.usage.reading(), f.usage.reading('ACME'), f.usage.reading('acme')])
  await settled()
  expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  expect((await f.usage.reading()).credits).toEqual((await f.usage.reading('acme')).credits)
})

it('expires usage four hours from the export end, rather than from a delayed download', async () => {
  const f = circle()
  await f.usage.reading('acme')
  await settled()
  f.clock.now += 4 * 60 * 60_000 + 1
  expect((await f.usage.reading('acme')).credits).toBeNull()
})

it('keeps exports account scoped, sums all compressed parts, and preserves an intentional saved allowance', async () => {
  const calls: string[] = []
  const http = (id: string) => new CloudHttp(newPorts(), 'circleci', { circleToken: async () => 'fixture-token',
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname
      calls.push(`${id}:${init?.method ?? 'GET'}:${path}`)
      if (path.endsWith('collaborations')) return Response.json([{ id: 'org', name: 'acme' }])
      if (init?.method === 'POST') return Response.json({ usage_export_job_id: 'job' })
      if (path.endsWith('/job')) return Response.json({ state: 'completed', download_urls: [
        'https://signed.example/first', 'https://signed.example/second',
      ] })
      const credits = id === 'default' ? 100 : 200
      return new Response(new Uint8Array(gzipSync(`TOTAL_CREDITS\n${credits}\n`)))
    } })
  const clients = new Map(['default', 'reserve'].map(id => [id, http(id)]))
  const usage = new CircleCreditUsage(id => clients.get(id)!, {
    allowance: async () => ({ defaultMonthlyCredits: 30_000, accounts: { acme: 45_000 } }), primaryOwner: async () => 'acme',
  })
  await Promise.all([usage.reading('acme'), usage.reading('ACME', 'reserve')])
  await settled()
  expect((await usage.reading('acme')).credits).toMatchObject({ total: 45_000, used: 200, remaining: 44_800 })
  expect((await usage.reading('acme', 'reserve')).credits).toMatchObject({ total: 45_000, used: 400, remaining: 44_600 })
  expect(calls.filter(call => call.includes(':POST:'))).toHaveLength(2)
})

it('persists creation attempts and pending jobs across readers and recreation without another POST', async () => {
  const parent = process.env.FOREMAN_CODE_TEST_ROOT ?? join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'circle-usage-'))
  const readers: CircleCreditUsage[] = []
  try {
    let now = Date.parse('2026-10-17T12:00:00Z')
    let completed = false
    let posts = 0
    const http = new CloudHttp(newPorts(), 'circleci', { circleToken: async () => 'fixture-token', fetch: async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('collaborations')) return Response.json([{ id: 'org', name: 'acme' }])
      if (init?.method === 'POST') { posts++; return Response.json({ usage_export_job_id: 'job' }) }
      if (path.endsWith('/job')) return Response.json({ state: completed ? 'completed' : 'processing',
        download_urls: completed ? ['https://signed.example/usage'] : null })
      return new Response('TOTAL_CREDITS\n380000\n')
    } })
    const create = () => {
      const reader = new CircleCreditUsage(http, {
        allowance: async () => ({ defaultMonthlyCredits: 400_000, accounts: {} }), primaryOwner: async () => 'acme',
      }, { now: () => now, waitMs: 0, cache: new CircleCreditCache(join(directory, 'usage.json')) })
      readers.push(reader)
      return reader
    }
    const first = create()
    const second = create()
    await Promise.all([first.reading('acme'), second.reading('ACME')])
    await Promise.all([first.close(), second.close()])
    expect(posts).toBe(1)
    completed = true
    now += 6_000
    const restarted = create()
    await restarted.reading('acme')
    await vi.waitFor(async () => {
      expect((await restarted.reading('acme')).credits).toMatchObject({ used: 380_000, remaining: 20_000 })
    })
    expect(posts).toBe(1)
    now = Date.parse('2026-11-01T00:00:00Z')
    expect((await restarted.reading('acme')).credits).toBeNull()
  } finally {
    await Promise.all(readers.map(reader => reader.close()))
    await rm(directory, { recursive: true })
  }
})

it('enforces the daily POST ceiling across recreated readers, including failed creation attempts', async () => {
  const cache = new CircleCreditCache()
  let now = Date.parse('2026-10-17T23:00:00Z')
  await cache.transaction(states => {
    states[circleCreditKey('acme')] = { orgId: 'org',
      attempts: Array.from({ length: 10 }, (_, index) => Date.parse('2026-10-17T00:00:00Z') + index * 60_000) }
  })
  let posts = 0
  const http = new CloudHttp(newPorts(), 'circleci', { circleToken: async () => 'fixture-token', fetch: async () => {
    posts++
    return Response.json({ message: 'Export unavailable.' }, { status: 503 })
  } })
  const create = () => new CircleCreditUsage(http, {
    allowance: async () => ({ defaultMonthlyCredits: 400_000, accounts: {} }), primaryOwner: async () => 'acme',
  }, { cache, now: () => now })
  await Promise.all([create().reading('acme'), create().reading('ACME')])
  await settled()
  expect(posts).toBe(0)
  now = Date.parse('2026-10-18T00:00:00Z')
  await create().reading('acme')
  await vi.waitFor(() => { expect(posts).toBe(1) })
  await create().reading('acme')
  await settled()
  expect(posts).toBe(1)
  now += 3 * 60 * 60_000
  await create().reading('acme')
  await vi.waitFor(() => { expect(posts).toBe(2) })
})

it('honors provider Retry-After without creating another export or polling before the six-second floor', async () => {
  let now = Date.parse('2026-10-17T12:00:00Z')
  let gets = 0
  let posts = 0
  const http = new CloudHttp(newPorts(), 'circleci', { circleToken: async () => 'fixture-token', fetch: async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('collaborations')) return Response.json([{ id: 'org', name: 'acme' }])
    if (init?.method === 'POST') { posts++; return Response.json({ usage_export_job_id: 'job' }) }
    gets++
    return Response.json({ message: 'Slow down.' }, { status: 429, headers: { 'retry-after': '60' } })
  } })
  const usage = new CircleCreditUsage(http, {
    allowance: async () => ({ defaultMonthlyCredits: 400_000, accounts: {} }), primaryOwner: async () => 'acme',
  }, { now: () => now, waitMs: 0 })
  await usage.reading('acme')
  await vi.waitFor(() => { expect(gets).toBe(1) })
  now += 5_999
  await usage.reading('acme')
  await settled()
  expect(gets).toBe(1)
  now++
  await usage.reading('acme')
  await settled()
  expect(gets).toBe(1)
  now += 54_000
  await usage.reading('acme')
  await vi.waitFor(() => { expect(gets).toBe(2) })
  expect(posts).toBe(1)
})

it('cannot apply a late previous-month export to the new month', async () => {
  let now = Date.parse('2026-10-31T23:59:00Z')
  let finish!: () => void
  let downloading!: () => void
  const entered = new Promise<void>(resolve => { downloading = resolve })
  const blocked = new Promise<void>(resolve => { finish = resolve })
  const http = new CloudHttp(newPorts(), 'circleci', { circleToken: async () => 'fixture-token', fetch: async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('collaborations')) return Response.json([{ id: 'org', name: 'acme' }])
    if (init?.method === 'POST') return Response.json({ usage_export_job_id: 'job' })
    if (path.endsWith('/job')) return Response.json({ state: 'completed', download_urls: ['https://signed.example/usage'] })
    downloading()
    await blocked
    return new Response('TOTAL_CREDITS\n400000\n')
  } })
  const usage = new CircleCreditUsage(http, {
    allowance: async () => ({ defaultMonthlyCredits: 400_000, accounts: {} }), primaryOwner: async () => 'acme',
  }, { now: () => now })
  await usage.reading('acme')
  await entered
  now = Date.parse('2026-11-01T00:00:00Z')
  finish()
  await settled()
  expect((await usage.reading('acme')).credits).toBeNull()
})
