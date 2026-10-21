// Managed stdio bridge to the owning app's authenticated, stateless MCP endpoint.
// Routes contain only a credential digest, never the credential itself.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { request } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { setTimeout as wait } from 'node:timers/promises'

const token = process.env.FOREMAN_CODE_MCP_TOKEN ?? process.env.GRAPHQL_MCP_TOKEN
const tokenConflict = process.env.FOREMAN_CODE_MCP_TOKEN !== undefined && process.env.GRAPHQL_MCP_TOKEN !== undefined
  && process.env.FOREMAN_CODE_MCP_TOKEN !== process.env.GRAPHQL_MCP_TOKEN
const directory = join(dirname(fileURLToPath(import.meta.url)), 'routes')
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
let protocolVersion = '2025-03-26'
const pending = new Map()

class BridgeFailure extends Error {
  constructor(kind, message, status) {
    super(message)
    this.kind = kind
    this.status = status
  }
}

function httpFailure(status) {
  if (status === 401) return new BridgeFailure('authentication',
    'MCP authentication expired or was revoked. Refresh the owning app credential before retrying.', status)
  if (status === 403) return new BridgeFailure('forbidden',
    'MCP access was denied. Ask the owning app operator to check this credential’s grants and scope.', status)
  if (status === 413) return new BridgeFailure('request_too_large',
    'The MCP request is too large. Reduce the request payload before retrying.', status)
  if (status === 429 || status >= 500) return new BridgeFailure('service_unavailable',
    'The owning app MCP service is temporarily unavailable. Retry later; read back any decision before retrying a write.', status)
  return new BridgeFailure('http_error',
    `The owning app rejected the MCP request (HTTP ${status}). Check the request before retrying.`, status)
}

function bridgeError(error, deliveryStage) {
  if (error instanceof BridgeFailure) return {
    code: -32000, message: error.message,
    data: { kind: error.kind, ...(error.status ? { httpStatus: error.status } : {}) },
  }
  if (error?.name === 'TimeoutError') return { code: -32000,
    message: 'The MCP request timed out. Read back any decision before retrying; the owning app may have committed it.',
    data: { kind: 'timeout', delivery: 'indeterminate' } }
  if (error instanceof SyntaxError) return { code: -32000,
    message: 'The owning app returned an invalid MCP response. Read back the original command before retrying a write; it may have been committed.',
    data: { kind: 'invalid_response', delivery: 'indeterminate' } }
  const unsent = deliveryStage === 'dispatched'
    && ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(error?.code ?? error?.cause?.code)
  if (deliveryStage !== 'preflight' && !unsent) return { code: -32000,
    message: 'The MCP response was interrupted or incomplete. Read back the original command before retrying a write; it may have been committed.',
    data: { kind: 'indeterminate_delivery', delivery: 'indeterminate' } }
  return { code: -32000,
    message: 'MCP could not connect to its owning app. Check that the owning app is running and retry.',
    data: { kind: 'transport' } }
}

// ci_get is a read, so a group wait retries every transient failure, including a Main restart, until its budget ends.
const GROUP_WAIT_RETRYABLE = ['service_unavailable', 'transport', 'route_unavailable', 'timeout', 'indeterminate_delivery',
  'invalid_response']

function isRetryableToolFailure(result) {
  if (result?.isError !== true) return false
  const text = result.content?.find(block => block.type === 'text')?.text
  if (typeof text !== 'string') return false
  let failure
  try {
    failure = JSON.parse(text)?.error
  } catch (error) {
    if (error instanceof SyntaxError) return false
    throw error
  }
  if (failure?.code === 'ACCESS_DENIED'
    || typeof failure?.code === 'string' && failure.code.startsWith('AUTH_')) return false
  return failure?.details?.retryable === true
}

/** The requested group wait budget; each native call is also bounded by its client deadline. */
function groupWaitBudgetMs(message) {
  if (!Object.hasOwn(message, 'id') || message.method !== 'tools/call' || message.params?.name !== 'ci_get') return undefined
  const args = message.params.arguments
  return args?.waitUntil === 'group-terminal' && args.waitSeconds > 0 ? args.waitSeconds * 1000 : undefined
}

let localBootId

