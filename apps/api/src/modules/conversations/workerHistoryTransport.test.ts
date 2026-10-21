import { Hash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { DEVICE_APPLICATION_JSON_BYTES } from '@foreman-code/contracts/device-application'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { WorkerConversationReceipt } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart } from '../harnesses/port.js'
import { WorkerConversationJournal } from './workerJournal.js'
import { WorkerConversationHost } from './workerHost.js'
import { WorkerConversationManager } from './workerManager.js'
import { MainWorkerConversationBridge } from './workerBridge.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { ClaudeBoundedQueue } from '../harnesses/claudeSdk/queue.js'
import type { NativeHarnessEvent } from '@foreman-code/contracts'

// Keep the worker's abortable timer on the same virtual clock as native output.
vi.mock('node:timers/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:timers/promises')>()
  return { ...original, setTimeout: (milliseconds: number, value: unknown, options: { signal?: AbortSignal } = {}) =>
    new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        reject(options.signal?.reason)
      }
      const timer = setTimeout(() => {
        options.signal?.removeEventListener('abort', abort)
        resolve(value)
      }, milliseconds)
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) abort()
    }) }
})

it('reads oversized native events and terminal records within the unchanged channel limit', async () => {
  const f = workerConversationFixture()
  const records: WorkerConversationReceipt[] = []
  const journal = new WorkerConversationJournal({ read: async () => structuredClone(records),
    change: async (_id, apply) => structuredClone(apply(records)) }, 8)
  const event = { sequence: 0, type: 'tool.completed', occurredAt: '2026-10-05T00:00:00.000Z',
    payload: { output: 'x'.repeat(2 * DEVICE_APPLICATION_JSON_BYTES) } }
  const history: NativeHistory = { events: [event], pendingInteractions: [], nextSequence: 1,
    terminalResult: { outcome: 'succeeded', output: { text: 'y'.repeat(2 * DEVICE_APPLICATION_JSON_BYTES) } } }
  const native = { harness: 'codex', createSession: async () => f.session,
    history: async () => history, close: async () => {} } as unknown as NativeHarnessSessionManager
  const host = new WorkerConversationHost({ journal, currentBinding: () => f.connection,
    authorize: async () => {}, observeSession: async () => {}, observeSubmission: async () => {},
    allocate: async () => ({ manager: native, nativeOwner: async () => f.nativeOwner, close: async () => {},
      start: async () => ({ kind: 'operator', configuration: f.configuration,
        workingDirectory: f.binding.workingDirectory }) as NativeSessionStart }) })
  const bridge = new MainWorkerConversationBridge()
  let responses = 0
  const manager = new WorkerConversationManager({ binding: f.binding, configuration: f.configuration,
    bridge, current: async () => {}, channel: { binding: f.connection, request: async payload => {
      const reply = await host.handle(payload, f.connection)
      responses++
      if (Buffer.byteLength(JSON.stringify(reply)) > DEVICE_APPLICATION_JSON_BYTES) throw new Error('payload-too-large')
      return { payload: reply }
    } } })
  try {
    await manager.createSession({ kind: 'operator', configuration: f.configuration,
      workingDirectory: f.binding.workingDirectory, correlationId: 'creation' } as NativeSessionStart)
    const hashing = vi.spyOn(Hash.prototype, 'update')
    try {
      await expect(manager.history(f.session)).resolves.toMatchObject(history)
      const largeBuffers = hashing.mock.calls.map(([value]) => value)
        .filter(value => value instanceof Uint8Array && value.byteLength > DEVICE_APPLICATION_JSON_BYTES)
      expect(largeBuffers).toHaveLength(2)
    } finally { hashing.mockRestore() }
    expect(responses).toBeGreaterThan(2)
  } finally { await manager.dispose(); await bridge.close(); await host.shutdown() }
})

it('drains completed output through the snapshot sequence boundary within the event read rate limit', async () => {
  vi.useFakeTimers()
  const startedAt = Date.now()
  const readTimes: number[] = []
  const f = workerConversationFixture()
  const bridge = new MainWorkerConversationBridge()
  const receipt: WorkerConversationReceipt = { binding: f.binding, connection: f.connection,
    revision: 1, closed: false, closing: false, session: f.session, nativeOwner: f.nativeOwner,
    turns: [], compactions: [], desiredPreferences: null, appliedPreferences: null }
  const events = Array.from({ length: 3 }, (_, sequence) => ({ sequence, type: 'tool.completed',
    occurredAt: '2026-10-05T00:00:00.000Z', payload: { output: 'x'.repeat(200_000) } }))
  const manager = new WorkerConversationManager({ binding: f.binding, configuration: f.configuration,
    bridge, current: async () => {}, channel: { binding: f.connection, request: async raw => {
      const request = raw as { method: string; correlationId?: string; afterSequence?: number }
      if (request.method === 'conversation.start-turn') {
        receipt.turns = [{ correlationId: 'turn', inputHash: commandInputHash('turn'), nativeTurnId: 'native-turn',
          status: 'completed', result: { outcome: 'succeeded' } }]
        receipt.revision++
      }
      if (request.method === 'conversation.history' && request.correlationId) readTimes.push(Date.now() - startedAt)
      if (request.method === 'conversation.history') return { payload: { receipt, context: null,
        history: { pendingInteractions: [], nextSequence: request.correlationId ? 3 : 0,
          events: request.correlationId ? events.filter(event => event.sequence > (request.afterSequence ?? -1)).slice(0, 1) : [] } } }
      return { payload: { receipt } }
    } } })
  try {
    await manager.attachSession(f.session, { kind: 'operator', configuration: f.configuration,
      workingDirectory: f.binding.workingDirectory, correlationId: 'turn' } as NativeSessionStart)
    const observed: NativeHarnessEvent[] = []
    const reading = (async () => {
      for await (const event of manager.startTurn(f.session, { prompt: 'Continue', clientCorrelationId: 'turn' })) observed.push(event)
    })()
    await vi.advanceTimersByTimeAsync(200)
    await reading
    expect(observed).toEqual(events)
    expect(readTimes).toEqual([0, 100, 200])
  } finally { await manager.dispose(); await bridge.close(); vi.useRealTimers() }
})

