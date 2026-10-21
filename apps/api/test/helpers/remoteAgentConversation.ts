import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { z } from 'zod'
import { AgentConfigurationVersionSchema, HarnessExecutionSchema, withAdvancedDefaults, type AgentConfigurationVersion } from '@foreman-code/contracts'
import { runChatStorageKey } from '../../src/modules/conversations/selectedRunChat.js'
import { createTestPool } from './testPool.mjs'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { AgentFileReadResultSchema, FileWithRevisionSchema, type MessageAttachmentRef } from '@foreman-code/contracts/files'
import { AcceptedWorkflowRunV3Schema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { WorkerConversationBindingSchema, WorkerConversationRpcRequestSchema,
  type WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import { buildApp } from '../../src/app.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { AgentChatService } from '../../src/modules/conversations/agentChat.js'
import { agentChatKey, PostgresAgentChatRepository } from '../../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../../src/modules/conversations/operatorChatRepository.js'
import { qualifiedAgentChatSteer } from '../../src/modules/conversations/chatSteerQualification.js'
import type { ConversationFeatureContext } from '../../src/modules/conversations/conversationFeatureSubject.js'
import { prepareAgentChatInput } from '../../src/modules/collaboration/chatInputPreparation.js'
import { conversationChatTools } from '../../src/modules/access/conversationCredentials.js'
import { createProductionWorkerConversations } from '../../src/modules/conversations/workerProduction.js'
import { workerConversationFixture } from '../../src/modules/conversations/workerFixtures.test-support.js'
import { workerConversationCallbacks } from '../../src/modules/conversations/workerCallbacks.js'
import { WorkerConversationFiles } from '../../src/modules/conversations/workerFiles.js'
import { WorkerConversationHost } from '../../src/modules/conversations/workerHost.js'
import { RemoteOperationJournal } from '../../src/modules/runs/remote/operationJournal.js'
import { PostgresWorkflowRepository } from '../../src/modules/workflows/postgres.js'
import { OperatorAgentMutationService, readAgentForReuse } from '../../src/modules/workspaces/operatorAgents.js'
import { localCodexChatHost } from '../../src/modules/harnesses/codexFiles/localHost.js'
import { postgresCodexChatFiles } from '../../src/modules/harnesses/codexFiles/chatAdmission.js'
import { productionCodexChatFiles } from '../../src/modules/harnesses/codexFiles/production.js'
import { registerProductionFileStorage } from '../../src/modules/files/production.js'
import { productionFileTools } from '../../src/modules/files/tools/production.js'
import type { ApiConfig } from '../../src/config.js'
import { withTransaction } from '../../src/infrastructure/transaction.js'
import { requireAuthorization } from '../../src/modules/access/policy.js'
import { HarnessInstanceSettingsRepository } from '../../src/modules/harnesses/instanceSettings/repository.js'
import { HostHarnessOverrideService } from '../../src/modules/harnesses/instanceSettings/service.js'
import { graphHeaders, graphRpc, graphRpcValue } from '../eng04-graph-composition-fixture.js'
import { agent3Database, seedAgent3 } from './wave25Agent3.js'
import { remoteChatProvider } from './remoteChatProvider.js'
import { deferred } from './deferred.js'
import { recordedConversationRuntime } from './recordedConversationRuntime.js'
import { DomainError } from '../../src/modules/errors.js'

export async function remoteAgentConversation(harness: 'codex' | 'claude', location: 'worker' | 'main' = 'worker',
  options: { runAttempts?: number; poolSize?: number; sessionObservationDelayMs?: number } = {}) {
  const db = await agent3Database()
  const recorded = workerConversationFixture('agent', harness)
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
  fixture.configurations = fixture.configurations.map(value => AgentConfigurationVersionSchema.parse({ ...value,
    harness: { ...recorded.configuration.harness, model: 'test-model',
      ...(harness === 'claude' ? { configDirectory: join(db.directory, 'claude-profile') } : {}) },
    ...(location === 'worker' ? { harnessProfileSelection: recorded.binding.profile } : {}) }))
  const seeded = await seedAgent3(db.pool, db.directory, fixture, { run: !!options.runAttempts })
  const sourceRun = options.runAttempts ? AcceptedWorkflowRunV3Schema.parse({ ...seeded.run,
    executionState: 'completed', outcome: 'succeeded', result: { outcome: 'succeeded', output: {} },
    finishedAt: seeded.createdAt }) : undefined
  const constrainedPool = options.poolSize ? createTestPool({ connectionString: db.databaseUrl,
    max: options.poolSize, connectionTimeoutMillis: 1000,
    options: '-c statement_timeout=10000 -c lock_timeout=5000' }) : undefined
  if (constrainedPool) db.pool = constrainedPool
  const node = seeded.version.definition.nodes[0]!
  const configuration = seeded.configurations.find(value => value.agentId === node.agentId)!
  if (configuration.harness.harness === 'opencode') throw new Error('Supported chat harness required')
  const context = { workspaceId: configuration.workspaceId, workflowId: seeded.scope.workflowId,
    workflowNodeId: node.id, agentId: configuration.agentId, ...(options.runAttempts ? { runId: seeded.run.id } : {}) }
  const executions = Array.from({ length: options.runAttempts ?? 0 }, (_, index) => HarnessExecutionSchema.parse({
    id: randomUUID(), runId: seeded.run.id, workflowNodeId: node.id, agentId: configuration.agentId,
    agentConfigurationVersionId: configuration.id, attempt: index + 1, state: 'completed',
    input: {}, nativeSessionId: `run-session-${randomUUID()}`, workingDirectory: db.directory,
    createdAt: seeded.createdAt, startedAt: seeded.createdAt, finishedAt: seeded.createdAt,
    result: { outcome: 'succeeded' },
  }))
  for (const source of executions) {
    await db.pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
      values($1,$2,$3,$4,$5,$6::jsonb)`,
    [source.id,source.runId,source.workflowNodeId,source.agentId,source.attempt,JSON.stringify(source)])
  }
  const access = new PostgresAccessService(db.pool)
  const writer = await access.issue({ name: 'Remote chat writer', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ManagementActionSchema.options, scope: {} }] })
  const reader = await access.issue({ name: 'Remote chat reader', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000),
    grants: [{ actions: ['agent_chat:read', 'agents:read'], scope: {} }] })
  const repository = new PostgresAgentChatRepository(db.pool)
  const workflows = new PostgresWorkflowRepository(db.pool)
  const messages = new PostgresOperatorConversationRepository(db.pool)
  const execution = executions[0]
  const conversation = await repository.ensureForControls(execution ? runChatStorageKey(context, execution.id) : agentChatKey(context), { context,
    agentConfigurationVersionId: configuration.id, harness, origin: execution
      ? { kind: 'run_execution', runId: execution.runId, executionId: execution.id, sourceNativeSessionId: execution.nativeSessionId! }
      : { kind: 'fresh' },
    workingDirectory: db.directory, runtimeDirectory: join(db.directory, 'chat') }, async () => {})
  const journal = await RemoteOperationJournal.open(join(db.directory, 'worker-operations.json'),
    { initializeNewInstallation: true })
  const frames: WorkerConversationRpcRequest[] = []
  let connection = recorded.connection
  const callbacks = workerConversationCallbacks({ currentBinding: () => connection,
    capture: () => ({ binding: connection, request: async (payload, requestOptions) => {
      // A slow callback channel delivers the Worker's session observation to Main after later reads.
      if (options.sessionObservationDelayMs && (payload as { method?: string }).method === 'conversation.session-observed') {
        await new Promise(resolve => setTimeout(resolve, options.sessionObservationDelayMs))
      }
      return { payload: await workerChats.bridge.handle(payload, connection,
        requestOptions?.signal ?? AbortSignal.timeout(10_000)) }
    } }) })
  const lifetime = new AbortController()
  const workerFiles = new WorkerConversationFiles(callbacks)
  let source: WorkerConversationRpcRequest
  let attached: MessageAttachmentRef | undefined
  const receivedAttachments: string[] = []
  const provider = await remoteChatProvider(harness, db.directory, {
    ...(location === 'worker' ? { codexFiles: workerFiles.adapter({ source: () => source,
      host: () => localCodexChatHost(join(db.directory, 'worker-copies')),
      assertCurrent: async () => {}, signal: lifetime.signal }) } : {}),
    codexInput: async input => {
      for (const item of input as Array<{ type: string; text?: string }>) {
        for (const line of (item.text ?? '').split('\n').filter(line => line.startsWith('{"filename"'))) {
          const copy = JSON.parse(line) as { path: string }
          receivedAttachments.push(await readFile(copy.path, 'utf8'))
        }
      }
    },
    claudeMessage: async (sessionId, messageId) => {
      if (!attached) return
      const request = source
      if (request.method !== 'conversation.initial-turn' && request.method !== 'conversation.start-turn') {
        throw new Error('An admitted Claude message is required')
      }
      const admission = z.object({ ownerPrincipalId: z.string(), attemptId: z.string() }).parse(
        await callbacks.claudeAuthority(request, { phase: 'admission' }, lifetime.signal))
      await vi.waitFor(async () => {
        const current = (await repository.get(conversation.id))!
        const turn = await repository.turn(conversation.id, current.active_request_id!)
        expect(turn?.nativeSubmission?.nativeMessageId).toBe(messageId)
      }, { timeout: 5000 })
      const result = AgentFileReadResultSchema.parse(await callbacks.claudeAuthority(request, {
        phase: 'file', identity: { ...admission, nativeSessionId: sessionId, nativeMessageId: messageId,
          clientCorrelationId: request.correlationId, generation: 'recorded-query', toolUseId: randomUUID() },
        operation: 'files.read', args: attached,
      }, lifetime.signal))
      if (result.status !== 'ready') throw new Error('The remote attachment must be readable')
      receivedAttachments.push(Buffer.from(result.contentBase64, 'base64').toString('utf8'))
    },
  })
  const providers = [provider]
  const providersByConversation = new Map([[conversation.id, provider]])
  const nativeManagers = new Map([[conversation.id, provider.manager]])
  const providerSources = new Map([[conversation.id, { provider, harness, accountId: configuration.harness.accountId }]])
  const nativeManager = async (conversationId: string, selected = configuration) => {
    if (selected.harness.harness === 'opencode') throw new Error('Supported chat harness required')
    const existing = nativeManagers.get(conversationId)
    if (existing) return existing
    const previous = providerSources.get(conversationId)
    if (previous?.harness === selected.harness.harness && previous.accountId === selected.harness.accountId) {
      const manager = previous.provider.createManager()
      nativeManagers.set(conversationId, manager)
      return manager
    }
    const created = await remoteChatProvider(selected.harness.harness, db.directory)
    providers.push(created)
    providerSources.set(conversationId, { provider: created, harness: selected.harness.harness,
      accountId: selected.harness.accountId })
    providersByConversation.set(conversationId, created)
    nativeManagers.set(conversationId, created.manager)
    return created.manager
  }
  const prepareProvider = async (conversationId: string) => {
    await nativeManager(conversationId)
    return providersByConversation.get(conversationId)!
  }
  const createHost = () => new WorkerConversationHost({ ...callbacks, currentBinding: () => connection,
    journal: journal.conversations, authorize: callbacks.authorize,
    ...recordedConversationRuntime({ connection, journal: journal.conversations,
      authorize: callbacks.authorize,
      manager: async (binding, accepted) => {
        if (!('agentId' in accepted)) throw new Error('Agent configuration required')
        return nativeManager(binding.owner.conversationId, accepted)
      }, released: id => { nativeManagers.delete(id) },
    }) })
  let host = createHost()
  const createChannel = () => ({ binding: connection, request: async (raw: unknown) => {
    const request = WorkerConversationRpcRequestSchema.parse(raw)
    frames.push(request)
    if (request.method === 'conversation.file-copy') return { payload: await workerFiles.copy(request, lifetime.signal) }
    if (request.method === 'conversation.initial-turn' || request.method === 'conversation.start-turn') source = request
    return { payload: await host.handle(request, connection) }
  } })
  let channel = createChannel()
  let profileRevision = 0
  const profiles = { admit: async () => {
    const current = (await repository.get(conversation.id))!
    const selected = (await workflows.getAgentConfiguration(current.agent_configuration_version_id))!
    return { override: { configuration: selected.harness, target: recorded.binding.profile.target }, profileRevision }
  }, revalidate: async (_owner: unknown, accepted: { profileRevision: number }) => {
    if (accepted.profileRevision !== profileRevision) {
      throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'The recorded harness profile changed.', 409)
    }
  } }
  // Installed-profile qualification is a fixture boundary; conversation authorization and persistence are real.
  const workerChats = createProductionWorkerConversations({ pool: db.pool,
    endpoint: () => ({ captureRequest: () => channel }), profiles, claudeProfiles: profiles,
    operators: messages, agents: repository, registry: {}, qualifications: {},
    suiteRevisions: {}, access, mcpForward: () => ({}),
    fileService: () => productionFileTools(app),
    files: (conversationId: string) =>
      async ({ host: fileHost, assertHost, ...turn }: Parameters<import('../../src/modules/conversations/mainWorkerFiles.js').PrepareWorkerFiles>[0]) => {
        const admissions = postgresCodexChatFiles(db.pool, () => storage, async () => fileHost,
          { assertCurrent: assertHost })
        return productionCodexChatFiles(() => app, conversationId, admissions).prepare(turn)
      },
  } as unknown as Parameters<typeof createProductionWorkerConversations>[0])
  // Production composes Worker owners, input preparation and steering qualification the same way.
  const managers = Object.assign((conversationId: string, selected: AgentConfigurationVersion, workingDirectory: string,
    _accountSource?: unknown, featureContext?: ConversationFeatureContext) =>
    location === 'main' ? nativeManager(conversationId)
      : workerChats.create({ conversationId, configuration: selected, workingDirectory, fileInputs: true,
        appMcpAccess: featureContext && conversationChatTools(featureContext).length ? 'scoped' : 'none' }),
  { closeRetainedSession: workerChats.closeRetainedSession, prepareInput: prepareAgentChatInput(db.pool),
    qualifiedSteer: qualifiedAgentChatSteer })
  const createChat = () => new AgentChatService(db.pool, repository, messages, workflows, {
    getForWorkspace: async (workspaceId, runId) => {
      if (!options.runAttempts) throw new Error('Fresh Agent chat must not select a Run')
      return workspaceId === context.workspaceId && runId === seeded.run.id
        ? sourceRun : undefined
    },
    getExecution: async id => {
      if (!options.runAttempts) throw new Error('Fresh Agent chat must not select an execution')
      return executions.find(item => item.id === id)
    },
    async *executionPages(runId) {
      if (!options.runAttempts) throw new Error('Fresh Agent chat must not select an execution')
      if (runId === seeded.run.id) yield executions
    },
  }, managers, db.directory)

  let chat = createChat()
  const commands = new PostgresCommandCoordinator(db.pool)
  const profileRepository = new HarnessInstanceSettingsRepository(db.pool)
  const profileService = new HostHarnessOverrideService(profileRepository, commands, {
    // Physical installation admission is recorded; the actual profile/configuration validator remains active.
    authorize: async (principal, action) => { requireAuthorization(principal, action) },
  }, async () => null)
  const saveProfile = async (selected: AgentConfigurationVersion['harness']) => withTransaction(db.pool, async client => {
    const original = await profileRepository.latest(client, recorded.binding.profile.instanceId)
    const previous = original?.driverId === selected.harness ? original : undefined
    const instanceId = original && !previous ? randomUUID() : recorded.binding.profile.instanceId
    return profileRepository.append(client, writer.principal.id, previous?.revision ?? 0, {
      instanceId, instanceRevision: previous ? String(previous.revision + 1)
        : recorded.binding.profile.instanceRevision, revision: (previous?.revision ?? 0) + 1,
      target: recorded.binding.profile.target, presetId: 'recorded', enabled: true, driverId: selected.harness,
      configuration: withAdvancedDefaults(selected), configurationFingerprint: commandInputHash(withAdvancedDefaults(selected)),
      qualification: 'unqualified',
    })
  }).then(saved => { profileRevision++; return saved })
  await saveProfile(configuration.harness)
  const agents = new OperatorAgentMutationService(db.pool, commands, {
    qualifyConfiguration: async selected => ({ harness: selected.harness, version: 'recorded',
      authenticated: true, ready: true, structuredEvents: true, supportsResume: true,
      supportsCancellation: true, supportsWorkingDirectory: true, supportsStartupPrompt: true,
      supportedNativeTools: [], supportedSettings: [], unsupportedCapabilities: [] }),
  }, profileService)
  const createApp = () => buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { agentChat: chat, commands, extensions: { agents } } as never } })
  let app = createApp()
  const registerStorage = () => registerProductionFileStorage(app, db.pool, {
    fileStorageRoot: join(db.directory, 'vault'), workspaceStorageRoot: join(db.directory, 'workspaces'),
    harnesses: { workspaceRoot: join(db.directory, 'runtime') },
  } as ApiConfig)
  let storage = registerStorage()
  const call = async (name: string, args: Record<string, unknown>, token = writer.token) =>
    graphRpc(app, token, 'tools/call', { name, arguments: { workspaceId: context.workspaceId, ...args } }, randomUUID())
  const value = async (name: string, args: Record<string, unknown>) => {
    const response = await call(name, args)
    expect(response.result?.isError, JSON.stringify(response)).not.toBe(true)
    expect(response.error, JSON.stringify(response)).toBeUndefined()
    return graphRpcValue(response.result)
  }
  const send = async (content: string, delivery: 'completed' | 'failed' = 'completed',
    attachments: MessageAttachmentRef[] = [], conversationId = conversation.id) => {
    const requestId = randomUUID()
    const terminal = deferred()
    const events: Parameters<Parameters<typeof chat.events.subscribe>[1]>[0][] = []
    const unsubscribe = chat.events.subscribe(conversationId, event => {
      events.push(event)
      if (event.data.requestId === requestId && ['completed', 'failed', 'canceled'].includes(String(event.data.delivery))) {
        terminal.resolve()
      }
    })
    try {
      await value('agent_chat_send', { request: { requestId, content, intent: 'next_turn',
        expectedConversationId: conversationId, context, attachments } })
      await terminal.promise
      await host.drainForUpdate()
      const turn = await repository.turn(conversationId, requestId)
      expect(turn?.delivery, JSON.stringify(turn)).toBe(delivery)
      return { requestId, turn, events }
    } finally { unsubscribe() }
  }
  return { db, provider, providers, prepareProvider, executions, configuration, context, conversation, repository, frames,
    get chat() { return chat }, get app() { return app },
    get workerConnection() { return connection },
    journal, writer, reader, call, value, send, receivedAttachments,
    drainWorker: () => host.drainForUpdate(),
    async restartMain() {
      await host.drainForUpdate()
      await chat.shutdown()
      await app.close()
      chat = createChat()
      app = createApp()
      storage = registerStorage()
    },
    async restartWorker() {
      await host.shutdown()
      connection = { ...connection, bootId: randomUUID(), connectionEpoch: randomUUID(),
        connectionGeneration: connection.connectionGeneration + 1 }
      host = createHost()
      channel = createChannel()
    },
    async chatConfiguration() {
      const row = (await repository.get(conversation.id))!
      return workflows.getAgentConfiguration(row.agent_configuration_version_id)
    },
    async snapshot() {
      const row = (await repository.get(conversation.id))!
      const native = row.native_session_id && row.provider_version ? await provider.manager.history({
        harness: row.harness, nativeSessionId: row.native_session_id, providerVersion: row.provider_version,
      }) : undefined
      const binding = (await db.pool.query<{ worker_conversation_binding: unknown }>(
        'select worker_conversation_binding from operator_conversations where id=$1', [conversation.id])).rows[0]!
      const record = binding.worker_conversation_binding ? await journal.conversations.read(
        WorkerConversationBindingSchema.parse(binding.worker_conversation_binding)) : undefined
      return { requestId: row.active_request_id, nativeTurnId: row.active_native_turn_id,
        turnState: row.turn_state, nativeCalls: provider.calls, modes: provider.modes,
        frames: frames.map(frame => ({ method: frame.method,
          correlationId: 'correlationId' in frame ? frame.correlationId : undefined })),
        workerTurns: record?.turns, nativeEvents: native?.events.map(event => ({ type: event.type, payload: event.payload })) }
    },
    async binding() {
      const row = (await db.pool.query<{ worker_conversation_binding: unknown }>(
        'select worker_conversation_binding from operator_conversations where id=$1', [conversation.id])).rows[0]!
      return WorkerConversationBindingSchema.parse(row.worker_conversation_binding)
    },
    async upload(bytes: Buffer) {
      const requestId = randomUUID()
      const url = `/api/workspaces/${context.workspaceId}/agent-chat/conversations/${conversation.id}/files/uploads`
      const headers = graphHeaders(writer.token)
      const allocation = await app.inject({ method: 'POST', url, headers, payload: {
        requestId, filename: 'attached.md', mediaType: 'text/markdown', byteSize: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      } })
      expect(allocation.statusCode, allocation.body).toBe(201)
      const uploaded = await app.inject({ method: 'PUT', url: `${url}/${requestId}`,
        headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: bytes })
      expect(uploaded.statusCode, uploaded.body).toBe(200)
      const finalized = await app.inject({ method: 'POST', url: `${url}/${requestId}/finalize`, headers, payload: {} })
      expect(finalized.statusCode, finalized.body).toBe(200)
      const file = FileWithRevisionSchema.parse(finalized.json().value)
      attached = { fileId: file.file.fileId, revisionId: file.revision.revisionId }
      return attached
    },
    async update(configuration: AgentConfigurationVersion['harness'], options: { matchingProfile?: boolean } = {}) {
      const current = await withTransaction(db.pool, client =>
        readAgentForReuse(client, writer.principal, context.workspaceId, context.agentId))
      const selected = options.matchingProfile ? await saveProfile(configuration) : undefined
      return value('agent_update', { agentId: context.agentId, commandId: randomUUID(), configuration,
        expectedRevision: current.baseRevision, expectedConfigurationVersionId: current.agent.configurationVersionId,
        ...(selected ? { harnessProfileSelection: { instanceId: selected.instanceId,
          instanceRevision: selected.instanceRevision, target: selected.target } } : {}) })
    },
    async close() {
      provider.releaseReply()
      try { await chat.shutdown() }
      finally {
        try {
          await workerChats.close(); await host.shutdown()
          for (const current of providers) await current.manager.dispose?.()
          lifetime.abort(); await workerFiles.close(); await journal.close()
        }
        finally {
          try { await app.close() }
          finally {
            try { await constrainedPool?.end() }
            finally { await db.close() }
          }
        }
      }
    } }
}
