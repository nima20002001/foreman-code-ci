import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { WorkerConversationReceipt, WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeHarnessSessionManager, NativeSessionStart, NativeTurnInput } from '../harnesses/port.js'
import type { CodexFileHostLease } from '../harnesses/codexFiles/port.js'
import { WorkerConversationHost } from './workerHost.js'
import { WorkerConversationJournal } from './workerJournal.js'
import { WorkerConversationFiles } from './workerFiles.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { deferred, rejectableDeferred } from '../../../test/helpers/deferred.js'

it.each([false, true])('keeps active Codex file calls and cleanup available (reconnected: %s)', async reconnect => {
  const f = workerConversationFixture('agent')
  const records: WorkerConversationReceipt[] = []
  const journal = new WorkerConversationJournal({ read: async () => structuredClone(records),
    change: async (_id, apply) => structuredClone(apply(records)) }, 8)
  const originalAdmission = randomUUID()
  let activeAdmission = originalAdmission
  let connection = f.connection
  let source: WorkerConversationRpcRequest
  const calls: string[] = []
  const files = new WorkerConversationFiles({ authorizeCopy: async () => {}, files: async (request, _session, _id, action) => {
    if (request.admissionId !== activeAdmission) throw new Error('The old Main admission is closed')
    calls.push(action.phase)
    if (action.phase === 'prepare') return { allowedTools: ['files.list'] }
    if (action.phase === 'call') return { success: true, contentItems: [{ type: 'inputText', text: 'Recovered files' }] }
    return { acknowledged: true }
  } })
  const adapter = files.adapter({ source: () => source, assertCurrent: async () => {},
    signal: AbortSignal.timeout(5000), host: async () => ({ executionHostId: randomUUID(),
      close: async () => {} }) as CodexFileHostLease })
  const activated = deferred()
  const release = deferred()
  const finished = rejectableDeferred<{ success: boolean }>()
  const native = { harness: 'codex', createSession: async () => f.session,
    async *startTurn(_session: Parameters<NativeHarnessSessionManager['startTurn']>[0], input: NativeTurnInput) {
      const turn = await adapter.prepare({ session: f.session, clientCorrelationId: input.clientCorrelationId,
        signal: AbortSignal.timeout(5000) })
      if (!turn) throw new Error('File callbacks are required')
      await input.onSubmitted?.('native-turn')
      await turn.activate('native-turn')
      activated.resolve()
      await release.promise
      try {
        const result = await turn.call({ threadId: f.session.nativeSessionId, turnId: 'native-turn',
          tool: 'files_list', arguments: {} })
        await turn.close()
        finished.resolve(result)
      } catch (error) { finished.reject(error); throw error }
      yield { sequence: 1, type: 'turn.completed', occurredAt: '2026-10-05T00:00:00.000Z', payload: {} }
    },
    history: async () => ({ events: [], pendingInteractions: [] }),
    reconcile: async () => ({ events: [], pendingInteractions: [], nativeTurnId: 'native-turn',
      terminalResult: { outcome: 'succeeded' } }),
  } as unknown as NativeHarnessSessionManager
  const host = new WorkerConversationHost({ journal, currentBinding: () => connection,
    authorize: async request => { if (request.method === 'conversation.start-turn') source = request },
    observeSession: async () => {}, observeSubmission: async () => {
      if (!reconnect) {
        activated.resolve()
        await release.promise
      }
    },
    allocate: async () => ({ manager: native, nativeOwner: async () => f.nativeOwner, close: async () => {},
      recoverFiles: (request, nativeTurnId, signal) => files.recover(request, nativeTurnId, signal),
      start: async () => ({ kind: 'agent-chat', configuration: f.configuration,
        workingDirectory: f.binding.workingDirectory }) as NativeSessionStart }) })
  const result = finished.promise.then(value => ({ value }), error => ({ error }))
  try {
    await host.handle({ method: 'conversation.open', binding: f.binding, configuration: f.configuration,
      operationId: 'creation', mode: 'create' }, connection)
    await host.handle({ method: 'conversation.start-turn', binding: f.binding, session: f.session,
      admissionId: originalAdmission, correlationId: 'message', prompt: 'Read files' }, connection)
    await activated.promise
    if (reconnect) {
      connection = { ...connection, connectionEpoch: randomUUID(), connectionGeneration: 2 }
      await host.handle({ method: 'conversation.open', binding: f.binding, configuration: f.configuration,
        operationId: 'creation', mode: 'attach', source: f.session }, connection)
      activeAdmission = randomUUID()
    }
    await host.handle({ method: 'conversation.reconcile', binding: f.binding, session: f.session,
      admissionId: activeAdmission, correlationId: 'message' }, connection)
    release.resolve()
    expect(await result).toMatchObject({ value: { success: true } })
    expect(calls).toEqual(reconnect
      ? ['prepare', 'activate', 'prepare', 'activate', 'call', 'close']
      : ['prepare', 'activate', 'call', 'close'])
  } finally { release.resolve(); await host.drainForUpdate(); await files.close(); await host.shutdown() }
})
