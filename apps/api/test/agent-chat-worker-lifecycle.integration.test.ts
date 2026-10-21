import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentConfigurationVersionSchema, type NativeSessionReference } from '@foreman-code/contracts'
import { AgentChatStateSchema } from '@foreman-code/contracts/agent-chat'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import type { WorkerConversationReceipt } from '@foreman-code/contracts/remote-execution-rpc'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { AgentChatService, type AgentChatManagerFactory } from '../src/modules/conversations/agentChat.js'
import { agentChatKey, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { createProductionWorkerConversations } from '../src/modules/conversations/workerProduction.js'
import { WorkerConversationHost } from '../src/modules/conversations/workerHost.js'
import { WorkerConversationJournal } from '../src/modules/conversations/workerJournal.js'
import { workerConversationCallbacks } from '../src/modules/conversations/workerCallbacks.js'
import { workerConversationFixture } from '../src/modules/conversations/workerFixtures.test-support.js'
import { workerClaudeReplacementFixture } from '../src/modules/conversations/workerClaudeReplacement.test-support.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { OperatorAgentMutationService } from '../src/modules/workspaces/operatorAgents.js'
import { AgentManagementService } from '../src/modules/workspaces/agents.js'
import { HarnessCatalogService } from '../src/modules/harnesses/catalog.js'
import { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'
import { readSystemPromptSetting } from '../src/modules/settings/foundation.js'
import type { NativeInitialTurnInput, NativeSessionStart } from '../src/modules/harnesses/port.js'
import { conversationChatTools } from '../src/modules/access/conversationCredentials.js'
import { prepareAgentChatInput } from '../src/modules/collaboration/chatInputPreparation.js'
import { prepareWorkerInput } from './helpers/workerChatPreparation.js'
import { ChatManager, waitFor } from './helpers/operatorChatFixture.js'
import { agent3Database, seedAgent3 } from './helpers/wave25Agent3.js'
import { graphHeaders, graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { deferred } from './helpers/deferred.js'

async function fixture() {
  const db = await agent3Database()
  const recorded = workerConversationFixture('agent', 'claude')
  const definition = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
  definition.configurations = definition.configurations.map(value => AgentConfigurationVersionSchema.parse({ ...value,
    harness: recorded.configuration.harness, harnessProfileSelection: recorded.binding.profile }))
  let worker: Awaited<ReturnType<typeof workerClaudeReplacementFixture>> | undefined
  let chat: AgentChatService | undefined
  let app: ReturnType<typeof buildApp> | undefined
  const cleanup = async () => {
    worker?.reconnect()
    await chat?.shutdown()
    await app?.close()
    await worker?.close()
    await db.close()
  }
  try {
    const seeded = await seedAgent3(db.pool, db.directory, definition, { run: false })
    const node = seeded.version.definition.nodes[0]!
    const configuration = seeded.configurations.find(value => value.agentId === node.agentId)!
    const context = { workspaceId: seeded.scope.workspaceId, workflowId: seeded.scope.workflowId,
      workflowNodeId: node.id, agentId: node.agentId }
    const query = { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId: context.agentId }
    const access = new PostgresAccessService(db.pool)
    const credential = (actions: ['agent_chat:read'] | ['agent_chat:read', 'agent_chat:write']) => access.issue({
      name: 'Worker chat caller', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions, scope: {} }] })
    const writer = await credential(['agent_chat:read', 'agent_chat:write'])
    const reader = await credential(['agent_chat:read'])
    const denied = await access.issue({ name: 'Unrelated workspace caller', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['agent_chat:read'], scope: { workspaceIds: ['other-workspace'] } }] })
    const repository = new PostgresAgentChatRepository(db.pool)
    const conversation = await repository.ensureForControls(agentChatKey(context), { context,
      agentConfigurationVersionId: configuration.id, harness: 'claude', origin: { kind: 'fresh' },
      workingDirectory: db.directory, runtimeDirectory: join(db.directory, 'worker-chat') }, async () => {})
    worker = await workerClaudeReplacementFixture({ ...recorded, configuration,
      binding: { ...recorded.binding, workingDirectory: db.directory,
        systemPrompt: await readSystemPromptSetting(db.pool), owner: { kind: 'agent',
          conversationId: conversation.id, workspaceId: configuration.workspaceId, workflowId: context.workflowId,
          workflowNodeId: node.id, agentId: node.agentId, configurationVersionId: configuration.id,
          configurationHash: commandInputHash(configuration) } } })
    chat = new AgentChatService(db.pool, repository, new PostgresOperatorConversationRepository(db.pool),
      new PostgresWorkflowRepository(db.pool), {
        getForWorkspace: async () => { throw new Error('This chat has no Run.') },
        getExecution: async () => { throw new Error('This chat has no execution.') },
        executionPages: () => { throw new Error('This chat has no execution pages.') },
      }, Object.assign(() => worker!.createManager(),
        { prepareInput: async (input: Parameters<NonNullable<AgentChatManagerFactory['prepareInput']>>[0]) =>
          prepareWorkerInput(worker!.manager)(input) }), db.directory)
    app = buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { agentChat: chat, commands: new PostgresCommandCoordinator(db.pool) } as never } })
    const call = (token: string, name: string, args: Record<string, unknown>) => graphRpc(app!, token, 'tools/call', {
      name, arguments: { workspaceId: context.workspaceId, ...args },
    })
    const complete = deferred()
    const unsubscribe = chat.events.subscribe(conversation.id, event => {
      if (event.data.requestId === 'initial-message' && event.data.delivery === 'completed') complete.resolve()
    })
    try {
      const sent = await call(writer.token, 'agent_chat_send', { request: { requestId: 'initial-message',
        content: 'Remember this message', intent: 'next_turn', expectedConversationId: conversation.id, context: query } })
      expect(sent.result?.isError).not.toBe(true)
      await complete.promise
    } finally { unsubscribe() }
    const read = async () => {
      const response = await call(reader.token, 'agent_chat_read', { query })
      expect(response.result?.isError).not.toBe(true)
      return AgentChatStateSchema.parse(graphRpcValue(response.result))
    }
    const root = `/api/workspaces/${context.workspaceId}/agent-chat`
    return { db, worker, chat, app, repository, conversation, query, reader, denied, call, read, root, cleanup }
  } catch (error) { await cleanup(); throw error }
}

