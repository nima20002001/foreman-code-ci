import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import {
  DEVICE_APPLICATION_IN_FLIGHT, negotiateDeviceExtensions, type DeviceApplicationResult,
} from '@foreman-code/contracts/device-application'
import {
  DeviceApplicationChannel, extensionDescriptors, type DeviceApplicationRequestOptions,
} from '../src/modules/devices/deviceApplicationChannel.js'
import { DeviceRequestQueue } from '../src/modules/devices/deviceRequestQueue.js'
import { adaptDeviceSocket } from '../src/modules/devices/deviceWire.js'

class Socket extends EventEmitter {
  bufferedAmount = 0
  peer?: Socket
  closed = false
  readonly frames: Record<string, unknown>[] = []
  rejectsObservation = false

  send(text: string) {
    const frame = JSON.parse(text) as Record<string, unknown>
    this.frames.push(frame)
    queueMicrotask(() => {
      // Model the previous receiver, which closes on observation admission.
      if (this.peer?.rejectsObservation && frame.type === 'application-open'
        && frame.admission === 'observation') {
        this.peer.close()
        return
      }
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
const observationRequests = [
  { method: 'history' },
  { method: 'conversation.history' },
  { method: 'conversation.reconcile' },
  { method: 'physical-readout' },
  { method: 'physical-ack', retire: true },
]

function fixture(ignoreAbort = new Set<string>(), workerSupportsMaintenanceObservation = true) {
  const rawMain = new Socket()
  const rawWorker = new Socket()
  rawMain.peer = rawWorker
  rawWorker.peer = rawMain
  const mainSocket = adaptDeviceSocket(rawMain)
  const workerSocket = adaptDeviceSocket(rawWorker)
  const started: string[] = []
  const releases = new Map<string, (result: DeviceApplicationResult) => void>()
  const namespaces = ['execution-v1', 'ci-host-v1', 'worker-mcp-v2', 'computer-maintenance-v2',
    'harness-discovery-v1', 'host-harness-check-v1', 'resource-telemetry', 'computer-sync-v1']
  const registrations = namespaces.map(namespace => ({
    namespace, version: namespace === 'computer-maintenance-v2' ? 2 : 1,
    role: 'duplex' as const, maxJsonBytes: 1_048_576, maxBinaryBytes: 1_048_576,
    handle: async (payload: unknown, context: { signal: AbortSignal }) => {
      const { id } = payload as { id: string }
      started.push(id)
      return new Promise<DeviceApplicationResult>(resolve => {
        const cancel = () => resolve({ payload: id })
        releases.set(id, result => {
          context.signal.removeEventListener('abort', cancel)
          releases.delete(id)
          resolve(result)
        })
        if (!ignoreAbort.has(id)) context.signal.addEventListener('abort', cancel, { once: true })
      })
    },
  }))
  const mainDescriptors = extensionDescriptors(registrations)
  const workerDescriptors = extensionDescriptors(registrations).map(descriptor => {
    if (workerSupportsMaintenanceObservation) return descriptor
    // Previous peers advertise only these descriptor fields.
    const { namespace, version, role, maxJsonBytes, maxBinaryBytes } = descriptor
    return { namespace, version, role, maxJsonBytes, maxBinaryBytes }
  })
  rawWorker.rejectsObservation = !workerSupportsMaintenanceObservation
  const extensions = negotiateDeviceExtensions(mainDescriptors, workerDescriptors)
  const parent = new AbortController()
  const main = new DeviceApplicationChannel({ side: 'main', binding, socket: mainSocket,
    signal: parent.signal, extensions, registrations })
  const worker = new DeviceApplicationChannel({ side: 'worker', binding, socket: workerSocket,
    signal: parent.signal, extensions, registrations })
  const tasks: Promise<unknown>[] = [main.run(mainSocket.messages[Symbol.asyncIterator](), 600_000),
    worker.run(workerSocket.messages[Symbol.asyncIterator](), 300_000)]
    .map(task => task.catch(error => error))
  const request = (side: 'main' | 'worker', namespace: string,
    payload: { id: string; method?: string; operation?: string; scope?: string },
    options: DeviceApplicationRequestOptions = {}) => {
    const result = ({ main, worker })[side].request(namespace, payload, { timeoutMs: 120_000, ...options })
      .then(value => value, (error: unknown) => error)
    tasks.push(result)
    return result
  }
  return {
    main, worker, rawMain, rawWorker, request, started,
    release: (id: string, result: DeviceApplicationResult = { payload: id }) => releases.get(id)!(result),
    close: async () => {
      parent.abort()
      for (const release of releases.values()) release({ payload: null })
      await Promise.allSettled(tasks)
      await Promise.all([main.join(), worker.join()])
    },
  }
}

afterEach(() => vi.useRealTimers())

it.each(['main', 'worker'] as const)(
  'keeps a native request queued on %s within its caller deadline without adding slots', async side => {
    vi.useFakeTimers()
    const f = fixture()
    try {
      for (let index = 0; index < DEVICE_APPLICATION_IN_FLIGHT; index++) {
        void f.request(side, 'execution-v1', { id: `occupied-${index}` })
      }
      await vi.advanceTimersByTimeAsync(0)
      let settled = false
      const native = f.request(side, 'execution-v1', { id: 'native', method: 'start-turn' }, { timeoutMs: 90_000 })
        .then(result => { settled = true; return result })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(settled).toBe(false)
      expect(f.started).toHaveLength(DEVICE_APPLICATION_IN_FLIGHT)
      const background = f.request(side, 'ci-host-v1', { id: 'poll', operation: 'status' })
      expect(await background).toMatchObject({ code: 'backpressure', reason: 'background_yield' })
      f.release('occupied-0')
      await vi.advanceTimersByTimeAsync(0)
      expect(f.started.filter(id => id === 'native')).toHaveLength(1)
      f.release('native')
      expect(await native).toEqual({ payload: 'native' })
      expect(f.rawMain.closed).toBe(false)
      expect(f.rawWorker.closed).toBe(false)
    } finally { await f.close() }
  },
)

it('expires a queued native request at its caller deadline before a handler can run', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    for (let index = 0; index < DEVICE_APPLICATION_IN_FLIGHT; index++) {
      void f.request('main', 'execution-v1', { id: `occupied-${index}` })
    }
    await vi.advanceTimersByTimeAsync(0)
    let failure: unknown
    const native = f.request('main', 'execution-v1', { id: 'expired' }, { timeoutMs: 1_000 })
      .then(result => { failure = result })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(failure).toMatchObject({ code: 'backpressure', reason: 'admission_queue_timeout' })
    f.release('occupied-0')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.started).not.toContain('expired')
    await native
  } finally { await f.close() }
})

it('includes local slot waiting in the native request response deadline', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    for (let index = 0; index < DEVICE_APPLICATION_IN_FLIGHT; index++) {
      void f.request('main', 'execution-v1', { id: `occupied-${index}` })
    }
    await vi.advanceTimersByTimeAsync(0)
    let failure: unknown
    const native = f.request('main', 'execution-v1', { id: 'slow-native' }, { timeoutMs: 2_000 })
      .then(result => { failure = result })
    await vi.advanceTimersByTimeAsync(1_500)
    f.release('occupied-0')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.started).toContain('slow-native')
    await vi.advanceTimersByTimeAsync(500)
    expect(failure).toMatchObject({ code: 'timeout' })
    await native
    expect(f.started.filter(id => id === 'slow-native')).toHaveLength(1)
  } finally { await f.close() }
})

