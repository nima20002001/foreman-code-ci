import { asRecord } from '../../shared/records.js'
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { runtimeTimingPoint, runtimeTimingPublisher, type RuntimeTimingRecord } from '../diagnostics/runtimeTiming.js'

const transportEvents = new Set([
  'codex.api_request', 'codex.sse_event', 'codex.websocket_request', 'codex.websocket_event',
  'codex.websocket.request', 'codex.websocket.event',
])
const bodyLimit = 1024 * 1024

function array(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function scalar(value: unknown): unknown {
  const fields = asRecord(value)
  return fields.stringValue ?? fields.intValue ?? fields.doubleValue ?? fields.boolValue
}
function number(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  if (typeof value === 'string' && value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/** Whitelist timing metadata; prompt, model output, headers and tool results never leave this decoder. */
export function codexTransportTimings(payload: unknown): RuntimeTimingRecord[] {
  const result: RuntimeTimingRecord[] = []
  for (const resource of array(asRecord(payload).resourceLogs)) {
    for (const scope of array(asRecord(resource).scopeLogs)) {
      for (const value of array(asRecord(scope).logRecords)) {
        const record = asRecord(value)
        const entries = [...array(asRecord(asRecord(resource).resource).attributes), ...array(record.attributes)]
        const attributes = new Map(entries.map(entry => {
          const attribute = asRecord(entry)
          return [attribute.key, scalar(attribute.value)] as const
        }))
        const event = attributes.get('event.name') ?? scalar(record.body)
        if (typeof event !== 'string' || !transportEvents.has(event)) continue
        const durationMs = number(attributes.get('duration_ms') ?? attributes.get('event.duration_ms'))
        const time = record.timeUnixNano === '0' || record.timeUnixNano === undefined
          ? record.observedTimeUnixNano : record.timeUnixNano
        const timestamp = typeof time === 'string' ? time : ''
        if (durationMs === undefined || durationMs > 3_600_000 || !/^\d{16,22}$/.test(timestamp)) continue
        const finished = Number(BigInt(timestamp) / 1_000_000n)
        if (!Number.isFinite(finished) || finished < 946_684_800_000 || finished > 4_102_444_800_000) continue
        const session = attributes.get('conversation.id') ?? attributes.get('conversation_id')
        const kind = attributes.get('kind') ?? attributes.get('event.kind')
        const statusCode = number(attributes.get('http.status_code') ?? attributes.get('status'))
        const attempt = number(attributes.get('attempt'))
        const success = attributes.get('success')
        result.push({ component: 'harness', phase: `native.${event.slice('codex.'.length).replaceAll('.', '_')}`,
          operation: event, startedAt: new Date(finished - durationMs).toISOString(),
          finishedAt: new Date(finished).toISOString(), durationMs,
          ...(typeof session === 'string' && /^[a-f0-9-]{36}$/i.test(session) ? { nativeSessionId: session } : {}),
          ...(typeof kind === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(kind) ? { eventType: kind } : {}),
          ...(statusCode !== undefined && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? { statusCode } : {}),
          ...(attempt !== undefined && Number.isInteger(attempt) && attempt <= 100 ? { attempt } : {}),
          ...(typeof success === 'boolean' ? { success } : {}) })
      }
    }
  }
  return result
}

async function receive(request: IncomingMessage, response: ServerResponse,
  publish: ReturnType<typeof runtimeTimingPublisher>) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array)
    size += bytes.length
    if (size > bodyLimit) { request.resume(); response.writeHead(413).end(); return }
    chunks.push(bytes)
  }
  let payload: unknown
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { response.writeHead(400).end(); return }
  for (const record of codexTransportTimings(payload)) publish(record)
  response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
}

/** One process-local, loopback receiver, closed with its native transport. Export is opt-in. */
export async function openCodexRuntimeTiming() {
  const path = `/${randomUUID()}/v1/logs`
  const publish = runtimeTimingPublisher()
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== path) { request.resume(); response.writeHead(404).end(); return }
    void receive(request, response, publish).catch(() => {
      if (!response.headersSent && !response.destroyed) response.writeHead(400).end()
    })
  })
  server.on('error', () => runtimeTimingPoint('harness', 'native.api_timing_unavailable', { eventType: 'receiver_error' }))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  server.unref()
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Native timing receiver has no TCP address.')
  const endpoint = `http://127.0.0.1:${address.port}${path}`
  return {
    endpoint,
    arguments: ['-c', `otel.exporter={otlp-http={endpoint=${JSON.stringify(endpoint)},protocol="json"}}`,
      '-c', 'otel.log_user_prompt=false'],
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    }),
  }
}