it.each(['transport', 'unavailable'] as const)(
  'serves persisted Agent chat state and SSE bootstrap with an offline %s observation through HTTP and MCP', async failure => {
  const f = await fixture()
  try {
    const before = await f.read()
    expect(before.messages.some(message => message.role === 'user')).toBe(true)
    f.worker.disconnect(failure)
    const denied = await f.call(f.denied.token, 'agent_chat_read', { query: f.query })
    expect(denied.error || denied.result?.isError).toBeTruthy()
    const offline = await f.read()
    expect(offline.messages).toEqual(before.messages)
    expect(offline.turns).toEqual(before.turns)
    expect(offline.activitySnapshot?.observation).toMatchObject({ status: 'unavailable',
      lastError: expect.stringContaining(failure === 'transport' ? 'transport' : 'WORKER_CONVERSATION_UNAVAILABLE'), consecutiveFailures: 1 })
    const http = await f.app.inject({ method: 'GET', url: `${f.root}?${new URLSearchParams(f.query)}`,
      headers: graphHeaders(f.reader.token) })
    expect(http.statusCode).toBe(200)
    expect(AgentChatStateSchema.parse(http.json()).messages).toEqual(before.messages)
    const address = f.app.server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP listener required')
    const controller = new AbortController()
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}${f.root}/conversations/${f.conversation.id}/events`, {
        headers: graphHeaders(f.reader.token), signal: controller.signal })
      expect(response.status).toBe(200)
      const stream = response.body!.getReader()
      const first = await stream.read()
      const frame = new TextDecoder().decode(first.value)
      expect(frame).toContain('event: snapshot')
      const snapshot = JSON.parse(frame.split('\n').find(line => line.startsWith('data:'))!.slice(5))
      expect(snapshot.data.messages).toEqual(before.messages)
      expect(snapshot.data.activitySnapshot.observation.status).toBe('unavailable')
      await stream.cancel()
    } finally { controller.abort() }
    expect((await f.repository.state(f.conversation.id))?.messages).toEqual(before.messages)
    f.worker.reconnect()
    expect((await f.read()).activitySnapshot?.observation).toMatchObject({ status: 'available',
      consecutiveFailures: 0, lastError: null, lastSuccess: expect.any(String) })
    expect(f.worker.offers).toHaveLength(1)
  } finally { await f.cleanup() }
})

it('releases a settled Worker runtime during graceful Main shutdown while retaining its saved session', async () => {
  const f = await fixture()
  try {
    const before = (await f.worker.journal.conversations.read(f.worker.binding))!
    expect(f.worker.launches).toHaveLength(1)
    expect(f.worker.launches[0]?.lifecycle).toBe('active')
    await f.chat.shutdown()
    const released = (await f.worker.journal.conversations.read(f.worker.binding))!
    expect(released.runtimeReleased).toBe(true)
    expect(released.closed).toBe(false)
    expect(released.session).toEqual(before.session)
    expect(released.turns).toEqual(before.turns)
    expect(f.worker.launches[0]).toMatchObject({ lifecycle: 'closed', closureEvidence: 'native_exit_removed_cgroup' })
    expect((await f.repository.get(f.conversation.id))?.native_session_id).toBe(before.session!.nativeSessionId)
    await f.chat.shutdown()
    expect(f.worker.offers).toHaveLength(1)
  } finally { await f.cleanup() }
})

async function promptly<T>(read: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([read, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Persisted snapshot waited for the stalled Worker')), 2_000)
    })])
  } finally { clearTimeout(timer) }
}

it.each(['pending', 'shared reconnect'] as const)('bounds stalled %s refreshes for persisted MCP, HTTP and SSE snapshots', async blocked => {
  const f = await fixture()
  let controls: Promise<unknown> | undefined
  let controlsFinished = false
  try {
    const before = await f.read()
    if (blocked === 'shared reconnect') {
      const observer = f.worker.observer
      const conversation = before.conversation
      const session = conversation?.nativeSession
      if (!observer || !session || !conversation) throw new Error('The saved native session and its observer are required')
      f.worker.holdReconnect()
      controls = observer.sessionControlCapabilities({ harness: conversation.harness, ...session }).then(
        value => { controlsFinished = true; return { value } }, error => { controlsFinished = true; return { error } })
      await vi.waitFor(() => expect(f.worker.hasReconnectWaiter()).toBe(true))
    } else f.worker.disconnect('stalled')
    const offline = await promptly(f.read())
    expect(offline.messages).toEqual(before.messages)
    expect(offline.activitySnapshot?.observation).toMatchObject({ status: 'unavailable',
      lastError: expect.stringContaining('TimeoutError') })
    const http = await promptly(f.app.inject({ method: 'GET', url: `${f.root}?${new URLSearchParams(f.query)}`,
      headers: graphHeaders(f.reader.token) }))
    expect(http.statusCode).toBe(200)
    expect(AgentChatStateSchema.parse(http.json()).messages).toEqual(before.messages)
    const address = f.app.server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP listener required')
    const controller = new AbortController()
    try {
      const response = await promptly(fetch(`http://127.0.0.1:${address.port}${f.root}/conversations/${f.conversation.id}/events`, {
        headers: graphHeaders(f.reader.token), signal: controller.signal }))
      expect(response.status).toBe(200)
      const stream = response.body!.getReader()
      const first = await promptly(stream.read())
      const frame = new TextDecoder().decode(first.value)
      expect(frame).toContain('event: snapshot')
      const snapshot = JSON.parse(frame.split('\n').find(line => line.startsWith('data:'))!.slice(5))
      expect(snapshot.data.messages).toEqual(before.messages)
      expect(snapshot.data.activitySnapshot.observation.status).toBe('unavailable')
      await stream.cancel()
    } finally { controller.abort() }
    if (controls) expect(controlsFinished).toBe(false)
    f.worker.reconnect()
    if (controls) expect(await controls).toHaveProperty('value')
    expect((await f.read()).activitySnapshot?.observation?.status).toBe('available')
    expect(f.worker.offers).toHaveLength(1)
  } finally { f.worker.reconnect(); await controls; await f.cleanup() }
})