async function routeExpired(route) {
  const clock = route.monotonicExpiry
  if (clock === undefined) return Date.parse(route.expiresAt) <= Date.now()
  if (!clock || typeof clock.bootId !== 'string' || typeof clock.nanoseconds !== 'string'
    || !/^-?\d+$/.test(clock.nanoseconds)) {
    throw new BridgeFailure('route_unavailable', 'The owning app MCP route has an invalid elapsed-time deadline.')
  }
  localBootId ??= (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  if (clock.bootId !== localBootId) {
    throw new BridgeFailure('route_unavailable', 'The owning app MCP route belongs to another computer boot.')
  }
  return process.hrtime.bigint() >= BigInt(clock.nanoseconds)
}

async function readRoute() {
  if (tokenConflict) throw new BridgeFailure('configuration',
    'FOREMAN_CODE_MCP_TOKEN conflicts with GRAPHQL_MCP_TOKEN. Supply one credential or matching credentials.')
  if (!token) throw new BridgeFailure('authentication', 'The MCP credential is missing. Refresh the owning app credential.')
  const key = createHash('sha256').update(token).digest('hex')
  let route
  try {
    route = JSON.parse(await readFile(join(directory, `${key}.json`), 'utf8'))
  } catch {
    throw new BridgeFailure('route_unavailable',
      'The owning app MCP route is unavailable. Open the owning app to refresh this credential’s connection.')
  }
  const expired = await routeExpired(route)
  if (typeof route.renewalFailure === 'string' && expired) {
    throw new BridgeFailure('renewal_failed',
      `The owning app MCP route expired because its renewal failed: ${route.renewalFailure.slice(0, 500)}`)
  }
  const url = new URL(route.endpoint)
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash
    || !Number.isInteger(route.pid) || route.pid <= 0 || expired
    || !Number.isFinite(Date.parse(route.expiresAt))) throw new BridgeFailure('route_unavailable',
      'The owning app MCP route is invalid or expired. Open the owning app to refresh this credential’s connection.')
  return route
}

/** The installed launcher is standalone; Node HTTP avoids fetch's separate five-minute header deadline. */
function postMcp(url, { headers, body, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method: 'POST', headers, signal, timeout: timeoutMs }, resolve)
    outgoing.once('error', reject)
    outgoing.once('timeout', () => outgoing.destroy(new DOMException('MCP HTTP request timed out.', 'TimeoutError')))
    outgoing.end(body)
  })
}

async function forwardAttempt(message, controller, timeoutMs, emit = output) {
  let requestSignal
  let deliveryStage = 'preflight'
  let terminalReceived = false
  const expectsReply = Object.hasOwn(message, 'id')
  try {
    const route = await readRoute()
    const url = new URL(route.endpoint)
    if (timeoutMs === undefined) {
      if (!Number.isFinite(route.toolTimeoutMs) || route.toolTimeoutMs <= 0) {
        throw new BridgeFailure('route_unavailable', 'The MCP route has no client tool timeout. Refresh the owning app route.')
      }
      const claudeTimeoutMs = Number(process.env.MCP_TOOL_TIMEOUT)
      const clientTimeoutMs = Math.min(route.toolTimeoutMs, claudeTimeoutMs > 0 ? claudeTimeoutMs : Infinity)
      // The API enforces upload progress and execution deadlines; leave time to deliver its terminal reply.
      timeoutMs = Math.max(1, clientTimeoutMs - 5_000)
    }
    // The owning API's host PID is not visible inside a harness PID namespace.
    // Each request proves access through the endpoint's scoped credential authentication.
    requestSignal = controller ? AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs)
    deliveryStage = 'dispatched'
    const response = await postMcp(url, { timeoutMs,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': protocolVersion },
      body: JSON.stringify(message), signal: requestSignal })
    deliveryStage = 'response'
    const status = response.statusCode
    if (status < 200 || status >= 300) {
      response.destroy()
      throw httpFailure(status)
    }
    if ((status === 202 || status === 204) && !expectsReply) {
      response.resume()
      return
    }
    const publish = (value) => {
      if (controller?.signal.aborted || terminalReceived) return
      const terminal = expectsReply && value?.id === message.id
        && (Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error'))
      if (terminal && message.method === 'tools/list' && Object.hasOwn(value, 'result')
        && (!Array.isArray(value.result?.tools) || value.result.tools.length === 0)) {
        throw new BridgeFailure('invalid_response',
          'Foreman Code MCP tool discovery returned an invalid or empty catalog. Retry the activation.')
      }
      if (message.method === 'initialize' && value.result?.protocolVersion) protocolVersion = value.result.protocolVersion
      emit(value)
      if (terminal) terminalReceived = true
    }
    if (response.headers['content-type']?.includes('application/json')) {
      const chunks = []
      for await (const chunk of response) chunks.push(chunk)
      publish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    } else {
      let buffer = ''
      const decoder = new TextDecoder()
      for await (const chunk of response) {
        buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n')
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const event = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
          if (data) publish(JSON.parse(data))
          if (terminalReceived) return
        }
      }
    }
    if (expectsReply && !terminalReceived) throw new Error('Missing terminal MCP response.')
  } catch (error) {
    if (terminalReceived || controller?.signal.aborted && controller.signal.reason?.name !== 'TimeoutError') return
    if (expectsReply) return bridgeError(requestSignal?.aborted ? requestSignal.reason : error, deliveryStage)
  }
}

