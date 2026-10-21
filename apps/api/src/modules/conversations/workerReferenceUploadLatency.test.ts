import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import { WORKER_MCP_EXTENSION, decodeWorkerMcpRequest } from '@foreman-code/contracts/worker-mcp-relay'
import { negotiateDeviceExtensions } from '@foreman-code/contracts/device-application'
import { DeviceApplicationChannel, extensionDescriptors } from '../devices/deviceApplicationChannel.js'
import { workerMcpUploadCeilingMs } from '../devices/workerMcpDeadline.js'
import { adaptDeviceSocket } from '../devices/deviceWire.js'
import { prepareWorkerConversationMcp } from './workerMcpAccess.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(close => close()))
  vi.useRealTimers()
})

/** Each direction takes 50 ms, giving data and acknowledgements a 100 ms round trip. */
class LatencySocket extends EventEmitter {
  bufferedAmount = 0
  peer?: LatencySocket
  closed = false
  dropChunks = false
  bytesPerSecond = Infinity
  lastAcknowledgedAt: number | undefined
  lastAdmittedAt: number | undefined
  coalesce = false
  largestBatchBytes = 0
  private batch: string[] = []
  private availableAt = 0
  constructor(private readonly latencyMs: number) { super() }
  send(text: string) {
    const frame = JSON.parse(text) as { type: string; offset?: number }
    if (this.dropChunks && frame.type === 'application-chunk') return
    if (this.coalesce) {
      this.batch.push(text)
      if (this.batch.length === 1) setTimeout(() => {
        const batch = this.batch.splice(0)
        this.largestBatchBytes = Math.max(this.largestBatchBytes,
          batch.reduce((total, item) => total + Buffer.byteLength(item), 0))
        for (const item of batch) {
          if (!this.closed && !this.peer?.closed) this.peer?.emit('message', Buffer.from(item), false)
        }
      }, this.latencyMs)
      return
    }
    const deliver = () => {
      if (this.closed || this.peer?.closed) return
      if (this.peer && frame.type === 'application-ack') {
        if (frame.offset === 0) this.peer.lastAdmittedAt = Date.now()
        else this.peer.lastAcknowledgedAt = Date.now()
      }
      this.peer?.emit('message', Buffer.from(text), false)
    }
    this.availableAt = Math.max(Date.now(), this.availableAt)
      + Buffer.byteLength(text) * 1000 / this.bytesPerSecond
    const delayMs = this.latencyMs + this.availableAt - Date.now()
    if (delayMs === 0) queueMicrotask(deliver)
    else setTimeout(deliver, delayMs)
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
    this.peer?.close()
  }
}

async function prepare(toolDurationMs: number, latencyMs = 50) {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const fixture = workerConversationFixture()
  const mainRaw = new LatencySocket(latencyMs)
  const workerRaw = new LatencySocket(latencyMs)
  mainRaw.peer = workerRaw
  workerRaw.peer = mainRaw
  const mainSocket = adaptDeviceSocket(mainRaw)
  const workerSocket = adaptDeviceSocket(workerRaw)
  const stop = new AbortController()
  let receivedAt: number | undefined
  let received: unknown
  let calls = 0
  const server = { ...WORKER_MCP_EXTENSION, role: 'server' as const, handle: async (raw: unknown,
    context: { bytes?: Uint8Array; signal: AbortSignal }) => {
    const request = decodeWorkerMcpRequest({ payload: raw, ...(context.bytes ? { bytes: context.bytes } : {}) }) as {
      operation: string; body?: unknown
    }
    if (request.operation === 'conversation-mcp.authorize') {
      return { payload: { expiresAt: new Date(Date.now() + 600_000).toISOString() } }
    }
    calls++
    receivedAt = Date.now()
    received = request.body
    await new Promise<void>((resolve, reject) => {
      const finish = () => { context.signal.removeEventListener('abort', abort); resolve() }
      const timer = setTimeout(finish, toolDurationMs)
      const abort = () => { clearTimeout(timer); reject(context.signal.reason) }
      context.signal.addEventListener('abort', abort, { once: true })
    })
    return { payload: { statusCode: 200, contentType: 'application/json', body: '{"result":"stored"}' } }
  } }
  const client = { ...WORKER_MCP_EXTENSION, role: 'client' as const }
  const extensions = negotiateDeviceExtensions(extensionDescriptors([server]), extensionDescriptors([client]))
  const binding = { ...fixture.connection }
  const main = new DeviceApplicationChannel({ side: 'main', binding, socket: mainSocket, signal: stop.signal,
    extensions, registrations: [server] })
  const worker = new DeviceApplicationChannel({ side: 'worker', binding, socket: workerSocket, signal: stop.signal,
    extensions, registrations: [client] })
  const tasks = [main.run(mainSocket.messages[Symbol.asyncIterator](), 3000),
    worker.run(workerSocket.messages[Symbol.asyncIterator](), 1000)]
  for (const task of tasks) void task.catch(() => {
    // ignore: cleanup closes and joins both readers.
  })
  cleanups.push(async () => {
    stop.abort()
    main.close()
    worker.close()
    await Promise.allSettled(tasks)
    await Promise.all([main.join(), worker.join()])
  })
  const preparing = prepareWorkerConversationMcp({ source: { method: 'conversation.status',
    binding: { ...fixture.binding, appMcpAccess: 'scoped' }, admissionId: randomUUID() },
  token: 'scoped-token', signal: stop.signal,
  request: (namespace, payload, options) => worker.request(namespace, payload, options) })
  await vi.advanceTimersByTimeAsync(500)
  const relay = await preparing
  return { relay, receivedAt: () => receivedAt, received: () => received, calls: () => calls,
    stallUpload: () => { workerRaw.dropChunks = true },
    limitUpload: (bytesPerSecond: number) => { workerRaw.bytesPerSecond = bytesPerSecond },
    lastAcknowledgedAt: () => workerRaw.lastAcknowledgedAt,
    lastAdmittedAt: () => workerRaw.lastAdmittedAt,
    coalesceFrames: () => { mainRaw.coalesce = true; workerRaw.coalesce = true },
    largestBatchBytes: () => workerRaw.largestBatchBytes,
    occupyCapacity: () => worker.request(WORKER_MCP_EXTENSION.namespace, { operation: 'occupied' }, {
      bytes: Buffer.alloc(WORKER_MCP_EXTENSION.maxBinaryBytes), uploadTimeoutMs: workerMcpUploadCeilingMs,
    }) }
}

