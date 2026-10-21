import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, expect, it } from 'vitest'
import { APP_MCP_TIMEOUTS, registerAppRoute } from '../src/modules/harnesses/appMcpLauncher.js'
import { deviceRequestTimeoutMs } from '../src/modules/devices/deviceRequestRetry.js'
import { deviceForegroundWaitMs } from '../src/modules/devices/deviceRequestQueue.js'
import { workerMcpUploadCeilingMs } from '../src/modules/devices/workerMcpDeadline.js'

const cleanup: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

type Reply = (call: { waitSeconds: number; index: number }) => {
  status: number; result?: unknown; error?: unknown; delayMs?: number
}
const waitResult = (status: 'still-running' | 'settled') => ({ structuredContent: {
  run: { id: 'ticket', state: 'running' },
  partitions: [{ id: 'ticket', state: 'running' }, { id: 'sibling', state: 'passed' }], wait: {
  until: 'group-terminal', status, tickets: 2, settledTickets: status === 'settled' ? 2 : 1 } }, content: [] })

/** A fake authenticated MCP endpoint whose ci_get answers follow a script; the bridge is the unit under test. */
async function fakeEndpoint(reply: Reply) {
  const calls: Array<{ waitSeconds: number; name?: string | undefined }> = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const server: Server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const message = JSON.parse(body) as { id?: number; method: string; params?: { name: string; arguments: { waitSeconds: number } } }
      if (message.method !== 'tools/call') { response.writeHead(202).end(); return }
      const index = calls.length
      calls.push({ name: message.params?.name, waitSeconds: message.params?.arguments.waitSeconds ?? 0 })
      const next = reply({ waitSeconds: message.params?.arguments.waitSeconds ?? 0, index })
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (next.status !== 200) { response.writeHead(next.status).end(); return }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: next.result, error: next.error }))
      }, next.delayMs ?? 0)
      timers.add(timer)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => {
    for (const timer of timers) clearTimeout(timer)
    server.closeAllConnections()
    server.close(() => resolve())
  }))
  const { port } = server.address() as { port: number }
  return { endpoint: `http://127.0.0.1:${port}/mcp`, calls }
}

interface BridgeReply {
  id: number
  result: { structuredContent: { wait: { status: string; tickets: number; settledTickets: number } } }
  error: { code: number; message: string; data: { kind: string } }
}

/** Starts the managed stdio bridge the way a harness launches it, with a route to the fake endpoint. */
async function startBridge(endpoint: string, options: { clockScale?: number; claudeTimeoutMs?: number } = {}) {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'graphql-group-wait-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const launcher = join(directory, 'graphql-mcp.mjs')
  await copyFile(new URL('../../../scripts/graphql-mcp.mjs', import.meta.url), launcher)
  const token = `group-wait-${Math.random().toString(36).slice(2)}`
  await registerAppRoute(token, endpoint, new Date(Date.now() + 86_400_000).toISOString(), launcher)
  const args: string[] = []
  if (options.clockScale) {
    const clock = join(directory, 'clock.mjs')
    await writeFile(clock, `
      import timers from 'node:timers/promises'
      import { syncBuiltinESMExports } from 'node:module'
      const now = Date.now.bind(Date)
      const started = now()
      Date.now = () => started + (now() - started) * ${options.clockScale}
      const timeout = AbortSignal.timeout.bind(AbortSignal)
      AbortSignal.timeout = ms => timeout(Math.max(1, Math.ceil(ms / ${options.clockScale})))
      const wait = timers.setTimeout
      timers.setTimeout = (ms, ...args) => wait(Math.ceil(ms / ${options.clockScale}), ...args)
      syncBuiltinESMExports()
    `)
    args.push('--import', clock)
  }
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => name !== 'FOREMAN_CODE_MCP_TOKEN'))
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [...args, launcher],
    { env: { ...environment, GRAPHQL_MCP_TOKEN: token,
      ...(options.claudeTimeoutMs ? { MCP_TOOL_TIMEOUT: String(options.claudeTimeoutMs) } : {}) }, stdio: 'pipe' })
  cleanup.push(() => { child.kill() })
  const replies = new Map<number, (message: BridgeReply) => void>()
  const lines: Array<{ id?: number }> = []
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line) as BridgeReply & { id?: number }
    lines.push(message)
    if (message.id !== undefined) replies.get(message.id)?.(message)
  })
  return {
    lines,
    request: (id: number, method: string, params: unknown) => new Promise<BridgeReply>(resolve => {
      replies.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    }),
    notify: (method: string, params: unknown) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
  }
}

const groupWait = (ticketId: string, waitSeconds: number) => ({ name: 'ci_get',
  arguments: { ticketId, waitUntil: 'group-terminal', waitSeconds, logTail: false } })

