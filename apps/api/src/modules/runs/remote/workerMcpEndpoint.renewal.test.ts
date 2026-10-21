import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { deferred } from '../../../../test/helpers/deferred.js'
import { createWorkerMcpEndpoint, WORKER_MCP_LEASE_RENEWAL_WINDOW_MS } from './workerMcpEndpoint.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('keeps renewing after a successful refresh outlives its watchdog without recording a stale failure', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
  const base = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'worker-slow-renewal-'))
  const token = 'slow-renewal-test-token'
  const firstRefresh = deferred<string>()
  const refresh = vi.fn(async () => new Date(Date.now() + 15 * 60_000).toISOString())
    .mockImplementationOnce(() => firstRefresh.promise)
  const endpoint = await createWorkerMcpEndpoint({ launcher: join(root, 'launcher.mjs'),
    signal: new AbortController().signal, relay: {
      environment: { agentId: 'agent', variables: { FOREMAN_CODE_MCP_TOKEN: token } },
      expiresAt: new Date(Date.now() + WORKER_MCP_LEASE_RENEWAL_WINDOW_MS).toISOString(),
      request: vi.fn(async () => ({ statusCode: 200, contentType: 'application/json' as const, body: '{}' })),
      refresh,
    } })
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(91_000)
    const renewedExpiry = new Date(Date.now() + 15 * 60_000).toISOString()
    firstRefresh.resolve(renewedExpiry)
    await endpoint.refreshLease()
    const route = join(root, 'routes', `${createHash('sha256').update(token).digest('hex')}.json`)
    const registered = JSON.parse(await readFile(route, 'utf8'))
    expect(registered.expiresAt).toBe(renewedExpiry)
    expect.soft(registered.renewalFailure).toBeUndefined()

    await vi.advanceTimersByTimeAsync(15 * 60_000 - WORKER_MCP_LEASE_RENEWAL_WINDOW_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
    await endpoint.refreshLease()
    expect(Date.parse(JSON.parse(await readFile(route, 'utf8')).expiresAt)).toBeGreaterThan(Date.parse(renewedExpiry))
  } finally {
    firstRefresh.resolve(new Date(Date.now() + 15 * 60_000).toISOString())
    await endpoint.close()
    await rm(root, { recursive: true, force: true })
  }
})
