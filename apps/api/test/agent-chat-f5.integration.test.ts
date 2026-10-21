import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'
import { AgentChatStateSchema, type SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { agentChatKey, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { AgentChatF5Native, eventually } from './helpers/agentChatF5.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { deferred } from './helpers/deferred.js'

/** Opt-in real SQL/authenticated transports; native I/O remains a deterministic substitute. */
describe.skipIf(!postgresEnabled)('F5 approval and receipt PostgreSQL / HTTP / MCP regressions', { timeout: 60_000 }, () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let pool: pg.Pool
  let root: string
  let fixture: ReturnType<typeof makeCurrentWorkflowFixture>
  let access: PostgresAccessService
  let writer: ManagementPrincipal
  let writerToken: string
  let readerToken: string

  beforeAll(async () => {
    database = await agent3Database() // Loopback test DB, task-owned random schema, scoped teardown.
    pool = database.pool; root = database.directory
    fixture = await seedAgent3(pool, root, makeCurrentWorkflowFixture(`f5-${randomUUID()}`, 'single'), { run: false })
    access = new PostgresAccessService(pool)
    const issued = await access.issue({ name: 'F5 writer', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['agent_chat:read', 'agent_chat:write', 'agent_chat:cancel', 'agent_chat:respond'], scope: {} }] })
    writer = issued.principal; writerToken = issued.token
    readerToken = (await access.issue({ name: 'F5 reader', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['agent_chat:read'], scope: {} }] })).token
  })
  beforeEach(async () => {
    await pool.query(`delete from operator_conversations where kind='agent' and workspace_id=$1`, [fixture.scope.workspaceId])
  })
  afterAll(async () => { await database?.close() })

  async function setup() {
    const node = fixture.version.definition.nodes[0]!
    const context = { workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId }
    const { workspaceId, ...query } = context
    const repository = new PostgresAgentChatRepository(pool)
    const managers = new Map<string, AgentChatF5Native>()
    const service = new AgentChatService(pool, repository, new PostgresOperatorConversationRepository(pool), new PostgresWorkflowRepository(pool),
      { getForWorkspace: async () => { throw new Error('F5 fixture must not access a Run.') }, getExecution: async () => { throw new Error('This fixture must not read a Run execution.') }, async *executionPages() { yield [] } },
      (id) => { const manager = new AgentChatF5Native(); managers.set(id, manager); return manager }, root)
    const app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access, services: { agentChat: service, commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
    const clients: Client[] = []
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'agent-chat-f5', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const mcp = await connect(writerToken)
    const reader = await connect(readerToken)
    const url = `/api/workspaces/${workspaceId}/agent-chat`
    const headers = { authorization: `Bearer ${writerToken}` }
    const message = (requestId: string, expectedConversationId: string | null): SendAgentChatMessageRequest =>
      ({ requestId, context: query, content: `F5 ${requestId}`, intent: 'next_turn', expectedConversationId })
    const first = await service.send(writer, workspaceId, message('active-f5', null))
    const id = first.state.conversation!.id
    await eventually(() => managers.has(id))
    const native = managers.get(id)!
    await native.started.promise
    const read = () => service.read(writer, workspaceId, query)
    return { context, workspaceId, query, repository, service, app, mcp, reader, url, headers, message, id, native, read,
      close: async () => {
        native.beforeResponse = undefined; native.beforePendingReturn = undefined
        native.finish({ outcome: 'canceled' })
        await service.shutdown()
        await Promise.allSettled(clients.map((client) => client.close()))
        await app.close()
      } }
  }

  it('A-R11: exposes A, B, then C across authenticated HTTP/MCP replies, denies read-only replies, and persists each handoff', async () => {
    const f = await setup()
    const entered = deferred(), release = deferred()
    try {
      f.native.offer('approval-a'); f.native.offer('approval-b')
      await eventually(async () => (await f.read()).pendingInteraction?.turn.nativeRequestId === 'approval-a')
      const before = await f.repository.get(f.id)
      const denied = await f.app.inject({ method: 'POST', url: `${f.url}/conversations/${f.id}/responses`,
        headers: { authorization: `Bearer ${readerToken}` },
        payload: { requestId: 'denied-response', nativeRequestId: 'approval-a', optionId: 'approve-once' } })
      assert.equal(denied.statusCode, 403)
      assert.equal((await f.reader.listTools()).tools.some((tool) => tool.name === 'agent_chat_respond'), false)
      await expectMcpAccessDenied(f.reader.callTool({ name: 'agent_chat_respond', arguments: { workspaceId: f.workspaceId, conversationId: f.id,
        nativeRequestId: 'approval-a', optionId: 'approve-once' } }))
      assert.deepEqual(await f.repository.get(f.id), before)
      assert.deepEqual(f.native.responses, [])

      f.native.beforeResponse = async () => { entered.resolve(); await release.promise }
      const reply = f.app.inject({ method: 'POST', url: `${f.url}/conversations/${f.id}/responses`, headers: f.headers,
        payload: { requestId: 'reply-a', nativeRequestId: 'approval-a', optionId: 'approve-once' } })
      await entered.promise
      f.native.offer('approval-c') // A later native event arrives while A's reply is awaiting acknowledgement.
      release.resolve()
      const response = await reply
      assert.equal(response.statusCode, 200, response.body)
      assert.equal(AgentChatStateSchema.parse(response.json().state).pendingInteraction?.turn.nativeRequestId, 'approval-b')
      const readback = await f.mcp.callTool({ name: 'agent_chat_read', arguments: { workspaceId: f.workspaceId, query: f.query } })
      assert.equal(AgentChatStateSchema.parse(decodeMcpToolResult(readback)).pendingInteraction?.turn.nativeRequestId, 'approval-b')
      const second = await f.mcp.callTool({ name: 'agent_chat_respond', arguments: { workspaceId: f.workspaceId, conversationId: f.id,
        requestId: 'reply-b', nativeRequestId: 'approval-b', optionId: 'approve-once' } })
      assert.notEqual(second.isError, true)
      assert.equal(AgentChatStateSchema.parse((decodeMcpToolResult(second) as { state: unknown } | undefined)?.state)
        .pendingInteraction?.turn.nativeRequestId, 'approval-c')
      const httpRead = await f.app.inject({ method: 'GET', url: `${f.url}?${new URLSearchParams(f.query)}`, headers: f.headers })
      assert.equal(AgentChatStateSchema.parse(httpRead.json()).pendingInteraction?.turn.nativeRequestId, 'approval-c')
      const third = await f.app.inject({ method: 'POST', url: `${f.url}/conversations/${f.id}/responses`, headers: f.headers,
        payload: { requestId: 'reply-c', nativeRequestId: 'approval-c', optionId: 'approve-once' } })
      assert.equal(third.statusCode, 200, third.body)
      assert.equal(AgentChatStateSchema.parse(third.json().state).pendingInteraction, undefined)
      assert.equal((await f.repository.get(f.id))!.pending_interaction, null)
      assert.deepEqual(f.native.responses, ['approval-a', 'approval-b', 'approval-c'])
    } finally { release.resolve(); await f.close() }
  })

  it('A-R15: arbitrates the last slot concurrently, keeps mixed open receipts visible past terminal history, and cancels every queued identity', async () => {
    const f = await setup()
    try {
      const admit = (input: SendAgentChatMessageRequest, delivery: 'queued' | 'submitting' = 'queued') =>
        f.repository.admit({ key: agentChatKey(f.context), context: f.context, request: input, delivery })
      // This capacity scenario includes 159 admissions and authenticated cancellation of every queued turn.
      // Older unfinished receipts, then enough terminal history to crowd out the old oldest-first LIMIT.
      for (let i = 0; i < 59; i++) {
        const input = { ...f.message(`older-${i}`, f.id), ...(i < 15
          ? { intent: 'steer' as const, expectedNativeTurnId: f.native.nativeTurnId } : {}) }
        await admit(input, i < 15 ? 'submitting' : 'queued')
        if (i < 5) await f.repository.unknown(f.id, input.requestId, 'Fixture lost acknowledgement.')
        else if (i < 10) await f.repository.steerAccepted(f.id, input.requestId, f.native.nativeTurnId)
      }
      for (let i = 0; i < 60; i++) {
        await admit(f.message(`terminal-${i}`, f.id))
        await f.repository.cancelQueued(f.id, `terminal-${i}`)
      }
      for (let i = 0; i < 39; i++) await admit(f.message(`newer-${i}`, f.id))
      const counts = async () => (await pool.query<{ receipts: string; messages: string }>(`select
        (select count(*)::text from operator_conversation_turns where conversation_id=$1) as receipts,
        (select count(*)::text from operator_conversation_messages where conversation_id=$1) as messages`, [f.id])).rows[0]!
      const before = await counts()
      const httpInput = f.message('last-http', f.id), mcpInput = f.message('last-mcp', f.id)
      const [http, mcp] = await Promise.all([
        f.app.inject({ method: 'POST', url: `${f.url}/messages`, headers: f.headers, payload: httpInput }),
        f.mcp.callTool({ name: 'agent_chat_send', arguments: { workspaceId: f.workspaceId, request: mcpInput } }),
      ])
      assert.equal(Number(http.statusCode === 202) + Number(mcp.isError !== true), 1)
      if (http.statusCode !== 202) {
        assert.equal(http.statusCode, 409); assert.equal(http.json().error.code, 'AGENT_CHAT_CAPACITY_EXCEEDED')
      } else {
        assert.equal(mcp.isError, true)
        assert.ok(mcp.content.some((content) => content.type === 'text' && content.text.includes('AGENT_CHAT_CAPACITY_EXCEEDED')))
      }
      const after = await counts()
      assert.equal(Number(after.receipts), Number(before.receipts) + 1)
      assert.equal(Number(after.messages), Number(before.messages) + 1)
      const winner = http.statusCode === 202 ? httpInput : mcpInput
      const loser = http.statusCode === 202 ? mcpInput : httpInput
      assert.equal(await f.repository.turn(f.id, loser.requestId), undefined)
      assert.equal((await pool.query(`select 1 from operator_conversation_messages where conversation_id=$1 and client_request_id=$2`,
        [f.id, loser.requestId])).rowCount, 0)
      const replay = await f.app.inject({ method: 'POST', url: `${f.url}/messages`, headers: f.headers, payload: winner })
      assert.equal(replay.statusCode, 200, replay.body)
      assert.equal(replay.json().replayed, true)
      assert.deepEqual(await counts(), after)
      // The crash-left receipts above bypass service admission; explicitly run startup recovery.
      await f.service.recover()
      const state = await f.read()
      assert.equal(state.turns.length, 100)
      assert.equal(state.turns.some((turn) => turn.requestId === winner.requestId), true)
      assert.deepEqual(new Set(state.turns.map((turn) => turn.delivery)), new Set(['queued', 'accepted', 'unknown']))
      for (const index of [0, 1, 2, 3, 4, 10, 11, 12, 13, 14]) {
        assert.equal(state.turns.find((turn) => turn.requestId === `older-${index}`)?.delivery, 'unknown',
          'Unconfirmed steers must settle as unknown instead of remaining provisionally submitting.')
      }
      assert.ok(state.turns.every((turn, index) => index === 0 || BigInt(state.turns[index - 1]!.sequence) < BigInt(turn.sequence)))
      const authoritative = (await pool.query<{ request_id: string }>(`select request_id from operator_conversation_turns
        where conversation_id=$1 and delivery in ('queued','submitting','accepted','unknown') order by turn_sequence`, [f.id])).rows
      assert.deepEqual(state.turns.map((turn) => turn.requestId), authoritative.map((turn) => turn.request_id))
      const mcpState = await f.mcp.callTool({ name: 'agent_chat_read', arguments: { workspaceId: f.workspaceId, query: f.query } })
      assert.deepEqual(AgentChatStateSchema.parse(decodeMcpToolResult(mcpState)).turns, state.turns)
      const queued = state.turns.filter((turn) => turn.delivery === 'queued')
      await expectMcpAccessDenied(f.reader.callTool({ name: 'agent_chat_cancel_queued', arguments: {
        workspaceId: f.workspaceId, conversationId: f.id, turnRequestId: queued[0]!.requestId,
        requestId: 'denied-cancel',
      } }))
      assert.equal((await f.repository.turn(f.id, queued[0]!.requestId))?.delivery, 'queued')
      const cancelTurn = async (turn: (typeof queued)[number], index: number) => {
        if (index % 2) {
          const result = await f.mcp.callTool({ name: 'agent_chat_cancel_queued', arguments: { workspaceId: f.workspaceId,
            conversationId: f.id, turnRequestId: turn.requestId, requestId: `cancel-${turn.requestId}` } })
          assert.notEqual(result.isError, true)
          const response = decodeMcpToolResult(result) as { state: unknown }
          assert.equal(AgentChatStateSchema.parse(response.state).turns
            .some((entry) => entry.requestId === turn.requestId && entry.delivery === 'queued'), false)
        } else {
          const result = await f.app.inject({ method: 'POST', url: `${f.url}/conversations/${f.id}/turns/${turn.requestId}/cancel`,
            headers: f.headers, payload: { requestId: `cancel-${turn.requestId}` } })
          assert.equal(result.statusCode, 200, result.body)
          assert.equal(AgentChatStateSchema.parse(result.json().state).turns
            .some((entry) => entry.requestId === turn.requestId && entry.delivery === 'queued'), false)
        }
        assert.equal((await f.repository.turn(f.id, turn.requestId))?.delivery, 'canceled')
      }
      // Independent cancellations can overlap; bound concurrency below the fixture pool's capacity.
      for (let offset = 0; offset < queued.length; offset += 4) {
        const results = await Promise.allSettled(queued.slice(offset, offset + 4)
          .map((turn, index) => cancelTurn(turn, offset + index)))
        for (const result of results) {
          if (result.status === 'rejected') throw result.reason
        }
      }
      const canceledRead = await f.app.inject({ method: 'GET',
        url: `${f.url}?${new URLSearchParams(f.query)}`, headers: f.headers })
      assert.equal(canceledRead.statusCode, 200, canceledRead.body)
      assert.equal(AgentChatStateSchema.parse(canceledRead.json()).turns
        .some((turn) => turn.delivery === 'queued'), false)
      const canceledMcpRead = await f.mcp.callTool({ name: 'agent_chat_read', arguments: {
        workspaceId: f.workspaceId, query: f.query,
      } })
      const canceledState = AgentChatStateSchema.parse(decodeMcpToolResult(canceledMcpRead))
      assert.equal(canceledState.turns.some(turn => turn.delivery === 'queued'), false)
      assert.equal(canceledState.activeTurn?.requestId, 'active-f5')
      await admit(f.message('capacity-freed', f.id))
      assert.equal((await f.read()).turns.some((turn) => turn.requestId === 'capacity-freed'), true)
      assert.equal(f.native.prompts.length, 1, 'No queued or rejected request may reach the held native turn.')
    } finally { await f.close() }
  }, 120_000)
})