it('reports a refused loopback connection as an unsent transport failure', async () => {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback listener')
  await new Promise<void>(resolve => server.close(() => resolve()))
  const bridge = await startBridge(`http://127.0.0.1:${address.port}/mcp`)
  const reply = await bridge.request(32, 'tools/call', { name: 'reference_file_add', arguments: {} })
  expect(reply.error.data).toEqual({ kind: 'transport' })
  expect(bridge.lines.filter(line => line.id === 32)).toHaveLength(1)
})

it('allows a native reference call its queue, progressing upload and execution budgets', async () => {
  const budgetMs = deviceRequestTimeoutMs + deviceForegroundWaitMs + workerMcpUploadCeilingMs + 100_000
  const fake = await fakeEndpoint(() => ({ status: 200, delayMs: budgetMs / 100,
    result: { content: [], structuredContent: { stored: true } } }))
  const bridge = await startBridge(fake.endpoint, { clockScale: 100 })
  const reply = await bridge.request(30, 'tools/call', { name: 'reference_file_add', arguments: {} })
  expect(reply).toMatchObject({ result: { structuredContent: { stored: true } } })
  expect(APP_MCP_TIMEOUTS.tool_timeout_sec * 1000).toBeGreaterThan(budgetMs)
  expect(fake.calls).toHaveLength(1)
})

it('returns a stalled reference upload failure without retrying the write', async () => {
  const failure = relayError('timeout', false)
  const fake = await fakeEndpoint(() => ({ status: 200, error: failure, delayMs: 150 }))
  const bridge = await startBridge(fake.endpoint, { clockScale: 100 })
  const reply = await bridge.request(31, 'tools/call', { name: 'reference_file_add', arguments: {} })
  expect(reply.error).toEqual(failure)
  expect(fake.calls).toHaveLength(1)
})

it.each([
  { claudeTimeoutMs: undefined, stall: false },
  { claudeTimeoutMs: 120_000, stall: false },
  { claudeTimeoutMs: undefined, stall: true },
])('returns the running group before the client timeout ($claudeTimeoutMs, stalled=$stall)', async ({ claudeTimeoutMs, stall }) => {
  const scale = 200
  const timeoutMs = Math.min(APP_MCP_TIMEOUTS.tool_timeout_sec * 1000, claudeTimeoutMs ?? Infinity)
  const fake = await fakeEndpoint(({ index }) => ({ status: 200,
    delayMs: stall && index > 0 ? timeoutMs / scale * 2 : 20, result: waitResult('still-running') }))
  const bridge = await startBridge(fake.endpoint, { clockScale: scale, ...(claudeTimeoutMs ? { claudeTimeoutMs } : {}) })
  // The harness keeps its bridge running between calls, so process startup is not part of the client's deadline.
  await bridge.request(1, 'tools/call', { name: 'ci_get', arguments: { ticketId: 'ticket' } })
  fake.calls.length = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const reply = await Promise.race([
      bridge.request(24, 'tools/call', groupWait('ticket', 1800)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Client tool deadline reached')), timeoutMs / scale)
      }),
    ])
    expect(reply.result).toEqual(waitResult('still-running'))
    expect(fake.calls[0]!.waitSeconds).toBeLessThanOrEqual(timeoutMs * 0.9 / 1000)
    expect(bridge.lines.filter(line => line.id === 24)).toHaveLength(1)
  } finally {
    clearTimeout(timer)
  }
})

it('keeps one Agent tool call open across bounded chunks until the group settles', async () => {
  const fake = await fakeEndpoint(({ index }) => ({ status: 200, delayMs: 100,
    result: waitResult(index < 2 ? 'still-running' : 'settled') }))
  const bridge = await startBridge(fake.endpoint)
  const started = Date.now()
  const reply = await bridge.request(7, 'tools/call', groupWait('ticket', 30))
  expect(reply.result.structuredContent.wait.status).toBe('settled')
  expect(Date.now() - started).toBeLessThan(5_000)
  expect(fake.calls).toHaveLength(3)
  expect(fake.calls[1]!.waitSeconds!).toBeLessThan(fake.calls[0]!.waitSeconds!)
  expect(bridge.lines.filter(line => line.id === 7)).toHaveLength(1)
})

it('returns one still-running result when the wait budget elapses', async () => {
  const fake = await fakeEndpoint(() => ({ status: 200, delayMs: 200, result: waitResult('still-running') }))
  const bridge = await startBridge(fake.endpoint)
  const started = Date.now()
  const reply = await bridge.request(8, 'tools/call', groupWait('ticket', 1))
  expect(reply.result.structuredContent.wait).toMatchObject({ status: 'still-running', tickets: 2, settledTickets: 1 })
  expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  expect(Date.now() - started).toBeLessThan(5_000)
  expect(fake.calls.length).toBeGreaterThan(1)
  expect(bridge.lines.filter(line => line.id === 8)).toHaveLength(1)
})

