import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUnboundWorkerMcpEndpoint, createWorkerMcpEndpoint } from './workerMcpEndpoint.js'
import * as diagnostics from '../../diagnostics/logger.js'
import { DeviceApplicationError } from '../../devices/deviceApplicationError.js'

const roots: string[] = []
async function temporaryDirectory(prefix: string) {
  const root = process.env.FOREMAN_CODE_TEST_ROOT ?? join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(root, { recursive: true })
  return mkdtemp(join(root, prefix))
}
const endpoints: Awaited<ReturnType<typeof createWorkerMcpEndpoint>>[] = []
afterEach(async () => { await Promise.all(endpoints.splice(0).map(endpoint => endpoint.close())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
afterEach(() => vi.restoreAllMocks())
async function setup(tokenName = 'GRAPHQL_MCP_TOKEN') {
  const root = await temporaryDirectory('worker-private-mcp-'); roots.push(root)
  const token = 'actual-test-scoped-worker-token', expiresAt = new Date(Date.now() + 30 * 60_000).toISOString()
  const request = vi.fn(async () => ({ statusCode: 200, contentType: 'application/json' as const, body: '{"result":"Main grant checked"}' }))
  const refresh = vi.fn(async () => expiresAt)
  const endpoint = await createWorkerMcpEndpoint({ launcher: join(root, 'graphql-mcp.mjs'), signal: new AbortController().signal,
    relay: { environment: { agentId: 'admitted-agent', variables: { [tokenName]: token } }, expiresAt, request, refresh } })
  endpoints.push(endpoint)
  return { endpoint, token, expiresAt, request, refresh,
    route: join(root, 'routes', `${createHash('sha256').update(token).digest('hex')}.json`) }
}
describe('actual worker-private HTTP relay with Main authorization double, no paired/native proof', () => {
  it('reports a route registration failure and rejects startup without exposing the credential', async () => {
    const log = diagnostics.componentLogger('harness')
    const error = vi.spyOn(log, 'error')
    vi.spyOn(diagnostics, 'componentLogger').mockReturnValue(log)
    const root = await temporaryDirectory('worker-mcp-registration-')
    roots.push(root)
    const parent = join(root, 'occupied')
    await writeFile(parent, '')
    const token = 'registration-test-credential'
    const request = vi.fn(async () => { throw new Error('Unregistered route cannot forward') })
    await expect(createWorkerMcpEndpoint({ launcher: join(parent, 'launcher.mjs'),
      signal: new AbortController().signal, relay: {
        environment: { agentId: 'agent', variables: { GRAPHQL_MCP_TOKEN: token } },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        request,
      } })).rejects.toMatchObject({ code: 'EEXIST' })
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ operation: 'register', code: 'EEXIST' }),
      'Worker MCP relay failed')
    expect(request).not.toHaveBeenCalled()
    expect(JSON.stringify(error.mock.calls)).not.toContain(token)
  })
  it('rejects and logs an expired renewal while preserving the live route', async () => {
    const log = diagnostics.componentLogger('harness')
    const error = vi.spyOn(log, 'error')
    vi.spyOn(diagnostics, 'componentLogger').mockReturnValue(log)
    const f = await setup()
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.expiresAt) - 2 * 60_000)
    f.refresh.mockResolvedValueOnce(new Date(Date.now() - 60_000).toISOString())
    await expect(f.endpoint.refreshLease()).rejects.toThrow('renewed Main MCP lease is unavailable')
    const response = await fetch(f.endpoint.endpoint, { method: 'POST',
      headers: { authorization: `Bearer ${f.token}` }, body: '{"method":"tools/list"}' })
    expect(response.status).toBe(200)
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ operation: 'renew' }), 'Worker MCP relay failed')
    expect(JSON.stringify(error.mock.calls)).not.toContain(f.token)
  })
  it('keeps inspection unauthorized and the native URL stable when the actual Main lease arrives', async () => {
    const root = await temporaryDirectory('worker-unbound-mcp-')
    roots.push(root)
    const endpoint = await createUnboundWorkerMcpEndpoint({ launcher: join(root, 'foreman-code-mcp.mjs'),
      signal: new AbortController().signal })
    endpoints.push(endpoint)
    const url = endpoint.endpoint
    const request = vi.fn(async () => ({ statusCode: 200, contentType: 'application/json' as const,
      body: '{"result":"authorized Main response"}' }))
    const call = (token: string) => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })
    expect((await call('not-issued')).status).toBe(401)
    expect(request).not.toHaveBeenCalled()
    const lease = (token: string) => ({ environment: { agentId: 'admitted-operator',
      variables: { FOREMAN_CODE_MCP_TOKEN: token } }, expiresAt: new Date(Date.now() + 60000).toISOString(), request })
    await endpoint.bindRelay(lease('first-scoped-lease'))
    expect(endpoint.endpoint).toBe(url)
    expect((await call('first-scoped-lease')).status).toBe(200)
    await endpoint.bindRelay(lease('second-scoped-lease'))
    expect(endpoint.endpoint).toBe(url)
    expect((await call('first-scoped-lease')).status).toBe(401)
    expect((await call('second-scoped-lease')).status).toBe(200)
    expect(request).toHaveBeenCalledTimes(2)
    await endpoint.close()
  })
  it.each(['GRAPHQL_MCP_TOKEN', 'FOREMAN_CODE_MCP_TOKEN'])('forwards the scoped %s bearer and retains authorized expiry', async tokenName => {
    const f = await setup(tokenName)
    const route = JSON.parse(await readFile(f.route, 'utf8'))
    expect(route).toMatchObject({ endpoint: f.endpoint.endpoint, expiresAt: f.expiresAt })
    expect(JSON.stringify(route)).not.toContain(f.token)
    const result = await fetch(f.endpoint.endpoint, { method: 'POST', headers: { authorization: `Bearer ${f.token}`, 'mcp-protocol-version': '2026-07-28' }, body: '{"method":"tools/list"}' })
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({ result: 'Main grant checked' })
    expect(f.request).toHaveBeenCalledWith({ method: 'tools/list' }, '2026-07-28', expect.any(AbortSignal))
    await f.endpoint.close(); await f.endpoint.close()
    await expect(readFile(f.route)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('denies another bearer before calling Main and rejects malformed bodies', async () => {
    const f = await setup()
    const denied = await fetch(f.endpoint.endpoint, { method: 'POST', headers: { authorization: 'Bearer another-agent' }, body: '{}' })
    expect(denied.status).toBe(401)
    const malformed = await fetch(f.endpoint.endpoint, { method: 'POST', headers: { authorization: `Bearer ${f.token}` }, body: '{' })
    expect(malformed.status).toBe(400)
    expect(f.request).not.toHaveBeenCalled()
  })
  it('renews a bound route inside its expiry window without waiting for a Main status frame', async () => {
    const root = await temporaryDirectory('worker-lease-renewal-')
    roots.push(root)
    const token = 'lease-renewal-credential'
    const renewedExpiry = new Date(Date.now() + 15 * 60_000).toISOString()
    const refresh = vi.fn(async () => renewedExpiry)
    const endpoint = await createWorkerMcpEndpoint({ launcher: join(root, 'graphql-mcp.mjs'),
      signal: new AbortController().signal, relay: {
        environment: { agentId: 'renewing-agent', variables: { GRAPHQL_MCP_TOKEN: token } },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        request: vi.fn(async () => ({ statusCode: 200, contentType: 'application/json' as const, body: '{}' })),
        refresh,
      } })
    endpoints.push(endpoint)
    const route = join(root, 'routes', `${createHash('sha256').update(token).digest('hex')}.json`)
    await vi.waitFor(async () => expect(JSON.parse(await readFile(route, 'utf8')).expiresAt).toBe(renewedExpiry))
    expect(refresh).toHaveBeenCalled()
  })
  it('refreshes the original private route expiry while keeping its token and endpoint', async () => {
    const f = await setup()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.expiresAt) - 2 * 60_000)
    const renewedExpiry = new Date(Date.now() + 30 * 60_000).toISOString()
    f.refresh.mockResolvedValueOnce(renewedExpiry)
    expect(await f.endpoint.refreshLease()).toBe(renewedExpiry)
    expect(JSON.parse(await readFile(f.route, 'utf8'))).toMatchObject({
      endpoint: f.endpoint.endpoint, expiresAt: renewedExpiry, pid: process.pid,
    })
    clock.mockReturnValue(Date.parse(renewedExpiry) - 10 * 60_000)
    try {
      const response = await fetch(f.endpoint.endpoint, { method: 'POST',
        headers: { authorization: `Bearer ${f.token}` }, body: '{"method":"tools/list"}' })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ result: 'Main grant checked' })
    } finally {
      clock.mockReturnValue(Date.parse(renewedExpiry) - 2 * 60_000)
    }
    f.refresh.mockRejectedValueOnce(new Error('Original lease revoked'))
    await expect(f.endpoint.refreshLease()).rejects.toThrow('Original lease revoked')
    expect(JSON.parse(await readFile(f.route, 'utf8')).expiresAt).toBe(renewedExpiry)
    await f.endpoint.close()
    await expect(f.endpoint.refreshLease()).rejects.toThrow('closing')
    await expect(readFile(f.route)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps a live route without renewing outside its renewal window', async () => {
    const f = await setup()
    for (let index = 0; index < 3; index++) {
      expect(await f.endpoint.refreshLease()).toBe(f.expiresAt)
    }
    expect(f.refresh).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(f.route, 'utf8')).expiresAt).toBe(f.expiresAt)
  })

  it.each([
    { code: 'timeout', retryable: true, kind: 'relay_unavailable', text: 'did not answer in time' },
    { code: 'AUTH_REVOKED', retryable: false, kind: 'relay_refused', text: 'refused the call (AUTH_REVOKED)' },
  ])('answers a tool call the relay could not complete ($code) with a JSON-RPC error, not a bare 502',
    async ({ code, retryable, kind, text }) => {
      const f = await setup()
      f.request.mockRejectedValueOnce(new DeviceApplicationError(code))
      const response = await fetch(f.endpoint.endpoint, { method: 'POST', headers: { authorization: `Bearer ${f.token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'ci_get', arguments: {} } }) })
      expect(response.status).toBe(200)
      const reply = await response.json() as { id: number; error: { message: string; data: unknown } }
      expect(reply).toMatchObject({ jsonrpc: '2.0', id: 41,
        error: { code: -32000, data: { kind, code, retryable, delivery: 'indeterminate' } } })
      expect(reply.error.message).toContain(text)
    })

  it('asks Main once for a lease it refused and stops renewing it', async () => {
    const log = diagnostics.componentLogger('harness')
    const error = vi.spyOn(log, 'error')
    vi.spyOn(diagnostics, 'componentLogger').mockReturnValue(log)
    const f = await setup()
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.expiresAt) - 2 * 60_000)
    f.refresh.mockRejectedValue(new DeviceApplicationError('AUTH_REVOKED'))
    for (let index = 0; index < 3; index++) {
      await expect(f.endpoint.refreshLease()).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    }
    expect(f.refresh).toHaveBeenCalledOnce()
    expect(error.mock.calls.filter(([, message]) => message === 'Worker MCP relay failed')).toHaveLength(1)
  })

  it('records why its renewal stopped in the route, so the launcher reports the cause instead of a bare expiry', async () => {
    const root = await temporaryDirectory('worker-lease-refused-')
    roots.push(root)
    const token = 'refused-renewal-credential'
    const refresh = vi.fn(async (): Promise<string> => { throw new DeviceApplicationError('AUTH_REVOKED') })
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const endpoint = await createWorkerMcpEndpoint({ launcher: join(root, 'graphql-mcp.mjs'),
      signal: new AbortController().signal, relay: {
        environment: { agentId: 'abandoned-agent', variables: { GRAPHQL_MCP_TOKEN: token } }, expiresAt,
        request: vi.fn(async () => ({ statusCode: 200, contentType: 'application/json' as const, body: '{}' })),
        refresh,
      } })
    endpoints.push(endpoint)
    const route = join(root, 'routes', `${createHash('sha256').update(token).digest('hex')}.json`)
    await vi.waitFor(async () => expect(JSON.parse(await readFile(route, 'utf8'))).toMatchObject({
      endpoint: endpoint.endpoint, expiresAt, renewalFailure: expect.stringContaining('AUTH_REVOKED') }))
    expect(JSON.stringify(JSON.parse(await readFile(route, 'utf8')))).not.toContain(token)
    // Main refused the lease for good: the attempt's renewal stops instead of asking again.
    await new Promise(resolve => setTimeout(resolve, 2_500))
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('renews once when concurrent polls enter the renewal window', async () => {
    const f = await setup()
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.expiresAt) - 2 * 60_000)
    const renewedExpiry = new Date(Date.now() + 15 * 60_000).toISOString()
    f.refresh.mockResolvedValue(renewedExpiry)
    const expiries = await Promise.all(Array.from({ length: 8 }, () => f.endpoint.refreshLease()))
    expect(expiries).toEqual(Array(8).fill(renewedExpiry))
    expect(f.refresh).toHaveBeenCalledOnce()
    expect(JSON.parse(await readFile(f.route, 'utf8')).expiresAt).toBe(renewedExpiry)
  })
})
