import type { OperatorServices } from '../src/mcp/operator/types.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { operatorChatSettings, DEFAULT_AGENT_DEFAULTS, type OperatorConversationState } from '@foreman-code/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { nativeCorrelation } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { FoundationSettingsManagementService } from '../src/modules/settings/management.js'
import { buildApp } from '../src/app.js'
import { registerOperatorChatFixture, type OperatorChatFixture, claudeConfiguration, prepareClaudeProfile, ChatManager, waitFor } from './helpers/operatorChatFixture.js'

const connectionString = process.env.TEST_DATABASE_URL

let pool: OperatorChatFixture['pool']
let access: OperatorChatFixture['access']
let owner: OperatorChatFixture['owner']
let operators: OperatorChatFixture['operators']
let repository: OperatorChatFixture['repository']
let manager: OperatorChatFixture['manager']
let authority: OperatorChatFixture['authority']
let chat: OperatorChatFixture['chat']
let runtimeDirectory: OperatorChatFixture['runtimeDirectory']

registerOperatorChatFixture(fixture => {
  ({ pool, access, owner, operators, repository, manager, authority, chat, runtimeDirectory } = fixture)
}, () => chat)

describe.skipIf(!connectionString)('Operator chat persistence and native binding with stubbed authority', () => {
  it('changes harness in an empty conversation without a fork or inherited context', async () => {
    const claude = new ChatManager('claude')
    chat = new OperatorChatService(repository, operators,
      (configuration) => configuration.harness.harness === 'claude' ? claude : manager,
      runtimeDirectory, authority, prepareClaudeProfile)
    const source = await chat.create(owner)
    const settings = new PostgresFoundationSettingsRepository(pool)
    const defaults = await settings.getAgentDefaults()
    await settings.updateAgentDefaults({ ...defaults.value, operator: { ...defaults.value.operator,
      harness: claudeConfiguration } }, defaults.revision)
    await operators.update(claudeConfiguration, (await operators.ensure()).configuration.id)
    const first = await chat.send(source.id, { requestId: 'empty-switch', content: 'First message.',
      settings: operatorChatSettings(claudeConfiguration), defaultsRevision: defaults.revision + 1, configurationVersionId: source.operatorConfigurationVersionId }, owner)
    expect(first.state.conversation.id).toBe(source.id)
    expect(first.state.handoff).toBeUndefined()
    await waitFor(async () => (await chat.get(source.id, owner)).turnState === 'idle')
    expect(claude.prompts).toEqual(['First message.'])
  })
  it('keeps completed public messages through an active turn and final reconciliation', async () => {
    manager.autoFinish = false
    manager.publicMessages = ['I will create the folder.', 'The read-only sandbox blocked that attempt.']
    const conversation = await chat.create(owner)
    await chat.send(conversation.id, { requestId: 'commentary-turn', content: 'Create a folder.' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).messages.filter((message) => message.role === 'assistant').length === 2)
    manager.finish(nativeCorrelation(conversation.id, 'commentary-turn'))
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
    const messages = (await chat.get(conversation.id, owner)).messages.filter((message) => message.role === 'assistant')
    expect(messages.map((message) => message.content)).toEqual([
      'I will create the folder.', 'The read-only sandbox blocked that attempt.', 'final answer',
    ])
    expect(messages.map((message) => message.nativeMessageId)).toEqual(['commentary-0', 'commentary-1', 'answer:turn-1'])
  })
  it('forks the first cross-harness message with frozen context and idempotent retry', async () => {
    manager.publicMessages = ['First agent update.', 'Second agent update.']
    const claude = new ChatManager('claude')
    chat = new OperatorChatService(repository, operators,
      (configuration) => configuration.harness.harness === 'claude' ? claude : manager,
      runtimeDirectory, authority, prepareClaudeProfile)
    const source = await chat.create(owner)
    await chat.send(source.id, { requestId: 'source-turn', content: 'Please inspect the release.' }, owner)
    await waitFor(async () => (await chat.get(source.id, owner)).turnState === 'idle')
    manager.publicMessages = []
    for (const [role, content] of [['tool', 'TOOL_RESULT_MUST_NOT_TRANSFER'], ['system', 'SYSTEM_TEXT_MUST_NOT_TRANSFER']] as const) {
      const id = randomUUID()
      await pool.query(`insert into operator_conversation_messages (id,conversation_id,role,content,record)
        values ($1,$2,$3,$4,$5::jsonb)`, [id,source.id,role,content,JSON.stringify({ id, conversationId: source.id, role, content })])
    }
    await pool.query(`insert into operator_conversation_activity (conversation_id,request_id,activity_id,record)
      values ($1,$2,$3,$4::jsonb)`, [source.id,'source-turn','mcp-result',JSON.stringify({
      id: 'mcp-result', requestId: 'source-turn', kind: 'mcp', title: 'MCP call', status: 'completed',
      input: 'MCP_INPUT_MUST_NOT_TRANSFER', output: 'MCP_OUTPUT_MUST_NOT_TRANSFER',
    })])
    const before = await chat.get(source.id, owner)
    const settings = new PostgresFoundationSettingsRepository(pool)
    const defaults = await settings.getAgentDefaults()
    const target = { ...claudeConfiguration, tools: ['Bash'],
      permissionRules: [{ tool: 'Bash', effect: 'deny' as const }] }
    await settings.updateAgentDefaults({ ...defaults.value, operator: { ...defaults.value.operator, harness: target } }, defaults.revision)
    await operators.update(target, (await operators.ensure()).configuration.id)
    const input = { requestId: 'fork-turn', content: 'Continue with Claude.',
      settings: operatorChatSettings(target), forkExpectedRevision: before.revision, defaultsRevision: defaults.revision + 1, configurationVersionId: source.operatorConfigurationVersionId }
    const first = await chat.send(source.id, input, owner)
    expect(first.replayed).toBe(false)
    expect(first.state.conversation.id).toBe('operator-fork:fork-turn')
    expect(first.state.handoff).toMatchObject({ parentConversationId: source.id, sourceHarness: 'codex', omittedMessages: 0 })
    await waitFor(async () => (await chat.get(first.state.conversation.id, owner)).turnState === 'idle')
    const prompt = claude.prompts[0]!
    expect(prompt).toContain('Please inspect the release.')
    const history = ['User: "Please inspect the release."', 'Assistant: "First agent update."',
      'Assistant: "Second agent update."', 'Assistant: "final answer"']
    expect(history.map((line) => prompt.indexOf(line))).toEqual([...history.map((line) => prompt.indexOf(line))].sort((a, b) => a - b))
    expect(history.every((line) => prompt.includes(line))).toBe(true)
    for (const excluded of ['TOOL_RESULT_MUST_NOT_TRANSFER', 'SYSTEM_TEXT_MUST_NOT_TRANSFER',
      'MCP_INPUT_MUST_NOT_TRANSFER', 'MCP_OUTPUT_MUST_NOT_TRANSFER']) expect(prompt).not.toContain(excluded)
    expect(claude.prompts[0]).toContain('Current user message:\nContinue with Claude.')
    expect((await repository.configuration(first.state.conversation.operatorConfigurationVersionId!))?.harness).toMatchObject({
      harness: 'claude', tools: ['Bash'], permissionRules: [{ tool: 'Bash', effect: 'deny' }],
    })
    expect((await chat.get(source.id, owner)).conversation.operatorConfigurationVersionId).toBe(before.conversation.operatorConfigurationVersionId)
    expect((await chat.send(source.id, input, owner)).replayed).toBe(true)
    expect((await repository.list(owner.id)).filter((item) => item.id === first.state.conversation.id)).toHaveLength(1)
    await chat.send(source.id, { requestId: 'return-to-parent', content: 'Continue with Codex.' }, owner)
    await waitFor(async () => (await chat.get(source.id, owner)).turnState === 'idle')
    expect(manager.sessions).toBe(1)
    const reader = (await access.issue({ name: 'Fork history reader', audience: 'operator',
      grants: [{ actions: ['operator_handoff:read'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })).principal
    await pool.query('insert into operator_chat_credentials(principal_id,conversation_id) values ($1,$2)', [reader.id,first.state.conversation.id])
    const older = await chat.handoffHistory(reader)
    expect(older.sourceConversationId).toBe(source.id)
    expect(older.messages.map((message) => message.content)).toContain('Please inspect the release.')
    expect(older.messages.map((message) => message.content)).not.toContain('Continue with Codex.')
    expect(older.messages.map((message) => message.content)).not.toContain('TOOL_RESULT_MUST_NOT_TRANSFER')
    await expect(chat.handoffHistory(reader, 'unrelated-chat')).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(chat.send(source.id, { ...input, requestId: 'stale-fork', forkExpectedRevision: before.revision - 1 }, owner))
      .rejects.toMatchObject({ code: 'CONVERSATION_REVISION_CONFLICT' })
  })
  describe('MCP fork source fixture', () => {
    let app: ReturnType<typeof buildApp>
    let address: string
    let clients: Client[]
    let connect: (actions: ManagementPrincipal['grants'][number]['actions']) => Promise<Client>
    let client: Client
    let sourceId: string
    let get: (id: string) => Promise<OperatorConversationState>
    let source: OperatorConversationState
    beforeEach(async () => {
      const claude = new ChatManager('claude')
      chat = new OperatorChatService(repository, operators,
        (configuration) => configuration.harness.harness === 'claude' ? claude : manager,
        runtimeDirectory, authority, prepareClaudeProfile)
      const service = new FoundationSettingsManagementService(new PostgresFoundationSettingsRepository(pool),
        new PostgresCommandCoordinator(pool), { qualifyConfiguration: async () => ({} as never) }, operators)
      app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access, services: { settings: service, operatorChat: chat, commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
      clients = []
      address = await app.listen({ host: '127.0.0.1', port: 0 })
      connect = async (actions) => {
        const issued = await access.issue({ name: 'Fork MCP caller', audience: 'operator', grants: [{ actions, scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
        const client = new Client({ name: 'fork-mcp', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => issued.token } }))
        return client
      }
      client = await connect(['operator_chat:read', 'operator_chat:write', 'settings:read', 'settings:update', 'harnesses:read'])
      const created = decodeMcpToolResult((await client.callTool({ name: 'operator_chat_create', arguments: { commandId: randomUUID() } }))) as { conversation: { id: string } }
      sourceId = created.conversation.id
      await client.callTool({ name: 'operator_chat_send', arguments: { conversationId: sourceId,
        request: { requestId: 'mcp-source', content: 'Remember the release details.' } } })
      get = async (id: string) => decodeMcpToolResult((await client.callTool({ name: 'operator_chat_get', arguments: { conversationId: id } }))) as OperatorConversationState
      await waitFor(async () => (await get(sourceId)).turnState === 'idle')
      source = await get(sourceId)
    })
    afterEach(async () => {
      for (const client of clients ?? []) await client.close()
      await app?.close()
    })
    it('offers the same fork through authenticated MCP with persisted readback and denied callers', async () => {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['operator_chat_create', 'operator_chat_get', 'operator_chat_send']))
      const defaults = decodeMcpToolResult((await client.callTool({ name: 'agent_defaults_get', arguments: {} }))) as { revision: number; value: typeof DEFAULT_AGENT_DEFAULTS }
      const target = { ...claudeConfiguration }
      const changed = await client.callTool({ name: 'agent_defaults_update', arguments: { commandId: randomUUID(), expectedRevision: defaults.revision,
        value: { ...defaults.value, operator: { ...defaults.value.operator, harness: target } } } })
      expect(changed.isError).not.toBe(true)
      const request = { requestId: 'mcp-fork', content: 'Continue with Claude.', settings: operatorChatSettings(target), forkExpectedRevision: source.revision, defaultsRevision: defaults.revision + 1, configurationVersionId: source.conversation.operatorConfigurationVersionId }
      const fork = decodeMcpToolResult((await client.callTool({ name: 'operator_chat_send', arguments: { conversationId: sourceId, request } }))) as { state: OperatorConversationState; replayed: boolean }
      expect(fork.state.handoff?.parentConversationId).toBe(sourceId)
      expect(fork.state.conversation.id).toBe('operator-fork:mcp-fork')
      await waitFor(async () => (await get(fork.state.conversation.id)).turnState === 'idle')
      expect((await get(fork.state.conversation.id)).messages.some((message) => message.content === 'Continue with Claude.')).toBe(true)
      expect((await get(sourceId)).conversation.operatorConfigurationVersionId).toBe(source.conversation.operatorConfigurationVersionId)
      expect((decodeMcpToolResult((await client.callTool({ name: 'operator_chat_send', arguments: { conversationId: sourceId, request } }))) as { replayed: boolean }).replayed).toBe(true)
      const delegated = await access.issue({ name: 'Bound handoff reader', audience: 'operator',
        grants: [{ actions: ['operator_handoff:read'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
      await pool.query('insert into operator_chat_credentials(principal_id,conversation_id) values ($1,$2)',
        [delegated.principal.id,fork.state.conversation.id])
      const reader = new Client({ name: 'handoff-reader', version: '1' }); clients.push(reader)
      await reader.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => delegated.token } }))
      expect((await reader.listTools()).tools.map((tool) => tool.name)).toContain('operator_handoff_history_get')
      expect((await reader.listTools()).tools.map((tool) => tool.name)).not.toContain('operator_chat_send')
      const history = decodeMcpToolResult((await reader.callTool({ name: 'operator_handoff_history_get', arguments: {} }))) as { messages: Array<{ content: string }> }
      expect(history.messages.map((message) => message.content)).toContain('Remember the release details.')
      expect((await reader.callTool({ name: 'operator_handoff_history_get', arguments: { sourceConversationId: 'unrelated-chat' } })).isError).toBe(true)
      const denied = await connect(['operator_chat:read'])
      expect((await denied.listTools()).tools.map((tool) => tool.name)).not.toContain('operator_chat_send')
      await expectMcpAccessDenied(denied.callTool({ name: 'operator_chat_send', arguments: { conversationId: sourceId, request } }))
    })
  })
})
