import type { OperatorServices } from '../src/mcp/operator/types.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { SessionControlStore } from '../src/modules/conversations/sessionControls/store.js'
import { SessionPreferencesSchema } from '@foreman-code/contracts'
import { SessionControlStateSchema, unavailableSessionControls } from '@foreman-code/contracts'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { DEFAULT_HARNESS_DEFAULTS, type NativeSessionReference, type ContextSnapshot } from '@foreman-code/contracts'
import { describe, expect, it } from 'vitest'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { buildApp } from '../src/app.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'
import { registerOperatorChatFixture, type OperatorChatFixture, claudeConfiguration, ChatManager, waitFor } from './helpers/operatorChatFixture.js'

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
  it('saves future budgets through authenticated MCP independently of current history and denies callers without permission', async () => {
    const writer = await access.issue({ name: 'default settings owner', audience: 'operator', grants: owner.grants,
      expiresAt: new Date(Date.now() + 600000) })
    const denied = await access.issue({ name: 'chat writer without defaults permission', audience: 'operator',
      grants: [{ actions: ['operator_chat:read', 'operator_chat:write'], scope: {} }],
      expiresAt: new Date(Date.now() + 600000) })
    Object.assign(manager, {
      sessionControlCapabilities: async () => ({ ...unavailableSessionControls('profile'), model: 'fixture',
        contextBudgets: [100000, 200000, 300000], modelCapacity: 200000 }),
      contextSnapshot: (session: NativeSessionReference): ContextSnapshot => ({ nativeSessionId: session.nativeSessionId,
        model: 'fixture', generation: 'connection', sequence: 1, source: 'codex', accuracy: 'native',
        usedTokens: 150000, capacityTokens: 200000, lifetimeTokens: 150000, cost: null,
        observedAt: new Date().toISOString(), stale: false }),
    })
    const deniedConversation = await chat.create(denied.principal)
    const conversation = await chat.create(writer.principal)
    await chat.send(conversation.id, { requestId: randomUUID(), content: 'Existing history' }, writer.principal)
    await waitFor(async () => (await chat.get(conversation.id, writer.principal)).turnState === 'idle')
    const app = buildApp({ logger: false,
      readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access, services: { operatorChat: chat,
        commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
    registerOperatorChatRoutes(app, chat)
    const client = new Client({ name: 'future-default-owner', version: '1' })
    const limited = new Client({ name: 'future-default-denied', version: '1' })
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { authProvider: { token: async () => writer.token } }))
      await limited.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { authProvider: { token: async () => denied.token } }))
      const target = { conversationId: conversation.id }
      const before = SessionControlStateSchema.parse(decodeMcpToolResult((await client.callTool({
        name: 'operator_chat_controls_get', arguments: target }))))
      expect(before.context?.usedTokens).toBe(150000)
      const preferences = SessionPreferencesSchema.parse({ contextBudget: 100000 })
      const request = { kind: 'save-default', preferences, expectedRevision: before.revision, requestId: randomUUID() }
      const result = await client.callTool({ name: 'operator_chat_controls_update', arguments: { ...target, request } })
      expect(result.isError).not.toBe(true)
      const saved = SessionControlStateSchema.parse(decodeMcpToolResult(result))
      expect(saved.defaults).toEqual(preferences)
      expect(saved.desired).toEqual(before.desired)
      const deniedBefore = SessionControlStateSchema.parse(decodeMcpToolResult((await limited.callTool({
        name: 'operator_chat_controls_get', arguments: { conversationId: deniedConversation.id } }))))
      await expectMcpAccessDenied(limited.callTool({ name: 'operator_chat_controls_update', arguments: { conversationId: deniedConversation.id,
        request: { ...request, expectedRevision: 0, requestId: randomUUID(),
          preferences: SessionPreferencesSchema.parse({ contextBudget: 200000 }) } } }))
      const deniedAfter = SessionControlStateSchema.parse(decodeMcpToolResult((await limited.callTool({
        name: 'operator_chat_controls_get', arguments: { conversationId: deniedConversation.id } }))))
      expect(deniedAfter.defaults).toEqual(deniedBefore.defaults)
      expect(deniedAfter.revision).toBe(deniedBefore.revision)
      const persisted = SessionControlStateSchema.parse(decodeMcpToolResult((await client.callTool({
        name: 'operator_chat_controls_get', arguments: target }))))
      expect(persisted.defaults).toEqual(preferences)
      const headers = { authorization: `Bearer ${writer.token}` }
      const url = `/api/operator/conversations/${conversation.id}/session-controls`
      const lowering = await app.inject({ method: 'POST', url, headers,
        payload: { ...request, kind: 'preferences', expectedRevision: persisted.revision, requestId: randomUUID() } })
      expect(lowering.statusCode, lowering.body).toBe(422)
      expect(lowering.json().error.code).toBe('SESSION_BUDGET_TOO_SMALL')
      const oversized = await client.callTool({ name: 'operator_chat_controls_update', arguments: { ...target,
        request: { ...request, expectedRevision: persisted.revision, requestId: randomUUID(),
          preferences: SessionPreferencesSchema.parse({ contextBudget: 300000 }) } } })
      expect(oversized.isError).toBe(true)
      const fresh = await chat.create(writer.principal)
      expect((await chat.readSessionControls(fresh.id, writer.principal)).desired).toEqual(preferences)
    } finally {
      await Promise.all([client.close(), limited.close()])
      await app.close()
    }
  }, 30000)

  it('retains desired preferences and recovers their receipt after native application fails', async () => {
    const conversation = await chat.create(owner)
    await chat.send(conversation.id, { requestId: randomUUID(), content: 'Seed this session' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
    const desired = SessionPreferencesSchema.parse({ autoCompact: 'off' })
    let applications = 0
    Object.assign(manager, {
      sessionControlCapabilities: async () => ({ ...unavailableSessionControls('profile'), autoCompact: { supported: true, reason: null } }),
      applySessionPreferences: async () => { applications++; throw new Error('Native response lost') },
    })
    const before = await chat.readSessionControls(conversation.id, owner)
    const request = { kind: 'preferences' as const, preferences: desired,
      requestId: randomUUID(), expectedRevision: before.revision }
    await expect(chat.changeSessionControls(conversation.id, request, owner)).rejects.toMatchObject({ code: 'SESSION_CONTROL_UNCONFIRMED' })
    await chat.shutdown()
    chat = new OperatorChatService(repository, operators, () => manager, runtimeDirectory, authority)
    expect((await chat.readSessionControls(conversation.id, owner)).desired).toEqual(desired)
    expect((await chat.changeSessionControls(conversation.id, request, owner)).desired).toEqual(desired)
    expect(applications).toBe(1)
  }, 30000)

  it('replays a completed settings receipt after another caller supersedes its settings', async () => {
    const conversation = await chat.create(owner)
    const before = await chat.readSessionControls(conversation.id, owner)
    const request = { kind: 'preferences' as const, preferences: SessionPreferencesSchema.parse({}),
      requestId: randomUUID(), expectedRevision: before.revision }
    await chat.changeSessionControls(conversation.id, request, owner)
    const updated = await chat.readSessionControls(conversation.id, owner)
    await chat.changeSessionControls(conversation.id, { ...request, requestId: randomUUID(),
      expectedRevision: updated.revision }, owner)
    const current = await chat.readSessionControls(conversation.id, owner)
    const replay = await chat.changeSessionControls(conversation.id, request, owner)
    expect(replay.lastRequestId).toBe(current.lastRequestId)
    expect(replay.completedRequestId).toBe(request.requestId)
    expect(replay.revision).toBe(current.revision)
  })

  it('reads persisted controls after restart with read-only ownership and no credentials', async () => {
    const conversation = await chat.create(owner)
    const before = await chat.readSessionControls(conversation.id, owner)
    await chat.send(conversation.id, { requestId: randomUUID(), content: 'Seed this session' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
    await chat.shutdown()
    await pool.query('update management_principals set grants=$2::jsonb where id=$1',
      [owner.id, JSON.stringify([{ actions: ['operator_chat:read'], scope: {} }])])
    authority.prepare = async () => { throw new Error('Read-only observation tried to issue a credential') }
    chat = new OperatorChatService(repository, operators, () => manager, runtimeDirectory, authority)
    const read = await chat.readSessionControls(conversation.id, await access.currentOperator(owner.id))
    expect(read.desired).toEqual(before.desired)
    expect(manager.attachments).toBe(0)
  }, 30000)

  it.each(['codex', 'claude'] as const)(
    'recovers cold %s compaction through authenticated reads without execution credentials', async harness => {
      await operators.update(harness === 'claude' ? claudeConfiguration : DEFAULT_HARNESS_DEFAULTS.codex, (await operators.ensure()).configuration.id)
      manager = new ChatManager(harness)
      chat = new OperatorChatService(repository, operators, () => manager, runtimeDirectory, authority)
      const conversation = await chat.create(owner)
      await chat.send(conversation.id, { requestId: randomUUID(), content: 'Seed session' }, owner)
      await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
      Object.assign(manager, {
        sessionControlCapabilities: async () => ({ ...unavailableSessionControls('profile'), compact: { supported: true, reason: null } }),
        compactSession: async (session: NativeSessionReference, input: import('../src/modules/harnesses/port.js').NativeCompactInput) => {
          await input.onDispatch?.()
          return { requestId: input.requestId, nativeSessionId: session.nativeSessionId, nativeOperationId: 'compact-turn',
            status: 'uncertain', message: 'Completion notification lost', beforeTokens: 100, observedAt: new Date().toISOString() }
        },
      })
      const before = await chat.readSessionControls(conversation.id, owner)
      const compact = { kind: 'compact' as const, requestId: randomUUID(), expectedRevision: before.revision }
      await chat.changeSessionControls(conversation.id, compact, owner)
      await chat.shutdown()
      const reader = await access.issue({ name: 'cold control reader', audience: 'operator',
        grants: [{ actions: ['operator_chat:read'], scope: {} }], expiresAt: new Date(Date.now() + 600000) })
      await pool.query('update operator_conversations set owner_principal_id=$2 where id=$1', [conversation.id, reader.principal.id])
      let reads = 0
      const resolver = Object.assign(() => { throw new Error('Read allocated an execution manager') }, {
        recoverCompaction: async (_configuration: unknown, _id: string, session: NativeSessionReference,
          _start: unknown, state: import('@foreman-code/contracts').CompactionState) => {
          reads++
          expect(session.nativeSessionId).toBe(before.nativeSessionId)
          return { ...state, status: 'completed' as const, message: 'Context compacted' }
        },
      })
      authority.prepare = async () => { throw new Error('Read issued an execution credential') }
      chat = new OperatorChatService(repository, operators, resolver, runtimeDirectory, authority)
      const app = buildApp({
        readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
        operator: {
          access,
          services: {
            operatorChat: chat,
            commands: new PostgresCommandCoordinator(pool),
          } as unknown as OperatorServices,
        },
      })
      registerOperatorChatRoutes(app, chat)
      const client = new Client({ name: 'cold-control-reader', version: '1' })
      try {
        const address = await app.listen({ host: '127.0.0.1', port: 0 })
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
          authProvider: { token: async () => reader.token },
        }))
        const recovered = await client.callTool({ name: 'operator_chat_controls_get', arguments: { conversationId: conversation.id } })
        expect(recovered.isError).not.toBe(true)
        expect(SessionControlStateSchema.parse(decodeMcpToolResult(recovered)).compaction?.status).toBe('completed')
        const denied = await client.callTool({ name: 'operator_chat_controls_update', arguments: { conversationId: conversation.id,
          request: { kind: 'compact', requestId: randomUUID(), expectedRevision: before.revision } } })
        expect(denied.isError).toBe(true)
        const denial = (denied.content as Array<{ type: string; text: string }>).find(item => item.type === 'text')
        expect(JSON.parse(denial!.text)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
        const audit = await pool.query<{ outcome: string }>(
          'select outcome from management_audit where principal_id=$1 and source=$2 and action=$3',
          [reader.principal.id, 'mcp', 'operator_chat_controls_update'])
        expect(audit.rows).toEqual([{ outcome: 'denied' }])
        const http = await app.inject({ method: 'GET', url: `/api/operator/conversations/${conversation.id}/session-controls`,
          headers: { authorization: `Bearer ${reader.token}` } })
        expect(http.statusCode).toBe(200)
        expect(SessionControlStateSchema.parse(http.json()).compaction?.status).toBe('completed')
        expect(reads).toBe(1)
      } finally { await client.close(); await app.close() }
    })

  it('commits defaults only for the command that wins a concurrent revision update', async () => {
    const conversation = await chat.create(owner)
    const binding = { conversationId: conversation.id, principalId: owner.id, defaultSubject: 'application-operator',
      profileKey: 'race-profile', busyReason: null,
      pendingCapabilities: { ...unavailableSessionControls('race-profile'), autoCompact: { supported: true, reason: null } } }
    const first = new SessionControlStore(pool, 'operator')
    const second = new SessionControlStore(pool, 'operator')
    const before = await first.read(binding)
    const preferences = SessionPreferencesSchema.parse({ autoCompact: 'off' })
    const results = await Promise.allSettled([first.execute(owner, 'mcp', {
      kind: 'save-default', preferences, requestId: randomUUID(), expectedRevision: before.revision,
    }, async () => binding), second.execute(owner, 'http', {
      kind: 'preferences', preferences: SessionPreferencesSchema.parse({ autoCompact: 'on' }),
      requestId: randomUUID(), expectedRevision: before.revision,
    }, async () => binding)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const persisted = await new SessionControlStore(pool, 'operator').read(binding)
    expect(persisted.defaults).toEqual(results[0]!.status === 'fulfilled' ? preferences : before.defaults)
  }, 30000)

  it('admits Plan and preferences before the first native message without creating a turn', async () => {
    const conversation = await chat.create(owner)
    const empty = await chat.readSessionControls(conversation.id, owner)
    expect(empty.nativeSessionId).toBeNull()
    expect(manager.sessions).toBe(0)
    const plan = await chat.changeSessionControls(conversation.id, { kind: 'mode', mode: 'plan',
      requestId: randomUUID(), expectedRevision: empty.revision }, owner)
    expect(plan.desiredMode).toBe('plan')
    expect(plan.appliedMode).toBeNull()
    const noop = await chat.changeSessionControls(conversation.id, { kind: 'compact', requestId: randomUUID(),
      expectedRevision: plan.revision }, owner)
    expect(noop.compaction?.status).toBe('no-op')
    expect(manager.sessions).toBe(0)
    expect(manager.turns).toBe(0)
    await chat.send(conversation.id, { requestId: randomUUID(), content: 'First planned task' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
    expect(manager.modes).toEqual(['plan'])
    expect(manager.turns).toBe(1)
  }, 30000)

})
