import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { AgentHarnessSchema } from '@foreman-code/contracts'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, it, vi } from 'vitest'
import { AgentConfigurationVersionSchema, type ExecutionResult } from '@foreman-code/contracts'
import { SendAgentChatMessageResponseSchema, type SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { APP_MCP_SERVER_NAMES } from '@foreman-code/contracts/product'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'

import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { AgentChatService, type AgentChatManagerFactory } from '../src/modules/conversations/agentChat.js'
import { agentChatKey, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { qualifyNativeCodexModel } from '../src/modules/harnesses/codexQualification.js'
import { CodexRpcError, type CodexStdioTransport, type JsonObject } from '../src/modules/harnesses/codexStdioTransport.js'
import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'
import { runCommand } from '../src/modules/harnesses/process.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { deferred } from './helpers/deferred.js'

// The adapter's create/start/history/cleanup logic is real. Qualification and RPC I/O are test
// substitutes: no executable, real provider, App credential, or workflow execution is used.
vi.mock('../src/modules/harnesses/codexProtocol.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/modules/harnesses/codexProtocol.js')>(),
  qualifyCodex: vi.fn(async () => ({ binary: 'not-executed', providerVersion: 'codex-cli 0.154.0', protocol: {} })),
  assertCodexUnchanged: vi.fn(async () => {}),
}))
vi.mock('../src/modules/harnesses/codexQualification.js', () => ({ qualifyNativeCodexModel: vi.fn(async () => {}) }))
vi.mock('../src/modules/harnesses/process.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/modules/harnesses/process.js')>(), runCommand: vi.fn(),
}))