it('keeps maintenance requests ordinary and the link open when the peer does not advertise observation support', async () => {
  vi.useFakeTimers()
  const f = fixture(new Set(), false)
  try {
    for (const id of ['bundle-status', 'next-status']) {
      const status = f.request('main', 'computer-maintenance-v2',
        { id, operation: 'status', scope: 'worker' }, { priority: 'foreground' })
      await vi.advanceTimersByTimeAsync(0)
      const opens = f.rawMain.frames.filter(frame => frame.type === 'application-open' && frame.kind === 'request')
      expect(opens.at(-1)).toMatchObject({ namespace: 'computer-maintenance-v2', version: 2 })
      expect(opens.at(-1)).not.toHaveProperty('admission')
      expect(f.rawMain.closed).toBe(false)
      expect(f.rawWorker.closed).toBe(false)
      expect(f.started).toContain(id)
      f.release(id)
      expect(await status).toEqual({ payload: id })
    }
  } finally { await f.close() }
})

it('negotiates maintenance observation admission only when both peers advertise it', () => {
  const registration = { namespace: 'computer-maintenance-v2', version: 2, role: 'client' as const,
    maxJsonBytes: 1_048_576, maxBinaryBytes: 0 }
  const main = extensionDescriptors([registration])
  const worker = extensionDescriptors([{ ...registration, role: 'server', handle: async () => ({ payload: null }) }])
  expect(main[0]).toMatchObject({ observationAdmission: true })
  expect(worker[0]).toMatchObject({ observationAdmission: true })
  expect(negotiateDeviceExtensions(main, worker)[0]).toMatchObject({ observationAdmission: true })
  expect(negotiateDeviceExtensions([registration], worker)[0]).not.toHaveProperty('observationAdmission')
  expect(negotiateDeviceExtensions(main, [{ ...registration, role: 'server' }])[0])
    .not.toHaveProperty('observationAdmission')
})

