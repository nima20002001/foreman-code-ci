import { afterEach, expect, it, vi } from 'vitest'
import { CiPrewarm } from './prewarm.js'
import { queuedTicket, readyStatus } from './dispatchFleet.testSupport.js'
import { DeviceApplicationAdmissionError } from '../devices/deviceApplicationError.js'
import type { HostCiEndpoint } from './serviceTypes.js'

const computer = { key: 'builder', label: 'Builder', priority: 0,
  hostRef: { kind: 'main' as const, mainId: 'fixture-main' } }
afterEach(() => vi.useRealTimers())

it('backs off rejected background probes per computer and recovers without blocking other computers', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const request = vi.fn<HostCiEndpoint['request']>().mockRejectedValue(new DeviceApplicationAdmissionError('background_yield'))
  const prewarm = new CiPrewarm({ computers: async () => [computer], request })
  const ticket = queuedTicket()
  const probe = async () => { prewarm.schedule([computer], [ticket]); await prewarm.drain() }
  await probe()
  for (let attempt = 1; attempt <= 7; attempt++) {
    vi.setSystemTime(Date.now() + Math.min(300_000, 5000 * 2 ** (attempt - 1)) - 1)
    await probe()
    expect(request).toHaveBeenCalledTimes(attempt)
    vi.setSystemTime(Date.now() + 1)
    await probe()
    expect(request).toHaveBeenCalledTimes(attempt + 1)
  }
  const other = { ...computer, key: 'other-builder' }
  prewarm.schedule([computer, other], [ticket])
  await prewarm.drain()
  expect(request).toHaveBeenCalledTimes(9)
  request.mockResolvedValue(readyStatus())
  vi.setSystemTime(Date.now() + 300_000)
  await probe()
  expect(request).toHaveBeenCalledTimes(10)
  await probe()
  expect(request).toHaveBeenCalledTimes(11)
})

it('keeps increasing the retry delay when readiness succeeds but warmup starts fail', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  let starts = 0
  const request: HostCiEndpoint['request'] = async (_computer, input) => {
    if (input.operation === 'status') return readyStatus({ prewarmSupported: true })
    starts++
    throw new DeviceApplicationAdmissionError('background_yield')
  }
  const prewarm = new CiPrewarm({ computers: async () => [computer], request })
  const probe = async () => { prewarm.schedule([computer], [queuedTicket()]); await prewarm.drain() }
  await probe()
  vi.setSystemTime(Date.now() + 5000)
  await probe()
  expect(starts).toBe(2)
  vi.setSystemTime(Date.now() + 9999)
  await probe()
  expect(starts).toBe(2)
  vi.setSystemTime(Date.now() + 1)
  await probe()
  expect(starts).toBe(3)
})
