import { expect, it, vi } from 'vitest'
import type { CompactionState } from '@foreman-code/contracts'
import type { WorkerConversationReceipt } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeCompactInput, NativeHarnessSessionManager, NativeSessionStart,
  NativeTurnInput } from '../harnesses/port.js'
import { WorkerConversationHost } from './workerHost.js'
import { WorkerConversationJournal } from './workerJournal.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture() {
  const f = workerConversationFixture('operator', 'claude')
  const records: WorkerConversationReceipt[] = []
  const journal = new WorkerConversationJournal({ read: async () => structuredClone(records),
    change: async (_id, apply) => structuredClone(apply(records)) }, 8)
  const saved = deferred()
  const finish = deferred()
  const close = vi.fn(async () => {})
  const result = { outcome: 'succeeded' as const, output: 'Answer' }
  const start = { kind: 'operator', configuration: f.configuration,
    workingDirectory: f.binding.workingDirectory, correlationId: 'create' } as NativeSessionStart
  const native = {
    harness: 'claude', createSession: async () => f.session,
    async *startTurn(_session: unknown, input: NativeTurnInput) {
      const submission = { kind: 'message' as const, nativeSessionId: f.session.nativeSessionId,
        nativeMessageId: 'native-input', clientCorrelationId: input.clientCorrelationId }
      await input.onMessageSubmitted?.(submission)
      await input.onTerminal?.({ submission, result })
      yield { type: 'turn.completed', sequence: 1, occurredAt: '2026-10-01T00:00:00Z', payload: {} }
    },
    history: async () => ({ events: [], pendingInteractions: [] }),
    reconcile: async () => ({ events: [], pendingInteractions: [], correlationId: 'input', terminalResult: result }),
    async compactSession(_session: unknown, input: NativeCompactInput) {
      await input.onDispatch?.()
      const state: CompactionState = { requestId: input.requestId, nativeSessionId: f.session.nativeSessionId,
        nativeOperationId: 'native-compact', status: 'completed', beforeTokens: 100,
        observedAt: '2026-10-01T00:00:00Z', message: 'Compacted' }
      await input.onProgress(state)
      saved.resolve()
      await finish.promise
      return state
    },
  } as unknown as NativeHarnessSessionManager
  const host = new WorkerConversationHost({ journal, currentBinding: () => f.connection,
    authorize: async () => {}, observeSession: async () => {}, observeSubmission: async () => {},
    observeTerminal: async () => { saved.resolve(); await finish.promise },
    allocate: async () => ({ manager: native, start: async () => start,
      nativeOwner: async () => f.nativeOwner, close }),
  })
  const request = (input: Record<string, unknown>) => host.handle({ ...input, binding: f.binding }, f.connection)
  await request({ method: 'conversation.open', configuration: f.configuration, mode: 'create', operationId: 'create' })
  return { ...f, journal, host, request, close, saved: saved.promise, finish: finish.resolve }
}

it.each(['turn', 'compaction'] as const)(
  'reports %s completion only after its native operation finishes so runtime release is safe', async kind => {
    const f = await fixture()
    let reading: Promise<unknown> | undefined
    try {
      if (kind === 'turn') {
        await f.request({ method: 'conversation.start-turn', session: f.session, prompt: 'Continue', correlationId: 'input' })
      } else {
        await f.request({ method: 'conversation.compact', session: f.session, requestId: 'compact', correlationId: 'input' })
      }
      await f.saved
      const before = (await f.journal.read(f.binding))!
      await expect(f.request({ method: 'conversation.release-runtime', session: f.session }))
        .rejects.toMatchObject({ code: 'WORKER_CONVERSATION_UNAVAILABLE', status: 409 })
      expect(f.close).not.toHaveBeenCalled()
      expect(await f.journal.read(f.binding)).toEqual(before)
      let completed = false
      const read = kind === 'turn'
        ? { method: 'conversation.history', session: f.session, correlationId: 'input', afterSequence: -1, waitForEvents: true }
        : { method: 'conversation.compact-reconcile', session: f.session, state: before.compactions[0]!.state }
      reading = f.request(read).then(value => { completed = true; return value })
      // Drain ready work while the provider's completion is held by an explicit gate.
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(completed).toBe(false)
      f.finish()
      const response = await reading
      if (kind === 'turn') expect(response).toMatchObject({ receipt: { turns: [{ status: 'completed' }] } })
      else expect(response).toMatchObject({ compaction: { status: 'completed' } })
      await expect(f.request({ method: 'conversation.release-runtime', session: f.session }))
        .resolves.toMatchObject({ receipt: { runtimeReleased: true, session: f.session } })
      expect(f.close).toHaveBeenCalledOnce()
    } finally {
      f.finish()
      await reading
      await f.host.shutdown()
    }
  },
)