class RecordedNative extends ChatManager {
  disposed = false
  async createSession(): Promise<NativeSessionReference> {
    this.sessions++
    return { harness: this.harness, providerVersion: 'recorded-provider', nativeSessionId: randomUUID() }
  }
  async *startInitialTurn(start: NativeSessionStart, input: NativeInitialTurnInput, signal?: AbortSignal) {
    const session = await this.createSession()
    await input.onSessionObserved(session)
    yield* this.startTurn(session, input, signal)
  }
  async dispose() { this.disposed = true; this.disposals++ }
}

async function replacementFixture() {
  const db = await agent3Database()
  const recorded = workerConversationFixture('agent')
  const seed = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
  seed.configurations = seed.configurations.map(value => AgentConfigurationVersionSchema.parse({ ...value,
    harness: recorded.configuration.harness, harnessProfileSelection: recorded.binding.profile }))
  const seeded = await seedAgent3(db.pool, db.directory, seed, { run: false })
  const node = seeded.version.definition.nodes[0]!
  const configuration = seeded.configurations.find(value => value.agentId === node.agentId)!
  const context = { workspaceId: seeded.scope.workspaceId, workflowId: seeded.scope.workflowId,
    workflowNodeId: node.id, agentId: node.agentId }
  const repository = new PostgresAgentChatRepository(db.pool)
  const messages = new PostgresOperatorConversationRepository(db.pool)
  const access = new PostgresAccessService(db.pool)
  const writer = await access.issue({ name: 'Chat lifecycle owner', audience: 'operator',
    grants: [{ actions: ManagementActionSchema.options, scope: {} }] })
  const reader = await access.issue({ name: 'Chat lifecycle reader', audience: 'operator',
    grants: [{ actions: ['agent_chat:read'], scope: {} }] })
  const commands = new PostgresCommandCoordinator(db.pool)
  const harnesses = new HarnessCatalogService({ qualify: async value => ({ harness: value.harness,
    version: 'recorded-provider', authenticated: true, ready: true, structuredEvents: true, supportsResume: true,
    supportsCancellation: true, supportsWorkingDirectory: true, supportsStartupPrompt: true,
    supportedNativeTools: [], supportedSettings: [], unsupportedCapabilities: [] }) },
  new PostgresSettingsRepository(db.pool), commands, db.directory)
  const agents = new OperatorAgentMutationService(db.pool, commands, harnesses,
    { validateSelection: async () => {} })
  const conversation = await repository.ensureForControls(agentChatKey(context), { context,
    agentConfigurationVersionId: configuration.id, harness: 'codex', origin: { kind: 'fresh' },
    workingDirectory: db.directory, runtimeDirectory: join(db.directory, 'chat') }, async () => {})
  const records: WorkerConversationReceipt[] = []
  const journal = new WorkerConversationJournal({ read: async () => structuredClone(records),
    change: async (_id, apply) => apply(records) }, 16)
  const natives: RecordedNative[] = []
  const workflows = new PostgresWorkflowRepository(db.pool)
  const profiles = { admit: async () => {
    const row = (await repository.get(conversation.id))!
    const selected = (await workflows.getAgentConfiguration(row.agent_configuration_version_id))!
    return { override: { configuration: selected.harness, target: selected.harnessProfileSelection!.target } }
  }, revalidate: async () => {} }
  const production = createProductionWorkerConversations({ pool: db.pool, operators: messages, agents: repository,
    endpoint: () => ({ captureRequest: () => ({ binding: recorded.connection,
      request: async (raw: unknown) => ({ payload: await host.handle(raw, recorded.connection) }) }) }),
    profiles, claudeProfiles: profiles, registry: {}, qualifications: {}, suiteRevisions: {}, access,
    mcpForward: () => ({}),
  } as unknown as Parameters<typeof createProductionWorkerConversations>[0])
  const callbacks = workerConversationCallbacks({ currentBinding: () => recorded.connection,
    capture: () => ({ binding: recorded.connection, request: async (raw, options) => ({
      payload: await production.bridge.handle(raw, recorded.connection, options?.signal ?? AbortSignal.timeout(1000)) }) }) })
  const host = new WorkerConversationHost({ ...callbacks, journal, currentBinding: () => recorded.connection,
    allocate: async (binding, selected) => {
      const native = new RecordedNative(binding.harness as 'codex' | 'claude')
      natives.push(native)
      return { manager: native, start: async options => ({ kind: 'agent-chat', configuration: selected,
        conversationId: conversation.id, workflowId: context.workflowId, workflowNodeId: context.workflowNodeId,
        workingDirectory: binding.workingDirectory, ...options } as NativeSessionStart),
      nativeOwner: async session => ({ sessionId: session.nativeSessionId,
        processIdentityDigest: commandInputHash({ binding, session }).slice('sha256:'.length) }),
      close: async () => native.dispose() }
    },
  })
  // Production composes Worker owners and input preparation the same way.
  const managers: AgentChatManagerFactory = (id, selected, directory, _accountSource, featureContext) => production.create({
    conversationId: id, configuration: selected, workingDirectory: directory, fileInputs: true,
    appMcpAccess: featureContext && conversationChatTools(featureContext).length ? 'scoped' : 'none' })
  managers.prepareInput = prepareAgentChatInput(db.pool)
  managers.closeRecoveredSession = (id, signal) => production.closeConversation(id, signal)
  const createChat = (factory = managers) => new AgentChatService(db.pool, repository, messages,
    new PostgresWorkflowRepository(db.pool), { getForWorkspace: async () => { throw new Error('No Run selection') },
      getExecution: async () => { throw new Error('No execution selection') }, executionPages() { throw new Error('No Run pages') } },
    factory, db.directory)
  let chat = createChat()
  const services = { commands, agentChat: chat, extensions: { agents } }
  const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: services as never } })
  const call = (token: string, name: string, args: Record<string, unknown>) => graphRpc(app, token, 'tools/call', { name, arguments: args })
  const send = async (requestId: string) => {
    const response = await call(writer.token, 'agent_chat_send', { workspaceId: context.workspaceId,
      request: { requestId, content: 'Reply once', intent: 'next_turn', expectedConversationId: conversation.id,
        context: { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId: context.agentId } } })
    expect(response.result?.isError, JSON.stringify(response)).not.toBe(true)
    await waitFor(async () => ['completed', 'failed', 'unknown'].includes((await repository.turn(conversation.id, requestId))?.delivery ?? ''))
    const turn = await repository.turn(conversation.id, requestId)
    expect(turn?.delivery, JSON.stringify(turn)).toBe('completed')
  }
  return { db, recorded, configuration, conversation, context, repository, journal, records, natives, managers,
    createChat, send, call, writer, reader, agentManagement: new AgentManagementService(db.pool), get chat() { return chat },
    async replaceChat(factory: AgentChatManagerFactory) {
      await chat.shutdown()
      chat = createChat(factory)
      services.agentChat = chat
      return chat
    },
    async close() { await chat.shutdown(); await host.shutdown(); await production.close(); await app.close(); await db.close() } }
}

