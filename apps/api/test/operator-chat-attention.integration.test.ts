import { readUntil } from './helpers/observableCondition.js'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { NativeHarnessEventSchema, unavailableSessionControls, type NativeSessionReference } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { OperatorChatService, PostgresOperatorConversationRepository,
  type OperatorChatAuthority } from '../src/modules/conversations/operatorChat.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeTurnInput } from '../src/modules/harnesses/port.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'

class SessionManager implements NativeHarnessSessionManager {
  readonly harness = 'codex' as const
  attachments = 0
  private nativeHistory: NativeHistory = { events: [], pendingInteractions: [] }

  capabilities(): ReturnType<NativeHarnessSessionManager['capabilities']> {
    throw new Error('Provider capabilities are not used by this fixture.')
  }
  inspectMcp(): ReturnType<NativeHarnessSessionManager['inspectMcp']> {
    throw new Error('MCP setup is supplied by the fixture authority.')
  }
  async createSession(): Promise<NativeSessionReference> {
    return { harness: 'codex', providerVersion: 'fixture', nativeSessionId: 'native-session' }
  }
  async attachSession(session: NativeSessionReference) {
    this.attachments++
    return session
  }
  async *startTurn(_session: NativeSessionReference, input: NativeTurnInput) {
    await input.onSubmitted?.('native-turn')
    this.nativeHistory = { correlationId: input.clientCorrelationId, nativeTurnId: 'native-turn',
      events: [], pendingInteractions: [], nativeMessageId: 'native-answer',
      terminalResult: { outcome: 'succeeded', output: { text: 'Finished' } } }
    yield NativeHarnessEventSchema.parse({ sequence: 1, type: 'assistant.delta',
      occurredAt: new Date().toISOString(), payload: { text: 'Finished' } })
  }
  async pending() { return undefined }
  async respond() {}
  async cancel() { return false }
  async history() { return this.nativeHistory }
  async reconcile() { return this.nativeHistory }
  async close() {}
  async dispose() {}
}

const connectionString = process.env.TEST_DATABASE_URL
let schema: string
let admin: pg.Pool
let pool: pg.Pool
let access: PostgresAccessService
let owner: ManagementPrincipal
let chat: OperatorChatService
let manager: SessionManager
let runtimeDirectory: string

beforeEach(async () => {
  runtimeDirectory = await privateFixtureDirectory('operator-attention-')
  schema = `attention_${randomUUID().replaceAll('-', '')}`
  admin = new pg.Pool({ connectionString })
  await createFixtureSchema(admin, schema)
  pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 2_000,
    options: `-c search_path=${schema}` })
  await applyApplicationMigrations(pool)
  access = new PostgresAccessService(pool)
  owner = (await access.issue({ name: 'attention owner', audience: 'operator',
    grants: [{ actions: ['operator_chat:read', 'operator_chat:write', 'operator_chat:respond'], scope: {} }],
    expiresAt: new Date(Date.now() + 600_000) })).principal
  manager = new SessionManager()
  const authority: OperatorChatAuthority = {
    current: id => access.currentOperator(id), assertConfiguration() {},
    setup: async () => ({ harness: 'codex', status: 'configured', endpoint: 'http://127.0.0.1:3000/mcp',
      checkedAt: new Date().toISOString() }),
    prepare: async (_manager, configuration) => ({ agentId: configuration.operatorId, variables: {} }),
    release: async () => {},
  }
  chat = new OperatorChatService(new PostgresOperatorConversationRepository(pool),
    new PostgresOperatorRepository(pool), () => manager, runtimeDirectory, authority)
}, 60_000)

afterEach(async () => {
  try { await chat?.shutdown() }
  finally {
    try { await pool?.end() }
    finally {
      try { if (admin) await dropFixtureSchema(admin, schema) }
      finally {
        try { await admin?.end() }
        finally { await rm(runtimeDirectory, { recursive: true, force: true }) }
      }
    }
  }
}, 60_000)

async function waitFor(id: string, check: () => Promise<boolean>) {
  await readUntil(check, ready => ready, { timeoutMs: 2000, description: 'the native turn to finish',
    subscribe: changed => chat.events.subscribe(id, changed) })
}

