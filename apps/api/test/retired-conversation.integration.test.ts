import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GetOperatorConversationResponseSchema, SessionControlStateSchema } from '@foreman-code/contracts'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { productionOperatorManagers } from '../src/modules/harnesses/operatorFiles/managers.js'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { NativeResponseJournal } from '../src/modules/harnesses/recovery/responseJournal.js'
import { NativeHarnessFactories } from '../src/modules/harnesses/runtimeFactory.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('Retired Operator conversation history', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let access: PostgresAccessService
  let repository: PostgresOperatorConversationRepository
  let chat: OperatorChatService
  let app: ReturnType<typeof buildApp>
  let address: string
  let owner: Awaited<ReturnType<PostgresAccessService['issue']>>
  let denied: Awaited<ReturnType<PostgresAccessService['issue']>>
  let conversationId: string
  let configurationId: string
  let nativeFactories: NativeHarnessFactories
  let processRegistry: NativeProcessRegistry
  const clients: Client[] = []
  const managers = new Map<string, NativeHarnessSessionManager>()
  const prepare = vi.fn(async () => { throw new Error('Retired history issued execution credentials') })
  const setup = vi.fn(async () => { throw new Error('Retired history inspected a native manager') })
  const timestamp = '2026-09-01T12:00:00.000Z'

  beforeEach(async () => {
    managers.clear()
    prepare.mockClear()
    setup.mockClear()
    database = await agent3Database()
    access = new PostgresAccessService(database.pool)
    owner = await access.issue({ name: 'Historical conversation owner', audience: 'operator',
      grants: [{ actions: ['operator_chat:read', 'operator_chat:write', 'harnesses:read'], scope: {} }],
      expiresAt: new Date(Date.now() + 600_000) })
    denied = await access.issue({ name: 'Caller without conversation access', audience: 'operator',
      grants: [{ actions: ['harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
    const operators = new PostgresOperatorRepository(database.pool)
    const current = await operators.ensure()
    configurationId = `historical-configuration-${randomUUID()}`
    conversationId = `historical-conversation-${randomUUID()}`
    const configuration = { id: configurationId, operatorId: current.operator.id,
      version: current.configuration.version + 1, contentHash: `sha256:${'a'.repeat(64)}`, createdAt: timestamp,
      showThinking: true, harness: { harness: 'opencode', model: 'opencode-go/deepseek-v4.1-flash',
        variant: 'max', nativeAgent: 'build', thinking: true, autoApprove: false } }
    await database.pool.query(`insert into operator_configuration_versions(id,operator_id,version,record,created_at)
      values($1,$2,$3,$4::jsonb,$5)`, [configurationId, current.operator.id, configuration.version,
      JSON.stringify(configuration), timestamp])
    const conversation = { id: conversationId, agentId: current.operator.id, scope: 'application',
      operatorConfigurationVersionId: configurationId, title: 'Saved OpenCode conversation', status: 'open',
      createdAt: timestamp, updatedAt: timestamp }
    await database.pool.query(`insert into operator_conversations
      (id,operator_id,operator_configuration_version_id,harness,provider_version,native_session_id,
       owner_principal_id,record,created_at,updated_at)
      values($1,$2,$3,'opencode','1.18.31','historical-native-session',$4,$5::jsonb,$6,$6)`,
    [conversationId, current.operator.id, configurationId, owner.principal.id, JSON.stringify(conversation), timestamp])
    for (const message of [
      { id: `${conversationId}-user`, conversationId, role: 'user', content: 'Remember the saved release context.',
        createdAt: timestamp },
      { id: `${conversationId}-assistant`, conversationId, role: 'assistant', content: 'Saved provider response.',
        nativeMessageId: 'historical-text-part', nativeParentMessageId: 'historical-assistant-message',
        nativeMessageComplete: true, createdAt: timestamp },
    ]) {
      await database.pool.query(`insert into operator_conversation_messages
        (id,conversation_id,role,content,native_message_id,record,created_at) values($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [message.id, conversationId, message.role, message.content, message.nativeMessageId ?? null,
        JSON.stringify(message), timestamp])
    }
    repository = new PostgresOperatorConversationRepository(database.pool)
    const config = loadConfig({ DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/retired_conversation_test',
      HARNESS_WORKSPACE_ROOT: database.directory, FILE_STORAGE_ROOT: join(database.directory, 'files') })
    nativeFactories = new NativeHarnessFactories(config.harnesses)
    vi.spyOn(nativeFactories, 'allocate').mockImplementation(() => {
      throw new Error('Retired history allocated a native adapter')
    })
    processRegistry = new NativeProcessRegistry(join(database.directory, 'processes'))
    vi.spyOn(processRegistry, 'scope').mockImplementation(() => {
      throw new Error('Retired history acquired a native process scope')
    })
    const resolveManager = productionOperatorManagers({ app: () => app, pool: database.pool, config,
      workingDirectory: database.directory, processRegistry,
      responseJournal: new NativeResponseJournal(join(database.directory, 'responses')), managers, nativeFactories })
    chat = new OperatorChatService(repository, operators, resolveManager, database.directory, {
      current: id => access.currentOperator(id), assertConfiguration() {}, setup, prepare, release: async () => {},
    })
    app = buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { operatorChat: chat,
        commands: new PostgresCommandCoordinator(database.pool) } as unknown as OperatorServices } })
    registerOperatorChatRoutes(app, chat)
    address = await app.listen({ host: '127.0.0.1', port: 0 })
  }, 30_000)

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map(client => client.close()))
    await chat?.shutdown()
    await app?.close()
    await database?.close()
    vi.restoreAllMocks()
  })

  async function connect(token: string) {
    const client = new Client({ name: 'retired-conversation-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => token },
    }))
    return client
  }

  async function savedFacts() {
    const configuration = await database.pool.query('select record from operator_configuration_versions where id=$1',
      [configurationId])
    const conversation = await database.pool.query(`select record,harness,provider_version,native_session_id,
      operator_configuration_version_id,revision,active_request_id from operator_conversations where id=$1`, [conversationId])
    const messages = await database.pool.query(`select record,native_message_id,content from operator_conversation_messages
      where conversation_id=$1 order by sequence`, [conversationId])
    return { configuration: configuration.rows[0]!.record, conversation: conversation.rows[0]!, messages: messages.rows }
  }

  it('preserves saved configuration, session identities and messages through authenticated HTTP and MCP reads', async () => {
    const before = await savedFacts()
    const client = await connect(owner.token)
    const headers = { authorization: `Bearer ${owner.token}` }
    const response = await app.inject({ method: 'GET', url: `/api/operator/conversations/${conversationId}`, headers })
    expect(response.statusCode, response.body).toBe(200)
    const state = GetOperatorConversationResponseSchema.parse(response.json())
    expect(state.conversation).toEqual(before.conversation.record)
    expect(state.settings).toEqual({ harness: 'opencode', model: 'opencode-go/deepseek-v4.1-flash',
      variant: 'max', showThinking: true })
    expect(state.messages).toHaveLength(2)
    for (const [index, message] of before.messages.entries()) expect(state.messages[index]).toMatchObject(message.record)
    const mcp = await client.callTool({ name: 'operator_chat_get', arguments: { conversationId } })
    expect(mcp.isError, JSON.stringify(mcp.content)).not.toBe(true)
    expect(GetOperatorConversationResponseSchema.parse(decodeMcpToolResult(mcp))).toEqual(state)
    expect(await repository.configuration(configurationId)).toEqual(before.configuration)

    const controlsResponse = await app.inject({ method: 'GET',
      url: `/api/operator/conversations/${conversationId}/session-controls`, headers })
    expect(controlsResponse.statusCode, controlsResponse.body).toBe(200)
    const controls = SessionControlStateSchema.parse(controlsResponse.json())
    expect(controls).toMatchObject({ nativeSessionId: 'historical-native-session', nativeProviderVersion: '1.18.31' })
    for (const name of ['plan', 'compact', 'autoCompact', 'autoCompactBudget'] as const) {
      expect(controls.capabilities[name]).toEqual({ supported: false, reason: expect.stringContaining('OpenCode is retired') })
    }
    const mcpControls = await client.callTool({ name: 'operator_chat_controls_get', arguments: { conversationId } })
    expect(mcpControls.isError, JSON.stringify(mcpControls.content)).not.toBe(true)
    expect(SessionControlStateSchema.parse(decodeMcpToolResult(mcpControls))).toEqual(controls)
    expect(await savedFacts()).toEqual(before)
    expect(nativeFactories.allocate).not.toHaveBeenCalled()
    expect(processRegistry.scope).not.toHaveBeenCalled()
    expect(managers.size).toBe(0)
    expect(prepare).not.toHaveBeenCalled()
    expect(setup).not.toHaveBeenCalled()
  })

  it('denies unauthorized reads and rejects retired sends and setup before allocating native execution', async () => {
    const before = await savedFacts()
    const client = await connect(owner.token)
    const blocked = await connect(denied.token)
    const deniedRead = await app.inject({ method: 'GET', url: `/api/operator/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${denied.token}` } })
    expect(deniedRead.statusCode).toBe(403)
    expect(deniedRead.body).not.toContain('Saved provider response.')
    await expectMcpAccessDenied(blocked.callTool({ name: 'operator_chat_get', arguments: { conversationId } }))
    await expectMcpAccessDenied(blocked.callTool({ name: 'operator_chat_controls_get', arguments: { conversationId } }))
    const headers = { authorization: `Bearer ${owner.token}` }
    const send = await app.inject({ method: 'POST', url: `/api/operator/conversations/${conversationId}/messages`,
      headers, payload: { requestId: randomUUID(), content: 'Continue the historical session.' } })
    expect(send.statusCode, send.body).toBe(409)
    expect(send.json()).toMatchObject({ error: { code: 'HARNESS_RETIRED', message: expect.stringContaining('OpenCode is retired') } })
    const setupResponse = await app.inject({ method: 'GET',
      url: `/api/operator/setup?conversationId=${conversationId}&configurationVersionId=${configurationId}`, headers })
    expect(setupResponse.statusCode, setupResponse.body).toBe(409)
    expect(setupResponse.json()).toMatchObject({ error: { code: 'HARNESS_RETIRED' } })
    for (const call of [
      { name: 'operator_chat_send', arguments: { conversationId,
        request: { requestId: randomUUID(), content: 'Continue the historical session.' } } },
      { name: 'operator_mcp_setup_get', arguments: { conversationId, configurationVersionId: configurationId } },
    ]) {
      const result = await client.callTool(call)
      expect(result.isError).toBe(true)
      expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('HARNESS_RETIRED') }])
    }
    expect(await savedFacts()).toEqual(before)
    expect((await database.pool.query('select count(*)::int as count from operator_conversation_turns')).rows[0]!.count).toBe(0)
    expect(nativeFactories.allocate).not.toHaveBeenCalled()
    expect(processRegistry.scope).not.toHaveBeenCalled()
    expect(managers.size).toBe(0)
    expect(prepare).not.toHaveBeenCalled()
    expect(setup).not.toHaveBeenCalled()
  })
})