it.each(['main', 'worker'] as const)('completes bundle status with every ordinary slot occupied from %s', async side => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    const backgroundNamespaces = ['harness-discovery-v1', 'host-harness-check-v1', 'resource-telemetry']
    for (let index = 0; index < DEVICE_APPLICATION_IN_FLIGHT - 1; index++) {
      void f.request(side, backgroundNamespaces[index % backgroundNamespaces.length]!, { id: `background-${index}` })
    }
    await vi.advanceTimersByTimeAsync(0)
    // Sync uses the last ordinary slot that background-priority requests leave available.
    void f.request(side, 'computer-sync-v1', { id: 'sync' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.started).toHaveLength(DEVICE_APPLICATION_IN_FLIGHT)

    const status = f.request(side, 'computer-maintenance-v2',
      { id: 'bundle-status', operation: 'status', scope: 'worker' }, { priority: 'foreground', timeoutMs: 10_000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.started.slice(DEVICE_APPLICATION_IN_FLIGHT)).toEqual(['bundle-status'])
    const reply = { payload: { operation: 'worker', worker: null } }
    f.release('bundle-status', reply)
    expect(await status).toEqual(reply)
  } finally { await f.close() }
})

it.each(observationRequests)('keeps all short-request slots available while $method is held', async payload => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    for (let index = 0; index < 4; index++) {
      void f.request('main', 'execution-v1', { ...payload, id: `observation-${index}` })
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(f.started).toHaveLength(4)
    const namespaces = ['ci-host-v1', 'worker-mcp-v2', 'execution-v1']
    for (let index = 0; index < DEVICE_APPLICATION_IN_FLIGHT; index++) {
      void f.request('main', namespaces[index % namespaces.length]!, { id: `short-${index}` })
    }
    await vi.advanceTimersByTimeAsync(15_000)
    expect(f.started.slice(4)).toEqual(Array.from({ length: DEVICE_APPLICATION_IN_FLIGHT }, (_, i) => `short-${i}`))
    const first = f.request('main', 'ci-host-v1', { id: 'queued-first' })
    const second = f.request('main', 'worker-mcp-v2', { id: 'queued-second' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.started).not.toContain('queued-first')
    f.release('short-0')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.started.slice(-1)).toEqual(['queued-first'])
    f.release('queued-first')
    expect(await first).toEqual({ payload: 'queued-first' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.started.slice(-1)).toEqual(['queued-second'])
    f.release('queued-second')
    expect(await second).toEqual({ payload: 'queued-second' })
  } finally { await f.close() }
})

