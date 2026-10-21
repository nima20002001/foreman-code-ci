import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  AgentConfigurationVersionSchema, SessionControlStateSchema, unavailableSessionControls,
} from '@foreman-code/contracts'
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
import { deferred } from './helpers/deferred.js'

it('reconciles uncertain compaction during shutdown without an active message or another native dispatch', async () => {
  const db = await agent3Database()
  const f = workerConversationFixture('agent')
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
  fixture.configurations = fixture.configurations.map(value => AgentConfigurationVersionSchema.parse({ ...value,
    harness: f.configuration.harness, harnessProfileSelection: f.binding.profile }))
  const bridge = new MainWorkerConversationBridge()
  let host: WorkerConversationHost | undefined
  let app: ReturnType<typeof buildApp> | undefined
  let completed = false
  let retiring = false
  try {
    const seeded = await seedAgent3(db.pool, db.directory, fixture, { run: false })
    const node = seeded.version.definition.nodes[0]!
    const configuration = seeded.configurations.find(value => value.agentId === node.agentId)!
    const context = { workspaceId: configuration.workspaceId, workflowId: seeded.scope.workflowId,
      workflowNodeId: node.id, agentId: node.agentId }
    const repository = new PostgresAgentChatRepository(db.pool)
    const conversation = await repository.ensureForControls(agentChatKey(context), { context,
      agentConfigurationVersionId: configuration.id, harness: 'codex', origin: { kind: 'fresh' },
      workingDirectory: db.directory, runtimeDirectory: join(db.directory, 'compaction-retirement') }, async () => {})
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
    let dispatches = 0
    let retirementReads = 0
    const history = (): NativeHistory => ({ events: [], pendingInteractions: [],
      ...(correlation ? { correlationId: correlation, nativeTurnId: 'seed-turn',
        terminalResult: { outcome: 'succeeded' as const } } : {}) })
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
        await input.onSubmitted?.('seed-turn')
        yield* []
      },
      history: async () => history(),
      reconcile: async () => history(),
      pending: async () => undefined,
      sessionControlCapabilities: async () => ({ ...unavailableSessionControls('retirement-fixture'),
        compact: { supported: true, reason: null } }),
      compactSession: async (session, input) => {
        dispatches++
        await input.onDispatch?.()
        await input.onProgress({ requestId: input.requestId, nativeSessionId: session.nativeSessionId,
          nativeOperationId: 'native-compaction', status: 'running', beforeTokens: 100,
          message: 'Compacting', observedAt: new Date().toISOString() })
        throw new Error('The native compaction acknowledgement was lost')
      },
      reconcileCompaction: async (_session, state, signal) => {
        if (retiring) {
          expect(signal).toBeInstanceOf(AbortSignal)
          signal!.throwIfAborted()
          retirementReads++
        }
        return completed ? { ...state, status: 'completed' as const, message: 'Context compacted.' } : state
      },
    } satisfies NativeHarnessSessionManager
    const callbacks = workerConversationCallbacks({ currentBinding: () => f.connection,
      capture: () => ({ binding: f.connection, request: async raw => ({
        payload: await bridge.handle(raw, f.connection, AbortSignal.timeout(5_000)) }) }) })
    host = new WorkerConversationHost({ ...callbacks, journal, currentBinding: () => f.connection,
      allocate: async () => ({ manager: native,
        start: async ({ correlationId }) => ({ kind: 'agent-chat', configuration,
          conversationId: conversation.id, correlationId, workflowId: context.workflowId,
          workflowNodeId: node.id, workingDirectory: db.directory }),
        nativeOwner: async () => f.nativeOwner, close: async () => { closes++ } }) })
    const managerOptions = { binding, configuration, bridge, current: async () => {}, channel: { binding: f.connection,
      request: async (raw, options) => ({ payload: await host!.handle(raw, f.connection, options?.signal) }) } } satisfies ConstructorParameters<typeof WorkerConversationManager>[0]
    const chat = new AgentChatService(db.pool, repository, new PostgresOperatorConversationRepository(db.pool),
      new PostgresWorkflowRepository(db.pool), {
        getForWorkspace: async () => { throw new Error('Chat has no Run') },
        getExecution: async () => { throw new Error('Chat has no execution') },
        executionPages: () => { throw new Error('Chat has no execution pages') },
      }, Object.assign(() => admittedWorkerManager(managerOptions),
        { prepareInput: prepareWorkerInput(new WorkerConversationManager(managerOptions)) }), db.directory)
    const access = new PostgresAccessService(db.pool)
    const writer = await access.issue({ name: 'Chat writer', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['agent_chat:read', 'agent_chat:write'], scope: {} }] })
    const reader = await access.issue({ name: 'Chat reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['agent_chat:read'], scope: {} }] })
    app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { agentChat: chat, commands: new PostgresCommandCoordinator(db.pool) } as never } })
    const query = { workflowId: context.workflowId, workflowNodeId: node.id, agentId: node.agentId }
    const call = (token: string, name: string, args: Record<string, unknown>) => graphRpc(app!, token, 'tools/call', {
      name, arguments: { workspaceId: context.workspaceId, ...args } })
    const settled = deferred()
    const unsubscribe = chat.events.subscribe(conversation.id, event => {
      if (event.data.requestId === 'seed-input' && event.data.delivery === 'completed') settled.resolve()
    })
    try {
      const sent = await call(writer.token, 'agent_chat_send', { request: { requestId: 'seed-input',
        content: 'Seed this session', intent: 'next_turn', expectedConversationId: conversation.id, context: query } })
      expect(sent.result?.isError, JSON.stringify(sent)).not.toBe(true)
      await settled.promise
    } finally { unsubscribe() }
    const controls = await call(writer.token, 'agent_chat_controls_get', { conversationId: conversation.id })
    const before = SessionControlStateSchema.parse(graphRpcValue(controls.result))
    const request = { kind: 'compact', requestId: randomUUID(), expectedRevision: before.revision }
    const denied = await call(reader.token, 'agent_chat_controls_update', { conversationId: conversation.id, request })
    expect(denied.error || denied.result?.isError).toBeTruthy()
    const compacted = await call(writer.token, 'agent_chat_controls_update', { conversationId: conversation.id, request })
    expect(compacted.result?.isError).not.toBe(true)
    expect(SessionControlStateSchema.parse(graphRpcValue(compacted.result)).compaction)
      .toMatchObject({ requestId: request.requestId, status: 'uncertain', dispatchPhase: 'dispatched' })
    expect((await repository.get(conversation.id))?.active_request_id).toBeNull()
    expect((await journal.read(binding))?.compactions[0]?.state.status).toBe('uncertain')
    retiring = true
    await expect(chat.shutdown()).rejects.toThrow('cleanup was incomplete')
    expect(closes).toBe(0)
    expect((await journal.read(binding))?.compactions[0]?.state.status).toBe('uncertain')
    completed = true
    await expect(chat.shutdown()).resolves.toBeUndefined()
    expect(retirementReads).toBeGreaterThan(0)
    expect(dispatches).toBe(1)
    expect(inputs).toBe(1)
    expect(creates).toBe(1)
    expect(closes).toBe(1)
    expect(await journal.read(binding)).toMatchObject({ runtimeReleased: true,
      compactions: [{ state: { requestId: request.requestId, status: 'completed' } }] })
    const saved = await db.pool.query<{ record: unknown }>(
      'select record from conversation_session_controls where conversation_id=$1', [conversation.id])
    expect(SessionControlStateSchema.parse(saved.rows[0]?.record).compaction)
      .toMatchObject({ requestId: request.requestId, status: 'completed', principalId: writer.principal.id })
    const receipt = await db.pool.query<{ result: unknown }>(`select result from management_command_receipts
      where principal_id=$1 and command_id=$2 and target_key=$3`,
    [writer.principal.id, request.requestId, conversation.id])
    expect(receipt.rows[0]?.result).toMatchObject({ status: 'completed',
      state: { compaction: { requestId: request.requestId, status: 'completed' } } })
  } finally {
    completed = true
    await app?.close()
    await host?.shutdown()
    await bridge.close()
    await db.close()
  }
})