function referenceCall(byteSize: number) {
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'reference_file_add', arguments: {
    scope: { kind: 'workspace_reference', workspaceId: 'workspace' },
    upload: { requestId: randomUUID(), filename: 'reference.bin', byteSize },
    contentBase64: Buffer.alloc(byteSize, 97).toString('base64'),
  } } }
}

it('uploads the advertised maximum within fifteen seconds at 100 ms RTT and preserves the execution budget', async () => {
  const f = await prepare(99_000)
  const call = referenceCall(MAX_FILE_BYTES)
  const started = Date.now()
  const pending = f.relay.request(call)
  const checked = expect(pending).resolves.toMatchObject({ statusCode: 200, body: '{"result":"stored"}' })
  await Promise.allSettled([checked, vi.advanceTimersByTimeAsync(120_000)])
  await checked
  expect(f.receivedAt()! - started).toBeLessThanOrEqual(15_000)
  expect(f.received()).toEqual(call)
  expect(f.calls()).toBe(1)
})

it('still times out tool execution after one hundred seconds without replaying the uploaded call', async () => {
  const f = await prepare(101_000)
  const pending = f.relay.request(referenceCall(2 * 1024 * 1024))
  let settledAt: number | undefined
  const checked = expect(pending.catch(error => { settledAt = Date.now(); throw error }))
    .rejects.toMatchObject({ code: 'timeout' })
  await Promise.allSettled([checked, vi.advanceTimersByTimeAsync(120_000)])
  await checked
  expect(settledAt! - f.receivedAt()!).toBeGreaterThanOrEqual(100_000)
  expect(settledAt! - f.receivedAt()!).toBeLessThan(100_200)
  expect(f.calls()).toBe(1)
})

it('keeps the socket buffer bounded when upload frames arrive in a burst', async () => {
  const f = await prepare(0, 0)
  const call = referenceCall(2 * 1024 * 1024)
  const checked = expect(f.relay.request(call)).resolves.toMatchObject({ statusCode: 200 })
  await Promise.allSettled([checked, vi.advanceTimersByTimeAsync(20_000)])
  await checked
  expect(f.received()).toEqual(call)
})

it('cancels a stalled upload within its own budget before running the tool', async () => {
  const f = await prepare(0)
  f.stallUpload()
  const pending = f.relay.request(referenceCall(2 * 1024 * 1024))
  let timedOut = false
  const checked = expect(pending.catch(error => { timedOut = true; throw error }))
    .rejects.toMatchObject({ code: 'timeout' })
  await vi.advanceTimersByTimeAsync(200)
  const admittedAt = f.lastAdmittedAt()!
  expect(admittedAt).toBeGreaterThan(Date.now() - 200)
  await vi.advanceTimersByTimeAsync(admittedAt + 14_999 - Date.now())
  expect(timedOut).toBe(false)
  await Promise.allSettled([checked, vi.advanceTimersByTimeAsync(1)])
  await checked
  expect(f.calls()).toBe(0)
})

