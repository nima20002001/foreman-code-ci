import { OperatorConversationStateSchema } from '@foreman-code/contracts'
import { randomUUID } from 'node:crypto'
import { operatorChatSettings, SendOperatorMessageResponseSchema,
  type NativeSessionReference, type SendOperatorMessageRequest } from '@foreman-code/contracts'
import type { HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { FoundationSettingsManagementService } from '../src/modules/settings/management.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'
import { graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { ChatManager, claudeConfiguration, registerOperatorChatFixture,
  type OperatorChatFixture, waitFor } from './helpers/operatorChatFixture.js'

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

function workerProfile(): HarnessProfileSelection {
  return { instanceId: randomUUID(), instanceRevision: '1', target: {
    hostRef: { kind: 'device', mainId: randomUUID(), deviceId: randomUUID() },
    applicationInstallationId: randomUUID(), harnessInstallationId: 'fixture-harness',
    installationFingerprint: 'fixture-harness-profile',
  } }
}

class WorkerChatManager extends ChatManager {
  async closeForResume(session: NativeSessionReference) {
    await this.close(session)
  }
}

async function apiFixture() {
  const writer = await access.issue({ name: 'input size owner', audience: 'operator', grants: owner.grants,
    expiresAt: new Date(Date.now() + 600_000) })
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { operatorChat: chat,
      commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
  registerOperatorChatRoutes(app, chat)
  return { app, writer,
    send: (id: string, input: SendOperatorMessageRequest) => app.inject({ method: 'POST',
      url: `/api/operator/conversations/${id}/messages`, headers: { authorization: `Bearer ${writer.token}` }, payload: input }),
    sendMcp: (id: string, input: SendOperatorMessageRequest) => graphRpc(app, writer.token, 'tools/call', {
      name: 'operator_chat_send', arguments: { conversationId: id, request: input },
    }),
  }
}

async function saveWorkerDefaults(profile: HarnessProfileSelection) {
  const settings = new PostgresFoundationSettingsRepository(pool)
  const defaults = await settings.getAgentDefaults()
  const management = new FoundationSettingsManagementService(settings, new PostgresCommandCoordinator(pool),
    undefined, operators, {
      validateSelection: async (_principal, selected, harness) => {
        expect(selected).toEqual(profile)
        expect(harness).toEqual(claudeConfiguration)
      },
    })
  const saved = await management.updateAgentDefaults(owner, 'http', { commandId: randomUUID(),
    expectedRevision: defaults.revision, value: { ...defaults.value, operator: { ...defaults.value.operator,
      harness: claudeConfiguration, harnessProfileSelection: profile } } })
  return saved.value
}

describe.skipIf(!connectionString)('Operator input size admission', () => {
  it.each([
    { kind: 'UTF-8', initial: '界'.repeat(100_000), content: 'message '.repeat(95_000) },
    { kind: 'JSON escaping', initial: '\u0001'.repeat(100_000), content: 'message '.repeat(75_000) },
  ])('rejects an assembled Worker prompt that exceeds transport capacity through $kind before persistence', async ({ initial, content }) => {
    const settings = new PostgresFoundationSettingsRepository(pool)
    const defaults = await settings.getAgentDefaults()
    await settings.updateAgentDefaults({ ...defaults.value, operator: { ...defaults.value.operator,
      harnessProfileSelection: workerProfile() } }, defaults.revision)
    await withTransaction(pool, client => settings.updateOperatorInitialPrompt({ text: initial }, undefined, client))
    const f = await apiFixture()
    try {
      const conversation = await chat.create(f.writer.principal)
      const input: SendOperatorMessageRequest = { requestId: 'oversized-composed', content,
        sessionMode: 'plan', context: { route: '/settings' } }
      const before = await chat.get(conversation.id, f.writer.principal)
      const http = await f.send(conversation.id, input)
      expect(http.statusCode, http.body).toBe(400)
      expect(http.json()).toMatchObject({ error: { code: 'CHAT_MESSAGE_TOO_LARGE' } })
      expect(http.json().error.message).toContain('1 MiB')
      const mcp = await f.sendMcp(conversation.id, input)
      expect(mcp.result?.isError).toBe(true)
      expect(JSON.stringify(mcp.result)).toContain('1 MiB')
      expect(await chat.get(conversation.id, f.writer.principal)).toEqual(before)
      expect(await repository.hasTurn(conversation.id, input.requestId)).toBe(false)
      expect(manager.turns).toBe(0)
    } finally { await f.app.close() }
  })

  it.each(['http', 'mcp'] as const)('admits a small first Worker handoff through %s with saved defaults', async transport => {
    const profile = workerProfile()
    const claude = new WorkerChatManager('claude')
    chat = new OperatorChatService(repository, operators,
      configuration => configuration.harness.harness === 'claude' ? claude : manager,
      runtimeDirectory, authority, async () => profile)
    const f = await apiFixture()
    try {
      const source = await chat.create(f.writer.principal)
      await chat.send(source.id, { requestId: 'source-turn', content: 'Keep these prior details.' }, f.writer.principal)
      await waitFor(async () => (await chat.get(source.id, f.writer.principal)).turnState === 'idle')
      const saved = await saveWorkerDefaults(profile)
      const before = await chat.get(source.id, f.writer.principal)
      const input: SendOperatorMessageRequest = { requestId: 'small-fork', content: 'Continue with Claude.',
        settings: operatorChatSettings(claudeConfiguration), defaultsRevision: saved.revision,
        configurationVersionId: source.operatorConfigurationVersionId, forkExpectedRevision: before.revision }
      let response: unknown
      if (transport === 'http') {
        const http = await f.send(source.id, input)
        expect(http.statusCode, http.body).toBe(202)
        response = http.json()
      } else {
        const mcp = await f.sendMcp(source.id, input)
        expect(mcp.error, JSON.stringify(mcp)).toBeUndefined()
        expect(mcp.result?.isError, JSON.stringify(mcp)).not.toBe(true)
        response = graphRpcValue(mcp.result)
      }
      const sent = SendOperatorMessageResponseSchema.parse(response)
      expect(sent.replayed).toBe(false)
      expect(OperatorConversationStateSchema.parse(sent.state).conversation.id).toBe(`operator-fork:${input.requestId}`)
      expect(OperatorConversationStateSchema.parse(sent.state).handoff).toMatchObject({ parentConversationId: source.id, sourceHarness: 'codex' })
      await waitFor(async () => (await chat.get(OperatorConversationStateSchema.parse(sent.state).conversation.id, f.writer.principal)).turnState === 'idle')
      const child = await chat.get(OperatorConversationStateSchema.parse(sent.state).conversation.id, f.writer.principal)
      expect(child.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user', content: input.content })]))
      expect(await repository.hasTurn(child.conversation.id, input.requestId)).toBe(true)
      expect(await chat.get(source.id, f.writer.principal)).toEqual(before)
      expect(claude.turns).toBe(1)
      expect(claude.closes).toBe(1)
      expect(claude.prompts[0]).toContain('Keep these prior details.')
      expect(claude.prompts[0]).toContain(input.content)
    } finally { await f.app.close() }
  })

  it('rejects an oversized first Worker handoff before creating a child conversation or receipt', async () => {
    const settings = new PostgresFoundationSettingsRepository(pool)
    await withTransaction(pool, client => settings.updateOperatorInitialPrompt({ text: '界'.repeat(100_000) }, undefined, client))
    const profile = workerProfile()
    const claude = new WorkerChatManager('claude')
    chat = new OperatorChatService(repository, operators,
      configuration => configuration.harness.harness === 'claude' ? claude : manager,
      runtimeDirectory, authority, async () => profile)
    const f = await apiFixture()
    try {
      const source = await chat.create(f.writer.principal)
      await chat.send(source.id, { requestId: 'source-turn', content: 'Keep these prior details. '.repeat(100) }, f.writer.principal)
      await waitFor(async () => (await chat.get(source.id, f.writer.principal)).turnState === 'idle')
      const saved = await saveWorkerDefaults(profile)
      const before = await chat.get(source.id, f.writer.principal)
      const input: SendOperatorMessageRequest = { requestId: 'oversized-fork', content: 'continue '.repeat(84_000),
        settings: operatorChatSettings(claudeConfiguration), defaultsRevision: saved.revision,
        configurationVersionId: source.operatorConfigurationVersionId, forkExpectedRevision: before.revision }
      const http = await f.send(source.id, input)
      expect(http.statusCode, http.body).toBe(400)
      expect(http.json()).toMatchObject({ error: { code: 'CHAT_MESSAGE_TOO_LARGE' } })
      const mcp = await f.sendMcp(source.id, input)
      expect(mcp.result?.isError).toBe(true)
      expect(JSON.stringify(mcp.result)).toContain('CHAT_MESSAGE_TOO_LARGE')
      expect(await chat.get(source.id, f.writer.principal)).toEqual(before)
      expect(await repository.active(`operator-fork:${input.requestId}`)).toBeUndefined()
      expect(await repository.hasTurn(source.id, input.requestId)).toBe(false)
      expect(claude.turns).toBe(0)
    } finally { await f.app.close() }
  })

  it('recovers a historical oversized receipt without admitting another native turn', async () => {
    const f = await apiFixture()
    try {
      const conversation = await chat.create(f.writer.principal)
      const input = { requestId: 'historical-receipt', content: 'x'.repeat(1_000_001) }
      // Seed an older accepted record through the public persistence interface.
      await repository.beginTurn(conversation.id, input, f.writer.principal.id)
      await repository.finish(conversation.id, input.requestId, { outcome: 'succeeded' })
      const before = await chat.get(conversation.id, f.writer.principal)
      const recovery = { ...input, recovery: 'receipt' as const }
      const http = await f.send(conversation.id, recovery)
      expect(http.statusCode, http.body).toBe(200)
      expect(http.json()).toMatchObject({ replayed: true })
      const mcp = await f.sendMcp(conversation.id, recovery)
      expect(mcp.result?.isError).not.toBe(true)
      expect(graphRpcValue(mcp.result)).toMatchObject({ replayed: true })
      const fresh = await f.send(conversation.id, { ...input, requestId: 'new-oversized-request' })
      expect(fresh.statusCode).toBe(400)
      expect(await chat.get(conversation.id, f.writer.principal)).toEqual(before)
      expect(await repository.hasTurn(conversation.id, 'new-oversized-request')).toBe(false)
      expect(manager.turns).toBe(0)
    } finally { await f.app.close() }
  })
})
