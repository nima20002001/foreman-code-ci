import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { setImmediate } from 'node:timers/promises'
import { ProductionHostCiEndpoint } from './endpoint.js'
import { readyStatus } from './dispatchFleet.testSupport.js'

const computer = { key: 'builder', label: 'Builder', priority: 0,
  hostRef: { kind: 'main' as const, mainId: 'fixture-main' } }

afterEach(() => vi.useRealTimers())

it('backs off failed directory scans without reducing the five-minute cleanup floor', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const query = vi.fn().mockRejectedValue(new Error('Query read timeout'))
  const endpoint = new ProductionHostCiEndpoint({ query } as unknown as pg.Pool, 'fixture-main',
    () => undefined, { handle: async () => readyStatus({ cleanupSupported: true }) })
  const status = async () => {
    await endpoint.request(computer, { operation: 'status' })
    await setImmediate()
  }
  await status()
  expect(query).toHaveBeenCalledTimes(1)
  for (let attempt = 1; attempt <= 5; attempt++) {
    const delay = Math.min(30 * 60_000, 5 * 60_000 * 2 ** (attempt - 1))
    vi.setSystemTime(Date.now() + delay - 1)
    await status()
    expect(query).toHaveBeenCalledTimes(attempt)
    vi.setSystemTime(Date.now() + 1)
    await status()
    expect(query).toHaveBeenCalledTimes(attempt + 1)
  }
  query.mockResolvedValue({ rows: [] })
  vi.setSystemTime(Date.now() + 30 * 60_000)
  await status()
  expect(query).toHaveBeenCalledTimes(7)
  vi.setSystemTime(Date.now() + 5 * 60_000 - 1)
  await status()
  expect(query).toHaveBeenCalledTimes(7)
  vi.setSystemTime(Date.now() + 1)
  await status()
  expect(query).toHaveBeenCalledTimes(8)
})