it.each(['main', 'worker'] as const)('starts short requests across namespaces in FIFO order from %s', async side => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    void f.request(side, 'execution-v1', { id: 'held-history', method: 'history' })
    await vi.advanceTimersByTimeAsync(0)
    const namespaces = ['ci-host-v1', 'worker-mcp-v2', 'execution-v1']
    const ids = Array.from({ length: DEVICE_APPLICATION_IN_FLIGHT }, (_, index) => `short-${index}`)
    const requests = ids.map((id, index) => f.request(side, namespaces[index % namespaces.length]!, { id }))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.started).toEqual(['held-history', ...ids])
    for (const id of ids) f.release(id)
    expect(await Promise.all(requests)).toEqual(ids.map(id => ({ payload: id })))
  } finally { await f.close() }
})

it.each(['main', 'worker'] as const)('bounds observations separately in the %s direction and preserves chunked replies', async side => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    const observations = Array.from({ length: DEVICE_APPLICATION_IN_FLIGHT }, (_, index) =>
      f.request(side, 'execution-v1', { id: `observation-${index}`, method: 'conversation.history' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.started).toHaveLength(DEVICE_APPLICATION_IN_FLIGHT)
    const next = f.request(side, 'execution-v1', { id: 'next-observation', method: 'history' })
    const short = f.request(side, 'worker-mcp-v2', { id: 'relay' })
    await vi.advanceTimersByTimeAsync(0)
    const background = f.request(side, 'ci-host-v1', { id: 'status' }, { priority: 'background' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.started.slice(DEVICE_APPLICATION_IN_FLIGHT)).toEqual(['relay', 'status'])
    f.release('relay')
    f.release('status')
    expect(await short).toEqual({ payload: 'relay' })
    expect(await background).toEqual({ payload: 'status' })
    const reply = { payload: { nextAfterSequence: 42, events: [{ sequence: 42, text: 'x'.repeat(24_000) }] },
      bytes: Buffer.alloc(24_000, 7) }
    f.release('observation-0', reply)
    expect(await observations[0]).toEqual(reply)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.started.slice(-1)).toEqual(['next-observation'])
    f.release('next-observation', { payload: { nextAfterSequence: 43, events: [{ sequence: 43 }] } })
    expect(await next).toEqual({ payload: { nextAfterSequence: 43, events: [{ sequence: 43 }] } })
    expect(f.started.filter(id => id === 'next-observation')).toHaveLength(1)
  } finally { await f.close() }
})

it('keeps cancelled physical handlers within observation capacity until they drain', async () => {
  vi.useFakeTimers()
  const f = fixture(new Set(['abandoned']))
  try {
    const abort = new AbortController()
    const abandoned = f.request('main', 'execution-v1', { id: 'abandoned', method: 'history' }, { signal: abort.signal })
    for (let index = 1; index < DEVICE_APPLICATION_IN_FLIGHT; index++) {
      void f.request('main', 'execution-v1', { id: `observation-${index}`, method: 'history' })
    }
    await vi.advanceTimersByTimeAsync(0)
    abort.abort()
    expect(await abandoned).toMatchObject({ code: 'cancelled' })
    const next = f.request('main', 'execution-v1', { id: 'next', method: 'history' })
    const short = f.request('main', 'ci-host-v1', { id: 'short' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.started).not.toContain('next')
    expect(f.started).toContain('short')
    f.release('short')
    expect(await short).toEqual({ payload: 'short' })
    f.release('abandoned')
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.started.filter(id => id === 'next')).toHaveLength(1)
    f.release('next')
    expect(await next).toEqual({ payload: 'next' })
  } finally { await f.close() }
})

