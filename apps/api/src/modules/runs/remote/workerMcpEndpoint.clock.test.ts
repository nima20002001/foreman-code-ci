import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { MainClock } from '../../devices/workerClock.js'
import { privateFixtureDirectory, withPrivateFixtureDirectories } from '../../../../test/helpers/privateFixtureDirectory.js'
import { createWorkerMcpEndpoint, WORKER_MCP_LEASE_RENEWAL_WINDOW_MS } from './workerMcpEndpoint.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it.each([-120_000, 120_000])('renews automatically in Main time with a %s ms Worker offset', async offset => {
  await withPrivateFixtureDirectories(async () => {
    const root = await privateFixtureDirectory('worker-clock-renewal-')
    const mainTime = Date.now()
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(mainTime + offset)
    const clock = new MainClock()
    clock.observe(mainTime)
    const lifetimeMs = 15 * 60_000
    const renewalAt = lifetimeMs - WORKER_MCP_LEASE_RENEWAL_WINDOW_MS
    const refresh = vi.fn(async () => new Date(clock.now() + lifetimeMs).toISOString())
    const endpoint = await createWorkerMcpEndpoint({ launcher: join(root, 'launcher.mjs'),
      signal: new AbortController().signal, ...{ now: () => clock.now() }, relay: {
        environment: { agentId: 'agent', variables: { FOREMAN_CODE_MCP_TOKEN: 'clock-renewal-token' } },
        expiresAt: new Date(mainTime + lifetimeMs).toISOString(), refresh,
        request: async () => ({ statusCode: 200, contentType: 'application/json', body: '{}' }),
      } })
    try {
      await vi.advanceTimersByTimeAsync(renewalAt - 1)
      expect(refresh).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(refresh).toHaveBeenCalledOnce()
      expect(await endpoint.refreshLease()).toBe(new Date(clock.now() + lifetimeMs).toISOString())
      await vi.advanceTimersByTimeAsync(renewalAt)
      expect(refresh).toHaveBeenCalledTimes(2)
      expect(await endpoint.refreshLease()).toBe(new Date(clock.now() + lifetimeMs).toISOString())
    } finally {
      await endpoint.close()
      vi.useRealTimers()
    }
  })
})

it.each([-120_000, 120_000])('enforces HTTP lease expiry in Main time with a %s ms Worker offset', async offset => {
  await withPrivateFixtureDirectories(async () => {
    const root = await privateFixtureDirectory('worker-clock-http-')
    const mainTime = Date.now()
    let elapsed = 0
    const clock = new MainClock(() => elapsed)
    clock.observe(mainTime)
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(mainTime + offset)
    const token = 'clock-http-token'
    const request = vi.fn(async () => ({ statusCode: 200, contentType: 'application/json' as const, body: '{}' }))
    const endpoint = await createWorkerMcpEndpoint({ launcher: join(root, 'launcher.mjs'),
      signal: new AbortController().signal, ...{ now: () => clock.now() }, relay: {
        environment: { agentId: 'agent', variables: { FOREMAN_CODE_MCP_TOKEN: token } },
        expiresAt: new Date(mainTime + 60_000).toISOString(), request,
      } })
    const call = async (bearer = token) => {
      const response = await fetch(endpoint.endpoint, { method: 'POST',
        headers: { authorization: `Bearer ${bearer}` }, body: '{}' })
      await response.text()
      return response.status
    }
    try {
      expect(await call('another-token')).toBe(401)
      expect(request).not.toHaveBeenCalled()
      expect(await call()).toBe(200)
      elapsed = 59_999
      wallClock.mockReturnValue(mainTime + 300_000)
      expect(await call()).toBe(200)
      elapsed = 60_000
      wallClock.mockReturnValue(mainTime - 300_000)
      expect(await call()).toBe(401)
      expect(request).toHaveBeenCalledTimes(2)
    } finally {
      await endpoint.close()
      wallClock.mockRestore()
    }
  })
})
