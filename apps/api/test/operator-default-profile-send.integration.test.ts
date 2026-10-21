import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { operatorChatSettings, type OperatorConfigurationVersion } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { buildApp } from '../src/app.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { FoundationSettingsManagementService } from '../src/modules/settings/management.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { PostgresOperatorChatAuthority } from '../src/modules/conversations/operatorChatAuthority.js'
import { NativeRollout } from '../src/modules/harnesses/nativeRollout.js'
import { DomainError } from '../src/modules/errors.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'

// Real authenticated routes, defaults publication and durable receipt admission.
// The native allocation boundary records the exact selection and rejects before
// any native process, credential or prompt. These metadata pins are not native proof.
it.skipIf(!postgresEnabled)('carries the full saved Claude default profile through browser settings, empty-chat switch, receipt recovery and MCP retries', async () => {
  const f = await currentOperatorIntegration()
  const operators = new PostgresOperatorRepository(f.db.pool)
  const defaults = new PostgresFoundationSettingsRepository(f.db.pool)
  const repository = new PostgresOperatorConversationRepository(f.db.pool)
  const captured: OperatorConfigurationVersion[] = []
  const endpoint = new URL('/mcp', f.address).href
  const authority = new PostgresOperatorChatAuthority(f.db.pool, f.access, new NativeRollout({}), f.db.directory, endpoint,
    undefined, async () => { throw new Error('Native credential delivery is outside this fixture.') })
  const chat = new OperatorChatService(repository, operators, configuration => {
    captured.push(configuration)
    throw new DomainError('FIXTURE_NATIVE_UNAVAILABLE', 'Allocation boundary reached; no native process was started.', 409)
  }, f.db.directory, {
    current: id => f.access.currentOperator(id), assertConfiguration: configuration => authority.assertConfiguration(configuration),
    setup: async () => { throw new Error('Native setup is outside this fixture.') },
    prepare: async () => { throw new Error('Native preparation is outside this fixture.') }, release: async () => {},
  }, async (principal, selected) => {
    expect(principal.id).toBe(f.writer.principal.id)
    expect(selected).toEqual(configuration)
    return selection
  })
  const mainId = randomUUID()
  const selection = { instanceId: randomUUID(), instanceRevision: '1', target: { hostRef: { kind: 'main' as const, mainId },
    applicationInstallationId: mainId, harnessInstallationId: 'unit-claude-installation', installationFingerprint: 'unit-payload' } }
  const configuration = { harness: 'claude' as const, model: 'unit-claude-model', effort: 'medium' as const,
    authMode: 'subscription' as const, configDirectory: f.db.directory, permissionMode: 'default' as const,
    sandbox: 'danger-full-access' as const, tools: [], permissionRules: [], instructions: '', mcpServers: {} }
  const settings = new FoundationSettingsManagementService(defaults, f.commands, f.services.harnesses, operators, {
    validateSelection: async (_principal, selected, harness) => { expect(selected).toEqual(selection); expect(harness).toEqual(configuration) },
  })
  const app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
    operator: { access: f.access, services: { ...f.services, settings, operatorChat: chat } } })
  registerOperatorChatRoutes(app, chat)
  const clients: Client[] = []
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const headers = { authorization: `Bearer ${f.writer.token}`, 'content-type': 'application/json' }
    const create = await fetch(new URL('/api/operator/conversations', address), { method: 'POST', headers, body: '{}' })
    expect(create.status).toBe(201)
    const old = (await create.json() as { conversation: { id: string; operatorConfigurationVersionId: string } }).conversation
    const historyCreate = await fetch(new URL('/api/operator/conversations', address), { method: 'POST', headers, body: '{}' })
    const history = (await historyCreate.json() as { conversation: { id: string; operatorConfigurationVersionId: string } }).conversation
    const sourceRequest = { requestId: randomUUID(), content: 'Owned source history; allocation fixture rejects before native input.' }
    expect((await fetch(new URL(`/api/operator/conversations/${history.id}/messages`, address), {
      method: 'POST', headers, body: JSON.stringify(sourceRequest),
    })).status).toBe(202)
    await vi.waitFor(async () => {
      expect((await repository.active(history.id))?.turn_state).toBe('error')
    }, { interval: 5, timeout: 1000 })
    const previous = await defaults.getAgentDefaults()
    const saved = await settings.updateAgentDefaults(f.writer.principal, 'http', { commandId: randomUUID(), expectedRevision: previous.revision,
      value: { ...previous.value, operator: { ...previous.value.operator, harness: configuration, harnessProfileSelection: selection } } })
    const published = await operators.inspectionConfiguration(saved.value.revision)
    const input = { requestId: randomUUID(), content: 'Unit hello once.', settings: operatorChatSettings(configuration),
      configurationVersionId: old.operatorConfigurationVersionId, defaultsRevision: saved.value.revision }
    const url = new URL(`/api/operator/conversations/${old.id}/messages`, address)
    const post = (value = input) => fetch(url, { method: 'POST', headers, body: JSON.stringify(value) })
    expect((await post({ ...input, defaultsRevision: input.defaultsRevision - 1 })).status).toBe(409)
    expect((await post({ ...input, configurationVersionId: 'unknown-source-pin' })).status).toBe(409)
    const reader = await f.access.issue({ name: 'Read-only chat actor', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
      grants: [{ actions: ['operator_chat:read'], scope: {} }] })
    expect((await fetch(url, { method: 'POST', headers: { ...headers, authorization: `Bearer ${reader.token}` }, body: JSON.stringify(input) })).status).toBe(403)
    expect((await f.db.pool.query('select 1 from operator_conversation_turns where conversation_id=$1', [old.id])).rowCount).toBe(0)
    expect((await post()).status).toBe(202)
    await vi.waitFor(async () => {
      expect((await repository.active(old.id))?.turn_state).toBe('error')
    }, { interval: 5, timeout: 1000 })
    const allocations = captured.length
    const accepted = await repository.acceptedConfiguration(old.id, input.requestId)
    expect(accepted).toMatchObject({ harness: configuration, harnessProfileSelection: selection, showThinking: input.settings.showThinking })
    expect(accepted?.harnessProfileSelection).toEqual(published.harnessProfileSelection)
    expect(captured.at(-1)).toEqual(accepted)
    const receipt = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...input, recovery: 'receipt' }) })
    expect(receipt.status).toBe(200); expect(captured).toHaveLength(allocations)
    const client = new Client({ name: 'default-profile-send-test', version: '1' }); clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => f.writer.token } }))
    const retry = await client.callTool({ name: 'operator_chat_send', arguments: { conversationId: old.id, request: { ...input, recovery: 'receipt' } } })
    expect(retry.isError, JSON.stringify(retry)).not.toBe(true); expect(captured).toHaveLength(allocations)
    const mismatch = { ...input, requestId: randomUUID(), configurationVersionId: accepted!.id,
      settings: { ...input.settings, model: 'unqualified-other-model' } }
    const rejected = await fetch(url, { method: 'POST', headers, body: JSON.stringify(mismatch) })
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({ error: { code: 'HARNESS_PROFILE_SELECTION_CONFLICT' } })
    expect((await f.db.pool.query('select 1 from operator_conversation_turns where conversation_id=$1', [old.id])).rowCount).toBe(1)
    expect((await repository.acceptedConfiguration(old.id, input.requestId))?.harnessProfileSelection).toEqual(selection)
    const deniedClient = new Client({ name: 'read-only-conversation', version: '1' })
    clients.push(deniedClient)
    await deniedClient.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => reader.token },
    }))
    const readConversation = async () => decodeMcpToolResult(await client.callTool({
      name: 'operator_chat_get', arguments: { conversationId: old.id },
    }))
    const beforeConflict = await readConversation()
    const deniedSend = await deniedClient.callTool({ name: 'operator_chat_send', arguments: {
      conversationId: old.id, request: mismatch,
    } })
    expect(deniedSend.isError).toBe(true)
    expect(JSON.stringify(deniedSend.content)).toContain('ACCESS_DENIED')
    const conflict = await client.callTool({ name: 'operator_chat_send', arguments: {
      conversationId: old.id, request: mismatch,
    } })
    expect(conflict.isError).toBe(true)
    const conflictText = JSON.stringify(conflict.content)
    expect(conflictText).toContain('HARNESS_PROFILE_SELECTION_CONFLICT')
    expect.soft(conflictText).toMatch(/conversation.*pinned settings/)
    expect.soft(conflictText).toMatch(/save.*desired defaults.*start a new conversation/)
    expect.soft(conflictText).not.toContain('harness_instance_save')
    expect(await readConversation()).toEqual(beforeConflict)
    const pinnedRequest = { ...input, requestId: randomUUID(), configurationVersionId: accepted!.id }
    const pinnedSend = await client.callTool({ name: 'operator_chat_send', arguments: {
      conversationId: old.id, request: pinnedRequest,
    } })
    expect(pinnedSend.isError, JSON.stringify(pinnedSend)).not.toBe(true)
    await vi.waitFor(async () => {
      expect((await repository.active(old.id))?.turn_state).toBe('error')
    }, { interval: 5, timeout: 1000 })
    expect(await repository.acceptedConfiguration(old.id, pinnedRequest.requestId))
      .toMatchObject({ harness: configuration, harnessProfileSelection: selection })
    const source = await chat.get(history.id, f.writer.principal)
    const forkInput = { ...input, requestId: randomUUID(), configurationVersionId: history.operatorConfigurationVersionId, forkExpectedRevision: source.revision }
    const forkResponse = await fetch(new URL(`/api/operator/conversations/${history.id}/messages`, address), {
      method: 'POST', headers, body: JSON.stringify(forkInput),
    })
    expect(forkResponse.status).toBe(202)
    const childId = `operator-fork:${forkInput.requestId}`
    expect((await repository.acceptedConfiguration(childId, forkInput.requestId))?.harnessProfileSelection).toEqual(selection)
    expect((await repository.configuration(history.operatorConfigurationVersionId))?.harness.harness).toBe('codex')
  } finally { await Promise.allSettled(clients.map(client => client.close())); await chat.shutdown(); await app.close(); await f.close() }
}, 60000)
