import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach } from 'vitest'
import { AgentConfigurationVersionSchema, DEFAULT_HARNESS_DEFAULTS, operatorChatSettings, type OperatorConversationState } from '@foreman-code/contracts'
import type { AgentChatState, SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { AgentChatService, type AgentChatManagerFactory } from '../src/modules/conversations/agentChat.js'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { OperatorChatService, type OperatorChatAuthority, type NativeManagerResolver } from '../src/modules/conversations/operatorChat.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { createAdmittedNativeManager } from '../src/modules/harnesses/admittedManager.js'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import type { CodexChatFiles } from '../src/modules/harnesses/codexFiles/runtime.js'
import { CodexStdioTransport } from '../src/modules/harnesses/codexStdioTransport.js'
import { agent3Database, seedAgent3 } from './helpers/wave25Agent3.js'
import { deliveryFixture } from './fixtures/codex-delivery.js'
import { until } from './fixtures/codex-test-helpers.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'

export function useCodexChatDelivery(options: { manualLateReplies?: boolean } = {}) {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let native: Awaited<ReturnType<typeof deliveryFixture>>
  let agentChat: AgentChatService
  let operatorChat: OperatorChatService
  let repository: PostgresAgentChatRepository
  let messages: PostgresOperatorConversationRepository
  let app: ReturnType<typeof buildApp>
  let writer: Client
  let denied: Client
  let reader: Client
  let writerToken: string
  let readerToken: string
  let access: PostgresAccessService
  let context: SendAgentChatMessageRequest['context']
  let workspaceId: string
  let operatorFiles: CodexChatFiles | undefined
  let agentFiles: CodexChatFiles | undefined
  let factory: AgentChatManagerFactory
  let resolver: NativeManagerResolver
  let authority: OperatorChatAuthority
  let services: OperatorServices
  const clients: Client[] = []
  const settings = { ...operatorChatSettings(DEFAULT_HARNESS_DEFAULTS.codex), harness: 'codex' as const,
    model: 'test-model', reasoningEffort: 'low' as const, serviceTier: 'standard' as const }

  beforeEach(async () => {
    database = await agent3Database()
    native = await deliveryFixture()
    const source = await readFile(native.binary, 'utf8')
    await writeFile(native.binary, source
      .replace("setTimeout(() => replyThread(owner, message.id, params), 800)",
        "replyOrHold('late-creation', () => replyThread(owner, message.id, params))")
      .replace("if (flag('late-reject-thread-start')) { setTimeout(() => fail(message.id), 800); return }",
        "if (flag('late-reject-thread-start')) { replyOrHold('late-creation-rejection', () => fail(message.id)); return }")
      .replace("if (prompt === 'late-reject' || flag('late-reject-turn-start')) { setTimeout(() => fail(message.id), 800); return }",
        "if (prompt === 'late-reject' || flag('late-reject-turn-start')) { replyOrHold('late-turn-rejection', () => fail(message.id)); return }"))
    for (const kind of ['late-creation', 'late-creation-rejection', 'late-turn-rejection']) {
      await native.flag(`hold-${kind}`)
    }
    const makeManager = (files?: CodexChatFiles) => native.makeManager(files, {
      transport: (...args) => {
        // Healthy RPCs use the production deadline; faults follow observed native input.
        args[7] = undefined
        return new class extends CodexStdioTransport {
          override async request(...input: Parameters<CodexStdioTransport['request']>): Promise<unknown> {
            const [method, params, signal, late] = input
            const flagged = (flag: string) => existsSync(join(native.directory, flag))
            const faults = [
              { method: 'thread/start', flag: 'late-reject-thread-start', reply: 'late-creation-rejection' },
              { method: 'thread/start', flag: 'late-thread-start', reply: 'late-creation' },
              { method: 'turn/start', flag: 'late-reject-turn-start', reply: 'late-turn-rejection' },
            ]
            const fault = faults.find(candidate => candidate.method === method && flagged(candidate.flag))?.reply
            if (!fault) return super.request(...input)
            const count = (await native.wire(method)).length
            const controller = new AbortController()
            const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
            const response = super.request(method, params, requestSignal, late)
            const observed = until(async () => controller.signal.aborted
              || (await native.wire(method)).length > count || undefined)
            try {
              return await Promise.race([response, observed.then(() => {
                controller.abort(new Error('Fixture response is held after native input.'))
                return response
              })])
            } catch (error) {
              // The reply follows uncertainty, regardless of scheduler or database load.
              if (!options.manualLateReplies) await native.flag(`release-${fault}`)
              throw error
            } finally {
              controller.abort()
            }
          }
        }(...args)
      },
    })
    operatorFiles = undefined
    agentFiles = undefined
    const fixture = makeCurrentWorkflowFixture(`delivery-${randomUUID()}`, 'single')
    fixture.configurations = fixture.configurations.map((configuration) => AgentConfigurationVersionSchema.parse({
      ...configuration, harness: { ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'test-model',
        reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard' },
    }))
    const saved = await seedAgent3(database.pool, native.directory, fixture, { run: false })
    const node = saved.version.definition.nodes[0]!
    workspaceId = saved.scope.workspaceId
    context = { workflowId: saved.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId }
    access = new PostgresAccessService(database.pool)
    const issued = await access.issue({ name: 'Delivery writer', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ scope: {}, actions: [
        'agent_chat:read', 'agent_chat:write', 'agent_chat:cancel', 'agent_chat:respond',
        'operator_chat:read', 'operator_chat:write', 'operator_chat:cancel', 'operator_chat:respond', 'capabilities:read',
      ] }] })
    const deniedAccess = await access.issue({ name: 'Other workspace', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ scope: { workspaceIds: ['other-workspace'] },
        actions: ['agent_chat:read', 'agent_chat:write', 'agent_chat:respond'] }] })
    const readerAccess = await access.issue({ name: 'Delivery reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ scope: {}, actions: ['operator_chat:read'] }] })
    writerToken = issued.token
    readerToken = readerAccess.token
    const agentOwners = new Map<string, NativeHarnessSessionManager>()
    factory = (id) => {
      let owner = agentOwners.get(id)
      if (!owner) {
        owner = createAdmittedNativeManager('codex', async () => ({ manager: makeManager(agentFiles) })).manager
        agentOwners.set(id, owner)
      }
      return owner
    }
    factory.release = (id) => { agentOwners.delete(id) }
    repository = new PostgresAgentChatRepository(database.pool)
    messages = new PostgresOperatorConversationRepository(database.pool)
    agentChat = new AgentChatService(database.pool, repository, messages, new PostgresWorkflowRepository(database.pool), {
      getForWorkspace: async () => { throw new Error('No Run source in this fixture.') },
      getExecution: async () => { throw new Error('This fixture must not read a Run execution.') }, executionPages: () => { throw new Error('No Run source in this fixture.') },
    }, factory, database.directory)
    const operatorOwners = new Map<string, NativeHarnessSessionManager>()
    resolver = (_configuration, id) => {
      let owner = operatorOwners.get(id)
      if (!owner) {
        owner = createAdmittedNativeManager('codex', async () => ({ manager: makeManager(operatorFiles) })).manager
        operatorOwners.set(id, owner)
      }
      return owner
    }
    resolver.release = (id) => { operatorOwners.delete(id) }
    authority = {
      current: (id) => access.currentOperator(id),
      assertConfiguration() {},
      setup: async (manager) => ({ harness: manager.harness, status: 'configured',
        endpoint: 'http://127.0.0.1:3000/mcp', checkedAt: new Date().toISOString() }),
      prepare: async (_manager, configuration) => ({ agentId: configuration.operatorId, variables: {} }),
      release: async () => undefined,
    }
    operatorChat = new OperatorChatService(messages, new PostgresOperatorRepository(database.pool),
      resolver, native.directory, authority)
    services = { agentChat, operatorChat, commands: new PostgresCommandCoordinator(database.pool) } as unknown as OperatorServices
    app = buildApp({ logger: false, readiness: { database: { ping: async () => undefined },
      checkpoints: { ping: async () => undefined } }, operator: { access,
      services } })
    registerOperatorChatRoutes(app, operatorChat)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'codex-delivery', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    writer = await connect(issued.token)
    denied = await connect(deniedAccess.token)
    reader = await connect(readerAccess.token)
  })

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close()
    await app?.close()
    await agentChat?.shutdown()
    await operatorChat?.shutdown()
    await native?.close()
    await database?.close()
  })

  const request = (requestId: string, expectedConversationId: string | null): SendAgentChatMessageRequest => ({
    requestId, content: 'A user message', intent: 'next_turn', context, expectedConversationId,
  })
  async function sendAgent(input: SendAgentChatMessageRequest) {
    const result = await writer.callTool({ name: 'agent_chat_send', arguments: { workspaceId, request: input } })
    assert.notEqual(result.isError, true, JSON.stringify(result))
    return decodeMcpToolResult(result) as { state: AgentChatState; replayed: boolean }
  }
  async function readAgent() {
    const result = await writer.callTool({ name: 'agent_chat_read', arguments: { workspaceId, query: context } })
    assert.notEqual(result.isError, true, JSON.stringify(result))
    return decodeMcpToolResult(result) as AgentChatState
  }
  async function createOperator() {
    const result = await writer.callTool({ name: 'operator_chat_create', arguments: { commandId: randomUUID() } })
    assert.notEqual(result.isError, true, JSON.stringify(result))
    return (decodeMcpToolResult(result) as { conversation: { id: string } }).conversation.id
  }
  async function sendOperator(id: string, requestId: string, content = 'A user message') {
    const result = await writer.callTool({ name: 'operator_chat_send', arguments: {
      conversationId: id, request: { requestId, content, settings },
    } })
    assert.notEqual(result.isError, true, JSON.stringify(result))
  }
  async function readOperator(id: string) {
    const result = await writer.callTool({ name: 'operator_chat_get', arguments: { conversationId: id } })
    assert.notEqual(result.isError, true, JSON.stringify(result))
    return decodeMcpToolResult(result) as OperatorConversationState
  }

  function restartAgentService() {
    agentChat = new AgentChatService(database.pool, repository, messages, new PostgresWorkflowRepository(database.pool), {
      getForWorkspace: async () => { throw new Error('No Run source in this fixture.') },
      getExecution: async () => { throw new Error('This fixture must not read a Run execution.') }, executionPages: () => { throw new Error('No Run source in this fixture.') },
    }, factory, database.directory)
    services.agentChat = agentChat
  }

  return {
    get database() { return database },
    get native() { return native },
    get repository() { return repository },
    get messages() { return messages },
    get writer() { return writer },
    get denied() { return denied },
    get reader() { return reader },
    get writerToken() { return writerToken },
    get readerToken() { return readerToken },
    get access() { return access },
    get context() { return context },
    get workspaceId() { return workspaceId },
    get resolver() { return resolver },
    get authority() { return authority },
    get services() { return services },
    get clients() { return clients },
    get settings() { return settings },
    get request() { return request },
    sendAgent,
    readAgent,
    createOperator,
    sendOperator,
    readOperator,
    restartAgentService,
    get agentChat() { return agentChat },
    get operatorChat() { return operatorChat },
    set operatorChat(value) { operatorChat = value },
    get app() { return app },
    set app(value) { app = value },
    get operatorFiles() { return operatorFiles },
    set operatorFiles(value) { operatorFiles = value },
    get agentFiles() { return agentFiles },
    set agentFiles(value) { agentFiles = value },
  }
}
