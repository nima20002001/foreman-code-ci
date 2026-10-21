import { afterEach, expect, it, vi } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { CloudCi } from './cloud.js'
import { CircleCiProvider } from './cloudProviders.js'
import { circleOrganizations } from './circleOrganizations.js'
import { CircleStandby } from './circleStandby.js'
import { dispatchFleet, queuedTicket } from './dispatchFleet.testSupport.js'
import type { HostCiComputer } from './serviceTypes.js'
import type { HostCiPorts } from './runner.js'

afterEach(() => { vi.useRealTimers() })

function standbyCloud(probe: () => Promise<{ code: number; stdout: string; stderr: string }>) {
  const ports: HostCiPorts = { run: probe, now: () => new Date(), cpus: 4, memoryBytes: 2 ** 30 }
  return new CloudCi('fixture-main', new CircleCiProvider(ports, { circleToken: async () => 'fixture-token' }, {
    owner: 'fixture-reserve', circleAccountId: 'reserve', role: 'standby', registered: true,
    mirrorNames: new Set(['ci-mirror']),
  }), async () => 'fixture-primary/ci-mirror')
}
const executors: HostCiComputer[] = [
  { key: 'fixture:main', label: 'Local executor', priority: 0, hostRef: { kind: 'main', mainId: 'fixture' } },
  { key: 'fixture:worker', label: 'Worker executor', priority: 0,
    hostRef: { kind: 'device', mainId: 'fixture', deviceId: 'fixture-worker' } },
  { key: 'fixture:cloud:github:0', label: 'GitHub executor', priority: 0,
    hostRef: { kind: 'cloud', mainId: 'fixture', provider: 'github', slot: 0 } },
]

it.each(executors)('dispatches to $label while an unchecked standby readiness probe is blocked', async computer => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-12T00:00:01Z'))
  const probe = deferred<{ code: number; stdout: string; stderr: string }>()
  const cloud = standbyCloud(() => probe.promise)
  const selector = new CircleStandby(() => circleOrganizations([cloud]), { reading: async () => ({ credits: null }) })
  const f = dispatchFleet([computer], [queuedTicket()], { circleStandby: selector })
  let settled = false
  const dispatch = f.service.dispatch().then(() => f.service.drain()).then(() => { settled = true })
  try {
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    expect(f.started.map(start => start.computer.key)).toEqual([computer.key])
    expect(await circleOrganizations([cloud])).toMatchObject([{ ready: false, role: 'standby' }])
  } finally {
    probe.resolve({ code: 0, stdout: '{}', stderr: '' })
    await vi.advanceTimersByTimeAsync(1)
    await dispatch
    await f.service.close()
  }
})

it('reuses the last readiness observation during a refresh and excludes a confirmed logged-out standby', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const probe = deferred<{ code: number; stdout: string; stderr: string }>()
  let refreshing = false
  const run = vi.fn(async () => refreshing ? probe.promise : { code: 0, stdout: '{}', stderr: '' })
  const cloud = standbyCloud(run)
  expect(await cloud.ready()).toBe(true)
  refreshing = true
  vi.setSystemTime(Date.now() + 61_000)
  let observed: Awaited<ReturnType<typeof circleOrganizations>> | undefined
  const reading = circleOrganizations([cloud]).then(value => { observed = value })
  try {
    await Promise.resolve()
    await Promise.resolve()
    expect(observed).toMatchObject([{ ready: true }])
  } finally {
    probe.resolve({ code: 1, stdout: '', stderr: 'Not logged in' })
    await cloud.ready()
    await reading
  }
  expect(await circleOrganizations([cloud])).toMatchObject([{ ready: false }])
  expect(run).toHaveBeenCalledTimes(2)
})

it.each(executors)('dispatches to $label while CircleCI credit-policy storage is blocked', async computer => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-12T00:00:01Z'))
  const release = deferred()
  const circle: HostCiComputer = { key: 'fixture:cloud:circleci@fixture-org:0', label: 'Fixture CircleCI', priority: 30,
    hostRef: { kind: 'cloud', mainId: 'fixture', provider: 'circleci', account: 'fixture-org', slot: 0 } }
  const selector = new CircleStandby(async () => [{ owner: 'fixture-org', circleAccountId: 'default',
    role: 'primary', ready: true, mirrorNames: new Set(['ci-mirror']) }], { reading: async () => {
    await release.promise
    return { credits: null }
  } })
  const f = dispatchFleet([computer, circle], [queuedTicket()], { circleStandby: selector })
  const dispatch = f.service.dispatch()
  try {
    await vi.advanceTimersByTimeAsync(3500)
    await dispatch
    expect(f.started.map(start => start.computer.key)).toEqual([computer.key])
  } finally {
    const closing = f.service.close()
    release.resolve()
    await vi.advanceTimersByTimeAsync(1)
    await closing
  }
})
