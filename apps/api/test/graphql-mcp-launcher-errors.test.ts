import { describe, expect, it } from 'vitest'
import { mcpLauncherFixture } from './support/mcpLauncher.js'

describe('MCP launcher failure guidance', () => {
  // Retry backoff only. Requests the server answers keep their real timeouts, so a slow machine never adds a retry.
  const fastBackoff = `
    const schedule = globalThis.setTimeout;
    globalThis.setTimeout = (callback, milliseconds, ...args) =>
      schedule(callback, [1000, 2000].includes(milliseconds) ? 1 : milliseconds, ...args);
  `
  const fastStartup = `
    const schedule = globalThis.setTimeout;
    globalThis.setTimeout = (callback, milliseconds, ...args) =>
      schedule(callback, [1000, 2000].includes(milliseconds) ? 1 : milliseconds, ...args);
    const timeout = AbortSignal.timeout;
    AbortSignal.timeout = milliseconds =>
      timeout([10000, 45000, 120000].includes(milliseconds) ? 100 : milliseconds);
  `

  it.each(['initialize', 'tools/list'])('allows a slow authenticated discovery response during %s', async method => {
    const f = await mcpLauncherFixture((message, response) => {
      setTimeout(() => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        jsonrpc: '2.0', id: message.id, result: method === 'initialize'
          ? { protocolVersion: '2025-03-26' } : { tools: [{ name: 'context_get' }, { name: 'ci_get' }] },
      })), 120)
    }, { preload: `
      const schedule = globalThis.setTimeout;
      globalThis.setTimeout = (callback, milliseconds, ...args) =>
        schedule(callback, [1000, 2000].includes(milliseconds) ? 1 : milliseconds, ...args);
      const timeout = AbortSignal.timeout;
      const scaledTimeouts = new Map([[10000, 30], [45000, 300], [55000, 800]]);
      AbortSignal.timeout = milliseconds => timeout(scaledTimeouts.get(milliseconds) ?? milliseconds);
    ` })
    try {
      f.send({ id: 'slow-discovery', method })
      const result = await f.receive('slow-discovery')
      expect(result.error).toBeUndefined()
      expect(result.result).toEqual(method === 'initialize'
        ? { protocolVersion: '2025-03-26' } : { tools: [{ name: 'context_get' }, { name: 'ci_get' }] })
    } finally { await f.close() }
  }, 10_000)

  it.each([{}, { tools: [] }])('reports an invalid or empty discovery result: %j', async result => {
    const f = await mcpLauncherFixture((message, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
    try {
      f.send({ id: 'empty-discovery', method: 'tools/list' })
      expect(await f.receive('empty-discovery')).toMatchObject({ error: {
        data: { kind: 'invalid_response' }, message: expect.stringContaining('tool discovery'),
      } })
      expect(f.messages.filter(message => message.id === 'empty-discovery')).toHaveLength(1)
      expect(f.messages[0]?.result).toBeUndefined()
    } finally { await f.close() }
  }, 10_000)

  it.each(['initialize', 'tools/list'])('retries transient HTTP failures during %s', async method => {
    const requests: unknown[] = []
    const f = await mcpLauncherFixture((message, response) => {
      requests.push(message)
      if (requests.length < 3) response.writeHead(requests.length === 1 ? 500 : 503).end()
      else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        jsonrpc: '2.0', id: message.id, result: method === 'initialize'
          ? { protocolVersion: '2025-03-26' } : { tools: [{ name: 'context_get' }] },
      }))
    }, { preload: fastBackoff })
    try {
      f.send({ id: 'startup', method })
      expect(await f.receive('startup')).toMatchObject({ id: 'startup', result: expect.any(Object) })
      expect(requests).toHaveLength(3)
      expect(requests[1]).toEqual(requests[0])
      expect(requests[2]).toEqual(requests[0])
      expect(f.messages.filter(message => message.id === 'startup')).toHaveLength(1)
    } finally { await f.close() }
  }, 10_000)

  it.each(['initialize', 'tools/list'])('retries a timeout during %s', async method => {
    let requests = 0
    const f = await mcpLauncherFixture((message, response) => {
      requests++
      if (requests > 1) response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'context_get' }] },
      }))
    }, { preload: fastStartup })
    try {
      f.send({ id: 'startup-timeout', method })
      expect(await f.receive('startup-timeout')).toMatchObject({ result: expect.any(Object) })
      expect(requests).toBe(2)
    } finally { await f.close() }
  }, 10_000)

  it('bounds startup retries and reports the final retryable failure', async () => {
    let requests = 0
    const f = await mcpLauncherFixture((_message, response) => {
      requests++
      response.writeHead(500).end()
    }, { preload: fastBackoff })
    try {
      f.send({ id: 'startup-failed', method: 'initialize' })
      expect(await f.receive('startup-failed')).toMatchObject({ error: {
        data: { kind: 'service_unavailable', httpStatus: 500, retryable: true },
      } })
      expect(requests).toBe(3)
    } finally { await f.close() }
  }, 10_000)

  it.each([401, 403])('does not retry permanent startup HTTP %s', async status => {
    let requests = 0
    const f = await mcpLauncherFixture((_message, response) => {
      requests++
      response.writeHead(status).end()
    }, { preload: fastBackoff })
    try {
      f.send({ id: 'startup-denied', method: 'initialize' })
      expect(await f.receive('startup-denied')).toMatchObject({ error: { data: { httpStatus: status } } })
      expect(requests).toBe(1)
    } finally { await f.close() }
  }, 10_000)

  it.each([
    { status: 401, kind: 'authentication', guidance: 'Refresh the owning app credential' },
    { status: 403, kind: 'forbidden', guidance: 'grants and scope' },
    { status: 413, kind: 'request_too_large', guidance: 'Reduce the request payload' },
    { status: 503, kind: 'service_unavailable', guidance: 'Retry later' },
  ])('preserves the RPC id and safely classifies HTTP $status', async ({ status, kind, guidance }) => {
    const f = await mcpLauncherFixture((_message, response) => {
      response.writeHead(status, { 'content-type': 'text/plain' }).end('secret server diagnostic /private/path')
    })
    try {
      f.send({ id: `request-${status}`, method: 'tools/call', params: { name: 'interaction_get' } })
      const result = await f.receive(`request-${status}`)
      expect(result.id).toBe(`request-${status}`)
      expect(result.error).toMatchObject({ data: { kind, httpStatus: status }, message: expect.stringContaining(guidance) })
      expect(JSON.stringify(result)).not.toMatch(/secret|private|[Rr]estart|could not connect/)
    } finally { await f.close() }
  }, 10_000)

  it('reports connection refusal as a transport failure without restart advice', async () => {
    const f = await mcpLauncherFixture(() => {}, { unavailableEndpoint: true })
    try {
      f.send({ id: 17, method: 'ping' })
      const result = await f.receive(17)
      expect(result).toMatchObject({ id: 17, error: {
        data: { kind: 'transport' }, message: expect.stringContaining('Check that the owning app is running'),
      } })
      expect(result.error?.message).not.toMatch(/[Rr]estart/)
    } finally { await f.close() }
  }, 10_000)

  it.each([false, true])('reports timeout before or during streaming; streaming=%s', async (streaming) => {
    const f = await mcpLauncherFixture((_message, response) => {
      if (streaming) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(': keepalive\n\n')
      }
    }, {
      preload: 'const originalTimeout = AbortSignal.timeout; AbortSignal.timeout = () => originalTimeout(100);',
    })
    try {
      f.send({ id: 'timed-out', method: 'tools/call', params: { name: 'interaction_respond' } })
      const result = await f.receive('timed-out')
      expect(result).toMatchObject({ id: 'timed-out', error: {
        data: { kind: 'timeout' }, message: expect.stringContaining('may have committed'),
      } })
      expect(result.error?.message).not.toMatch(/[Rr]estart|could not connect/)
    } finally { await f.close() }
  }, 10_000)

  it.each(['truncated-json', 'truncated-sse', 'broken-body', 'empty-accepted'])('reports uncertain delivery after a committed request with %s', async fault => {
      const committed: string[] = []
      const commandId = '695abeb8-598a-49a4-8c3c-c6e3533053e8'
      const f = await mcpLauncherFixture((message, response) => {
        committed.push(String((message.params?.arguments as { commandId: string }).commandId))
        if (fault === 'empty-accepted') {
          response.writeHead(202).end()
        } else if (fault === 'truncated-json') {
          response.writeHead(200, { 'content-type': 'application/json' }).end('{"jsonrpc":"2.0","result":')
        } else {
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.write('data: {"jsonrpc":"2.0","id":"uncertain","result":')
          if (fault === 'broken-body') setTimeout(() => response.destroy(), 20)
          else response.end()
        }
      })
      try {
        f.send({ id: 'uncertain', method: 'tools/call', params: { arguments: { commandId } } })
        const result = await f.receive('uncertain')
        expect(result.error).toMatchObject({
          data: expect.objectContaining({ delivery: 'indeterminate' }),
          message: expect.stringContaining('Read back the original command'),
        })
        expect(result.result).toBeUndefined()
        expect(committed).toEqual([commandId])
        expect(f.messages.filter(message => message.id === 'uncertain')).toHaveLength(1)
      } finally { await f.close() }
    }, 10_000)

  it('delivers one split SSE result and ignores trailing duplicate results', async () => {
    let requests = 0
    const f = await mcpLauncherFixture((message, response) => {
      requests++
      const terminal = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { commandId: 'original' } })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${terminal.slice(0, 15)}`)
      setTimeout(() => response.end(`${terminal.slice(15)}\n\ndata: ${terminal}\n\n`), 10)
    })
    try {
      f.send({ id: 'split', method: 'tools/call' })
      expect(await f.receive('split')).toMatchObject({ id: 'split', result: { commandId: 'original' } })
      expect(f.messages.filter(message => message.id === 'split')).toHaveLength(1)
      expect(requests).toBe(1)
    } finally { await f.close() }
  }, 10_000)
})