/** Re-resolves the ticket across bounded chunks and Main restarts, leaving time to deliver the native reply. */
async function forwardGroupWait(message, controller, budgetMs) {
  const started = Date.now()
  const route = await readRoute()
  if (!Number.isFinite(route.toolTimeoutMs) || route.toolTimeoutMs <= 0) {
    throw new BridgeFailure('route_unavailable', 'The MCP route has no client tool timeout. Refresh the owning app route.')
  }
  const claudeTimeoutMs = Number(process.env.MCP_TOOL_TIMEOUT)
  const toolTimeoutMs = Math.min(route.toolTimeoutMs, claudeTimeoutMs > 0 ? claudeTimeoutMs : Infinity)
  const deadline = started + Math.min(budgetMs, toolTimeoutMs * 0.9)
  let stillRunning
  let lastFailure
  for (let failures = 0; ;) {
    const remainingMs = Math.max(0, deadline - Date.now())
    if (!remainingMs && (stillRunning || lastFailure)) {
      output(stillRunning ?? lastFailure)
      return
    }
    const waitSeconds = remainingMs / 1000
    const chunk = { ...message, params: { ...message.params, arguments: { ...message.params.arguments, waitSeconds } } }
    let reply
    const timeoutMs = Math.max(1, Math.ceil(Math.min(120_000, remainingMs)))
    const error = await forwardAttempt(chunk, controller, timeoutMs, (value) => { reply = value })
    if (controller.signal.aborted) return
    let retryable
    if (error) {
      retryable = GROUP_WAIT_RETRYABLE.includes(error.data.kind)
    } else if (reply?.error) {
      retryable = reply.error.data?.retryable === true
    } else {
      retryable = isRetryableToolFailure(reply?.result)
    }
    if (error || reply?.error || reply?.result?.isError === true) {
      const failureReply = error ? { jsonrpc: '2.0', id: message.id, error } : reply
      lastFailure = failureReply
      if (!retryable || Date.now() >= deadline) {
        output(stillRunning && retryable ? stillRunning : failureReply)
        return
      }
      failures++
    } else {
      if (reply?.result?.structuredContent?.wait?.status !== 'still-running' || Date.now() >= deadline) {
        output(reply)
        return
      }
      stillRunning = reply
      failures = 0
    }
    if (failures) await wait(Math.min(1_000 * 2 ** (failures - 1), 15_000, Math.max(0, deadline - Date.now())),
      undefined, { signal: controller.signal })
  }
}

async function forward(message, controller) {
  const startup = message.method === 'initialize' || message.method === 'tools/list'
  // Leave time for a slow database read while staying below the native 60-second startup timeout.
  const signal = startup ? AbortSignal.any([AbortSignal.timeout(55_000),
    ...(controller ? [controller.signal] : [])]) : controller?.signal
  const attemptController = signal ? { signal } : undefined
  const budgetMs = groupWaitBudgetMs(message)
  try {
    if (budgetMs !== undefined) return await forwardGroupWait(message, controller, budgetMs)
    for (let attempt = 0; ; attempt++) {
      const error = await forwardAttempt(message, attemptController, startup ? 45_000 : undefined)
      if (!error || controller?.signal.aborted) return
      const retryable = startup && ['service_unavailable', 'timeout'].includes(error.data.kind)
      if (retryable) error.data.retryable = true
      if (!retryable || attempt === 2 || signal?.aborted) {
        output({ jsonrpc: '2.0', id: message.id, error })
        return
      }
      await wait(1_000 * 2 ** attempt, undefined, { signal })
    }
  } catch (error) {
    if (controller?.signal.aborted) return
    const failure = bridgeError(signal?.aborted ? signal.reason : error, 'preflight')
    if (startup && failure.data.kind === 'timeout') failure.data.retryable = true
    if (Object.hasOwn(message, 'id')) output({ jsonrpc: '2.0', id: message.id, error: failure })
  } finally {
    if (controller && pending.get(message.id) === controller) pending.delete(message.id)
  }
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  try {
    const message = JSON.parse(line)
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('invalid message')
    if (message.method === 'notifications/cancelled') pending.get(message.params?.requestId)?.abort()
    if (Object.hasOwn(message, 'id')) {
      if (pending.has(message.id)) {
        output({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'This MCP request id is already in flight.' } })
        continue
      }
      const controller = new AbortController()
      pending.set(message.id, controller)
      void forward(message, controller)
    } else void forward(message)
  } catch { output({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC message.' } }) }
}
for (const controller of pending.values()) controller.abort()