it('starts a replacement Worker session after a harness change and can return to the original harness without replay', async () => {
  const f = await replacementFixture()
  try {
    await f.send('before-change')
    const original = (await f.repository.get(f.conversation.id))!.native_session_id
    const first = structuredClone(f.records[0]!)
    for (const harness of ['claude', 'codex'] as const) {
      const configuration = harness === 'codex' ? f.configuration.harness : { harness: 'claude', model: 'recorded',
        authMode: 'subscription', configDirectory: '/recorded/claude-profile', permissionMode: 'default',
        sandbox: 'danger-full-access', tools: [], permissionRules: [], instructions: '', mcpServers: {} }
      const before = await f.agentManagement.get(f.writer.principal, f.context.workspaceId, f.context.agentId)
      const updated = await f.call(f.writer.token, 'agent_update', { workspaceId: f.context.workspaceId,
        agentId: f.context.agentId, commandId: randomUUID(), expectedRevision: before.metadataRevision,
        expectedConfigurationVersionId: before.agent.configurationVersionId, configuration, harnessProfileSelection: { ...f.recorded.binding.profile,
          target: { ...f.recorded.binding.profile.target, harnessInstallationId: harness } } })
      expect(updated.result?.isError, JSON.stringify(updated)).not.toBe(true)
      if (harness === 'codex') await f.replaceChat(f.managers)
      const requestId = `after-${harness}`
      await f.send(requestId)
      const row = (await f.repository.get(f.conversation.id))!
      expect(row.native_session_id).not.toBe(original)
      expect(row.harness).toBe(harness)
      expect(f.natives.at(-2)!.disposed).toBe(true)
    }
    expect(f.natives.map(native => native.sessions)).toEqual([1, 1, 1])
    expect(f.natives.map(native => native.turns)).toEqual([1, 1, 1])
    expect((await f.journal.read(first.binding))?.turns).toEqual(first.turns)
    expect((await f.journal.read(first.binding))?.closed).toBe(true)
    const denied = await f.call(f.reader.token, 'agent_chat_send', { workspaceId: f.context.workspaceId,
      request: { requestId: 'denied', content: 'No input', intent: 'next_turn', expectedConversationId: f.conversation.id,
        context: { workflowId: f.context.workflowId, workflowNodeId: f.context.workflowNodeId, agentId: f.context.agentId } } })
    expect(denied.error || denied.result?.isError).toBeTruthy()
    expect(f.natives).toHaveLength(3)
  } finally { await f.close() }
})

