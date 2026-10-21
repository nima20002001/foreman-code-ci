import { expect, it } from 'vitest'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { WorkerConversationReceipt } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeHarnessSessionManager, NativeSessionStart } from '../harnesses/port.js'
import { WorkerConversationHost, type WorkerConversationAllocation } from './workerHost.js'
import { WorkerConversationJournal } from './workerJournal.js'
import { WorkerConversationManager } from './workerManager.js'
import { MainWorkerConversationBridge } from './workerBridge.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'

it('refreshes the retained Codex MCP route on attachment before the next message', async () => {
  const f = workerConversationFixture()
  const binding = { ...f.binding, appMcpAccess: 'scoped' as const }
  const records: WorkerConversationReceipt[] = []
  const journal = new WorkerConversationJournal({ read: async () => structuredClone(records),
    change: async (_id, apply) => structuredClone(apply(records)) }, 8)
  let token: string | undefined
  let creates = 0
  let allocations = 0
  const native = { harness: 'codex', createSession: async () => { creates++; return f.session },
    history: async () => {
      if (token !== 'second-scoped-token') throw new Error('AUTH_REVOKED')
      return { events: [], pendingInteractions: [] }
    } } as unknown as NativeHarnessSessionManager
  const allocation = { manager: native, nativeOwner: async () => f.nativeOwner, close: async () => {},
    start: async (input: Parameters<WorkerConversationAllocation['start']>[0]) => {
      token = input.applicationAccess?.token
      return { kind: 'operator', configuration: f.configuration,
        correlationId: input.correlationId, workingDirectory: binding.workingDirectory } as NativeSessionStart
    },
    refreshApplicationAccess: async (next: string) => { token = next },
  }
  const host = new WorkerConversationHost({ journal, currentBinding: () => f.connection,
    authorize: async () => {}, observeSession: async () => {}, observeSubmission: async () => {},
    allocate: async () => { allocations++; return allocation } })
  const open = { method: 'conversation.open', binding, operationId: 'first-message', mode: 'create',
    configuration: f.configuration, applicationAccess: { kind: 'operator-chat-mcp', token: 'first-scoped-token' } }
  try {
    await host.handle(open, f.connection)
    await journal.reserveTurn(binding, 'first-message', commandInputHash('first-message'))
    await journal.finishTurn(binding, 'first-message', { outcome: 'succeeded' })
    await host.handle({ ...open, mode: 'attach', source: f.session, operationId: 'second-message',
      applicationAccess: { kind: 'operator-chat-mcp', token: 'second-scoped-token' } }, f.connection)
    await expect(host.handle({ method: 'conversation.history', binding, session: f.session }, f.connection))
      .resolves.toMatchObject({ history: { events: [] } })
    expect(creates).toBe(1)
    expect(allocations).toBe(1)
    expect((await journal.read(binding))?.session).toEqual(f.session)
  } finally { await host.shutdown() }
})

it('recovers a journaled creation by its original operation after losing the identity callback', async () => {
  const f = workerConversationFixture()
  const records: WorkerConversationReceipt[] = []
  const journal = new WorkerConversationJournal({ read: async () => structuredClone(records),
    change: async (_id, apply) => structuredClone(apply(records)) }, 8)
  let creates = 0
  const host = new WorkerConversationHost({ journal, currentBinding: () => f.connection,
    authorize: async () => {}, observeSubmission: async () => {},
    observeSession: async () => { throw new Error('Connection lost before Main saved the session') },
    allocate: async () => ({ manager: {
      harness: 'codex', createSession: async () => { creates++; return f.session },
    } as unknown as NativeHarnessSessionManager, nativeOwner: async () => f.nativeOwner, close: async () => {},
    start: async () => ({ kind: 'operator', configuration: f.configuration,
      workingDirectory: f.binding.workingDirectory }) as NativeSessionStart }) })
  const start = { kind: 'operator', configuration: f.configuration,
    workingDirectory: f.binding.workingDirectory, correlationId: 'original-creation' } as NativeSessionStart
  await expect(host.handle({ method: 'conversation.open', binding: f.binding, mode: 'create',
    configuration: f.configuration, operationId: start.correlationId }, f.connection)).rejects.toThrow('Connection lost')
  const bridge = new MainWorkerConversationBridge()
  const manager: NativeHarnessSessionManager = new WorkerConversationManager({ binding: f.binding,
    configuration: f.configuration, bridge, current: async () => {},
    channel: { binding: f.connection, request: async request => ({ payload: await host.handle(request, f.connection) }) } })
  try {
    expect(manager.reconcileSessionCreation).toBeTypeOf('function')
    await expect(manager.reconcileSessionCreation!(start)).resolves.toEqual(f.session)
    await expect(manager.reconcileSessionCreation!({ ...start, correlationId: 'different-operation' })).rejects.toThrow()
    expect(creates).toBe(1)
    expect((await journal.read(f.binding))?.creation?.operationId).toBe(start.correlationId)
  } finally { await manager.dispose?.(); await bridge.close(); await host.shutdown() }
})
