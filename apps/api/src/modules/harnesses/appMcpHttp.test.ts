import { createServer, type ServerResponse } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { APP_MCP_TIMEOUTS } from './appMcpLauncher.js'
import { requestAppMcp } from './appMcpHttp.js'
import { deviceRequestTimeoutMs } from '../devices/deviceRequestRetry.js'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it.each(['managed-launcher', 'worker'] as const)('preserves the %s request deadline', async role => {
  const received = deferred<ServerResponse>()
  const server = createServer((request, response) => {
    expect(request.headers.authorization).toBe('Bearer budget-fixture')
    received.resolve(response)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('A loopback listener is required')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), milliseconds)
    return controller.signal
  })
  const endpoint = `http://127.0.0.1:${address.port}/mcp`
  const body = { jsonrpc: '2.0', id: 1, method: 'ping' }
  const signal = new AbortController().signal
  const operation = role === 'managed-launcher'
    ? requestAppMcp(endpoint, body, 'budget-fixture', '2025-03-26', signal, APP_MCP_TIMEOUTS.tool_timeout_sec * 1000)
    : requestAppMcp(endpoint, body, 'budget-fixture', '2025-03-26', signal)
  const outcome = operation.then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error }))
  try {
    const response = await received.promise
    await vi.advanceTimersByTimeAsync(deviceRequestTimeoutMs + 1)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
    if (role === 'managed-launcher') {
      expect(await outcome).toMatchObject({ status: 'fulfilled', value: {
        statusCode: 200, contentType: 'application/json', body: '{"ok":true}',
      } })
    } else {
      expect(await outcome).toMatchObject({ status: 'rejected', error: { name: 'TimeoutError' } })
    }
  } finally {
    vi.useRealTimers()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

it('refuses redirects without forwarding the scoped bearer to their target', async () => {
  let targetRequests = 0
  let originalRequests = 0
  const target = createServer((_request, response) => { targetRequests++; response.end('{}') })
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve))
  const address = target.address()
  if (!address || typeof address === 'string') throw new Error('A target listener is required')
  const source = createServer((_request, response) => {
    originalRequests++
    response.writeHead(302, { location: `http://127.0.0.1:${address.port}/mcp` })
    response.end()
  })
  await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve))
  const origin = source.address()
  if (!origin || typeof origin === 'string') throw new Error('An origin listener is required')
  try {
    await expect(requestAppMcp(`http://127.0.0.1:${origin.port}/mcp`, { method: 'ping' }, 'redirect-fixture'))
      .rejects.toThrow()
    expect(originalRequests).toBe(1)
    expect(targetRequests).toBe(0)
  } finally {
    for (const server of [source, target]) {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  }
})
