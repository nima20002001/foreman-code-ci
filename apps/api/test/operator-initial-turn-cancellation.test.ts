import { expect, it } from 'vitest'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { WorkerConversationReceipt } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { nativeCorrelation } from '../src/modules/conversations/operatorChatRepository.js'
import { MainWorkerConversationBridge } from '../src/modules/conversations/workerBridge.js'
import { WorkerConversationHost } from '../src/modules/conversations/workerHost.js'
import { WorkerConversationJournal } from '../src/modules/conversations/workerJournal.js'
import { WorkerConversationManager } from '../src/modules/conversations/workerManager.js'
import { workerConversationFixture } from '../src/modules/conversations/workerFixtures.test-support.js'
import { memoryConversation, operator } from './fixtures/agent1OperatorChat.js'

it('recovers and stops the original Claude initial input before settling cancellation after Main restarts', async () => {
  const f = workerConversationFixture('operator', 'claude')
  if (!('operatorId' in f.configuration)) throw new Error('Operator configuration required')
  f.binding.appMcpAccess = 'scoped'
  const principal = operator()
  const id = f.binding.owner.conversationId
  const requestId = 'original-request'
  const correlationId = nativeCorrelation(id, requestId)
  const stored = memoryConversation(f.configuration, principal.id, id)
  Object.assign(stored.row, { native_session_id: f.session.nativeSessionId, provider_version: f.session.providerVersion,
    active_request_id: requestId, active_phase: 'ready', turn_state: 'uncertain' })
  const submission = { kind: 'message' as const, nativeSessionId: f.session.nativeSessionId,
    nativeMessageId: 'original-message', clientCorrelationId: correlationId }
  let submittedMessageId: string | undefined
  stored.repository.submittedMessage = async (_id, _requestId, receipt) => {
    submittedMessageId = receipt.nativeMessageId
    stored.row.active_phase = 'submitted'
    return true
  }
  stored.repository.submittedMessageId = async () => submittedMessageId
  const commands = stored.repository.createControlCommands.bind(stored.repository)
  stored.repository.createControlCommands = (...args) => Object.assign(commands(...args), {
    reconcileStoredResponses: async () => {}, reconcileResponses: async () => {},
  })
  const records: WorkerConversationReceipt[] = []
  const journal = new WorkerConversationJournal({ read: async () => structuredClone(records),
    change: async (_id, apply) => structuredClone(apply(records)) }, 8)
  await journal.receive(f.binding, f.connection)
  await journal.reserveInitialTurn(f.binding, correlationId,
    commandInputHash({ mode: 'initial-turn', correlationId }), correlationId, commandInputHash('original-input'), 'regular')
  await journal.bindSession(f.binding, f.session, f.nativeOwner)
  await journal.submitted(f.binding, correlationId, { nativeSubmission: submission })
  const cancellations: Array<{ sessionId: string; messageId: string | undefined }> = []
  let terminal = false
  const forbidden = async (): Promise<never> => { throw new Error('Stop cannot create or submit another input') }
  const native: NativeHarnessSessionManager = { harness: 'claude',
    capabilities: forbidden, inspectMcp: forbidden, createSession: forbidden, attachSession: forbidden,
    startTurn() { throw new Error('Stop cannot submit another input') },
    pending: forbidden, respond: forbidden, history: forbidden,
    cancel: async (session, _signal, messageId) => {
    cancellations.push({ sessionId: session.nativeSessionId, messageId })
    return true
  }, reconcile: async () => ({ events: [], pendingInteractions: [], correlationId, nativeSubmission: submission,
    ...(terminal ? { terminalResult: { outcome: 'canceled' as const },
      terminalTurn: { correlationId, providerId: submission.nativeMessageId, result: { outcome: 'canceled' as const } } } : {}) }),
    close: async () => {},
  }
  const host = new WorkerConversationHost({ journal, currentBinding: () => f.connection,
    authorize: async () => {}, observeSession: async () => {}, observeSubmission: async () => {},
    allocate: async () => { throw new Error('Stop cannot launch another session') },
    recover: async () => ({ manager: native, nativeOwner: async () => f.nativeOwner, close: async () => {},
      start: async () => { throw new Error('Stop cannot submit another input') } }) })
  const bridge = new MainWorkerConversationBridge()
  const manager = new WorkerConversationManager({ binding: f.binding, configuration: f.configuration, bridge,
    current: async () => {}, channel: { binding: f.connection,
      request: async raw => ({ payload: await host.handle(raw, f.connection) }) } })
  const chat = new OperatorChatService(stored.repository, {} as never, (() => manager) as never,
    f.binding.workingDirectory, { current: async () => principal, release: async () => {},
      prepare: async () => { throw new Error('Stop cannot issue new launch credentials') } } as never)
  try {
    await chat.cancel(id, requestId, principal, undefined, 'mcp')
    expect(stored.row.last_error).toBeNull()
    expect(cancellations).toContainEqual({ sessionId: f.session.nativeSessionId, messageId: submission.nativeMessageId })
    expect(stored.finishResults).toEqual([])
    expect(stored.row.active_request_id).toBe(requestId)
    expect(stored.row.cancel_requested).toBe(true)
    terminal = true
    await chat.reconcileActive()
    expect(stored.finishResults).toEqual([{ outcome: 'canceled' }])
  } finally {
    await chat.shutdown()
    await manager.dispose()
    await bridge.close()
    await host.shutdown()
  }
})