it.each(['codex', 'claude'] as const)('delivers the first %s reply when the Worker produces it, without a polling delay', async harness => {
  vi.useFakeTimers()
  const startedAt = Date.now()
  const f = workerConversationFixture('operator', harness)
  const records: WorkerConversationReceipt[] = []
  const journal = new WorkerConversationJournal({ read: async () => structuredClone(records),
    change: async (_id, apply) => structuredClone(apply(records)) }, 8)
  const output = new ClaudeBoundedQueue<NativeHarnessEvent>(8)
  const history: NativeHistory = { events: [], pendingInteractions: [], nextSequence: 0 }
  let producedAt: number | undefined
  let receivedAt: number | undefined
  const native = {
    harness, createSession: async () => f.session, close: async () => output.close(),
    capabilities: async () => { throw new Error('Capability inspection is outside this provider fixture.') },
    inspectMcp: async () => { throw new Error('MCP inspection is outside this provider fixture.') },
    attachSession: async session => session,
    pending: async () => undefined,
    respond: async () => { throw new Error('No provider interaction was offered.') },
    cancel: async () => { output.close(); return true },
    history: async () => structuredClone(history), reconcile: async () => structuredClone(history),
    async *startTurn(_session, input) {
      history.correlationId = input.clientCorrelationId
      if (harness === 'claude') {
        history.nativeSubmission = { kind: 'message', nativeSessionId: f.session.nativeSessionId,
          nativeMessageId: 'input-message', clientCorrelationId: input.clientCorrelationId }
        await input.onMessageSubmitted?.(history.nativeSubmission)
      } else {
        history.nativeTurnId = 'native-turn'
        await input.onSubmitted?.('native-turn')
      }
      for await (const event of output) yield event
    },
  } satisfies NativeHarnessSessionManager
  const host = new WorkerConversationHost({ journal, currentBinding: () => f.connection,
    authorize: async () => {}, observeSession: async () => {}, observeSubmission: async () => {},
    allocate: async () => ({ manager: native,
      nativeOwner: async () => f.nativeOwner, close: async () => output.close(),
      start: async () => ({ kind: 'operator', configuration: f.configuration,
        workingDirectory: f.binding.workingDirectory }) as NativeSessionStart }) })
  const bridge = new MainWorkerConversationBridge()
  const manager = new WorkerConversationManager({ binding: f.binding, configuration: f.configuration,
    bridge, current: async () => {}, channel: { binding: f.connection,
      request: async payload => ({ payload: await host.handle(payload, f.connection) }) } })
  let reading: Promise<void> | undefined
  try {
    await manager.createSession({ kind: 'operator', configuration: f.configuration,
      workingDirectory: f.binding.workingDirectory, correlationId: 'creation' } as NativeSessionStart)
    reading = (async () => {
      for await (const event of manager.startTurn(f.session, { prompt: 'Reply once', clientCorrelationId: 'turn' })) {
        expect(event.payload.text).toBe('First reply')
        receivedAt = Date.now() - startedAt
      }
    })()
    setTimeout(() => {
      producedAt = Date.now() - startedAt
      const event = { sequence: 0, type: 'assistant.delta', occurredAt: new Date().toISOString(),
        payload: { text: 'First reply' } }
      history.events = [...history.events, event]
      history.nextSequence = 1
      const result = { outcome: 'succeeded' as const, output: 'First reply' }
      history.terminalResult = result
      history.terminalTurn = { correlationId: 'turn', providerId: history.nativeSubmission?.nativeMessageId ?? 'native-turn', result }
      void output.offer(event).then(() => output.close())
    }, 1_000)
    await vi.advanceTimersByTimeAsync(2_000)
    await reading
    console.info('Worker first reply timing', { harness, producedAt, receivedAt,
      deliveryDelayMs: receivedAt! - producedAt! })
    expect(producedAt).toBe(1_000)
    expect(receivedAt).toBe(producedAt)
  } finally {
    output.close()
    await reading
    await manager.dispose()
    await bridge.close()
    await host.shutdown()
    vi.useRealTimers()
  }
})
