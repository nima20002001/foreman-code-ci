import { afterEach, expect, it, vi } from 'vitest'
import type { CiHostStatus, CiRunRecord } from '@foreman-code/contracts'
import { DeviceApplicationAdmissionError } from '../devices/deviceApplicationError.js'
import { deferred } from '../../../test/helpers/deferred.js'
import { dispatchFleet, queuedTicket, readyStatus } from './dispatchFleet.testSupport.js'
import type { HostCiComputer } from './service.js'

afterEach(() => { vi.restoreAllMocks() })

const worker: HostCiComputer = { key: 'main:worker', label: 'Worker', priority: 0,
  hostRef: { kind: 'device', mainId: 'main', deviceId: 'worker' } }

/** Dispatch learns the Worker's readiness, then that status goes stale and its next read behaves as `refresh` says. */
async function staleWorker(refresh: () => Promise<CiHostStatus>) {
  let now = Date.parse('2026-10-12T00:00:00Z')
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  let stale = false
  const records: CiRunRecord[] = []
  const f = dispatchFleet([worker], records, { status: async () => stale ? refresh() : readyStatus() })
  await f.service.dispatch()
  await f.service.drain()
  now += 6000
  stale = true
  return { ...f, queue: () => { records.push(queuedTicket()) } }
}

it('starts a ticket on a Worker whose status refresh is still running', async () => {
  const refresh = deferred<CiHostStatus>()
  const f = await staleWorker(() => refresh.promise)
  try {
    f.queue()
    await f.service.dispatch()
    expect(f.started.map(item => item.computer.key)).toEqual([worker.key])
  } finally {
    refresh.resolve(readyStatus())
    await f.service.close()
  }
})

it('starts a ticket on a Worker whose status refresh yielded to background pressure', async () => {
  const f = await staleWorker(async () => { throw new DeviceApplicationAdmissionError('background_yield') })
  try {
    await f.service.dispatch()
    await f.service.drain()
    f.queue()
    await f.service.dispatch()
    expect(f.started.map(item => item.computer.key)).toEqual([worker.key])
  } finally {
    await f.service.close()
  }
})

it('stops dispatching to a Worker whose status refresh failed for another reason', async () => {
  const f = await staleWorker(async () => { throw new Error('transport closed') })
  try {
    await f.service.dispatch()
    await f.service.drain()
    f.queue()
    await f.service.dispatch()
    expect(f.started).toEqual([])
  } finally {
    await f.service.close()
  }
})
