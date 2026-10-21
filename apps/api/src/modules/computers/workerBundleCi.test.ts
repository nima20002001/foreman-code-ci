import type pg from 'pg'
import { expect, it } from 'vitest'
import { ProductionHostCiEndpoint } from '../ci-host/endpoint.js'
import { workerBundleFixture } from '../../../test/support/workerBundle.js'

it('reports bundle skew before CI placement and recovers after the connected Worker converges', async () => {
  const f = await workerBundleFixture()
  const computer = { key: 'fixture-worker', label: 'Worker', priority: 50,
    hostRef: { kind: 'device' as const, mainId: f.identity.mainId, deviceId: f.identity.deviceId } }
  const nativeStatus = { operation: 'status', ready: true, reasons: [], cpuCount: 8,
    memoryBytes: 16 * 2 ** 30, runs: [], startProtocolVersion: 3 }
  f.handled.mockImplementation(async () => ({ payload: nativeStatus }))
  const endpoint = new ProductionHostCiEndpoint({} as pg.Pool, f.identity.mainId, () => f.endpoint,
    { handle: async () => { throw new Error('Unexpected local execution') } })
  try {
    expect(await endpoint.request(computer, { operation: 'status' })).toMatchObject({
      operation: 'status', ready: false, reasons: [expect.stringContaining('WORKER_VERSION_SKEW')],
    })
    f.match()
    expect(await endpoint.request(computer, { operation: 'status' })).toMatchObject({
      operation: 'status', ready: true, reasons: [],
    })
  } finally { await f.close() }
})
