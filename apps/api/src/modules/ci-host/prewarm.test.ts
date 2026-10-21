import { expect, it } from 'vitest'
import type { CiHostStatus } from '@foreman-code/contracts'
import type { HostCiComputer } from './service.js'
import { deferred } from '../../../test/helpers/deferred.js'
import { waitForCiDispatch } from '../../infrastructure/ciDatabasePriority.js'
import { dispatchFleet, queuedTicket, readyStatus } from './dispatchFleet.testSupport.js'

const host: HostCiComputer = { key: 'builder', label: 'Build computer', priority: 50,
  hostRef: { kind: 'main', mainId: 'fixture-main' } }
const worker: HostCiComputer = { key: 'worker', label: 'Worker', priority: 50,
  hostRef: { kind: 'device', mainId: 'fixture-main', deviceId: 'fixture-worker' } }
const cloud: HostCiComputer = { key: 'cloud', label: 'Cloud', priority: 50,
  hostRef: { kind: 'cloud', mainId: 'fixture-main', provider: 'github' } }

function status(overrides: Partial<CiHostStatus> = {}) {
  return readyStatus({ prewarmSupported: true, ...overrides })
}

it('pre-warms queued commits on enabled idle Main and Worker computers without dispatching cloud warm-ups', async () => {
  const ticket = queuedTicket({ dispatchHostKey: 'waiting-computer' })
  const fixture = dispatchFleet([host, worker, cloud], [ticket, queuedTicket({ ...ticket })], {
    status: async () => status(),
  })
  try {
    await fixture.service.dispatch()
    await fixture.service.drain()
    const warmups = fixture.started.filter(item => item.request.warmup)
    expect(warmups.map(item => item.computer.key).sort()).toEqual(['builder', 'worker'])
    for (const { request } of warmups) {
      expect(request).toMatchObject({ repository: ticket.repository, commit: ticket.commit,
        suite: 'install', scope: 'full' })
    }
    expect(ticket.state).toBe('queued')
  } finally { await fixture.service.close() }
})

it.each([
  { prewarmSupported: false }, { ready: false }, { slotsUsed: 1 },
])('leaves unavailable, occupied and older build computers alone: %j', async overrides => {
  const fixture = dispatchFleet([host], [queuedTicket({ dispatchHostKey: 'waiting-computer' })], {
    status: async () => status(overrides),
  })
  try {
    await fixture.service.dispatch()
    await fixture.service.drain()
    expect(fixture.started).toEqual([])
  } finally { await fixture.service.close() }
})

it('starts background preparation when its status response arrives after dispatch ends', async () => {
  const response = deferred()
  const entered = deferred()
  const fixture = dispatchFleet([host], [queuedTicket({ dispatchHostKey: 'waiting-computer' })], {
    status: async () => status(),
  })
  const request = fixture.endpoint.request.bind(fixture.endpoint)
  fixture.endpoint.request = (computer, input, options) => waitForCiDispatch(async () => {
    if (input.operation === 'status' && options?.priority === 'background') {
      entered.resolve()
      await response.promise
    }
    return request(computer, input, options)
  })
  try {
    await fixture.service.dispatch()
    await entered.promise
    expect(fixture.started).toEqual([])
    response.resolve()
    await fixture.service.drain()
    expect(fixture.started).toEqual([
      expect.objectContaining({ request: expect.objectContaining({ warmup: true, suite: 'install' }) }),
    ])
  } finally {
    response.resolve()
    await fixture.service.close()
  }
})
