import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { setImmediate as yieldEventLoop } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { negotiateDeviceExtensions } from '@foreman-code/contracts/device-application'
import type { WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import { DeviceApplicationChannel, extensionDescriptors } from '../devices/deviceApplicationChannel.js'
import { adaptDeviceSocket } from '../devices/deviceWire.js'
import { collectCodexFileBytes } from '../harnesses/codexFiles/bytes.js'
import { prepareCodexFileTurn } from '../harnesses/codexFiles/index.js'
import { filePorts, fileScope, sourceRef } from '../../../test/fixtures/codex-file-runtime-helpers.js'
import { MainWorkerConversationBridge } from './workerBridge.js'
import { WorkerConversationFiles } from './workerFiles.js'
import { workerConversationCallbacks } from './workerCallbacks.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { deferred } from '../../../test/helpers/deferred.js'

class Socket extends EventEmitter {
  bufferedAmount = 0
  peer?: Socket
  private dropResponse = false
  private readonly droppedResponses = new Set<string>()

  get lostResponses(): number { return this.droppedResponses.size }
  dropNextResponse() { this.dropResponse = true }
  send(text: string) {
    const frame = JSON.parse(text) as { type: string; id?: string; kind?: string }
    if (this.dropResponse && frame.type === 'application-open' && frame.kind === 'response' && frame.id) {
      this.dropResponse = false
      this.droppedResponses.add(frame.id)
    }
    if (frame.id && this.droppedResponses.has(frame.id)) return
    queueMicrotask(() => this.peer?.emit('message', Buffer.from(text), false))
  }
  close() { this.emit('close') }
}

async function flush() {
  for (let index = 0; index < 10; index++) {
    for (let turn = 0; turn < 200; turn++) await Promise.resolve()
    await yieldEventLoop()
  }
}

function fixture(options: { downloadDelayMs?: number; copyDelayMs?: number; loseChunkReply?: boolean } = {}) {
  const f = workerConversationFixture('agent')
  f.binding.owner.conversationId = fileScope.chat.conversationId
  const bridge = new MainWorkerConversationBridge()
  const parent = new AbortController()
  const mainSocket = new Socket()
  const workerSocket = new Socket()
  mainSocket.peer = workerSocket
  workerSocket.peer = mainSocket
  const callbacks = workerConversationCallbacks({ currentBinding: () => f.connection,
    capture: () => worker.captureRequest('execution-v1') })
  const files = new WorkerConversationFiles(callbacks)
  const sources = new Map<string, WorkerConversationRpcRequest>()
  const ports = filePorts()
  const ready = deferred()
  let preparations = 0
  let lostReply = false
  const chunkRequests: unknown[] = []
  const copies: Buffer[] = []
  const current = vi.fn(async () => {})
  const limits = { namespace: 'execution-v1', version: 1, role: 'duplex' as const,
    maxJsonBytes: 1_048_576, maxBinaryBytes: 0 }
  const mainRegistration = { ...limits, handle: async (payload: unknown, context: { signal: AbortSignal }) => ({
    payload: await bridge.handle(payload, f.connection, context.signal),
  }) }
  const workerRegistration = { ...limits, handle: async (payload: unknown, context: { signal: AbortSignal }) => {
    const request = payload as WorkerConversationRpcRequest
    if (request.method === 'conversation.file-copy') {
      if (options.copyDelayMs) await new Promise(resolve => setTimeout(resolve, options.copyDelayMs))
      if (request.copy.phase === 'chunk') chunkRequests.push(structuredClone(request.copy))
      const result = await files.copy(request, context.signal)
      if (options.loseChunkReply && !lostReply && request.copy.phase === 'chunk') {
        lostReply = true
        workerSocket.dropNextResponse()
      }
      return { payload: result }
    }
    sources.set(request.admissionId!, request)
    return { payload: {} }
  } }
  const extensions = negotiateDeviceExtensions(extensionDescriptors([mainRegistration]),
    extensionDescriptors([workerRegistration]))
  const mainWire = adaptDeviceSocket(mainSocket)
  const workerWire = adaptDeviceSocket(workerSocket)
  const main = new DeviceApplicationChannel({ side: 'main', binding: f.connection, socket: mainWire,
    signal: parent.signal, registrations: [mainRegistration], extensions })
  const worker = new DeviceApplicationChannel({ side: 'worker', binding: f.connection, socket: workerWire,
    signal: parent.signal, registrations: [workerRegistration], extensions })
  const readers = [main.run(mainWire.messages[Symbol.asyncIterator](), 2000),
    worker.run(workerWire.messages[Symbol.asyncIterator](), 1000)]
  for (const reader of readers) void reader.catch(() => {
    // ignore: shutdown joins both carrier readers below.
  })
  const leases: Array<ReturnType<typeof bridge.capture>> = []
  const start = async () => {
    const lease = bridge.capture({ request: { method: 'conversation.start-turn', binding: f.binding,
      session: f.session, prompt: 'Read the attached notes.', correlationId: 'message' },
    channel: main.captureRequest('execution-v1'), current, callbacks: { files: async ({ host, signal, assertHost }) => {
      preparations++
      await ready.promise
      await assertHost()
      return prepareCodexFileTurn({ ownerPrincipalId: 'owner-a', scope: fileScope,
        nativeSessionId: f.session.nativeSessionId, messageId: 'message-a', admissionId: 'message',
        executionHostId: host.executionHostId, projectMode: 'write', allowMutation: true,
        allowedTools: ['files.list'], expiresAt: new Date(Date.now() + 3_600_000), attachments: [sourceRef] },
      { ...ports.dependencies, files: ports.files, host, editsOnly: true, source: {
        ...ports.dependencies.source, open: async () => {
          const opened = await ports.dependencies.source.open()
          const bytes = await collectCodexFileBytes(opened.stream, 1024, signal)
          return { value: opened.value, stream: Readable.from((async function* () {
            for (const byte of bytes) {
              if (options.downloadDelayMs) await new Promise(resolve => setTimeout(resolve, options.downloadDelayMs))
              signal.throwIfAborted()
              yield Buffer.from([byte])
            }
          })()) }
        },
      } }, signal)
    } } })
    leases.push(lease)
    await lease.request()
    const hostId = randomUUID()
    const adapter = files.adapter({ source: () => sources.get(lease.admissionId)!, signal: parent.signal,
      assertCurrent: current, host: async () => ({ executionHostId: hostId, pathStyle: 'posix',
        materialize: async input => {
          copies.push(await collectCodexFileBytes(input.bytes, 1024, parent.signal))
          return { executionHostId: hostId, registrationId: randomUUID(), executionPath: '/storage/notes.md',
            writable: false, byteSize: input.byteSize, sha256: input.sha256 }
        }, close: async () => {}, sealCompleted: async () => { throw new Error('Unexpected mutable copy') },
      }) })
    return adapter
  }
  return { ...f, ready, start, copies, current, worker, chunkRequests,
    lostReply: () => workerSocket.lostResponses === 1,
    preparations: () => preparations,
    async close() {
      parent.abort()
      main.close()
      worker.close()
      await Promise.allSettled(readers)
      for (const lease of leases) await lease.close()
      await files.close()
    } }
}

afterEach(() => vi.useRealTimers())

it('prepares eight simultaneous attached chats while rechecking copy authority on the saturated channel', async () => {
  const f = fixture()
  const pending: Promise<unknown>[] = []
  const completed: unknown[] = []
  try {
    const adapters = await Promise.all(Array.from({ length: 8 }, () => f.start()))
    for (const adapter of adapters) {
      const preparation = adapter.prepare({ session: f.session, clientCorrelationId: 'message', signal: new AbortController().signal })
      pending.push(preparation)
      void preparation.then(value => completed.push(value), error => completed.push(error))
    }
    await flush()
    expect(f.preparations()).toBe(8)
    f.ready.resolve()
    await flush()
    expect(completed).toHaveLength(8)
    expect(f.copies.map(bytes => bytes.toString())).toEqual(Array(8).fill('# Attached document\n'))
    await expect(f.worker.request('execution-v1', { method: 'conversation.file-copy-authorize',
      binding: f.binding, admissionId: randomUUID(), copy: { phase: 'validate', executionHostId: 'foreign' } }))
      .rejects.toMatchObject({ code: 'extension-rejected' })
    expect(f.current).toHaveBeenCalled()
  } finally { f.ready.resolve(); await f.close(); await Promise.allSettled(pending) }
})

it('keeps progressing downloads alive and resumes a chunk after an actual lost-reply deadline', async () => {
  vi.useFakeTimers()
  const f = fixture({ downloadDelayMs: 2000, copyDelayMs: 4000, loseChunkReply: true })
  let outcome: unknown
  let pending: Promise<unknown> | undefined
  try {
    const adapter = await f.start()
    pending = adapter.prepare({ session: f.session, clientCorrelationId: 'message', signal: new AbortController().signal })
    void pending.then(value => { outcome = value }, error => { outcome = error })
    f.ready.resolve()
    for (let second = 0; second < 80; second++) {
      await flush()
      await vi.advanceTimersByTimeAsync(1000)
      if (second === 59) {
        expect(f.lostReply()).toBe(true)
        expect(outcome).toBeUndefined()
      }
    }
    expect(outcome).toMatchObject({ nativeInput: expect.any(Function) })
    expect(f.lostReply()).toBe(true)
    expect(f.chunkRequests).toHaveLength(2)
    expect(f.chunkRequests[1]).toEqual(f.chunkRequests[0])
    expect(f.copies.map(bytes => bytes.toString())).toEqual(['# Attached document\n'])
  } finally { f.ready.resolve(); await f.close(); await Promise.allSettled(pending ? [pending] : []) }
})

it('expires attachment preparation when no download or copy makes progress for thirty seconds', async () => {
  vi.useFakeTimers()
  const f = fixture()
  let outcome: unknown
  let pending: Promise<unknown> | undefined
  try {
    const adapter = await f.start()
    pending = adapter.prepare({ session: f.session, clientCorrelationId: 'message', signal: new AbortController().signal })
    void pending.then(value => { outcome = value }, error => { outcome = error })
    await flush()
    await vi.advanceTimersByTimeAsync(30_001)
    expect(outcome).toMatchObject({ code: 'timeout' })
    expect(f.copies).toEqual([])
  } finally { f.ready.resolve(); await f.close(); await Promise.allSettled(pending ? [pending] : []) }
})