it('continues the same wait after a transient Main outage', async () => {
  const fake = await fakeEndpoint(({ index }) => index === 0
    ? { status: 503 } : { status: 200, result: waitResult('settled') })
  const bridge = await startBridge(fake.endpoint)
  const reply = await bridge.request(9, 'tools/call', groupWait('ticket', 30))
  expect(reply.result.structuredContent.wait.status).toBe('settled')
  expect(fake.calls).toHaveLength(2)
}, 20_000)

const relayError = (code: string, retryable?: boolean) => ({ code: -32000, message: 'Fixture relay failure',
  data: { kind: retryable ? 'relay_unavailable' : 'relay_refused', code,
    ...(retryable === undefined ? {} : { retryable }), delivery: 'indeterminate' } })

it.each(['timeout', 'backpressure', 'transport'])(
  'retries an HTTP-200 %s relay failure while the group-wait budget remains', async code => {
    const fake = await fakeEndpoint(({ index }) => ({ status: 200,
      ...(index === 0 ? { error: relayError(code, true) } : { result: waitResult('settled') }) }))
    const bridge = await startBridge(fake.endpoint)
    const reply = await bridge.request(18, 'tools/call', groupWait('ticket', 30))
    expect(reply).toMatchObject({ result: { structuredContent: { wait: { status: 'settled' } } } })
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[1]!.waitSeconds).toBeLessThan(fake.calls[0]!.waitSeconds)
    expect(bridge.lines.filter(line => line.id === 18)).toHaveLength(1)
  },
)

it.each([false, undefined])('returns a relay failure with retryable=%s once', async retryable => {
  const failure = relayError('timeout', retryable)
  const fake = await fakeEndpoint(() => ({ status: 200, error: failure }))
  const bridge = await startBridge(fake.endpoint)
  const reply = await bridge.request(19, 'tools/call', groupWait('ticket', 2))
  expect(reply.error).toEqual(failure)
  expect(fake.calls).toHaveLength(1)
})

it('does not retry a retryable relay failure for an ordinary ci_get', async () => {
  const failure = relayError('transport', true)
  const fake = await fakeEndpoint(() => ({ status: 200, error: failure }))
  const bridge = await startBridge(fake.endpoint)
  const reply = await bridge.request(20, 'tools/call', { name: 'ci_get', arguments: { ticketId: 'ticket' } })
  expect(reply.error).toEqual(failure)
  expect(fake.calls).toHaveLength(1)
})

it('returns the relay failure when retrying exhausts the budget without a successful wait', async () => {
  const failure = relayError('backpressure', true)
  const fake = await fakeEndpoint(() => ({ status: 200, error: failure }))
  const bridge = await startBridge(fake.endpoint)
  const started = Date.now()
  const reply = await bridge.request(21, 'tools/call', groupWait('ticket', 1))
  expect(reply.error).toEqual(failure)
  expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  expect(Date.now() - started).toBeLessThan(5_000)
  expect(bridge.lines.filter(line => line.id === 21)).toHaveLength(1)
})

it('retains the last still-running result when relay failures exhaust the budget', async () => {
  const fake = await fakeEndpoint(({ index }) => ({ status: 200,
    ...(index === 0 ? { result: waitResult('still-running') } : { error: relayError('transport', true) }) }))
  const bridge = await startBridge(fake.endpoint)
  const started = Date.now()
  const reply = await bridge.request(22, 'tools/call', groupWait('ticket', 1))
  expect(reply).toMatchObject({ result: { structuredContent: { wait: { status: 'still-running' } } } })
  expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  expect(fake.calls.length).toBeGreaterThan(1)
  expect(bridge.lines.filter(line => line.id === 22)).toHaveLength(1)
})

it('returns a permanent relay failure even after a still-running result', async () => {
  const failure = relayError('credential_revoked', false)
  const fake = await fakeEndpoint(({ index }) => ({ status: 200,
    ...(index === 0 ? { result: waitResult('still-running') } : { error: failure }) }))
  const bridge = await startBridge(fake.endpoint)
  const reply = await bridge.request(23, 'tools/call', groupWait('ticket', 30))
  expect(reply.error).toEqual(failure)
  expect(fake.calls).toHaveLength(2)
})

const toolError = (code: string, retryable?: boolean) => ({ isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error: { code, message: 'Fixture tool failure',
    ...(retryable === undefined ? {} : { details: { retryable } }) } }) }] })