it('disposes a released Agent runtime and attaches the persisted session for the following turn', async () => {
  const f = await replacementFixture()
  const managers: RecordedNative[] = []
  try {
    const factory: AgentChatManagerFactory = () => {
      const native = Object.assign(new RecordedNative(), { retireTurn: async () => ({ runtimeReleased: true as const }) })
      const start = native.startTurn.bind(native)
      native.startTurn = async function* (...args) {
        if (native.disposed) throw new Error('Released native runtime cannot receive another turn')
        yield* start(...args)
      }
      managers.push(native)
      return native
    }
    const chat = await f.replaceChat(factory)
    for (const requestId of ['released', 'following']) {
      await chat.send(f.writer.principal, f.context.workspaceId, { requestId, content: 'Reply once', intent: 'next_turn',
        expectedConversationId: f.conversation.id,
        context: { workflowId: f.context.workflowId, workflowNodeId: f.context.workflowNodeId, agentId: f.context.agentId } })
      await waitFor(async () => ['completed', 'failed', 'unknown'].includes((await f.repository.turn(f.conversation.id, requestId))?.delivery ?? ''))
      expect((await f.repository.turn(f.conversation.id, requestId))?.delivery).toBe('completed')
    }
    expect(managers).toHaveLength(2)
    expect(managers[0]!.disposed).toBe(true)
    expect(managers.map(native => native.sessions)).toEqual([1, 0])
    expect(managers.map(native => native.attachments)).toEqual([0, 1])
    expect(managers.map(native => native.turns)).toEqual([1, 1])
  } finally { await f.close() }
})