describe.skipIf(!connectionString)('Operator conversation attention', () => {
  it('includes a standalone native request discovered after session controls resume a completed chat', async () => {
    const issued = await access.issue({ name: 'standalone request owner', audience: 'operator', grants: owner.grants,
      expiresAt: new Date(Date.now() + 600_000) })
    const denied = await access.issue({ name: 'denied request reader', audience: 'operator', grants: [],
      expiresAt: new Date(Date.now() + 600_000) })
    const conversation = await chat.create(issued.principal)
    await chat.send(conversation.id, { requestId: randomUUID(), content: 'Finish a turn' }, issued.principal)
    await waitFor(conversation.id, async () => (await chat.get(conversation.id, issued.principal)).turnState === 'idle')
    Object.assign(manager, {
      sessionControlCapabilities: async () => ({ ...unavailableSessionControls('fixture'), model: 'fixture',
        plan: { supported: true, reason: null } }),
    })
    const controls = await chat.readSessionControls(conversation.id, issued.principal)
    await chat.changeSessionControls(conversation.id, { kind: 'mode', mode: 'plan',
      requestId: randomUUID(), expectedRevision: controls.revision }, issued.principal)
    expect(manager.attachments).toBe(1)
    let pending = true
    const nativeRequestId = 'standalone-request'
    Object.assign(manager, {
      pending: async (session: NativeSessionReference) => pending ? {
        session, turn: { nativeRequestId }, nativeRequestType: 'mcpServer/elicitation/request',
        request: { message: 'Allow this request?' }, responseOptions: [{
          optionId: 'accept', label: 'Allow', semantic: 'approve_once', persistence: 'request',
          affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false,
        }],
      } : undefined,
      inspectResponseAvailability: async (session: NativeSessionReference) => ({
        nativeSessionId: session.nativeSessionId, nativeRequestId, nativeRequestType: 'mcpServer/elicitation/request',
        qualified: true, generation: 'resumed-session', state: 'available', path: 'live_callback', reason: 'live_callback',
      }),
      respond: async () => { pending = false },
    })
    const app = buildApp({ logger: false,
      readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access, services: { operatorChat: chat,
        commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
    registerOperatorChatRoutes(app, chat)
    const client = new Client({ name: 'standalone-request-reader', version: '1' })
    const deniedClient = new Client({ name: 'denied-request-reader', version: '1' })
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { authProvider: { token: async () => issued.token } }))
      await deniedClient.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { authProvider: { token: async () => denied.token } }))
      const readback = decodeMcpToolResult(await client.callTool({ name: 'operator_chat_get',
        arguments: { conversationId: conversation.id } }))
      expect(readback).toMatchObject({ activeRequestId: null, responseDelivery: 'offered',
        pendingInteraction: { turn: { nativeRequestId } }, responseAvailability: { available: true } })
      await expectMcpAccessDenied(deniedClient.callTool({ name: 'operator_chat_get',
        arguments: { conversationId: conversation.id } }))
      const headers = { authorization: `Bearer ${issued.token}` }
      const summaries = await app.inject({ method: 'GET', url: '/api/operator/conversations/summaries?limit=1', headers })
      expect(summaries.statusCode).toBe(200)
      expect(summaries.json()).toMatchObject({
        conversations: [{ conversationId: conversation.id, activeRequestId: null, needsAttention: true }],
        attention: [{ conversationId: conversation.id, activeRequestId: null, needsAttention: true }],
      })
      const deniedSummaries = await app.inject({ method: 'GET',
        url: '/api/operator/conversations/summaries?limit=1',
        headers: { authorization: `Bearer ${denied.token}` } })
      expect(deniedSummaries.statusCode).toBe(403)
      expect(await chat.summaries(owner, undefined, true)).toEqual([])
      const answered = await client.callTool({ name: 'operator_chat_respond', arguments: {
        conversationId: conversation.id, request: { commandId: randomUUID(), requestId: nativeRequestId,
          nativeRequestId, optionId: 'accept' },
      } })
      expect(answered.isError).not.toBe(true)
      const resolved = decodeMcpToolResult(await client.callTool({ name: 'operator_chat_get',
        arguments: { conversationId: conversation.id } }))
      expect(resolved).toMatchObject({ activeRequestId: null })
      expect(resolved).not.toHaveProperty('pendingInteraction')
      expect(resolved).not.toHaveProperty('responseDelivery')
      expect(resolved).not.toHaveProperty('responseAvailability')
      expect(await chat.summaries(issued.principal, undefined, true)).toEqual([])
      expect(await chat.summaries(issued.principal)).toEqual([
        expect.objectContaining({ conversationId: conversation.id, needsAttention: false }),
      ])
    } finally {
      await client.close()
      await deniedClient.close()
      await app.close()
    }
  }, 60_000)
})
