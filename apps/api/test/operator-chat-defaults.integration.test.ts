import type { OperatorServices } from '../src/mcp/operator/types.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { CLAUDE_FULL_ACCESS_REQUIRED } from '@foreman-code/contracts/claude'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { ManagedAgentDefaultsSchema, AgentDefaultsUpdateResultSchema } from '@foreman-code/contracts/management'
import { applyOperatorChatSettings, operatorChatSettings, DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS, type OperatorConversationState } from '@foreman-code/contracts'
import { describe, expect, it } from 'vitest'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
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
  it('projects accepted models through authenticated MCP and history without changing immutable turn or message facts', async () => {
    const writer = await access.issue({ name: 'Accepted model reader', audience: 'operator',
      grants: [{ actions: ['operator_chat:read', 'operator_chat:write'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
    const source = await chat.create(writer.principal)
    const first = { requestId: 'accepted-sol', content: 'First model fixture',
      settings: { ...operatorChatSettings(DEFAULT_HARNESS_DEFAULTS.codex), harness: 'codex' as const,
        model: 'gpt-6.1-sol', reasoningEffort: 'medium' as const, serviceTier: 'standard' as const } }
    const second = { ...first, requestId: 'accepted-luna', content: 'Second model fixture',
      settings: { ...first.settings, model: 'gpt-6-luna' } }
    await chat.send(source.id, first, writer.principal)
    await waitFor(async () => (await chat.get(source.id, writer.principal)).turnState === 'idle')
    await chat.send(source.id, second, writer.principal)
    await waitFor(async () => (await chat.get(source.id, writer.principal)).turnState === 'idle')
    const current = await operators.ensure()
    await operators.update({ ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'different-future-default' }, current.configuration.id)
    const facts = async () => (await pool.query(`select record::text from operator_conversation_messages where conversation_id=$1 order by sequence`, [source.id])).rows
    const before = await facts()
    const acceptedFirst = await repository.acceptedConfiguration(source.id, first.requestId)
    const acceptedSecond = await repository.acceptedConfiguration(source.id, second.requestId)
    const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { operatorChat: chat, commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
    const clients: Client[] = []
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => {
        const client = new Client({ name: 'accepted-model-parity', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
        return client
      }
      const client = await connect(writer.token)
      const read = await client.callTool({ name: 'operator_chat_get', arguments: { conversationId: source.id } })
      expect(read.isError, JSON.stringify(read)).not.toBe(true)
      const state = decodeMcpToolResult(read) as OperatorConversationState
      expect(state.messages.map(message => [message.requestId, message.acceptedModel])).toEqual([
        [first.requestId, { harness: 'codex', model: first.settings.model }],
        [first.requestId, { harness: 'codex', model: first.settings.model }],
        [second.requestId, { harness: 'codex', model: second.settings.model }],
        [second.requestId, { harness: 'codex', model: second.settings.model }],
      ])
      const history = await chat.history(source.id, writer.principal, { limit: 2 })
      expect(history.entries.map(entry => entry.message.acceptedModel)).toEqual([
        { harness: 'codex', model: second.settings.model }, { harness: 'codex', model: second.settings.model },
      ])
      const older = await chat.history(source.id, writer.principal, { before: history.nextCursor!, limit: 2 })
      expect(older.entries.map(entry => entry.message.acceptedModel)).toEqual([
        { harness: 'codex', model: first.settings.model }, { harness: 'codex', model: first.settings.model },
      ])
      const denied = await access.issue({ name: 'No conversation read grant', audience: 'operator',
        grants: [{ actions: ['settings:read'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
      const deniedClient = await connect(denied.token)
      expect((await deniedClient.listTools()).tools.map(tool => tool.name)).not.toContain('operator_chat_get')
      await expectMcpAccessDenied(deniedClient.callTool({ name: 'operator_chat_get', arguments: { conversationId: source.id } }))
      await expect(chat.get(source.id, denied.principal)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      expect(await facts()).toEqual(before)
      expect(await repository.acceptedConfiguration(source.id, first.requestId)).toEqual(acceptedFirst)
      expect(await repository.acceptedConfiguration(source.id, second.requestId)).toEqual(acceptedSecond)
    } finally { await Promise.allSettled(clients.map(client => client.close())); await app.close() }
  })

  it('persists explicit Claude native-default effort through authenticated MCP and denies an ungranted writer', async () => {
    const defaults = new PostgresFoundationSettingsRepository(pool)
    const commands = new PostgresCommandCoordinator(pool)
    const mainId = '11111111-1111-4111-8111-111111111111'
    const selection = { instanceId: randomUUID(), instanceRevision: '1', target: { hostRef: { kind: 'main' as const, mainId },
      applicationInstallationId: mainId, harnessInstallationId: 'synthetic-haiku-installation', installationFingerprint: 'synthetic-payload' } }
    const base = { harness: 'claude' as const, model: 'claude-sonnet-5-5', effort: 'medium' as const, authMode: 'subscription' as const,
      configDirectory: '/synthetic/profile', permissionMode: 'default' as const, sandbox: 'danger-full-access' as const,
      tools: ['Read'], permissionRules: [], instructions: 'Keep the saved tool policy.', mcpServers: {} }
    const configuration = applyOperatorChatSettings(base, { harness: 'claude', model: 'claude-haiku-4-5-20251001', showThinking: false })
    const validated: unknown[] = []
    const prepared: unknown[] = []
    const service = new FoundationSettingsManagementService(defaults, commands, undefined, operators, {
      validateSelection: async (_principal, selected, harness) => { expect(selected).toEqual(selection); validated.push(harness) },
      prepareOperatorConfiguration: async (_principal, source, harness) => { expect(source).toBe('mcp'); prepared.push(harness); return selection },
    })
    const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { settings: service, operatorChat: chat, commands } as unknown as OperatorServices } })
    const clients: Client[] = []
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (actions: ManagementPrincipal['grants'][number]['actions']) => {
        const issued = await access.issue({ name: 'Claude effort settings', audience: 'operator', grants: [{ actions, scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
        const client = new Client({ name: 'claude-effort-parity', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => issued.token } }))
        return client
      }
      const client = await connect(['settings:read', 'settings:update', 'harnesses:read', 'harnesses:update'])
      const read = async () => ManagedAgentDefaultsSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'agent_defaults_get', arguments: {} }))))
      const before = await read()
      const input = { commandId: randomUUID(), expectedRevision: before.revision, value: { ...before.value,
        operator: { ...before.value.operator, harness: configuration } } }
      const unsupported = await client.callTool({ name: 'agent_defaults_update', arguments: {
        ...input, commandId: randomUUID(), value: { ...input.value,
          operator: { ...input.value.operator, harness: { ...configuration, sandbox: 'read-only' } } },
      } })
      expect(unsupported.isError, JSON.stringify(unsupported)).toBe(true)
      expect(unsupported.content).toEqual([{ type: 'text', text: expect.stringContaining(CLAUDE_FULL_ACCESS_REQUIRED) }])
      expect(await read()).toEqual(before)
      expect(validated).toHaveLength(0)
      expect(prepared).toHaveLength(0)
      const result = await client.callTool({ name: 'agent_defaults_update', arguments: input })
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      const accepted = AgentDefaultsUpdateResultSchema.parse(decodeMcpToolResult(result))
      expect((await read()).value.operator.harness).toEqual(configuration)
      expect((await read()).value.operator.harness).not.toHaveProperty('effort')
      expect((await read()).value.operator.harness).toMatchObject({ sandbox: 'danger-full-access', tools: ['Read'] })
      expect(validated).toEqual([configuration])
      expect(prepared).toEqual([configuration])
      expect((await read()).value.operator.harnessProfileSelection).toEqual(selection)
      const denied = await connect(['settings:read'])
      await expectMcpAccessDenied(denied.callTool({ name: 'agent_defaults_update', arguments: { ...input, commandId: randomUUID() } }))
      expect((await read()).revision).toBe(accepted.value.revision)
      expect(validated).toHaveLength(1)
      expect(prepared).toHaveLength(1)
    } finally { await Promise.allSettled(clients.map(client => client.close())); await app.close() }
  })

  it('checks the Operator MCP setup without creating an Operator or a conversation', async () => {
    expect(await chat.setup(owner)).toMatchObject({ harness: 'codex', status: 'configured' })
    expect((await pool.query('select id from application_operators')).rowCount).toBe(0)
    expect((await pool.query('select id from operator_conversations')).rowCount).toBe(0)
  })
  it('checks reviewed Claude defaults for an unaccepted harness change without replacing its source pin or admitting a turn', async () => {
    const source = await chat.create(owner)
    const sourcePin = source.operatorConfigurationVersionId!
    const settings = new PostgresFoundationSettingsRepository(pool)
    const mainId = '11111111-1111-4111-8111-111111111111'
    const selector = { instanceId: randomUUID(), instanceRevision: '1', target: { hostRef: { kind: 'main' as const, mainId },
      applicationInstallationId: mainId, harnessInstallationId: 'synthetic-claude', installationFingerprint: 'synthetic-payload' } }
    const harness = { harness: 'claude' as const, model: 'synthetic-claude', authMode: 'subscription' as const, configDirectory: '/synthetic/profile',
      permissionMode: 'default' as const, sandbox: 'danger-full-access' as const, tools: [], permissionRules: [], instructions: '',
      mcpServers: { graphql: { type: 'http' as const, url: 'http://127.0.0.1:3050/mcp' } } }
    const saved = await settings.updateAgentDefaults({ ...DEFAULT_AGENT_DEFAULTS,
      operator: { ...DEFAULT_AGENT_DEFAULTS.operator, harness, harnessProfileSelection: selector } }, 0)
    const connection = await pool.connect()
    let targetPin: string
    try {
      await connection.query('begin')
      targetPin = (await operators.updateWithClient(connection, harness, sourcePin, false, undefined, selector)).configuration.id
      await connection.query('commit')
    } catch (error) { await connection.query('rollback'); throw error } finally { connection.release() }
    let inspections = 0
    authority.setupConfiguration = async (_principal, configuration) => {
      inspections++
      expect(configuration.id).toBe(targetPin)
      expect(configuration.harnessProfileSelection).toEqual(selector)
      return { harness: 'claude', status: 'configured', endpoint: harness.mcpServers.graphql.url, checkedAt: new Date().toISOString() }
    }
    const pending = { conversationId: source.id, requestId: 'pending-unaccepted', configurationVersionId: sourcePin,
      harness: 'claude' as const, expectedDefaultsRevision: saved.revision }
    expect(await chat.setup(owner, pending)).toMatchObject({ status: 'configured', harness: 'claude', configurationVersionId: targetPin })
    expect((await repository.active(source.id))?.operator_configuration_version_id).toBe(sourcePin)
    expect(await repository.hasTurn(source.id, pending.requestId)).toBe(false)
    expect(manager.sessions).toBe(0)
    await expect(chat.setup(owner, { conversationId: source.id, requestId: pending.requestId,
      configurationVersionId: sourcePin, harness: 'claude' })).rejects.toMatchObject({ code: 'OPERATOR_CONFIGURATION_CONFLICT' })
    await expect(chat.setup(owner, { ...pending, configurationVersionId: targetPin, harness: 'codex' })).rejects.toMatchObject({ code: 'OPERATOR_CONFIGURATION_CONFLICT' })
    await settings.updateAgentDefaults(saved.value, saved.revision)
    await expect(chat.setup(owner, pending)).rejects.toMatchObject({ code: 'OPERATOR_DEFAULTS_CHANGED' })
    expect(inspections).toBe(1)
  })

  it('checks an accepted harness-change receipt instead of newer defaults or its original source pin', async () => {
    const source = await chat.create(owner)
    const sourcePin = source.operatorConfigurationVersionId!
    const settings = new PostgresFoundationSettingsRepository(pool)
    const saved = await settings.updateAgentDefaults({ ...DEFAULT_AGENT_DEFAULTS,
      operator: { ...DEFAULT_AGENT_DEFAULTS.operator, harness: claudeConfiguration } }, 0)
    await operators.update(claudeConfiguration, (await operators.ensure()).configuration.id)
    const claude = new ChatManager('claude')
    chat = new OperatorChatService(repository, operators, (configuration) => configuration.harness.harness === 'claude' ? claude : manager,
      runtimeDirectory, authority, prepareClaudeProfile)
    const request = { requestId: 'accepted-change', content: 'Synthetic receipt fixture', configurationVersionId: sourcePin,
      defaultsRevision: saved.revision, settings: operatorChatSettings(claudeConfiguration) }
    await chat.send(source.id, request, owner)
    await waitFor(async () => (await chat.get(source.id, owner)).turnState === 'idle')
    const accepted = await repository.acceptedConfiguration(source.id, request.requestId)
    expect(accepted?.harness.harness).toBe('claude')
    await settings.updateAgentDefaults({ ...saved.value, operator: { ...saved.value.operator, harness: DEFAULT_HARNESS_DEFAULTS.codex } }, saved.revision)
    await operators.update(DEFAULT_HARNESS_DEFAULTS.codex, (await operators.ensure()).configuration.id)
    expect(await chat.setup(owner, { conversationId: source.id, requestId: request.requestId, configurationVersionId: sourcePin,
      harness: 'claude', expectedDefaultsRevision: saved.revision })).toMatchObject({ harness: 'claude', status: 'configured', configurationVersionId: accepted!.id })
    expect(await repository.acceptedConfiguration(source.id, request.requestId)).toEqual(accepted)
    expect(claude.turns).toBe(1)
  })

  it('shares saved chat defaults with future sessions through authenticated MCP, preserving conflicts and denied callers', async () => {
    const settings = new PostgresFoundationSettingsRepository(pool)
    const commands = new PostgresCommandCoordinator(pool)
    const service = new FoundationSettingsManagementService(settings, commands,
      { qualifyConfiguration: async () => ({} as never) }, operators)
    const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { settings: service, operatorChat: chat, commands } as unknown as OperatorServices } })
    const clients: Client[] = []
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      async function connect(actions: ManagementPrincipal['grants'][number]['actions']) {
        const issued = await access.issue({ name: 'Settings parity', audience: 'operator', grants: [{ actions, scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
        const client = new Client({ name: 'settings-parity', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => issued.token } }))
        return client
      }
      const client = await connect(['settings:read', 'settings:update', 'harnesses:read'])
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('operator_mcp_setup_get')
      const read = async () => ManagedAgentDefaultsSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'agent_defaults_get', arguments: {} }))))
      const before = await read()
      expect(before.value.operator.harness).toMatchObject({ harness: 'codex', sandbox: 'danger-full-access' })
      expect(before.value.coder.harness).toMatchObject({ sandbox: 'read-only' })
      const input = { commandId: randomUUID(), expectedRevision: before.revision, value: { ...before.value,
        operator: { ...before.value.operator, showThinking: true,
          harness: { ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'gpt-5.4', reasoningEffort: 'high', sandbox: 'danger-full-access', serviceTier: 'priority' } } } }
      const accepted = AgentDefaultsUpdateResultSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'agent_defaults_update', arguments: input }))))
      expect(accepted.replayed).toBe(false)
      expect((await read()).value.operator).toEqual(accepted.value.value.operator)
      expect((await read()).value.operator.harness).toMatchObject({ sandbox: 'danger-full-access' })
      const conversation = await chat.create(owner)
      expect((await chat.get(conversation.id, owner)).settings).toEqual({ harness: 'codex', model: 'gpt-5.4', reasoningEffort: 'high', serviceTier: 'priority', showThinking: true })
      expect(AgentDefaultsUpdateResultSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'agent_defaults_update', arguments: input })))).replayed).toBe(true)
      expect((await client.callTool({ name: 'agent_defaults_update', arguments: { ...input, commandId: randomUUID() } })).isError).toBe(true)
      expect(decodeMcpToolResult((await client.callTool({ name: 'operator_mcp_setup_get', arguments: {} })))).toMatchObject({ status: 'configured', harness: 'codex' })
      const denied = await connect(['settings:read'])
      expect((await denied.listTools()).tools.map((tool) => tool.name)).not.toContain('operator_mcp_setup_get')
      await expectMcpAccessDenied(denied.callTool({ name: 'operator_mcp_setup_get', arguments: {} }))
      await expectMcpAccessDenied(denied.callTool({ name: 'agent_defaults_update', arguments: { ...input, commandId: randomUUID() } }))
      expect((await read()).revision).toBe(accepted.value.revision)
    } finally { for (const client of clients) await client.close(); await app.close() }
  })

})