it.each([
  ['execution-v1', 1, { method: 'start-turn' }],
  ['computer-maintenance-v2', 2, { operation: 'start', task: { kind: 'update-worker' } }],
] as const)('rejects a %s write disguised as an observation before calling its handler', async (namespace, version, payload) => {
  vi.useFakeTimers()
  const f = fixture()
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const packet = Buffer.from(JSON.stringify({ id: 'write', ...payload }))
  try {
    f.rawMain.send(JSON.stringify({ type: 'application-open', id, namespace, version,
      kind: 'request', jsonBytes: packet.byteLength, binaryBytes: 0, admission: 'observation' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.rawWorker.frames).toContainEqual({ type: 'application-ack', id, offset: 0 })
    f.rawMain.send(JSON.stringify({ type: 'application-chunk', id, offset: 0, data: packet.toString('base64') }))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.started).toEqual([])
    expect(f.rawWorker.frames).toContainEqual(expect.objectContaining({ type: 'application-open', id, kind: 'error' }))
  } finally { await f.close() }
})

it('expires and cancels queued observations without making short requests busy', async () => {
  vi.useFakeTimers()
  const queue = new DeviceRequestQueue()
  const slot = { priority: 'foreground' as const, stop: false, observation: true, namespace: 'execution-v1' }
  const releases = await Promise.all(Array.from({ length: DEVICE_APPLICATION_IN_FLIGHT }, () => queue.acquire(slot)))
  try {
    const abort = new AbortController()
    const cancelled = queue.acquire({ ...slot, signal: abort.signal }).catch((error: unknown) => error)
    const expired = queue.acquire(slot).catch((error: unknown) => error)
    expect(queue.busy).toBe(false)
    abort.abort()
    expect(await cancelled).toMatchObject({ code: 'cancelled' })
    await vi.advanceTimersByTimeAsync(45_000)
    expect(await expired).toMatchObject({ code: 'backpressure', reason: 'admission_queue_timeout' })
    const release = await queue.acquire({ priority: 'background', stop: false, namespace: 'ci-host-v1' })
    release()
  } finally {
    queue.close(new Error('closed'))
    for (const release of releases) release()
  }
})


it.each(observationRequests)('keeps $method usable with a Worker that has no execution observation capability', async payload => {
  vi.useFakeTimers()
  const f = fixture(new Set(), false)
  try {
    const result = f.request('main', 'execution-v1', { ...payload, id: 'readout' })
    await vi.advanceTimersByTimeAsync(0)
    const opens = f.rawMain.frames.filter(frame => frame.type === 'application-open' && frame.kind === 'request')
    expect(opens.at(-1)).toMatchObject({ namespace: 'execution-v1', version: 1 })
    expect(opens.at(-1)).not.toHaveProperty('admission')
    expect(f.rawWorker.closed).toBe(false)
    expect(f.started).toContain('readout')
    f.release('readout')
    expect(await result).toEqual({ payload: 'readout' })
  } finally { await f.close() }
})

it('advertises execution observation support and negotiates it only with a capable peer', () => {
  const registration = { namespace: 'execution-v1', version: 1, role: 'client' as const,
    maxJsonBytes: 1_048_576, maxBinaryBytes: 0 }
  const main = extensionDescriptors([registration])
  const worker = extensionDescriptors([{ ...registration, role: 'server', handle: async () => ({ payload: null }) }])
  expect(main[0]).toMatchObject({ observationAdmission: true })
  expect(worker[0]).toMatchObject({ observationAdmission: true })
  expect(negotiateDeviceExtensions(main, worker)[0]).toMatchObject({ observationAdmission: true })
  expect(negotiateDeviceExtensions(main, [{ ...registration, role: 'server' }])[0])
    .not.toHaveProperty('observationAdmission')
  expect(negotiateDeviceExtensions([registration], worker)[0]).not.toHaveProperty('observationAdmission')
})