it('uploads the advertised maximum over an 8 Mbit/s link and preserves the full execution budget', async () => {
  const f = await prepare(99_000)
  f.limitUpload(1_000_000)
  const call = referenceCall(MAX_FILE_BYTES)
  const started = Date.now()
  const checked = expect(f.relay.request(call)).resolves.toMatchObject({
    statusCode: 200, body: '{"result":"stored"}',
  })
  await Promise.allSettled([checked, vi.advanceTimersByTimeAsync(180_000)])
  await checked
  expect(f.receivedAt()! - started).toBeGreaterThan(MAX_FILE_BYTES / 1_000_000 * 1000)
  expect(f.receivedAt()! - started).toBeLessThan(60_000)
  expect(f.received()).toEqual(call)
  expect(f.calls()).toBe(1)
})

it('times out fifteen seconds after the last acknowledged progress when an upload stalls', async () => {
  const f = await prepare(0)
  f.limitUpload(1_000_000)
  const started = Date.now()
  let settledAt: number | undefined
  const pending = f.relay.request(referenceCall(2 * 1024 * 1024))
    .catch((error: unknown) => { settledAt = Date.now(); return error })
  await vi.advanceTimersByTimeAsync(1000)
  f.stallUpload()
  await vi.advanceTimersByTimeAsync(1000)
  const lastAcknowledgedAt = f.lastAcknowledgedAt()!
  expect(lastAcknowledgedAt).toBeGreaterThan(started)
  await vi.advanceTimersByTimeAsync(lastAcknowledgedAt + 14_999 - Date.now())
  expect(settledAt).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1)
  expect(await pending).toMatchObject({ code: 'timeout' })
  expect(settledAt! - lastAcknowledgedAt).toBe(15_000)
  expect(f.calls()).toBe(0)
})


it('preserves the Worker link when a full upload window arrives in one socket callback', async () => {
  const f = await prepare(0)
  f.coalesceFrames()
  const call = referenceCall(2 * 1024 * 1024)
  const checked = expect(f.relay.request(call)).resolves.toMatchObject({ statusCode: 200 })
  await Promise.allSettled([checked, vi.advanceTimersByTimeAsync(20_000)])
  await checked
  expect(f.largestBatchBytes()).toBeGreaterThan(65_536)
  expect(f.received()).toEqual(call)
  const followUp = expect(f.relay.request({ jsonrpc: '2.0', id: 2, method: 'ping' }))
    .resolves.toMatchObject({ statusCode: 200 })
  await vi.advanceTimersByTimeAsync(1000)
  await followUp
})

it('lets a queued reference wait for upload capacity without consuming its idle budget', async () => {
  const f = await prepare(0)
  f.limitUpload(1_000_000)
  const first = expect(f.relay.request(referenceCall(20 * 1024 * 1024))).resolves.toMatchObject({ statusCode: 200 })
  await vi.advanceTimersByTimeAsync(500)
  const call = referenceCall(20 * 1024 * 1024)
  const second = expect(f.relay.request(call)).resolves.toMatchObject({ statusCode: 200 })
  await Promise.allSettled([first, second, vi.advanceTimersByTimeAsync(90_000)])
  await first
  await second
  expect(f.received()).toEqual(call)
  expect(f.calls()).toBe(2)
})

it('still rejects an upload when its bounded capacity wait expires', async () => {
  const f = await prepare(0)
  f.stallUpload()
  const occupied = f.occupyCapacity().catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(500)
  const started = Date.now()
  let settledAt: number | undefined
  const pending = f.relay.request(referenceCall(2 * 1024 * 1024)).catch((error: unknown) => {
    settledAt = Date.now()
    return error
  })
  await vi.advanceTimersByTimeAsync(44_999)
  expect(settledAt).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1)
  expect(await pending).toMatchObject({ code: 'backpressure', reason: 'upload_capacity_timeout' })
  expect(settledAt! - started).toBe(45_000)
  expect(f.calls()).toBe(0)
  void occupied
})

it('lets a queued upload wait for a bulk request slot before starting its idle budget', async () => {
  const f = await prepare(20_000)
  const occupied = Array.from({ length: 4 }, () => expect(f.relay.request(referenceCall(1024 * 1024)))
    .resolves.toMatchObject({ statusCode: 200 }))
  await vi.advanceTimersByTimeAsync(3000)
  expect(f.calls()).toBe(4)
  const call = referenceCall(2 * 1024 * 1024)
  const queued = expect(f.relay.request(call)).resolves.toMatchObject({ statusCode: 200 })
  await Promise.allSettled([...occupied, queued, vi.advanceTimersByTimeAsync(60_000)])
  await Promise.all(occupied)
  await queued
  expect(f.received()).toEqual(call)
  expect(f.calls()).toBe(5)
})
