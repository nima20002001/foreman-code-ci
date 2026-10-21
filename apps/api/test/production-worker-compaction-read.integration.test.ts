import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  AgentConfigurationVersionSchema, SessionControlStateSchema, unavailableSessionControls,
} from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { WorkerConversationBindingSchema, type WorkerConversationReceipt,
  type WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import { loadConfig } from '../src/config.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { buildProductionApp } from '../src/production.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { agentChatKey, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { SessionControlStore } from '../src/modules/conversations/sessionControls/store.js'
import { WorkerConversationHost } from '../src/modules/conversations/workerHost.js'
import { WorkerConversationJournal } from '../src/modules/conversations/workerJournal.js'
import { workerConversationFixture } from '../src/modules/conversations/workerFixtures.test-support.js'
import { ProductionDeviceRuntime } from '../src/modules/devices/productionRuntime.js'
import type { DeviceEndpoint } from '../src/modules/devices/deviceEndpoint.js'
import { DomainError } from '../src/modules/errors.js'
import { legacyProviderAccountBinding } from '../src/modules/provider-accounts/acceptedBindings.js'
import type { NativeCompactInput, NativeSessionStart } from '../src/modules/harnesses/port.js'
import { agent3Database, seedAgent3 } from './helpers/wave25Agent3.js'
import { ChatManager } from './helpers/operatorChatFixture.js'
import { graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { productionClaudeFixture } from './support/claudeProduction.js'

it.each(['completed', 'failed'] as const)(
  'reads uncertain then %s Worker compaction through production without releasing its native owner', async status => {
    const db = await agent3Database()
    const f = workerConversationFixture('agent', 'claude')
    const definition = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
    definition.configurations = definition.configurations.map(value => AgentConfigurationVersionSchema.parse({ ...value,
      harness: f.configuration.harness, harnessProfileSelection: f.binding.profile }))
    const config = loadConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL! })
    config.harnesses.workspaceRoot = join(db.directory, 'runtime')
    const checkpoints = createCheckpointStore(config.database.connectionString, 'compaction_read', config.database)
    let production: ReturnType<typeof buildProductionApp> | undefined
    let host: WorkerConversationHost | undefined
    let nativeProfile: ReturnType<typeof productionClaudeFixture> | undefined
    try {
      const seeded = await seedAgent3(db.pool, db.directory, definition, { run: false })
      const node = seeded.version.definition.nodes[0]!
      const configuration = seeded.configurations.find(value => value.agentId === node.agentId)!
      const context = { workspaceId: configuration.workspaceId, workflowId: seeded.scope.workflowId,
        workflowNodeId: node.id, agentId: node.agentId }
      const repository = new PostgresAgentChatRepository(db.pool)
      const conversation = await repository.ensureForControls(agentChatKey(context), { context,
        agentConfigurationVersionId: configuration.id, harness: 'claude', origin: { kind: 'fresh' },
        workingDirectory: db.directory, runtimeDirectory: join(db.directory, 'chat') }, async () => {})
      await repository.bindSession(conversation.id, f.session.providerVersion, f.session.nativeSessionId)
      const binding = WorkerConversationBindingSchema.parse({ ...f.binding, workingDirectory: db.directory,
        accountBinding: legacyProviderAccountBinding(configuration.harness, configuration.harnessProfileSelection),
        owner: { kind: 'agent', conversationId: conversation.id, workspaceId: context.workspaceId,
          workflowId: context.workflowId, workflowNodeId: node.id, agentId: node.agentId,
          configurationVersionId: configuration.id, configurationHash: commandInputHash(configuration) } })
      await db.pool.query('update operator_conversations set worker_conversation_binding=$2::jsonb where id=$1',
        [conversation.id, JSON.stringify(binding)])
      const records: WorkerConversationReceipt[] = []
      const journal = new WorkerConversationJournal({ read: async () => structuredClone(records),
        change: async (_id, apply) => structuredClone(apply(records)) }, 8)
      await journal.receive(binding, f.connection)
      await journal.reserveCreation(binding, 'seed-session', commandInputHash('seed-session'))
      await journal.bindSession(binding, f.session, f.nativeOwner)
      const requestId = randomUUID()
      const reserved = await journal.reserveCompact(binding, requestId, commandInputHash(requestId))
      const uncertain = await journal.compactProgress(binding, { ...reserved.state,
        status: 'uncertain', dispatchPhase: 'dispatched', message: 'Native completion is unconfirmed.' })
      const access = new PostgresAccessService(db.pool)
      const writer = await access.issue({ name: 'Compaction sender', audience: 'operator',
        grants: [{ actions: ['agent_chat:read', 'agent_chat:write'], scope: {} }] })
      const reader = await access.issue({ name: 'Compaction reader', audience: 'operator',
        grants: [{ actions: ['agent_chat:read'], scope: {} }] })
      const denied = await access.issue({ name: 'Unrelated reader', audience: 'operator',
        grants: [{ actions: ['agent_chat:read'], scope: { workspaceIds: ['another-workspace'] } }] })
      const capabilities = { ...unavailableSessionControls('fixture'), compact: { supported: true, reason: null } }
      const provider = Object.assign(new ChatManager('claude'), {
        sessionControlCapabilities: async () => capabilities,
        compactSession: async (_session: unknown, input: NativeCompactInput) => {
          await input.onDispatch?.()
          return uncertain
        },
      })
      const store = new SessionControlStore(db.pool, 'agent')
      const controls = { conversationId: conversation.id, principalId: writer.principal.id,
        profileKey: configuration.id, defaultSubject: `${context.workspaceId}:${context.agentId}`,
        busyReason: null, manager: provider, session: f.session }
      const initial = await store.read(controls)
      await store.execute(writer.principal, 'mcp', { kind: 'compact', requestId, expectedRevision: initial.revision },
        async () => controls)
      const start: NativeSessionStart = { kind: 'agent-chat', configuration, conversationId: conversation.id,
        workflowId: context.workflowId, workflowNodeId: node.id, correlationId: 'cold-read', workingDirectory: db.directory }
      // Only installed profile metadata and the paired transport are synthetic.
      nativeProfile = productionClaudeFixture('agent', undefined, undefined, undefined, {
        database: db.pool, binding: { kind: 'agent', workspaceId: context.workspaceId,
          conversationId: conversation.id, repository }, start,
        sdk: {
          sdkVersion: 'fixture',
          query: () => { throw new Error('Cold read started an SDK query') },
          getSessionInfo: async () => { throw new Error('Cold read inspected a Main session') },
          getSessionMessages: async () => { throw new Error('Cold read inspected Main history') },
          forkSession: async () => { throw new Error('Cold read forked a native session') },
        },
      })
      let terminal = false
      let failRead = false
      let failStatus = false
      let allocations = 0
      const methods: WorkerConversationRpcRequest['method'][] = []
      host = new WorkerConversationHost({ journal, currentBinding: () => f.connection,
        authorize: async (_request, _connection, signal) => { signal.throwIfAborted() },
        observeSession: async () => { throw new Error('Cold read created a native session') },
        observeSubmission: async () => { throw new Error('Cold read submitted native input') },
        allocate: async () => { allocations++; throw new Error('Cold read opened a native writer') },
        readCompaction: async request => {
          if (failRead) throw new DomainError('COMPACTION_READ_FAILED', 'Native history unavailable.', 409)
          return terminal ? { ...request.state, status, message: `Compaction ${status}.` } : request.state
        } })
      const channel = { binding: f.connection, request: async (raw: unknown, options?: { signal?: AbortSignal }) => {
        const request = raw as WorkerConversationRpcRequest
        methods.push(request.method)
        if (failStatus && request.method === 'conversation.status') {
          throw new DomainError('COMPACTION_STATUS_FAILED', 'Worker status unavailable.', 409)
        }
        return { payload: await host!.handle(raw, f.connection, options?.signal) }
      } }
      vi.spyOn(ProductionDeviceRuntime.prototype, 'endpointForDomains').mockReturnValue({
        captureRequest: () => channel,
      } as unknown as DeviceEndpoint)
      production = buildProductionApp(config, { pool: db.pool, ping: async () => {}, migrate: async () => {},
        close: async () => {} }, checkpoints, false, undefined, undefined, undefined,
      { mode: 'native', claudeProfiles: nativeProfile.profiles })
      const target = { workspaceId: context.workspaceId, conversationId: conversation.id }
      const mcp = (token: string) => graphRpc(production!.app, token, 'tools/call', {
        name: 'agent_chat_controls_get', arguments: target })
      const pending = await mcp(reader.token)
      expect(pending.result?.isError, JSON.stringify(pending)).not.toBe(true)
      expect(methods).toContain('conversation.compact-read')
      expect(SessionControlStateSchema.parse(graphRpcValue(pending.result)).compaction)
        .toMatchObject({ requestId, status: 'uncertain' })
      failRead = true
      const failed = await mcp(reader.token)
      expect(graphRpcValue(failed.result)).toMatchObject({ error: { code: 'COMPACTION_READ_FAILED' } })
      failRead = false
      failStatus = true
      const unavailable = await mcp(reader.token)
      expect(graphRpcValue(unavailable.result)).toMatchObject({ error: { code: 'COMPACTION_STATUS_FAILED' } })
      failStatus = false
      const refused = await mcp(denied.token)
      expect(refused.error || refused.result?.isError).toBeTruthy()
      const write = await graphRpc(production.app, reader.token, 'tools/call', {
        name: 'agent_chat_controls_update', arguments: { ...target,
          request: { kind: 'compact', requestId: randomUUID(), expectedRevision: initial.revision } } })
      expect(write.error || write.result?.isError).toBeTruthy()
      expect((await journal.read(binding))?.compactions[0]?.state.status).toBe('uncertain')
      terminal = true
      const observed = await mcp(reader.token)
      expect(observed.result?.isError, JSON.stringify(observed)).not.toBe(true)
      expect(SessionControlStateSchema.parse(graphRpcValue(observed.result)).compaction)
        .toMatchObject({ requestId, status, principalId: writer.principal.id })
      const http = await production.app.inject({ method: 'GET',
        url: `/api/workspaces/${context.workspaceId}/agent-chat/conversations/${conversation.id}/session-controls`,
        headers: { authorization: `Bearer ${reader.token}` } })
      expect(http.statusCode, http.body).toBe(200)
      expect(SessionControlStateSchema.parse(http.json()).compaction).toMatchObject({ requestId, status })
      expect(methods).not.toContain('conversation.release-runtime')
      expect(methods).not.toContain('conversation.open')
      expect(allocations).toBe(0)
      expect(await journal.read(binding)).toMatchObject({ session: f.session, nativeOwner: f.nativeOwner,
        closed: false, turns: [], compactions: [{ state: { requestId, status } }] })
      expect((await journal.read(binding))?.runtimeReleased).not.toBe(true)
    } finally {
      await production?.app.close()
      await nativeProfile?.manager.dispose?.()
      await host?.shutdown()
      vi.restoreAllMocks()
      await checkpoints.close()
      await db.close()
    }
  })
