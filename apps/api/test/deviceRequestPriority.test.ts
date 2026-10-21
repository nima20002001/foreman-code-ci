import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { negotiateDeviceExtensions } from '@foreman-code/contracts/device-application'
import { DeviceApplicationChannel, extensionDescriptors } from '../src/modules/devices/deviceApplicationChannel.js'
import { adaptDeviceSocket } from '../src/modules/devices/deviceWire.js'

class Socket extends EventEmitter {
  bufferedAmount = 0
  peer?: Socket
  closed = false
  send(text: string) {
    queueMicrotask(() => {
      if (!this.closed && !this.peer?.closed) this.peer?.emit('message', Buffer.from(text), false)
    })
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
    this.peer?.close()
  }
}

const binding = {
  mainId: '11111111-1111-4111-8111-111111111111', deviceId: '22222222-2222-4222-8222-222222222222',
  workerInstallationId: '33333333-3333-4333-8333-333333333333', keyRevision: 1, authorizationRevision: 1,
  bootId: 'boot', connectionEpoch: 'epoch', connectionGeneration: 1,
}
const backgroundRequests = [
  ['harness-discovery-v1', { operation: 'discover' }],
  ['host-harness-check-v1', { operation: 'check' }],
  ['resource-telemetry', { operation: 'collect' }],
  ['computer-maintenance-v2', { operation: 'status' }],
  ['ci-host-v1', { operation: 'status' }],
] as const

function fixture() {
  const rawMain = new Socket()
  const rawWorker = new Socket()
  rawMain.peer = rawWorker
  rawWorker.peer = rawMain
  const mainSocket = adaptDeviceSocket(rawMain)
  const workerSocket = adaptDeviceSocket(rawWorker)
  const started: string[] = []
  const releases = new Map<string, () => void>()
  const namespaces = ['execution-v1', ...backgroundRequests.map(([namespace]) => namespace)]
  const registrations = namespaces.map(namespace => ({
    namespace, version: 1, role: 'client' as const, maxJsonBytes: 1_048_576, maxBinaryBytes: 1_048_576,
  }))
  const handlers = registrations.map(registration => ({
    ...registration, role: 'server' as const,
    handle: async (payload: unknown, context: { signal: AbortSignal }) => {
      const id = (payload as { id: string }).id
      started.push(id)
      await new Promise<void>(resolve => {
        releases.set(id, resolve)
        context.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      return { payload: id }
    },
  }))
  const extensions = negotiateDeviceExtensions(extensionDescriptors(registrations), extensionDescriptors(handlers))
  const parent = new AbortController()
  const main = new DeviceApplicationChannel({ side: 'main', binding, socket: mainSocket,
    signal: parent.signal, extensions, registrations })
  const worker = new DeviceApplicationChannel({ side: 'worker', binding, socket: workerSocket,
    signal: parent.signal, extensions, registrations: handlers })
  const tasks = [main.run(mainSocket.messages[Symbol.asyncIterator](), 600_000),
    worker.run(workerSocket.messages[Symbol.asyncIterator](), 300_000)].map(task => task.catch(error => error))
  const requests: Promise<unknown>[] = []
  // Requests handle rejections and are joined by close(), including intentionally unawaited load.
  const request = (id: string, namespace = 'execution-v1', payload = {}, options = {}) => {
    const result = main.request(namespace, { ...payload, id }, { timeoutMs: 120_000, ...options })
      .then(value => value, error => error)
    requests.push(result)
    return result
  }
  return { main, request, started, release: (id: string) => releases.get(id)!(), close: async () => {
    parent.abort()
    await Promise.allSettled([...tasks, ...requests])
    await Promise.all([main.join(), worker.join()])
  } }
}

afterEach(() => vi.useRealTimers())

it('caps background bulk reads and leaves capacity for short foreground calls', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    const bulk = Array.from({ length: 7 }, (_, index) => f.request(`bulk-${index}`,
      'ci-host-v1', { operation: 'read' }, { priority: 'background' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.started).toEqual(['bulk-0', 'bulk-1', 'bulk-2', 'bulk-3'])
    for (const yielded of bulk.slice(4)) {
      expect(await yielded).toMatchObject({ code: 'backpressure', retryable: true })
    }
    const foreground = Array.from({ length: 4 }, (_, index) => f.request(`short-${index}`))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.started.slice(4)).toEqual(['short-0', 'short-1', 'short-2', 'short-3'])
    f.release('bulk-0')
    expect(await bulk[0]).toEqual({ payload: 'bulk-0' })
    f.release('short-0')
    expect(await foreground[0]).toEqual({ payload: 'short-0' })
    const retry = f.request('bulk-retry', 'ci-host-v1', { operation: 'read' }, { priority: 'background' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.started).toContain('bulk-retry')
    f.release('bulk-retry')
    expect(await retry).toEqual({ payload: 'bulk-retry' })
  } finally { await f.close() }
})

it.each(backgroundRequests)('leaves foreground capacity when %s background traffic is slow', async (namespace, payload) => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    const background = Array.from({ length: 8 }, (_, index) => f.request(`background-${index}`, namespace, payload))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.started).toHaveLength(7)
    expect(await background[7]).toMatchObject({ code: 'backpressure', retryable: true })
    const foreground = f.request('foreground', 'ci-host-v1', { operation: 'read' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.started).toContain('foreground')
    f.release('foreground')
    expect(await foreground).toEqual({ payload: 'foreground' })
  } finally { await f.close() }
})

