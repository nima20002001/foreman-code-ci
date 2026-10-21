import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { AgentHarnessSchema } from '@foreman-code/contracts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'
import { MessageSchema, type Message } from '@foreman-code/contracts'
import {
  AgentChatHistoryPageSchema, AgentChatStateSchema, AgentChatStateResponseSchema, AgentChatTurnPageSchema, ReadAgentChatResponseSchema,
  type SendAgentChatMessageRequest,
} from '@foreman-code/contracts/agent-chat'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { agentChatKey, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorActivityRepository } from '../src/modules/conversations/operatorActivityRepository.js'
import { OPERATOR_HISTORY_PAGE_BYTES, OPERATOR_SNAPSHOT_MESSAGE_BYTES, PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { AgentChatF5Native, approval } from './helpers/agentChatF5.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'

/** Opt-in PostgreSQL and authenticated HTTP/MCP. Native ports are substitutes, never real providers. */
describe.skipIf(!postgresEnabled)('G4 PostgreSQL / HTTP / MCP regressions', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let pool: pg.Pool
  let fixture: ReturnType<typeof makeCurrentWorkflowFixture>
  let access: PostgresAccessService
  let writer: ManagementPrincipal
  let writerToken: string
  let deniedToken: string
  let readerToken: string
  beforeAll(async () => {
    database = await agent3Database(); pool = database.pool
    fixture = await seedAgent3(pool, database.directory, makeCurrentWorkflowFixture(`g4-${randomUUID()}`), { run: false })
    access = new PostgresAccessService(pool)
    const issue = (name: string, actions: ManagementPrincipal['grants'][number]['actions'], workflowId: string) => access.issue({
      name, audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions, scope: { workspaceIds: [fixture.scope.workspaceId], workflowIds: [workflowId] } }],
    })
    const issued = await issue('G4 writer', ['agent_chat:read', 'agent_chat:write', 'agent_chat:cancel'], fixture.scope.workflowId)
    writer = issued.principal; writerToken = issued.token
    readerToken = (await issue('G4 reader', ['agent_chat:read'], fixture.scope.workflowId)).token
    deniedToken = (await issue('G4 wrong-workflow caller', ['agent_chat:read', 'agent_chat:cancel'], 'other-workflow-g4')).token
  })
  beforeEach(async () => { await pool.query(`delete from operator_conversations where kind='agent' and workspace_id=$1`, [fixture.scope.workspaceId]) })
  afterAll(async () => { await database?.close() })

  async function setup() {
    const node = fixture.version.definition.nodes[0]!
    const configuration = fixture.configurations.find((value) => value.agentId === node.agentId)!
    const context = { workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId }
    const { workspaceId, ...query } = context
    const repository = new PostgresAgentChatRepository(pool)
    const native = new AgentChatF5Native()
    const chat = new AgentChatService(pool, repository, new PostgresOperatorConversationRepository(pool), new PostgresWorkflowRepository(pool),
      { getForWorkspace: async () => { throw new Error('G4 tests must not access a Run.') }, getExecution: async () => { throw new Error('This fixture must not read a Run execution.') }, async *executionPages() { yield [] } },
      () => native, database.directory)
    const app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access, services: { agentChat: chat, commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const clients: Client[] = []
    const connect = async (token: string) => {
      const client = new Client({ name: 'g4-regression', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const mcp = await connect(writerToken), denied = await connect(deniedToken), reader = await connect(readerToken)
    const url = `/api/workspaces/${workspaceId}/agent-chat`
    const headers = { authorization: `Bearer ${writerToken}` }
    const request = (requestId: string, expectedConversationId: string | null): SendAgentChatMessageRequest =>
      ({ requestId, context: query, content: `G4 ${requestId}`, intent: 'next_turn', expectedConversationId })
    const first = await repository.admit({ key: agentChatKey(context), context, request: request('g4-1', null), delivery: 'queued',
      create: { context, agentConfigurationVersionId: configuration.id, harness: AgentHarnessSchema.parse(configuration.harness.harness),
        origin: { kind: 'fresh' }, workingDirectory: database.directory, runtimeDirectory: database.directory } })
    const id = first.conversationId
    await pool.query(`update operator_conversations set native_session_id='native-g4',provider_version='0.154.0',
      active_request_id='g4-1',active_native_turn_id='turn-g4',active_phase='submitted',turn_state='uncertain',
      record=record || '{"startupDelivered":true}'::jsonb where id=$1`, [id])
    await pool.query(`update operator_conversation_turns set delivery='unknown',native_turn_id='turn-g4' where conversation_id=$1`, [id])
    const append = async (requestId: string, role: Message['role'], content: string) => {
      const now = new Date().toISOString()
      const message = MessageSchema.parse({ id: randomUUID(), conversationId: id, requestId, role, content, createdAt: now, updatedAt: now })
      await pool.query(`insert into operator_conversation_messages(id,conversation_id,role,content,client_request_id,record)
        values($1,$2,$3,$4,$5,$6::jsonb)`, [message.id, id, role, content, role === 'user' ? requestId : null, JSON.stringify(message)])
      return message
    }
    // Deliberately bypass admission only to represent rows written by the pre-capacity release.
    const legacy = async (index: number, delivery: 'queued' | 'unknown' = 'queued') => {
      const requestId = `g4-${index}`, message = await append(requestId, 'user', `G4 ${requestId}`)
      await pool.query(`insert into operator_conversation_turns(conversation_id,request_id,payload,input_hash,intent,delivery,message_id)
        values($1,$2,$3::jsonb,$4,'next_turn',$5,$6)`, [id, requestId, JSON.stringify({ content: message.content }), '0'.repeat(64), delivery, message.id])
    }
    const read = () => app.inject({ method: 'GET', url: `${url}?${new URLSearchParams(query)}`, headers })
    return { id, context, query, workspaceId, repository, chat, app, mcp, reader, denied, native, url, headers, request, append, legacy, read,
      close: async () => {
        await chat.shutdown()
        await Promise.allSettled(clients.map((client) => client.close()))
        await app.close()
      } }
  }

  it('A2-PF-09: full two-turn messages survive byte-bounded state and match HTTP/MCP pages; denied callers see no history', async () => {
    const f = await setup()
    try {
      const firstMessage = (await f.repository.state(f.id))!.messages[0]!
      const large = '界'.repeat(Math.ceil((Math.max(OPERATOR_HISTORY_PAGE_BYTES, OPERATOR_SNAPSHOT_MESSAGE_BYTES) + 4096) / 3))
      const answer1 = await f.append('g4-1', 'assistant', `first-${large}`)
      const user2 = await f.append('g4-2', 'user', 'second question')
      const answer2 = await f.append('g4-2', 'assistant', `second-${large}`)
      await pool.query(`insert into operator_conversation_turns(conversation_id,request_id,payload,input_hash,intent,delivery,message_id)
        values($1,'g4-2',$2::jsonb,$3,'next_turn','completed',$4)`, [f.id, JSON.stringify({ content: user2.content }), '0'.repeat(64), user2.id])
      await pool.query(`update operator_conversation_turns set delivery='completed' where conversation_id=$1`, [f.id])
      await pool.query(`update operator_conversations set active_request_id=null,active_native_turn_id=null,active_phase=null,turn_state='idle' where id=$1`, [f.id])
      const expected = [firstMessage, answer1, { ...user2,
        originalInput: { requestId: 'g4-2', content: user2.content, attachments: [] } }, answer2]
      // History exposes persisted ordering/revision metadata and exact admitted user input.
      const persisted = (await pool.query<{ id: string; revision: string; sequence: string }>(`
        select id,activity_record_revision::text as revision,sequence::text as sequence
        from operator_conversation_messages where conversation_id=$1 order by sequence`, [f.id])).rows
      assert.deepEqual(persisted.map((message) => message.id), expected.map((message) => message.id))
      const expectedMessages = expected.map((message, index) => ({ ...message,
        revision: persisted[index]!.revision, sequence: persisted[index]!.sequence }))
      const state = AgentChatStateSchema.parse((await f.read()).json())
      // The snapshot keeps only the newest message, as a preview within the byte budget; exact history pages hold the full bodies.
      assert.deepEqual(state.messages.map((message) => message.id), [answer2.id])
      assert.equal(state.messages[0]!.truncation?.truncated, true)
      assert.ok(Buffer.byteLength(JSON.stringify(state.messages)) <= OPERATOR_SNAPSHOT_MESSAGE_BYTES)
      assert.equal(state.hasEarlierMessages, true)
      const discovery = await f.mcp.listTools()
      const tool = discovery.tools.find((entry) => entry.name === 'agent_chat_read')!
      assert.ok(tool.inputSchema.properties?.history)
      assert.ok(tool.inputSchema.properties?.receipts)
      const messages: Message[] = []
      let before: string | undefined
      for (;;) {
        const params = new URLSearchParams({ limit: '50', ...(before ? { before } : {}) })
        const http = await f.app.inject({ method: 'GET', url: `${f.url}/conversations/${f.id}/history?${params}`, headers: f.headers })
        assert.equal(http.statusCode, 200)
        const page = AgentChatHistoryPageSchema.parse(http.json())
        const mcp = await f.mcp.callTool({ name: 'agent_chat_read', arguments: { workspaceId: f.workspaceId, query: f.query,
          history: { limit: 50, ...(before ? { before } : {}) } } })
        assert.notEqual(mcp.isError, true)
        assert.deepEqual(ReadAgentChatResponseSchema.parse(decodeMcpToolResult(mcp)).history, page)
        messages.unshift(...page.messages)
        if (!page.nextCursor) break
        assert.notEqual(page.nextCursor, before)
        before = page.nextCursor
      }
      assert.deepEqual(messages, expectedMessages)
      const prior = await f.repository.get(f.id)
      const deniedHttp = await f.app.inject({ method: 'GET', url: `${f.url}/conversations/${f.id}/history`,
        headers: { authorization: `Bearer ${deniedToken}` } })
      assert.equal(deniedHttp.statusCode, 403)
      const denied = await f.denied.callTool({ name: 'agent_chat_read', arguments: { workspaceId: f.workspaceId, query: f.query, history: {} } })
      assert.equal(denied.isError, true)
      const deniedResult = decodeMcpToolResult(denied) as { error: { code: string } }
      assert.equal(deniedResult.error.code, 'ACCESS_DENIED')
      assert.deepEqual(Object.keys(deniedResult), ['error'])
      assert.deepEqual(await f.repository.get(f.id), prior)
      assert.equal(f.native.prompts.length, 0)
    } finally { await f.close() }
  }, 30_000)

  it('rollout: GET opens the existing UI controls, HTTP/MCP queued cancellation succeeds while still over capacity, then Stop drains the queue', async () => {
    const f = await setup()
    try {
      for (let index = 2; index <= 106; index++) await f.legacy(index)
      await assert.rejects(f.repository.state(f.id), { code: 'AGENT_CHAT_RECEIPT_OVERFLOW' })
      const initial = await f.read()
      assert.equal(initial.statusCode, 200)
      const state = AgentChatStateSchema.parse(initial.json())
      assert.equal(state.hasMoreTurns, true)
      assert.equal(state.availability.canSend, false)
      assert.equal(state.turns.length, 100)
      assert.ok(state.turns.some((entry) => entry.delivery === 'queued'))
      assert.match(state.availability.message!, /Cancel queued messages/)
      await assert.rejects(f.chat.send(writer, f.workspaceId, f.request('capacity-reject', f.id)), { code: 'AGENT_CHAT_CAPACITY_EXCEEDED' })
      assert.equal(await f.repository.turn(f.id, 'capacity-reject'), undefined)
      const readerTools = await f.reader.listTools()
      assert.ok(!readerTools.tools.some((entry) => entry.name === 'agent_chat_cancel_queued'))
      const deniedHttp = await f.app.inject({ method: 'POST', url: `${f.url}/conversations/${f.id}/turns/g4-2/cancel`,
        headers: { authorization: `Bearer ${readerToken}` }, payload: { requestId: 'denied-http-cancel' } })
      assert.equal(deniedHttp.statusCode, 403)
      const deniedMcp = await f.denied.callTool({ name: 'agent_chat_cancel_queued', arguments: {
        workspaceId: f.workspaceId, conversationId: f.id, turnRequestId: 'g4-2', requestId: 'denied-mcp-cancel' } })
      assert.equal(deniedMcp.isError, true)
      assert.equal((await f.repository.turn(f.id, 'g4-2'))?.delivery, 'queued')
      const canceled = await f.app.inject({ method: 'POST', url: `${f.url}/conversations/${f.id}/turns/g4-2/cancel`,
        headers: f.headers, payload: { requestId: 'g4-http-cancel' } })
      assert.equal(canceled.statusCode, 200)
      assert.equal(AgentChatStateResponseSchema.parse(canceled.json()).state.hasMoreTurns, true)
      assert.equal((await f.repository.turn(f.id, 'g4-2'))?.delivery, 'canceled')
      const command = { workspaceId: f.workspaceId, conversationId: f.id, turnRequestId: 'g4-106', requestId: 'g4-mcp-cancel' }
      const mcpCanceled = await f.mcp.callTool({ name: 'agent_chat_cancel_queued', arguments: command })
      assert.notEqual(mcpCanceled.isError, true)
      assert.equal(AgentChatStateResponseSchema.parse(decodeMcpToolResult(mcpCanceled)).state.hasMoreTurns, true)
      assert.equal((await f.repository.turn(f.id, 'g4-106'))?.delivery, 'canceled')
      const receipt = async () => (await pool.query(`select target_key,input_hash,result from management_command_receipts
        where principal_id=$1 and operation='agent_chat_control' and command_id=$2`, [writer.id, command.requestId])).rows
      const audit = async () => (await pool.query(`select source,action,outcome,details from management_audit
        where principal_id=$1 and action='agent_chat_control' and details->>'commandId'=$2 order by sequence`, [writer.id, command.requestId])).rows
      const originalReceipt = await receipt(), originalAudit = await audit()
      const originalTurn = await f.repository.turn(f.id, command.turnRequestId)
      // A different real control advances state before this request is replayed.
      const advanced = await f.app.inject({ method: 'POST', url: `${f.url}/conversations/${f.id}/turns/g4-3/cancel`,
        headers: f.headers, payload: { requestId: 'g4-advance-before-replay' } })
      assert.equal(advanced.statusCode, 200)
      const replay = await f.mcp.callTool({ name: 'agent_chat_cancel_queued', arguments: command })
      assert.notEqual(replay.isError, true)
      const replayState = AgentChatStateResponseSchema.parse(decodeMcpToolResult(replay)).state
      assert.ok(replayState.revision > AgentChatStateResponseSchema.parse(decodeMcpToolResult(mcpCanceled)).state.revision)
      assert.equal(replayState.conversation!.id, f.id)
      assert.deepEqual(await receipt(), originalReceipt)
      assert.deepEqual(await audit(), originalAudit)
      assert.deepEqual(await f.repository.turn(f.id, command.turnRequestId), originalTurn)
      const stopped = await f.mcp.callTool({ name: 'agent_chat_interrupt', arguments: {
        workspaceId: f.workspaceId, conversationId: f.id, requestId: 'g4-stop', expectedNativeTurnId: 'turn-g4' } })
      assert.notEqual(stopped.isError, true)
      const after = AgentChatStateResponseSchema.parse(decodeMcpToolResult(stopped)).state
      assert.equal(after.hasMoreTurns, undefined)
      assert.equal(after.turns.some((entry) => entry.delivery === 'queued'), false)
      assert.equal((await f.repository.turn(f.id, 'g4-1'))?.delivery, 'unknown')
      const persisted = await f.repository.get(f.id)
      assert.equal(persisted?.active_request_id, 'g4-1')
      assert.equal(persisted?.active_native_turn_id, 'turn-g4')
      assert.equal(persisted?.cancel_requested, true)
      const totals = await pool.query<{ delivery: string; count: string }>(`select delivery,count(*)::text as count
        from operator_conversation_turns where conversation_id=$1 group by delivery`, [f.id])
      assert.deepEqual(Object.fromEntries(totals.rows.map((entry) => [entry.delivery, entry.count])), { unknown: '1', canceled: '105' })
      assert.equal(f.native.prompts.length, 0)
    } finally { await f.close() }
  }, 30_000)

  it('rollout: 103 unconfirmed receipts cannot hide a queued cleanup target; HTTP/MCP receipt paging loses no identities', async () => {
    const f = await setup()
    try {
      for (let index = 2; index <= 103; index++) await f.legacy(index, 'unknown')
      await f.legacy(104)
      const state = AgentChatStateSchema.parse((await f.read()).json())
      assert.ok(state.turns.some((entry) => entry.requestId === 'g4-104' && entry.delivery === 'queued'))
      const ids: string[] = []
      let before: string | undefined
      for (;;) {
        const params = new URLSearchParams({ limit: '37', ...(before ? { before } : {}) })
        const http = await f.app.inject({ method: 'GET', url: `${f.url}/conversations/${f.id}/turns?${params}`, headers: f.headers })
        assert.equal(http.statusCode, 200)
        const page = AgentChatTurnPageSchema.parse(http.json())
        const mcp = await f.mcp.callTool({ name: 'agent_chat_read', arguments: { workspaceId: f.workspaceId, query: f.query,
          receipts: { limit: 37, ...(before ? { before } : {}) } } })
        assert.notEqual(mcp.isError, true)
        assert.deepEqual(ReadAgentChatResponseSchema.parse(decodeMcpToolResult(mcp)).receipts, page)
        ids.unshift(...page.turns.map((entry) => entry.requestId))
        if (!page.nextCursor) break
        before = page.nextCursor
      }
      assert.deepEqual(ids, Array.from({ length: 104 }, (_, index) => `g4-${index + 1}`))
      const denied = await f.app.inject({ method: 'GET', url: `${f.url}/conversations/${f.id}/turns`, headers: { authorization: `Bearer ${deniedToken}` } })
      assert.equal(denied.statusCode, 403)
      const canceled = await f.app.inject({ method: 'POST', url: `${f.url}/conversations/${f.id}/turns/g4-104/cancel`,
        headers: f.headers, payload: { requestId: 'g4-last-queued' } })
      assert.equal(canceled.statusCode, 200)
      assert.equal(AgentChatStateResponseSchema.parse(canceled.json()).state.hasMoreTurns, true)
      assert.equal((await f.repository.turn(f.id, 'g4-104'))?.delivery, 'canceled')
      const unknown = await pool.query(`select 1 from operator_conversation_turns where conversation_id=$1 and delivery='unknown'`, [f.id])
      assert.equal(unknown.rowCount, 103, 'Unknown receipt cleanup requires native evidence, not a read or queued-cancel operation.')
    } finally { await f.close() }
  }, 30_000)

  it('T-09: startup repair settles legacy activity even when an unavailable conversation skips native reconciliation', async () => {
    const f = await setup()
    try {
      const activity = new PostgresOperatorActivityRepository(pool)
      await activity.append(f.id, 'g4-1', { id: 'legacy-running', requestId: 'g4-1', kind: 'tool', title: 'old activity', status: 'running' })
      await f.repository.markSessionUnavailable(f.id, 'A previously unavailable native session.', 'native_session_missing')
      const before = await f.repository.get(f.id)
      await f.chat.recover()
      const stored = await f.repository.get(f.id)
      assert.equal(stored?.active_request_id, before?.active_request_id)
      assert.equal(stored?.active_native_turn_id, before?.active_native_turn_id)
      assert.equal(stored?.cancel_requested, before?.cancel_requested)
      assert.equal((await f.repository.turn(f.id, 'g4-1'))?.delivery, 'unknown')
      const entries = (await activity.page(f.id)).activities
      assert.equal(entries[0]?.status, 'unknown')
      await f.chat.recover()
      assert.deepEqual((await activity.page(f.id)).activities, entries)
      assert.equal(f.native.prompts.length, 0)
    } finally { await f.close() }
  }, 30_000)

  it('T-09: unknown activity commits atomically, is idempotent, preserves ownership/approval and later terminal proof', async () => {
    const f = await setup()
    try {
      const pending = approval({ harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'native-g4' }, 'turn-g4', 'approval-g4')
      await pool.query(`update operator_conversation_turns set delivery='accepted' where conversation_id=$1`, [f.id])
      await pool.query(`update operator_conversations set turn_state='active',cancel_requested=true,pending_interaction=$2::jsonb where id=$1`, [f.id, JSON.stringify(pending)])
      const activity = new PostgresOperatorActivityRepository(pool)
      const statuses = ['pending', 'running', 'completed', 'failed', 'canceled', 'unknown'] as const
      for (const status of statuses) await activity.append(f.id, 'g4-1', { id: `g4-${status}`, requestId: 'g4-1', kind: 'tool', title: status, status })
      // A real trigger failure proves receipt, owner and activity writes roll back together.
      await pool.query(`create function g4_fail_activity() returns trigger language plpgsql as $$ begin raise exception 'g4 activity failure'; end; $$`)
      await pool.query(`create trigger g4_fail_activity before update on operator_conversation_activity for each row execute function g4_fail_activity()`)
      const before = await f.repository.get(f.id)
      try { await assert.rejects(f.repository.abandon(f.id, 'g4-1', 'evidence lost'), /g4 activity failure/) }
      finally {
        await pool.query('drop trigger g4_fail_activity on operator_conversation_activity')
        await pool.query('drop function g4_fail_activity()')
      }
      assert.deepEqual(await f.repository.get(f.id), before)
      assert.equal((await f.repository.turn(f.id, 'g4-1'))?.delivery, 'accepted')
      await f.repository.abandon(f.id, 'g4-1', 'evidence lost')
      const state = AgentChatStateSchema.parse((await f.read()).json())
      assert.deepEqual(state.activities.map((entry) => entry.status), ['unknown', 'unknown', 'completed', 'failed', 'canceled', 'unknown'])
      assert.equal(state.sessionState, 'uncertain')
      assert.deepEqual(state.pendingInteraction, pending)
      assert.equal(state.activeTurn?.requestId, 'g4-1')
      assert.equal(state.activeTurn?.nativeTurnId, 'turn-g4')
      assert.equal((await f.repository.get(f.id))?.cancel_requested, true)
      const revisions = state.activities.map((entry) => entry.revision)
      await f.repository.abandon(f.id, 'g4-1', 'still unconfirmed')
      assert.deepEqual((await activity.page(f.id)).activities.map((entry) => entry.revision), revisions)
      await activity.append(f.id, 'g4-1', { id: 'g4-running', requestId: 'g4-1', kind: 'tool', title: 'running', status: 'completed', output: 'later proof' })
      await f.repository.finish(f.id, 'g4-1', { outcome: 'succeeded' })
      await f.repository.abandon(f.id, 'g4-1', 'late old callback')
      assert.equal((await f.repository.turn(f.id, 'g4-1'))?.delivery, 'completed')
      assert.equal((await activity.page(f.id)).activities.find((entry) => entry.id === 'g4-running')?.status, 'completed')
    } finally { await f.close() }
  }, 30_000)
})
