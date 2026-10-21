import type { OperatorServices } from '../src/mcp/operator/types.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { SessionControlStateSchema, unavailableSessionControls } from '@foreman-code/contracts'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { type NativeSessionReference, type ContextSnapshot } from '@foreman-code/contracts'
import { describe, expect, it } from 'vitest'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { nativeCorrelation } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { buildApp } from '../src/app.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'
import { CodexRpcError } from '../src/modules/harnesses/codexStdioTransport.js'
import { registerOperatorChatFixture, type OperatorChatFixture, waitFor } from './helpers/operatorChatFixture.js'

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
  it.each([
    { outcome: 'success', status: 'completed', error: null },
    { outcome: 'Codex rejection', status: 'failed',
      error: new CodexRpcError('thread/compact/start', 'compact', false, 'REJECTED') },
    { outcome: 'Claude non-delivery', status: 'failed',
      error: Object.assign(new Error('Not delivered'), { deliveryState: 'not-delivered' }) },
    { outcome: 'timeout', status: 'uncertain', error: new DOMException('Response timed out', 'TimeoutError') },
    { outcome: 'disconnect', status: 'uncertain', error: new Error('Native connection closed') },
  ] as const)('shares authenticated HTTP/MCP compaction $outcome, retries and persisted readback', async testCase => {
    const writer = await access.issue({ name: 'Session controls writer', audience: 'operator',
      grants: [{ actions: ['operator_chat:read', 'operator_chat:write', 'settings:update'], scope: {} }],
      expiresAt: new Date(Date.now() + 60000) })
    const denied = await access.issue({ name: 'Denied controls caller', audience: 'operator', grants: [],
      expiresAt: new Date(Date.now() + 60000) })
    let compactions = 0
    let confirmed = false
    Object.assign(manager, {
      async sessionControlCapabilities() {
        return { ...unavailableSessionControls('fixture'), model: 'fixture-model', compact: { supported: true, reason: null },
          plan: { supported: true, reason: null }, autoCompact: { supported: true, reason: null } }
      },
      contextSnapshot(session: NativeSessionReference): ContextSnapshot {
        return { nativeSessionId: session.nativeSessionId, model: 'fixture-model', generation: 'fixture', sequence: 1,
          source: 'codex', accuracy: 'native', usedTokens: 100, capacityTokens: null, lifetimeTokens: 100,
          cost: null, observedAt: new Date().toISOString(), stale: false }
      },
      async compactSession(session: NativeSessionReference, input: import('../src/modules/harnesses/port.js').NativeCompactInput) {
        await input.onDispatch?.()
        compactions++
        if (testCase.error) throw testCase.error
        return { requestId: input.requestId, nativeSessionId: session.nativeSessionId, nativeOperationId: 'compact-operation',
          status: 'completed', message: 'Context compacted.', beforeTokens: 100, observedAt: new Date().toISOString() }
      },
      async reconcileCompaction(_session: NativeSessionReference, state: import('@foreman-code/contracts').CompactionState) {
        return confirmed ? { ...state, status: 'completed', message: 'Context compacted.' } : state
      },
    })
    const conversation = await chat.create(writer.principal)
    await chat.send(conversation.id, { requestId: randomUUID(), content: 'Seed the existing session' }, writer.principal)
    await waitFor(async () => (await chat.get(conversation.id, writer.principal)).turnState === 'idle')
    const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { operatorChat: chat, commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
    registerOperatorChatRoutes(app, chat)
    const client = new Client({ name: 'session-controls-parity', version: '1' })
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => writer.token } }))
      const root = `/api/operator/conversations/${conversation.id}/session-controls`
      const headers = { authorization: `Bearer ${writer.token}` }
      const before = SessionControlStateSchema.parse((await app.inject({ method: 'GET', url: root, headers })).json())
      const request = { kind: 'compact', requestId: randomUUID(), expectedRevision: before.revision }
      const accepted = await client.callTool({ name: 'operator_chat_controls_update', arguments: { conversationId: conversation.id, request } })
      expect(accepted.isError).not.toBe(true)
      const result = SessionControlStateSchema.parse(decodeMcpToolResult(accepted))
      expect(result.compaction?.status).toBe(testCase.status)
      expect(result.context).toMatchObject({ usedTokens: 100 })
      const refreshed = await app.inject({ method: 'GET', url: root, headers })
      expect(SessionControlStateSchema.parse(refreshed.json()).revision).toBe(result.revision)
      const stale = await app.inject({ method: 'POST', url: root, headers,
        payload: { kind: 'mode', mode: 'plan', requestId: randomUUID(), expectedRevision: before.revision } })
      expect(stale.statusCode).toBe(409)
      const replay = await app.inject({ method: 'POST', url: root, headers, payload: request })
      expect(replay.statusCode).toBe(200)
      expect(compactions).toBe(1)
      expect(manager.turns).toBe(1)
      const conflict = await app.inject({ method: 'POST', url: root, headers, payload: { ...request, kind: 'mode', mode: 'plan' } })
      expect(conflict.statusCode).toBe(409)
      const rejected = await app.inject({ method: 'POST', url: root,
        headers: { authorization: `Bearer ${denied.token}` }, payload: { ...request, requestId: randomUUID() } })
      expect(rejected.statusCode).toBe(403)
      expect(compactions).toBe(1)
      const deniedClient = new Client({ name: 'denied-session-control', version: '1' })
      try {
        await deniedClient.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => denied.token } }))
        const refusal = await deniedClient.callTool({ name: 'operator_chat_controls_update', arguments: { conversationId: conversation.id, request } })
        expect(refusal.isError).toBe(true)
      } finally { await deniedClient.close() }
      const read = SessionControlStateSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'operator_chat_controls_get',
        arguments: { conversationId: conversation.id } }))))
      expect(read.compaction?.status).toBe(testCase.status)
      const persisted = await pool.query<{ record: unknown }>(
        'select record from conversation_session_controls where conversation_id=$1', [conversation.id])
      expect(SessionControlStateSchema.parse(persisted.rows[0]!.record).compaction?.status).toBe(testCase.status)
      let recovered = read
      if (testCase.status === 'uncertain') {
        await expect(chat.send(conversation.id, { requestId: randomUUID(), content: 'Too early' }, writer.principal))
          .rejects.toMatchObject({ code: 'SESSION_COMPACT_UNCONFIRMED' })
        confirmed = true
        recovered = SessionControlStateSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'operator_chat_controls_get',
          arguments: { conversationId: conversation.id } }))))
        expect(recovered.compaction?.status).toBe('completed')
      }
      const plan = await chat.changeSessionControls(conversation.id,
        { kind: 'mode', mode: 'plan', requestId: randomUUID(), expectedRevision: recovered.revision }, writer.principal)
      expect(plan.desiredMode).toBe('plan')
      expect(manager.turns).toBe(1)
      const freshService = new OperatorChatService(repository, operators, () => manager, runtimeDirectory, authority)
      expect((await freshService.readSessionControls(conversation.id, writer.principal)).desiredMode).toBe('plan')
      // The restarted read must keep the native identity and history; this fixture does not qualify a native adapter.
      expect((await freshService.get(conversation.id, writer.principal)).messages).toEqual((await chat.get(conversation.id, writer.principal)).messages)
      await freshService.shutdown()
      await chat.send(conversation.id, { requestId: randomUUID(), content: 'Next planned task', sessionMode: 'plan' }, writer.principal)
      await waitFor(async () => (await chat.get(conversation.id, writer.principal)).turnState === 'idle')
      expect(compactions).toBe(1)
    } finally { await client.close(); await app.close() }
  }, 30000)

  it('serves an unsettled control read while the native dispatch is still running', async () => {
    const conversation = await chat.create(owner)
    await chat.send(conversation.id, { requestId: randomUUID(), content: 'Seed session' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let dispatched!: () => void
    const entered = new Promise<void>(resolve => { dispatched = resolve })
    let calls = 0
    Object.assign(manager, {
      sessionControlCapabilities: async () => ({ ...unavailableSessionControls('profile'), compact: { supported: true, reason: null } }),
      compactSession: async (session: NativeSessionReference, input: import('../src/modules/harnesses/port.js').NativeCompactInput) => {
        calls++
        await input.onDispatch?.()
        const state = { requestId: input.requestId, nativeSessionId: session.nativeSessionId, nativeOperationId: 'native-control',
          status: 'running' as const, message: 'Still compacting', beforeTokens: 100, observedAt: new Date().toISOString() }
        await input.onProgress(state)
        dispatched()
        await gate
        return { ...state, status: 'completed' as const }
      },
    })
    const before = await chat.readSessionControls(conversation.id, owner)
    const request = { kind: 'compact' as const, requestId: randomUUID(), expectedRevision: before.revision }
    const operation = chat.changeSessionControls(conversation.id, request, owner)
    let readTimeout: ReturnType<typeof setTimeout> | undefined
    try {
      await entered
      const state = await Promise.race([chat.readSessionControls(conversation.id, owner),
        new Promise<never>((_resolve, reject) => {
          readTimeout = setTimeout(() => reject(new Error('Read waited for compact settlement')), 2000)
        })])
      expect(state.compaction).toMatchObject({ requestId: request.requestId, status: 'running', dispatchPhase: 'dispatched' })
      expect(calls).toBe(1)
    } finally {
      clearTimeout(readTimeout)
      release()
      await operation
    }
    await chat.send(conversation.id, { requestId: randomUUID(), content: 'Follow-up' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
  })

  it('keeps uncertain compaction fenced through response loss and recovers without another dispatch', async () => {
    let dispatches = 0
    let confirmed = false
    Object.assign(manager, {
      async sessionControlCapabilities() {
        return { ...unavailableSessionControls('fixture'), compact: { supported: true, reason: null } }
      },
      async compactSession(_session: NativeSessionReference, input: { onDispatch?(): Promise<void> }) {
        await input.onDispatch?.()
        dispatches++
        throw new Error('Native acknowledgement was lost')
      },
      async reconcileCompaction(_session: NativeSessionReference, state: unknown) {
        const control = SessionControlStateSchema.shape.compaction.unwrap().parse(state)
        return confirmed ? { ...control, status: 'completed', message: 'Context compacted.' } : control
      },
    })
    const conversation = await chat.create(owner)
    await chat.send(conversation.id, { requestId: randomUUID(), content: 'Seed this session' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
    const before = await chat.readSessionControls(conversation.id, owner)
    const request = { kind: 'compact' as const, requestId: randomUUID(), expectedRevision: before.revision }
    expect((await chat.changeSessionControls(conversation.id, request, owner)).compaction?.status).toBe('uncertain')
    expect((await chat.changeSessionControls(conversation.id, request, owner)).compaction?.status).toBe('uncertain')
    expect(dispatches).toBe(1)
    const audit = await pool.query<{ outcome: string }>(`select outcome from management_audit
      where target_key=$1 and details->>'commandId'=$2 order by sequence desc limit 1`, [conversation.id, request.requestId])
    expect(audit.rows[0]?.outcome).toBe('uncertain')
    await expect(chat.send(conversation.id, { requestId: randomUUID(), content: 'Next task' }, owner))
      .rejects.toMatchObject({ code: 'SESSION_COMPACT_UNCONFIRMED' })
    confirmed = true
    expect((await chat.readSessionControls(conversation.id, owner)).compaction?.status).toBe('completed')
    expect(dispatches).toBe(1)
    await chat.send(conversation.id, { requestId: randomUUID(), content: 'Recovered follow-up' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
  }, 30000)

  it('records no-session no-op and rejects busy compaction without canceling the active turn', async () => {
    const conversation = await chat.create(owner)
    let state = await chat.readSessionControls(conversation.id, owner)
    state = await chat.changeSessionControls(conversation.id, { kind: 'compact', requestId: randomUUID(), expectedRevision: state.revision }, owner)
    expect(state.compaction?.status).toBe('no-op')
    expect(manager.sessions).toBe(0)
    expect(manager.turns).toBe(0)
    await expect(chat.send(conversation.id, { requestId: randomUUID(), content: '/compact' }, owner))
      .rejects.toMatchObject({ code: 'SESSION_COMMAND_ROUTE_REQUIRED' })
    expect(manager.turns).toBe(0)
    manager.autoFinish = false
    await chat.send(conversation.id, { requestId: 'busy-controls-turn', content: 'Keep working' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'active')
    state = await chat.readSessionControls(conversation.id, owner)
    await expect(chat.changeSessionControls(conversation.id,
      { kind: 'compact', requestId: randomUUID(), expectedRevision: state.revision }, owner)).rejects.toMatchObject({ code: 'SESSION_BUSY' })
    expect((await chat.get(conversation.id, owner)).activeRequestId).toBe('busy-controls-turn')
    manager.finish(nativeCorrelation(conversation.id, 'busy-controls-turn'))
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
  }, 30000)

})