it('queues foreground requests in order and makes background yield until capacity is released', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    for (let index = 0; index < 8; index++) void f.request(`active-${index}`)
    await vi.advanceTimersByTimeAsync(0)
    const first = f.request('first')
    const second = f.request('second')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(f.started).toHaveLength(8)
    expect(await f.request('background', 'ci-host-v1', { operation: 'status' }))
      .toMatchObject({ code: 'backpressure' })
    f.release('active-0')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.started.slice(8)).toEqual(['first'])
    f.release('first')
    await vi.advanceTimersByTimeAsync(0)
    expect(await first).toEqual({ payload: 'first' })
    expect(f.started.slice(8)).toEqual(['first', 'second'])
    f.release('second')
    expect(await second).toEqual({ payload: 'second' })
  } finally { await f.close() }
})

it.each([1_000, 60_000])('expires queued foreground work at the %i ms caller deadline', async timeoutMs => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    for (let index = 0; index < 8; index++) void f.request(`active-${index}`)
    await vi.advanceTimersByTimeAsync(0)
    let settled = false
    const waiting = f.request('expired', 'execution-v1', {}, { timeoutMs })
      .then(result => { settled = true; return result })
    await vi.advanceTimersByTimeAsync(timeoutMs - 1)
    expect(settled).toBe(false)
    expect(f.started).toHaveLength(8)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    expect(await waiting).toMatchObject({ code: 'backpressure', reason: 'admission_queue_timeout', retryable: true })
    f.release('active-0')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.started).not.toContain('expired')
    const fresh = f.request('after-expiry')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.started.slice(8)).toEqual(['after-expiry'])
    f.release('after-expiry')
    expect(await fresh).toEqual({ payload: 'after-expiry' })
  } finally { await f.close() }
})

it('bounds the queue size and cancels queued callers without running their handlers', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    for (let index = 0; index < 8; index++) void f.request(`active-${index}`)
    await vi.advanceTimersByTimeAsync(0)
    const canceled = new AbortController()
    const waiting = f.request('canceled', 'execution-v1', {}, { signal: canceled.signal })
    for (let index = 1; index < 64; index++) void f.request(`queued-${index}`)
    expect(await f.request('overflow')).toMatchObject({ code: 'backpressure', retryable: true })
    canceled.abort()
    expect(await waiting).toMatchObject({ code: 'cancelled' })
    f.release('active-0')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.started.slice(8)).toEqual(['queued-1'])
  } finally { await f.close() }
})

it('allows foreground overrides and yields background CI observations that read logs', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    for (let index = 0; index < 7; index++) void f.request(`background-${index}`, 'ci-host-v1', { operation: 'status' })
    await vi.advanceTimersByTimeAsync(0)
    let observation: unknown
    void f.request('poll', 'ci-host-v1', { operation: 'read' }, { priority: 'background' })
      .then(result => { observation = result })
    await vi.advanceTimersByTimeAsync(0)
    expect(observation).toMatchObject({ code: 'backpressure' })
    const requested = f.request('requested-check', 'host-harness-check-v1', {}, { priority: 'foreground' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.started).toContain('requested-check')
    f.release('requested-check')
    expect(await requested).toEqual({ payload: 'requested-check' })
  } finally { await f.close() }
})

it('waits for upload capacity instead of rejecting a foreground request before sending it', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    const options = { bytes: Buffer.alloc(1_048_576) }
    const first = f.request('upload-first', 'execution-v1', { text: 'x'.repeat(1_048_000) }, options)
    const second = f.request('upload-second', 'execution-v1', { text: 'x'.repeat(1_048_000) }, options)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.started).toEqual(['upload-first'])
    f.release('upload-first')
    await vi.advanceTimersByTimeAsync(1000)
    expect(await first).toEqual({ payload: 'upload-first' })
    expect(f.started).toEqual(['upload-first', 'upload-second'])
    f.release('upload-second')
    expect(await second).toEqual({ payload: 'upload-second' })
  } finally { await f.close() }
})

it('keeps captured request busy state live as foreground requests finish', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    const captured = f.main.captureRequest('execution-v1')
    expect(captured.busy).toBe(false)
    const ids = Array.from({ length: 7 }, (_, index) => `captured-${index}`)
    const results = ids.map(id => captured.request({ id }).then(value => value, error => error))
    await vi.advanceTimersByTimeAsync(0)
    expect(captured.busy).toBe(true)
    f.release('captured-0')
    await vi.advanceTimersByTimeAsync(0)
    expect(captured.busy).toBe(false)
    ids.slice(1).forEach(id => f.release(id))
    expect(await Promise.all(results)).toEqual(ids.map(id => ({ payload: id })))
    expect(captured.busy).toBe(false)
  } finally { await f.close() }
})
