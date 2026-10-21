import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { NativeHarnessSessionManager, NativeSessionStart } from '../harnesses/port.js'
import type { NativeLaunchObservation } from '../harnesses/recovery/processRegistry.js'
import { fixture as claudeFixture } from '../harnesses/claudeSdk/__tests__/sessionManager.js'
import { createClaudeNativeSessionManager, claudePromptUuid } from '../harnesses/claudeSdk/sessionManager.js'
import { createClaudeSdkRunner } from '../harnesses/claudeSdk/runner.js'
import { ClaudeBoundedQueue } from '../harnesses/claudeSdk/queue.js'
import type { ClaudeSdkClient } from '../harnesses/claudeSdk/port.js'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { MainWorkerConversationBridge } from './workerBridge.js'
import { WorkerConversationHost, type WorkerConversationAllocation } from './workerHost.js'
import { WorkerConversationManager } from './workerManager.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { workerConversationProcessDigest } from './workerNativeOwner.js'
import { recoverWorkerConversation } from './recoverWorkerConversation.js'

it.each(['session', 'submission', 'terminal'] as const)(
  'retains native Claude initialization and input when Main loses the %s callback', async failedCallback => {
  const f = workerConversationFixture('operator', 'claude')
  if (!('operatorId' in f.configuration)) throw new Error('Operator configuration required')
  f.binding.workingDirectory = '/work'
  const native = claudeFixture()
  const directory = await privateFixtureDirectory('claude-initial-callback-')
  const journal = await RemoteOperationJournal.open(join(directory, 'operations.json'), { initializeNewInstallation: true })
  const correlationId = 'original-initial-input'
  const start: NativeSessionStart = { kind: 'operator', configuration: f.configuration,
    workingDirectory: f.binding.workingDirectory, correlationId }
  const observed = vi.fn(async () => {
    if (failedCallback === 'session') throw new Error('Main disconnected during the session callback')
  })
  const host = new WorkerConversationHost({ journal: journal.conversations, currentBinding: () => f.connection,
    authorize: async () => {}, observeSession: observed,
    observeSubmission: async () => {
      if (failedCallback === 'submission') throw new Error('Main disconnected during the submission callback')
    },
    observeTerminal: async () => {
      if (failedCallback === 'terminal') throw new Error('Main disconnected during the terminal callback')
    },
    allocate: async () => ({ manager: native.manager, start: async () => start,
      nativeOwner: async session => ({ ...f.nativeOwner, sessionId: session.nativeSessionId }),
      close: async () => { await native.manager.dispose?.() } }) })
  const bridge = new MainWorkerConversationBridge()
  const manager = new WorkerConversationManager({ binding: f.binding, configuration: f.configuration, bridge,
    current: async () => {}, channel: { binding: f.connection,
      request: async raw => ({ payload: await host.handle(raw, f.connection) }) } })
  try {
    await host.handle({ method: 'conversation.initial-turn', binding: f.binding, configuration: f.configuration,
      operationId: correlationId, correlationId, prompt: 'Original input' }, f.connection)
    const message = await native.nextMessage()
    await vi.waitFor(() => expect(observed).toHaveBeenCalledOnce())
    await native.frames.offer({ type: 'assistant', session_id: 'native-session', uuid: 'original-reply',
      user_message_uuid: message.uuid })
    await native.frames.offer({ type: 'result', session_id: 'native-session', uuid: 'original-result',
      user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'Original answer' })
    await vi.waitFor(async () => {
      expect((await journal.conversations.read(f.binding))?.turns[0]?.status).toBe('completed')
    })
    const session = await manager.reconcileSessionCreation(start)
    expect(session.nativeSessionId).toBe('native-session')
    const history = await manager.reconcile(session, correlationId)
    expect(history.nativeSubmission).toMatchObject({ nativeMessageId: message.uuid, clientCorrelationId: correlationId })
    expect(history.terminalResult).toEqual({ outcome: 'succeeded', output: 'Original answer' })
    expect(native.queries).toHaveBeenCalledOnce()
    expect(native.offers).toHaveBeenCalledOnce()
    expect(native.close).not.toHaveBeenCalled()
  } finally {
    await manager.dispose()
    await bridge.close()
    await host.shutdown()
    await journal.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it.each([['codex', false], ['codex', true], ['claude', false]] as const)(
  'recovers journaled %s creation after a Worker restart without replaying input (fork=%s)', async (harness, fork) => {
    const f = workerConversationFixture('agent', harness)
    if (!('agentId' in f.configuration) || f.binding.owner.kind !== 'agent') throw new Error('Agent configuration required')
    const directory = await privateFixtureDirectory('worker-creation-restart-')
    const path = join(directory, 'operations.json')
    let journal = await RemoteOperationJournal.open(path, { initializeNewInstallation: true })
    const operationId = 'original-creation'
    const launch: NativeLaunchObservation = { owner: `conversation:${f.binding.owner.conversationId}`,
      launchId: randomUUID(), bootId: f.connection.bootId, lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty',
      guardian: { pid: 11111, startTicks: '10' }, provider: { pid: 11112, startTicks: '11' },
      boundary: { kind: 'cgroup-v2', path: '/fixture/native-boundary', device: '1', inode: '2' } }
    const owner = { sessionId: f.session.nativeSessionId,
      processIdentityDigest: workerConversationProcessDigest(f.binding, launch) }
    const source = fork ? { ...f.session, nativeSessionId: 'original-source' } : undefined
    const initial = harness === 'claude'
    await journal.conversations.receive(f.binding, f.connection)
    if (initial) {
      await journal.conversations.reserveInitialTurn(f.binding, operationId,
        commandInputHash({ mode: 'initial-turn', correlationId: operationId }), operationId,
        commandInputHash({ prompt: 'Original input' }), 'regular')
    } else {
      await journal.conversations.reserveCreation(f.binding, operationId,
        commandInputHash({ mode: fork ? 'fork' : 'create', source: source ?? null, preferences: null }))
    }
    await journal.conversations.bindSession(f.binding, f.session, owner)
    const submission = { kind: 'message' as const, nativeSessionId: f.session.nativeSessionId,
      nativeMessageId: claudePromptUuid(operationId), clientCorrelationId: operationId }
    const result = { outcome: 'succeeded' as const, output: 'Original answer' }
    if (initial) {
      await journal.conversations.submitted(f.binding, operationId, { nativeSubmission: submission })
      await journal.conversations.finishTurn(f.binding, operationId, result)
    }
    await journal.close()
    journal = await RemoteOperationJournal.open(path)
    const connection = { ...f.connection, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 2 }
    const start: NativeSessionStart = { kind: 'agent-chat', configuration: f.configuration,
      workingDirectory: f.binding.workingDirectory, conversationId: f.binding.owner.conversationId,
      workflowId: f.binding.owner.workflowId, workflowNodeId: f.binding.owner.workflowNodeId, correlationId: operationId }
    const attach = vi.fn(async () => f.session)
    const forbidden = async (): Promise<never> => { throw new Error('Recovery cannot create or submit input') }
    const native = { harness, attachSession: attach, createSession: forbidden, forkSession: forbidden,
      startInitialTurn: forbidden, startTurn: forbidden,
      reconcile: async () => ({ events: [], pendingInteractions: [], correlationId: operationId,
        nativeSubmission: submission, terminalResult: { outcome: 'succeeded' } }),
    } as unknown as NativeHarnessSessionManager
    const startAllocation = vi.fn(async () => start)
    const allocation: WorkerConversationAllocation = { manager: native, start: startAllocation,
      nativeOwner: async () => ({ ...owner, processIdentityDigest: 'd'.repeat(64) }), close: async () => {} }
    const offered = vi.fn()
    if (initial) {
      const frames = new ClaudeBoundedQueue<unknown>(2)
      const client: ClaudeSdkClient = { sdkVersion: '0.3.284', query(input) {
        void (async () => { for await (const message of input.prompt) offered(message) })()
        return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), close: () => frames.close(),
          interrupt: async () => {}, initializationResult: async () => ({}) }
      }, getSessionInfo: async sessionId => ({ sessionId }),
        getSessionMessages: async () => [{ type: 'user', session_id: f.session.nativeSessionId,
          uuid: submission.nativeMessageId, parent_tool_use_id: null }], forkSession: forbidden }
      allocation.manager = createClaudeNativeSessionManager({ runner: createClaudeSdkRunner({ loadClient: async () => client }),
        scope: { deviceId: connection.deviceId, profilePath: '/fixture/profile', configRevision: '1',
          cwd: f.binding.workingDirectory }, sdkOptions: {},
        qualification: { sdkVersion: '0.3.284', cliVersion: f.session.providerVersion,
          basicTurns: true, resume: true, fork: false, history: true } })
      allocation.close = async () => { await allocation.manager.dispose?.() }
    }
    const host = new WorkerConversationHost({ journal: journal.conversations, currentBinding: () => connection,
      authorize: async () => {}, observeSession: async () => {}, observeSubmission: async () => {}, allocate: forbidden,
      recover: async (record, configuration, current, signal, request) => recoverWorkerConversation({
        record, configuration, connection: current, signal, request, journal: journal.conversations,
        allocate: async () => allocation, assertCurrent: async () => {},
        registry: { snapshot: () => ({ revision: 'fixture', launches: [launch] }), closeOwner: async () => true },
      }) })
    const bridge = new MainWorkerConversationBridge()
    const manager = new WorkerConversationManager({ binding: f.binding, configuration: f.configuration, bridge,
      current: async () => {}, channel: { binding: connection,
        request: async raw => ({ payload: await host.handle(raw, connection) }) } })
    try {
      await expect(manager.reconcileSessionCreation(start, undefined, source)).resolves.toEqual(f.session)
      const saved = await journal.conversations.read(f.binding)
      expect(saved?.connection).toEqual(connection)
      expect(saved?.creation?.operationId).toBe(operationId)
      expect(saved?.session).toEqual(f.session)
      if (!initial) expect(attach).toHaveBeenCalledOnce()
      expect(startAllocation).toHaveBeenCalledWith({ correlationId: operationId, instructionsDelivered: true })
      if (initial) {
        expect(saved?.turns[0]).toMatchObject({ status: 'completed', nativeSubmission: submission, result })
        const history = await manager.reconcile(f.session, operationId)
        expect(history.nativeSubmission).toEqual(submission)
        expect(history.terminalResult).toEqual(result)
        expect(history.terminalTurn).toEqual({ correlationId: operationId, providerId: submission.nativeMessageId, result })
        expect(offered).not.toHaveBeenCalled()
      }
    } finally {
      await manager.dispose()
      await bridge.close()
      await host.shutdown()
      await journal.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