it('backs off and retries explicitly retryable tool failures within the group wait', async () => {
  const fake = await fakeEndpoint(({ index }) => ({ status: 200,
    result: index < 2 ? toolError('DATABASE_READ_TIMEOUT', true) : waitResult('settled') }))
  const bridge = await startBridge(fake.endpoint)
  const started = Date.now()
  const reply = await bridge.request(13, 'tools/call', groupWait('ticket', 30))
  expect(reply.result.structuredContent.wait.status).toBe('settled')
  expect(Date.now() - started).toBeGreaterThanOrEqual(3_000)
  expect(fake.calls).toHaveLength(3)
  expect(fake.calls[2]!.waitSeconds).toBeLessThan(fake.calls[0]!.waitSeconds)
  expect(bridge.lines.filter(line => line.id === 13)).toHaveLength(1)
})

it.each([
  ['ACCESS_DENIED', true],
  ['AUTH_EXPIRED', true],
  ['DATABASE_READ_TIMEOUT', false],
  ['DATABASE_READ_TIMEOUT', undefined],
] as const)('returns terminal tool failure %s with retryable=%s once', async (code, retryable) => {
  const failure = toolError(code, retryable)
  const fake = await fakeEndpoint(() => ({ status: 200, result: failure }))
  const bridge = await startBridge(fake.endpoint)
  const reply = await bridge.request(14, 'tools/call', groupWait('ticket', 2))
  expect(reply.result).toEqual(failure)
  expect(fake.calls).toHaveLength(1)
})

it('does not retry an explicitly retryable tool failure for an ordinary ci_get', async () => {
  const failure = toolError('DATABASE_READ_TIMEOUT', true)
  const fake = await fakeEndpoint(() => ({ status: 200, result: failure }))
  const bridge = await startBridge(fake.endpoint)
  const reply = await bridge.request(17, 'tools/call', { name: 'ci_get', arguments: { ticketId: 'ticket' } })
  expect(reply.result).toEqual(failure)
  expect(fake.calls).toHaveLength(1)
})

it('returns the last still-running result when retryable tool failures exhaust the budget', async () => {
  const fake = await fakeEndpoint(({ index }) => ({ status: 200,
    result: index === 0 ? waitResult('still-running') : toolError('DATABASE_READ_TIMEOUT', true) }))
  const bridge = await startBridge(fake.endpoint)
  const reply = await bridge.request(15, 'tools/call', groupWait('ticket', 1))
  expect(reply.result.structuredContent.wait.status).toBe('still-running')
  expect(fake.calls.length).toBeGreaterThan(1)
  expect(bridge.lines.filter(line => line.id === 15)).toHaveLength(1)
})

it('returns the retryable tool failure when no successful wait reply arrives before the deadline', async () => {
  const failure = toolError('DATABASE_READ_TIMEOUT', true)
  const fake = await fakeEndpoint(() => ({ status: 200, result: failure }))
  const bridge = await startBridge(fake.endpoint)
  const started = Date.now()
  const reply = await bridge.request(16, 'tools/call', groupWait('ticket', 1))
  expect(reply.result).toEqual(failure)
  expect(Date.now() - started).toBeGreaterThanOrEqual(900)
})

it('fails a denied group wait once without polling', async () => {
  const fake = await fakeEndpoint(() => ({ status: 403 }))
  const bridge = await startBridge(fake.endpoint)
  const reply = await bridge.request(10, 'tools/call', groupWait('ticket', 300))
  expect(reply.error.data.kind).toBe('forbidden')
  expect(fake.calls).toHaveLength(1)
})

it('forwards an ordinary ci_get once even when the reply is a still-running wait', async () => {
  const fake = await fakeEndpoint(() => ({ status: 200, result: waitResult('still-running') }))
  const bridge = await startBridge(fake.endpoint)
  const reply = await bridge.request(11, 'tools/call', { name: 'ci_get', arguments: { ticketId: 'ticket' } })
  expect(reply.result.structuredContent.wait.status).toBe('still-running')
  expect(fake.calls).toHaveLength(1)
})

it('returns the last still-running result when Main is unreachable as the budget ends', async () => {
  const fake = await fakeEndpoint(({ index }) => index === 0
    ? { status: 200, result: waitResult('still-running') } : { status: 503 })
  const bridge = await startBridge(fake.endpoint)
  const reply = await bridge.request(12, 'tools/call', groupWait('ticket', 2))
  expect(reply.result.structuredContent.wait).toMatchObject({ status: 'still-running', tickets: 2, settledTickets: 1 })
  expect(fake.calls.length).toBeGreaterThan(1)
}, 20_000)
