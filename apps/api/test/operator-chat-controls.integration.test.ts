import type { OperatorServices } from '../src/mcp/operator/types.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { SessionPreferencesSchema } from '@foreman-code/contracts'
import { SessionControlStateSchema, unavailableSessionControls } from '@foreman-code/contracts'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { DEFAULT_HARNESS_DEFAULTS, type ExecutionResult, type NativeSessionReference, type ContextSnapshot } from '@foreman-code/contracts'
import { describe, expect, it, vi } from 'vitest'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { nativeCorrelation } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { buildApp } from '../src/app.js'
import { DomainError } from '../src/modules/errors.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'
import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'
import { registerOperatorChatFixture, type OperatorChatFixture, ChatManager, waitFor } from './helpers/operatorChatFixture.js'

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
  it.each(['codex', 'claude'] as const)('reads saved %s controls through HTTP and MCP after unload and restart', async harness => {
    const configuration = harness === 'claude' ? {
      harness: 'claude' as const, model: 'fixture-model', authMode: 'subscription' as const,
      configDirectory: '/fixture/profile', permissionMode: 'default' as const, sandbox: 'danger-full-access' as const,
      tools: [], permissionRules: [], instructions: '', mcpServers: {},
    } : DEFAULT_HARNESS_DEFAULTS[harness]
    await operators.update(configuration, (await operators.ensure()).configuration.id)
    manager = new ChatManager(harness)
    chat = new OperatorChatService(repository, operators, () => manager, runtimeDirectory, authority)
    let unloaded = false
    const capabilities = { ...unavailableSessionControls('fixture'), model: 'fixture-model',
      plan: { supported: true, reason: null }, compact: { supported: true, reason: null } }
    const nativeCapabilities = vi.fn(async () => {
      const code = { codex: 'CODEX_SESSION_UNAVAILABLE', claude: 'CLAUDE_SESSION_UNAVAILABLE' }[harness]
      if (unloaded) throw new HarnessExecutionError(code, 'Native runtime unloaded')
      return capabilities
    })
    Object.assign(manager, { sessionControlCapabilities: nativeCapabilities,
      contextSnapshot: (session: NativeSessionReference): ContextSnapshot => ({
        nativeSessionId: session.nativeSessionId, model: 'fixture-model', generation: 'connection', sequence: 1,
        source: harness, accuracy: 'native', usedTokens: 100, capacityTokens: 200000, lifetimeTokens: 100,
        cost: null, observedAt: new Date().toISOString(), stale: false,
      }) })
    const writer = await access.issue({ name: 'control read owner', audience: 'operator',
      grants: [{ actions: ['operator_chat:read', 'operator_chat:write'], scope: {} }],
      expiresAt: new Date(Date.now() + 600000) })
    const denied = await access.issue({ name: 'denied control reader', audience: 'operator', grants: [],
      expiresAt: new Date(Date.now() + 600000) })
    const conversation = await chat.create(writer.principal)
    await chat.send(conversation.id, { requestId: randomUUID(), content: 'Complete a native turn' }, writer.principal)
    await waitFor(async () => (await chat.get(conversation.id, writer.principal)).turnState === 'idle')
    const discovered = await chat.readSessionControls(conversation.id, writer.principal)
    const attaches = vi.spyOn(manager, 'attachSession')
    const saved = await chat.changeSessionControls(conversation.id, { kind: 'mode', mode: 'plan',
      requestId: randomUUID(), expectedRevision: discovered.revision }, writer.principal)
    expect(attaches).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: saved.nativeSessionId }),
      expect.objectContaining({ correlationId: nativeCorrelation(conversation.id, 'session-control') }),
      expect.any(AbortSignal))
    const history = (await chat.get(conversation.id, writer.principal)).messages
    const attachmentsBeforeReads = manager.attachments
    unloaded = true

    async function checkReads(service: OperatorChatService) {
      const services = {
        operatorChat: service, commands: new PostgresCommandCoordinator(pool),
      } as unknown as OperatorServices
      const app = buildApp({ logger: false,
        readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access, services } })
      registerOperatorChatRoutes(app, service)
      const client = new Client({ name: 'saved-controls-reader', version: '1' })
      const deniedClient = new Client({ name: 'denied-saved-controls-reader', version: '1' })
      try {
        const address = await app.listen({ host: '127.0.0.1', port: 0 })
        const url = `/api/operator/conversations/${conversation.id}/session-controls`
        const http = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${writer.token}` } })
        expect(http.statusCode).toBe(200)
        expect(SessionControlStateSchema.parse(http.json())).toMatchObject({ desiredMode: 'plan',
          revision: saved.revision, capabilities, nativeStatus: 'resume-required',
          nativeSessionId: saved.nativeSessionId, context: { usedTokens: 100, stale: true } })
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
          { authProvider: { token: async () => writer.token } }))
        const mcp = await client.callTool({ name: 'operator_chat_controls_get', arguments: { conversationId: conversation.id } })
        expect(mcp.isError).not.toBe(true)
        expect(SessionControlStateSchema.parse(decodeMcpToolResult(mcp))).toEqual(SessionControlStateSchema.parse(http.json()))
        expect((await app.inject({ method: 'GET', url,
          headers: { authorization: `Bearer ${denied.token}` } })).statusCode).toBe(403)
        await deniedClient.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
          { authProvider: { token: async () => denied.token } }))
        await expectMcpAccessDenied(deniedClient.callTool({ name: 'operator_chat_controls_get',
          arguments: { conversationId: conversation.id } }))
        expect((await service.get(conversation.id, writer.principal)).messages).toEqual(history)
        const persisted = await pool.query<{ record: unknown }>(
          'select record from conversation_session_controls where conversation_id=$1', [conversation.id])
        expect(SessionControlStateSchema.parse(persisted.rows[0]!.record)).toMatchObject({ desiredMode: 'plan', capabilities })
        expect(manager.attachments).toBe(attachmentsBeforeReads)
      } finally {
        await client.close()
        await deniedClient.close()
        await app.close()
      }
    }

    await checkReads(chat)
    await chat.shutdown()
    chat = new OperatorChatService(repository, operators, () => manager, runtimeDirectory, authority)
    const nativeReads = nativeCapabilities.mock.calls.length
    await checkReads(chat)
    expect(nativeCapabilities).toHaveBeenCalledTimes(nativeReads)
    expect(manager.turns).toBe(1)
    expect(manager.attachments).toBe(attachmentsBeforeReads)
  })

  it('reads stored controls while terminal cleanup still owns the native manager', async () => {
    const conversation = await chat.create(owner)
    const requestId = randomUUID()
    let disposalStarted = false
    let releaseCleanup!: () => void
    const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve })
    const context = (session: NativeSessionReference): ContextSnapshot => {
      if (disposalStarted) throw new DomainError('NATIVE_MANAGER_DISPOSED', 'The native manager is closing.', 409)
      return { nativeSessionId: session.nativeSessionId, model: 'fixture-model', generation: 'fixture', sequence: 1,
        source: 'codex', accuracy: 'native', usedTokens: 42, capacityTokens: null, lifetimeTokens: 42,
        cost: null, observedAt: new Date().toISOString(), stale: false }
    }
    manager.autoFinish = false
    Object.assign(manager, {
      sessionControlCapabilities: async () => {
        if (disposalStarted) throw new DomainError('NATIVE_MANAGER_DISPOSED', 'The native manager is closing.', 409)
        return { ...unavailableSessionControls('profile'), model: 'fixture-model',
          compact: { supported: true, reason: null } }
      },
      contextSnapshot: context,
      dispose: async () => { disposalStarted = true; await cleanup },
    })
    try {
      await chat.send(conversation.id, { requestId, content: 'Seed this session' }, owner)
      await waitFor(async () => !!(await chat.readSessionControls(conversation.id, owner)).nativeSessionId)
      const before = await chat.readSessionControls(conversation.id, owner)
      expect(before.context).toMatchObject({ usedTokens: 42, stale: false })
      manager.finish(nativeCorrelation(conversation.id, requestId))
      await waitFor(async () => disposalStarted)
      const closing = await chat.readSessionControls(conversation.id, owner)
      expect(closing.nativeSessionId).toBe(before.nativeSessionId)
      expect(closing.context).toMatchObject({ usedTokens: 42, stale: true })
      expect(closing.busyReason).not.toBeNull()
      expect(manager.sessions).toBe(1)
    } finally {
      releaseCleanup()
    }
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
  }, 30000)

  it('releases definite preflight failures and crash-left reservations without native dispatch', async () => {
    const conversation = await chat.create(owner)
    await chat.send(conversation.id, { requestId: randomUUID(), content: 'Seed this session' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
    Object.assign(manager, {
      sessionControlCapabilities: async () => ({ ...unavailableSessionControls('profile'), compact: { supported: true, reason: null } }),
      compactSession: async () => { throw new Error('Native transcript preflight failed') },
    })
    const before = await chat.readSessionControls(conversation.id, owner)
    const rejected = await chat.changeSessionControls(conversation.id, { kind: 'compact',
      requestId: randomUUID(), expectedRevision: before.revision }, owner)
    expect(rejected.compaction?.status).toBe('failed')
    const reservation = { ...rejected, compaction: { ...rejected.compaction!, status: 'accepted',
      dispatchPhase: 'reserved', reservationOwner: 'previous-process' } }
    await pool.query('update conversation_session_controls set record=$2::jsonb where conversation_id=$1',
      [conversation.id, JSON.stringify(reservation)])
    await chat.shutdown()
    chat = new OperatorChatService(repository, operators, () => manager, runtimeDirectory, authority)
    const recovered = await chat.readSessionControls(conversation.id, owner)
    expect(recovered.compaction?.status).toBe('failed')
    await chat.send(conversation.id, { requestId: randomUUID(), content: 'Recovered task' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
  }, 30000)

  it('merges settings acknowledgment with concurrent HTTP controls without losing the native receipt', async () => {
    const issued = await access.issue({ name: 'concurrent settings owner', audience: 'operator',
      grants: owner.grants, expiresAt: new Date(Date.now() + 600000) })
    const conversation = await chat.create(issued.principal)
    await chat.send(conversation.id, { requestId: randomUUID(), content: 'Seed this session' }, issued.principal)
    await waitFor(async () => (await chat.get(conversation.id, issued.principal)).turnState === 'idle')
    Object.assign(manager, { sessionControlCapabilities: async () => ({ ...unavailableSessionControls('profile'),
      plan: { supported: true, reason: null }, contextBudgets: [100000], modelCapacity: 200000 }) })
    const app = buildApp({ logger: false,
      readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access, services: { operatorChat: chat,
        commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
    registerOperatorChatRoutes(app, chat)
    const client = new Client({ name: 'concurrent-session-settings', version: '1' })
    const query = pool.query.bind(pool)
    const start = manager.startTurn.bind(manager)
    let acknowledgeSettings = false
    let paused = false
    let reached!: () => void
    let resume!: () => void
    const writing = new Promise<void>(resolve => { reached = resolve })
    const released = new Promise<void>(resolve => { resume = resolve })
    manager.startTurn = async function* (session, input, signal) {
      const callback = input.onSettingsApplied
      yield* start(session, { ...input, onSettingsApplied: async () => {
        acknowledgeSettings = true
        try { await callback?.() } finally { acknowledgeSettings = false }
      } }, signal)
    }
    pool.query = (async (text: string, values?: unknown[]) => {
      if (!paused && acknowledgeSettings && text.includes('update conversation_session_controls')) {
        paused = true
        reached()
        await released
      }
      return query(text, values)
    }) as typeof pool.query
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { authProvider: { token: async () => issued.token } }))
      const requestId = randomUUID()
      await chat.send(conversation.id, { requestId, content: 'Planned task', sessionMode: 'plan' }, issued.principal)
      await writing
      const path = `/api/operator/conversations/${conversation.id}/session-controls`
      const headers = { authorization: `Bearer ${issued.token}` }
      const read = await app.inject({ method: 'GET', url: path, headers })
      expect(read.statusCode, read.body).toBe(200)
      const before = SessionControlStateSchema.parse(read.json())
      const off = await app.inject({ method: 'POST', url: path, headers,
        payload: { kind: 'mode', mode: 'regular', expectedRevision: before.revision, requestId: randomUUID() } })
      expect(off.statusCode, off.body).toBe(200)
      const changed = await client.callTool({ name: 'operator_chat_controls_update', arguments: {
        conversationId: conversation.id,
        request: { kind: 'preferences', preferences: SessionPreferencesSchema.parse({ contextBudget: 100000 }),
          expectedRevision: off.json().revision, requestId: randomUUID() } } })
      expect(changed.isError).not.toBe(true)
      resume()
      await waitFor(async () => (await chat.get(conversation.id, issued.principal)).turnState === 'idle')
      const row = (await query<{ native_turn_id: string | null; result: ExecutionResult }>(
        'select native_turn_id,result from operator_conversation_turns where conversation_id=$1 and request_id=$2',
        [conversation.id, requestId])).rows[0]
      expect(row?.result.outcome).toBe('succeeded')
      expect(row?.native_turn_id).toBeTruthy()
      const settings = SessionControlStateSchema.parse((await app.inject({ method: 'GET', url: path, headers })).json())
      expect(settings).toMatchObject({ desiredMode: 'regular', appliedMode: 'plan', desired: { contextBudget: 100000 } })
    } finally {
      resume()
      await chat.shutdown()
      pool.query = query
      await client.close()
      await app.close()
    }
  }, 30000)

})