async function eventually(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 30_000
  while (!await check()) {
    assert.ok(Date.now() < end, 'The H1 persisted transition did not occur.')
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}
type Mode = 'reject' | 'success' | 'uncertain' | 'cleanup-failure' | 'activation-failure'

/** Opt in with the repository's PostgreSQL test setting. Never real-native acceptance evidence. */
describe.skipIf(!postgresEnabled).each(APP_MCP_SERVER_NAMES)(
  'Agent chat creation and replay with %s MCP', { timeout: 60_000 }, (serverName) => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let pool: pg.Pool
  let saved: ReturnType<typeof makeCurrentWorkflowFixture>
  let access: PostgresAccessService
  let writer: ManagementPrincipal
  let writerToken: string
  let readerToken: string
  let deniedToken: string
  beforeAll(async () => {
    database = await agent3Database(); pool = database.pool
    const seed = makeCurrentWorkflowFixture(`h1-${randomUUID()}`, 'single')
    seed.configurations = seed.configurations.map((configuration) => AgentConfigurationVersionSchema.parse({
      ...configuration, harness: { ...configuration.harness, sandbox: 'read-only' },
    }))
    saved = await seedAgent3(pool, database.directory, seed, { run: false })
    access = new PostgresAccessService(pool)
    const issue = (name: string, actions: ManagementPrincipal['grants'][number]['actions'], workflowId = saved.scope.workflowId) => access.issue({
      name, audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions, scope: { workspaceIds: [saved.scope.workspaceId], workflowIds: [workflowId] } }],
    })
    const issued = await issue('H1 writer', ['agent_chat:read', 'agent_chat:write', 'agent_chat:cancel'])
    writer = issued.principal; writerToken = issued.token
    readerToken = (await issue('H1 reader', ['agent_chat:read'])).token
    deniedToken = (await issue('H1 wrong workflow', ['agent_chat:read', 'agent_chat:write'], 'h1-other-workflow')).token
  })
  beforeEach(async () => {
    await pool.query(`delete from operator_conversations where kind='agent' and workspace_id=$1`, [saved.scope.workspaceId])
    vi.mocked(qualifyNativeCodexModel).mockReset().mockResolvedValue(undefined)
    const entry = {
      name: serverName,
      enabled: false,
      transport: { type: 'stdio', command: 'not-executed', args: [], env_vars: [] },
    }
    vi.mocked(runCommand).mockReset().mockImplementation(async (_binary, args) => {
      assert.equal(args[0], 'mcp')
      if (args[1] === 'list') return { exitCode: 0, stderr: '', stdout: JSON.stringify([entry]) }
      assert.equal(args[1], 'get')
      if (args[2] !== serverName) return {
        exitCode: 1, stdout: '', stderr: `Error: No MCP server named '${args[2]}' found.`,
      }
      return { exitCode: 0, stderr: '', stdout: JSON.stringify(entry) }
    })
  })
  afterAll(async () => { await database?.close() })

  function setup(initial: Mode = 'reject') {
    const node = saved.version.definition.nodes[0]!
    const configuration = saved.configurations.find((item) => item.agentId === node.agentId)!
    const context = { workspaceId: saved.scope.workspaceId, workflowId: saved.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId }
    const { workspaceId, ...query } = context
    const repository = new PostgresAgentChatRepository(pool)
    const controls: { mode: Mode; closeGate?: ReturnType<typeof deferred<void>> } = { mode: initial }
    const calls: Array<{ method: string; params: JsonObject }> = []
    const created: string[] = []
    const managers: CodexAppServerSessionManager[] = []
    const owners = new Map<string, CodexAppServerSessionManager>()
    let closes = 0
    const factory: AgentChatManagerFactory = (id) => {
      let manager = owners.get(id)
      if (manager) return manager
      manager = new CodexAppServerSessionManager('not-executed', undefined, undefined, undefined, 'none')
      const owned = manager
      manager['transport'] = async (prepared) => {
        assert.equal(prepared.input.environment, undefined)
        assert.equal(prepared.environment.GRAPHQL_MCP_TOKEN, undefined)
        assert.equal(prepared.input.kind, 'agent-chat')
        if (prepared.input.kind === 'agent-chat') {
          assert.equal(prepared.input.conversationId, id)
          assert.deepEqual(prepared.input.configuration, configuration)
          assert.equal('request' in prepared.input, false)
        }
        const transport = {
          request: async (method: string, params: JsonObject = {}) => {
            calls.push({ method, params: structuredClone(params) })
            if (method === 'thread/start') {
              if (controls.mode === 'reject' || controls.mode === 'cleanup-failure') {
                throw new CodexRpcError(method, calls.length, false, 'CODEX_APP_SERVER_REQUEST_FAILED')
              }
              const nativeId = `h1-native-${created.length + 1}`
              created.push(nativeId)
              if (controls.mode === 'uncertain') throw new CodexRpcError(method, calls.length, true, 'CODEX_APP_SERVER_REQUEST_FAILED')
              const config = params.config as JsonObject
              return { thread: { id: nativeId, ephemeral: false }, model: params.model,
                reasoningEffort: config.model_reasoning_effort, cwd: params.cwd, approvalPolicy: params.approvalPolicy,
                approvalsReviewer: params.approvalsReviewer, sandbox: { type: 'readOnly' }, serviceTier: params.serviceTier }
            }
            if (method === 'turn/start') {
              return { turn: { id: 'h1-turn', status: 'completed', items: [
                { id: 'h1-answer', type: 'agentMessage', text: 'H1 completed reply', phase: 'final_answer' },
              ] } }
            }
            assert.fail(`Unexpected native RPC: ${method}`)
          },
          close: async () => {
            closes++; await controls.closeGate?.promise
            if (controls.mode === 'cleanup-failure') throw new Error('Native closure is unconfirmed.')
          },
        } as unknown as CodexStdioTransport
        // Match production transport ownership so real dispose() must drain it.
        owned['transports'].add(transport)
        return { transport, activate: async () => {
          if (controls.mode === 'activation-failure') throw new CodexRpcError('mcpServerStatus/list', 2, false, 'CODEX_APP_SERVER_REQUEST_FAILED')
        } }
      }
      managers.push(manager); owners.set(id, manager); return manager
    }
    factory.release = (id) => { owners.delete(id) }
    const chat = new AgentChatService(pool, repository, new PostgresOperatorConversationRepository(pool), new PostgresWorkflowRepository(pool),
      { getForWorkspace: async () => { throw new Error('H1 must not access a Run.') }, getExecution: async () => { throw new Error('This fixture must not read a Run execution.') }, executionPages: () => { throw new Error('H1 must not access an execution.') } },
      factory, database.directory)
    const request = (requestId: string, expectedConversationId: string | null): SendAgentChatMessageRequest =>
      ({ requestId, context: query, content: `H1 ${requestId}`, intent: 'next_turn', expectedConversationId })
    return { context, workspaceId, query, repository, controls, calls, created, managers, owners, chat, request,
      get closes() { return closes },
      read: () => chat.read(writer, workspaceId, query),
      close: async () => { controls.mode = 'success'; controls.closeGate?.resolve(); await chat.shutdown() },
      create: { context, agentConfigurationVersionId: configuration.id, harness: AgentHarnessSchema.parse(configuration.harness.harness),
        origin: { kind: 'fresh' as const }, workingDirectory: database.directory, runtimeDirectory: database.directory },
    }
  }

  it('creates a chat and completes its first message with an isolated App MCP transport', async () => {
    const f = setup('success')
    try {
      const request = f.request('first-message', null)
      const admitted = await f.chat.send(writer, f.workspaceId, request)
      await eventually(async () => {
        const state = await f.read()
        return state.turns.some(turn => turn.requestId === request.requestId
          && ['completed', 'failed', 'unknown', 'canceled'].includes(turn.delivery))
      })
      const state = await f.read()
      assert.equal(state.conversation?.id, admitted.state.conversation!.id)
      assert.equal(state.turns.find(turn => turn.requestId === request.requestId)?.delivery, 'completed')
      assert.equal(state.activeTurn, null)
      assert.equal(state.conversation?.nativeSession?.nativeSessionId, 'h1-native-1')
      assert.equal(state.messages.filter(message => message.role === 'assistant'
        && message.content === 'H1 completed reply').length, 1)
    } finally {
      await f.close()
    }
  }, 30_000)

  for (const preflight of [false, true]) {
    it(`actual Codex adapter: ${preflight ? 'preflight failure' : 'thread/start rejection'} is failed, exact replay is inert, explicit retry succeeds`, async () => {
      const f = setup()
      if (preflight) vi.mocked(qualifyNativeCodexModel).mockRejectedValue(new HarnessExecutionError('CODEX_MODEL_CATALOG_UNAVAILABLE', 'Unavailable catalogue.'))
      try {
        const first = f.request('h1-first', null)
        const admitted = await f.chat.send(writer, f.workspaceId, first)
        const id = admitted.state.conversation!.id
        await eventually(async () => (await f.repository.turn(id, first.requestId))?.delivery === 'failed')
        const state = await f.read(), row = (await f.repository.get(id))!
        assert.equal(state.sessionState, 'error'); assert.equal(state.availability.canSend, true)
        assert.equal(state.conversation?.nativeSession, null); assert.equal(state.activeTurn, null)
        assert.equal(row.record.sessionCreation, undefined); assert.equal(row.record.sessionUnavailable, undefined)
        assert.equal(f.owners.size, 0); assert.equal(f.created.length, 0)
        assert.equal(f.calls.filter((call) => call.method === 'thread/start').length, preflight ? 0 : 1)
        assert.equal(f.calls.filter((call) => call.method === 'turn/start').length, 0)
        const receipt = await f.repository.turn(id, first.requestId), before = structuredClone(f.calls)
        const replay = await f.chat.send(writer, f.workspaceId, first)
        assert.equal(replay.replayed, true); assert.deepEqual(replay.turn, receipt); assert.deepEqual(f.calls, before)
        vi.mocked(qualifyNativeCodexModel).mockResolvedValue(undefined); f.controls.mode = 'success'
        await f.chat.send(writer, f.workspaceId, f.request('h1-retry', id))
        await eventually(async () => (await f.repository.turn(id, 'h1-retry'))?.delivery === 'completed')
        const done = await f.read()
        assert.equal(done.conversation?.id, id); assert.equal(done.conversation?.nativeSession?.nativeSessionId, 'h1-native-1')
        assert.deepEqual(f.created, ['h1-native-1'])
        assert.equal(f.calls.filter((call) => call.method === 'thread/start').length, preflight ? 1 : 2)
        assert.equal(f.calls.filter((call) => call.method === 'turn/start').length, 1)
        assert.equal(done.messages.filter((message) => message.role === 'assistant' && message.content === 'H1 completed reply').length, 1)
        assert.deepEqual(done.turns.map((turn) => turn.delivery), ['failed', 'completed'])
      } finally { await f.close() }
    }, 30_000)
  }

  it('Stop committed while rejected native setup is closing settles canceled, not unknown', async () => {
    const f = setup(); f.controls.closeGate = deferred()
    try {
      const admitted = await f.chat.send(writer, f.workspaceId, f.request('h1-stop', null))
      const id = admitted.state.conversation!.id
      await eventually(() => f.closes > 0)
      await f.chat.interrupt(writer, f.workspaceId, id, { requestId: 'h1-stop-command' })
      assert.equal((await f.repository.get(id))?.cancel_requested, true)
      f.controls.closeGate.resolve()
      await eventually(async () => (await f.repository.turn(id, 'h1-stop'))?.delivery === 'canceled')
      const state = await f.read()
      assert.equal(state.availability.canSend, true); assert.equal(state.activeTurn, null)
      assert.equal((await f.repository.get(id))?.record.sessionCreation, undefined)
      assert.equal(f.calls.filter((call) => call.method === 'turn/start').length, 0)
    } finally { await f.close() }
  }, 30_000)

  it('creates and binds a chat session while its configured App MCP transport is disabled', async () => {
    const f = setup('success')
    try {
      const request = f.request('disabled-app-mcp', null)
      const admitted = await f.chat.send(writer, f.workspaceId, request)
      const id = admitted.state.conversation!.id
      await eventually(async () => {
        const turn = await f.repository.turn(id, request.requestId)
        assert.notEqual(turn?.delivery, 'failed', JSON.stringify(turn?.error))
        return turn?.delivery === 'completed'
      })
      const state = await f.read()
      assert.equal(state.conversation?.nativeSession?.nativeSessionId, 'h1-native-1')
      assert.equal(state.availability.canSend, true)
      assert.equal(f.created.length, 1)
      assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1)
      assert.equal((await f.chat.send(writer, f.workspaceId, request)).replayed, true)
      assert.equal(f.created.length, 1)
    } finally {
      await f.close()
    }
  }, 30_000)

  for (const mode of ['uncertain', 'cleanup-failure', 'activation-failure', 'binding-failure'] as const) {
    it(`actual adapter ${mode} preserves the creation fence and refuses replacement`, async () => {
      const f = setup(mode === 'binding-failure' ? 'success' : mode)
      if (mode === 'binding-failure') f.repository.bindSession = async () => {
        throw new CodexRpcError('thread/start', 1, false, 'CODEX_APP_SERVER_REQUEST_FAILED')
      }
      try {
        const first = f.request('h1-unknown', null)
        const admitted = await f.chat.send(writer, f.workspaceId, first)
        const id = admitted.state.conversation!.id
        await eventually(async () => (await f.repository.turn(id, first.requestId))?.delivery === 'unknown')
        const state = await f.read(), row = (await f.repository.get(id))!
        assert.equal(state.availability.canSend, false); assert.equal(state.sessionState, 'unavailable')
        assert.equal(row.record.sessionCreation?.requestId, first.requestId); assert.equal(row.record.sessionUnavailable, undefined)
        assert.equal(row.native_session_id, null)
        assert.equal(f.created.length, mode === 'cleanup-failure' ? 0 : 1)
        assert.equal(f.calls.filter((call) => call.method === 'turn/start').length, 0)
        const before = structuredClone(f.calls)
        assert.equal((await f.chat.send(writer, f.workspaceId, first)).replayed, true)
        await assert.rejects(f.chat.send(writer, f.workspaceId, f.request('h1-no-replacement', id)), { code: 'AGENT_CHAT_UNAVAILABLE' })
        assert.deepEqual(f.calls, before)
      } finally { await f.close() }
    }, 30_000)
  }

  it('PostgreSQL rollback cannot retire the marker without committing the terminal receipt', async () => {
    const f = setup()
    try {
      const request = f.request('h1-atomic', null)
      const admitted = await f.repository.admit({ key: agentChatKey(f.context), context: f.context, request, delivery: 'queued', create: f.create })
      const id = admitted.conversationId
      assert.equal(await f.repository.claim(id, request.requestId), true)
      assert.equal(await f.repository.beginSessionCreation(id, request.requestId), true)
      const before = { row: await f.repository.get(id), turn: await f.repository.turn(id, request.requestId) }
      let retired = false
      const faultPool = {
        connect: async () => {
          const client = await pool.connect()
          return { release: () => client.release(), query: async (sql: string, values?: unknown[]) => {
            if (sql.startsWith('update operator_conversations set record=record -')) {
              const result = await client.query(sql, values); retired = result.rowCount === 1; return result
            }
            if (sql.startsWith('update operator_conversation_turns')) throw new Error('H1 fault after marker retirement, before receipt settlement.')
            return client.query(sql, values)
          } }
        },
      } as unknown as pg.Pool
      const result: ExecutionResult = { outcome: 'failed', error: { code: 'FIXTURE', message: 'Definitely rejected.', retryable: true } }
      await assert.rejects(new PostgresAgentChatRepository(faultPool).finish(id, request.requestId, result, undefined, true), /H1 fault/)
      assert.equal(retired, true)
      assert.deepEqual({ row: await f.repository.get(id), turn: await f.repository.turn(id, request.requestId) }, before)
      assert.equal(await f.repository.finish(id, request.requestId, result, undefined, true), true)
      assert.equal((await f.repository.get(id))?.record.sessionCreation, undefined)
      assert.equal((await f.repository.turn(id, request.requestId))?.delivery, 'failed')
    } finally { await f.close() }
  }, 30_000)

  it('legacy urgent HTTP/MCP replay returns unchanged persisted readback and explicit target warning; denied and conflicting requests do not mutate', async () => {
    const f = setup()
    const app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access, services: { agentChat: f.chat, commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
    const clients: Client[] = []
    try {
      const input = { ...f.request('h1-legacy-urgent', null), intent: 'interrupt_and_send' as const, expectedNativeTurnId: 'original-target' }
      const admitted = await f.repository.admit({ key: agentChatKey(f.context), context: f.context, request: input, delivery: 'queued', create: f.create })
      const id = admitted.conversationId
      const oldHash = createHash('sha256').update(JSON.stringify([input.content, input.intent, input.context])).digest('hex')
      await pool.query(`update operator_conversation_turns set input_hash=$3,payload=$4::jsonb,target_native_turn_id=null,
        native_turn_id='urgent-own-turn',delivery='completed' where conversation_id=$1 and request_id=$2`,
      [id, input.requestId, oldHash, JSON.stringify({ content: input.content })])
      await pool.query(`update operator_conversations set native_session_id='old-session',provider_version='codex-cli 0.154.0',
        active_request_id='later-request',active_native_turn_id='later-target',turn_state='active' where id=$1`, [id])
      const snapshot = async () => ({
        row: await f.repository.get(id),
        receipt: (await pool.query('select * from operator_conversation_turns where conversation_id=$1', [id])).rows,
        messages: (await pool.query('select * from operator_conversation_messages where conversation_id=$1 order by sequence', [id])).rows,
      })
      const before = await snapshot(), expected = await f.repository.turn(id, input.requestId)
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => {
        const client = new Client({ name: 'h1-regression', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
        return client
      }
      const mcp = await connect(writerToken), denied = await connect(deniedToken)
      const url = `/api/workspaces/${f.workspaceId}/agent-chat/messages`
      for (const expectedNativeTurnId of ['original-target', 'later-target', undefined]) {
        const request = { ...input, expectedNativeTurnId }
        const http = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${writerToken}` }, payload: request })
        assert.equal(http.statusCode, 200)
        const result = SendAgentChatMessageResponseSchema.parse(http.json())
        assert.equal(result.replayed, true); assert.deepEqual(result.turn, expected)
        assert.equal(result.replayWarning?.code, 'AGENT_CHAT_LEGACY_TARGET_UNVERIFIABLE')
        assert.match(result.replayWarning!.message, /not verified or applied/)
        const tool = await mcp.callTool({ name: 'agent_chat_send', arguments: { workspaceId: f.workspaceId, request } })
        assert.notEqual(tool.isError, true)
        assert.deepEqual(SendAgentChatMessageResponseSchema.parse(decodeMcpToolResult(tool)), result)
      }
      const noWrite = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${readerToken}` }, payload: input })
      assert.equal(noWrite.statusCode, 403)
      const deniedTool = await denied.callTool({ name: 'agent_chat_send', arguments: { workspaceId: f.workspaceId, request: input } })
      assert.equal(deniedTool.isError, true)
      const deniedResult = decodeMcpToolResult(deniedTool) as { error: { code: string } }
      assert.equal(deniedResult.error.code, 'ACCESS_DENIED')
      assert.deepEqual(Object.keys(deniedResult), ['error'])
      const conflict = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${writerToken}` }, payload: { ...input, content: 'different' } })
      assert.equal(conflict.statusCode, 409); assert.match(conflict.body, /AGENT_CHAT_REQUEST_CONFLICT/)
      const conflictTool = await mcp.callTool({ name: 'agent_chat_send', arguments: { workspaceId: f.workspaceId, request: { ...input, intent: 'next_turn' } } })
      assert.equal(conflictTool.isError, true)
      assert.deepEqual(await snapshot(), before)
      assert.deepEqual(f.calls, []); assert.equal(f.managers.length, 0)
    } finally {
      await f.close()
      await Promise.allSettled(clients.map((client) => client.close()))
      await app.close()
    }
  }, 30_000)
})
