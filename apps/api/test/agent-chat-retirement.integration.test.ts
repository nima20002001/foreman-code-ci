import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AgentConfigurationVersionSchema, unavailableSessionControls, type ExecutionResult } from '@foreman-code/contracts'
import type { WorkerConversationReceipt } from '@foreman-code/contracts/remote-execution-rpc'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { agentChatKey, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { MainWorkerConversationBridge } from '../src/modules/conversations/workerBridge.js'
import { workerConversationCallbacks } from '../src/modules/conversations/workerCallbacks.js'
import { WorkerConversationHost } from '../src/modules/conversations/workerHost.js'
import { WorkerConversationJournal } from '../src/modules/conversations/workerJournal.js'
import { WorkerConversationManager } from '../src/modules/conversations/workerManager.js'
import { workerConversationFixture } from '../src/modules/conversations/workerFixtures.test-support.js'
import type { NativeHarnessSessionManager, NativeHistory } from '../src/modules/harnesses/port.js'
import { readSystemPromptSetting } from '../src/modules/settings/foundation.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { agent3Database, seedAgent3 } from './helpers/wave25Agent3.js'
import { graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { admittedWorkerManager, prepareWorkerInput } from './helpers/workerChatPreparation.js'
import { deferred, rejectableDeferred } from './helpers/deferred.js'

it.each([false, true])('reconciles an uncertain turn through shutdown without replay (Worker exits on completion: %s)', async exitsOnCompletion => {
  const db = await agent3Database()
  const f = workerConversationFixture('agent')
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
  fixture.configurations = fixture.configurations.map(value => AgentConfigurationVersionSchema.parse({ ...value,
    harness: f.configuration.harness, harnessProfileSelection: f.binding.profile }))
  const bridge = new MainWorkerConversationBridge()
  let host: WorkerConversationHost | undefined
  let chat: AgentChatService | undefined
  let app: ReturnType<typeof buildApp> | undefined
  let result: ExecutionResult | undefined
  const completed = { outcome: 'succeeded' as const, output: 'Recovered native completion' }
  try {
    const seeded = await seedAgent3(db.pool, db.directory, fixture, { run: false })
    const node = seeded.version.definition.nodes[0]!
    const configuration = seeded.configurations.find(value => value.agentId === node.agentId)!
    const context = { workspaceId: configuration.workspaceId, workflowId: seeded.scope.workflowId,
      workflowNodeId: node.id, agentId: node.agentId }
    const repository = new PostgresAgentChatRepository(db.pool)
    const conversation = await repository.ensureForControls(agentChatKey(context), { context,
      agentConfigurationVersionId: configuration.id, harness: 'codex', origin: { kind: 'fresh' },
      workingDirectory: db.directory, runtimeDirectory: join(db.directory, 'retirement') }, async () => {})
    const binding = { ...f.binding, workingDirectory: db.directory, systemPrompt: await readSystemPromptSetting(db.pool),
      owner: { kind: 'agent' as const, conversationId: conversation.id, workspaceId: context.workspaceId,
        workflowId: context.workflowId, workflowNodeId: node.id, agentId: node.agentId,
        configurationVersionId: configuration.id, configurationHash: commandInputHash(configuration) } }
    const records: WorkerConversationReceipt[] = []
    const journal = new WorkerConversationJournal({ read: async () => structuredClone(records),
      change: async (_id, apply) => structuredClone(apply(records)) }, 8)
    let correlation = ''
    let inputs = 0
    let creates = 0
    let closes = 0
    let reconciles = 0
    let exited = false
    const history = (): NativeHistory => ({ events: [], pendingInteractions: [],
      ...(correlation ? { correlationId: correlation, nativeTurnId: 'native-turn' } : {}),
      ...(result ? { terminalResult: result } : {}) })
    const native = { harness: 'codex',
      capabilities: async () => { throw new Error('Unexpected native capabilities request') },
      inspectMcp: async () => { throw new Error('Unexpected native MCP inspection') },
      attachSession: async () => { throw new Error('Unexpected native session attachment') },
      respond: async () => { throw new Error('Unexpected native response') },
      cancel: async () => { throw new Error('Unexpected native cancellation') },
      close: async () => { throw new Error('Unexpected native session close') },
      createSession: async () => { creates++; return f.session },
      async *startTurn(_session, input) {
        inputs++
        correlation = input.clientCorrelationId
        await input.onSettingsApplied?.()
        await input.onSubmitted?.('native-turn')
        yield* []
        throw new Error('The native output observer disconnected after acceptance')
      },
      history: async () => history(),
      reconcile: async (_session, requested, signal) => {
        signal?.throwIfAborted()
        expect(requested).toBe(correlation)
        reconciles++
        if (result && exitsOnCompletion) exited = true
        return history()
      },
      pending: async () => undefined,
      sessionControlCapabilities: async () => unavailableSessionControls('retirement-fixture'),
    } satisfies NativeHarnessSessionManager
    const callbacks = workerConversationCallbacks({ currentBinding: () => f.connection,
      capture: () => ({ binding: f.connection, request: async raw => ({
        payload: await bridge.handle(raw, f.connection, AbortSignal.timeout(5_000)) }) }) })
    host = new WorkerConversationHost({ ...callbacks, journal, currentBinding: () => f.connection,
      allocate: async () => ({ manager: native,
        start: async ({ correlationId }) => ({ kind: 'agent-chat', configuration, conversationId: conversation.id, correlationId,
          workflowId: context.workflowId, workflowNodeId: node.id, workingDirectory: db.directory }),
        nativeOwner: async () => f.nativeOwner, hasExited: () => exited, close: async () => { closes++ } }) })
    const managerOptions = { binding, configuration, bridge, current: async () => {}, channel: { binding: f.connection,
      request: async (raw, options) => ({ payload: await host!.handle(raw, f.connection, options?.signal) }) } } satisfies ConstructorParameters<typeof WorkerConversationManager>[0]
    chat = new AgentChatService(db.pool, repository, new PostgresOperatorConversationRepository(db.pool),
      new PostgresWorkflowRepository(db.pool), {
        getForWorkspace: async () => { throw new Error('Chat has no Run') },
        getExecution: async () => { throw new Error('Chat has no execution') },
        executionPages: () => { throw new Error('Chat has no execution pages') },
      }, Object.assign(() => admittedWorkerManager(managerOptions),
        { prepareInput: prepareWorkerInput(new WorkerConversationManager(managerOptions)) }), db.directory)
    const access = new PostgresAccessService(db.pool)
    const writer = await access.issue({ name: 'Chat writer', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['agent_chat:read', 'agent_chat:write'], scope: {} }] })
    const reader = await access.issue({ name: 'Unrelated reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['agent_chat:read'], scope: { workspaceIds: ['unrelated-workspace'] } }] })
    app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { agentChat: chat, commands: new PostgresCommandCoordinator(db.pool) } as never } })
    const query = { workflowId: context.workflowId, workflowNodeId: node.id, agentId: node.agentId }
    const call = (token: string, name: string, args: Record<string, unknown>) => graphRpc(app!, token, 'tools/call', {
      name, arguments: { workspaceId: context.workspaceId, ...args } })
    const uncertain = deferred()
    const unsubscribe = chat.events.subscribe(conversation.id, event => {
      if (event.data.requestId === 'original-input' && event.data.delivery === 'unknown') uncertain.resolve()
    })
    try {
      const sent = await call(writer.token, 'agent_chat_send', { request: { requestId: 'original-input',
        content: 'Run once', intent: 'next_turn', expectedConversationId: conversation.id, context: query } })
      expect(sent.result?.isError, JSON.stringify(sent)).not.toBe(true)
      console.error('DIAG sent'); await uncertain.promise; console.error('DIAG uncertain')
    } finally { unsubscribe() }
    expect((await journal.read(binding))?.turns[0]?.status).toBe('uncertain')
    console.error('DIAG journal ok'); await expect(chat.shutdown()).rejects.toThrow('cleanup was incomplete'); console.error('DIAG shutdown1')
    expect((await repository.turn(conversation.id, 'original-input'))?.delivery).toBe('unknown')
    expect(closes).toBe(0)
    result = completed
    const shutdown = rejectableDeferred()
    const deadline = setTimeout(() => shutdown.reject(new Error('Shutdown did not finish after native completion')), 5_000)
    try {
      void chat.shutdown().then(shutdown.resolve, shutdown.reject)
      await expect(shutdown.promise).resolves.toBeUndefined(); console.error('DIAG shutdown2')
    } finally { clearTimeout(deadline) }
    expect(reconciles).toBeGreaterThan(0)
    expect(inputs).toBe(1)
    expect(creates).toBe(1)
    expect(closes).toBe(1)
    expect(await journal.read(binding)).toMatchObject({ runtimeReleased: true, closed: false,
      turns: [{ status: 'completed', result: completed }] })
    expect(await repository.get(conversation.id)).toMatchObject({ active_request_id: null, last_result: completed })
    const denied = await call(reader.token, 'agent_chat_read', { query })
    expect(denied.error || denied.result?.isError).toBeTruthy()
    const read = await call(writer.token, 'agent_chat_read', { query })
    expect(read.result?.isError).not.toBe(true)
    expect(graphRpcValue(read.result)).toMatchObject({ turns: [{ requestId: 'original-input', delivery: 'completed' }] })
  } finally {
    result = completed
    await app?.close()
    await host?.shutdown()
    await bridge.close()
    await db.close()
  }
})
