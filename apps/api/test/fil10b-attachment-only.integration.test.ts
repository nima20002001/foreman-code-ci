import { readUntil } from './helpers/observableCondition.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { removeFixtureDirectory } from './helpers/testResources.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { NativeHarnessEventSchema, type NativeSessionReference } from '@foreman-code/contracts'
import { AgentChatStateSchema, type AgentChatQuery, type SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { FileWithRevisionSchema, MAX_FILE_BYTES, type FileWithRevision } from '@foreman-code/contracts/files'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'

import { buildApp } from '../src/app.js'
import { fileStorageMigration } from '../src/infrastructure/fileStorageMigration.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { registerOperatorHttpSecurity } from '../src/modules/access/http.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { DomainError } from '../src/modules/errors.js'
import { PostgresFileConversationAuthorization } from '../src/modules/files/authorization.js'
import { PostgresFileRepository } from '../src/modules/files/postgres.js'
import { TemporaryFileService } from '../src/modules/files/service.js'
import { FileByteStorage } from '../src/modules/files/storage.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeTurnInput } from '../src/modules/harnesses/port.js'
import { operatorTurnHasFileInputs, recordOperatorFileSubmission } from '../src/modules/harnesses/operatorFiles/postgres.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { registerAgentChatRoutes } from '../src/routes/agentChat.js'
import { registerFileRoutes } from '../src/routes/files.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'

/** Native I/O only is synthetic. These tests exercise real file allocations, disk
 * bytes, chat services, PostgreSQL receipts, authenticated HTTP and Operator MCP.
 * FIL-08/09 native delivery of attachment bytes is deliberately outside this test. */
class AttachmentOnlyNative implements NativeHarnessSessionManager {
  readonly harness = 'codex' as const
  sessions = 0
  prompts: string[] = []
  private histories = new Map<string, NativeHistory>()
  async capabilities() {
    return { provider: this.harness, providerVersion: 'fixture-1', persistentSessions: true, reconnect: true,
      sameRequestResponses: true, cancellation: true, history: true, configurationInspection: false,
      mcpDetection: false, supportedInteractionKinds: [] }
  }
  inspectMcp(): ReturnType<NativeHarnessSessionManager['inspectMcp']> { throw new Error('unused') }
  async createSession(): Promise<NativeSessionReference> {
    this.sessions++
    return { harness: this.harness, providerVersion: 'fixture-1', nativeSessionId: randomUUID() }
  }
  async attachSession(session: NativeSessionReference) { return session }
  async *startTurn(_session: NativeSessionReference, input: NativeTurnInput) {
    this.prompts.push(input.prompt)
    const id = randomUUID()
    const history: NativeHistory = { correlationId: input.clientCorrelationId, nativeTurnId: id, events: [], pendingInteractions: [] }
    this.histories.set(input.clientCorrelationId, history)
    await input.onSubmitted?.(id)
    yield NativeHarnessEventSchema.parse({ sequence: 1, type: 'item.completed', occurredAt: new Date().toISOString(),
      payload: { turnId: id, item: { id: randomUUID(), type: 'agentMessage', text: 'done', phase: 'final_answer' } } })
    history.terminalResult = { outcome: 'succeeded' }
  }
  async pending() { return undefined }
  async respond() {}
  async cancel() { return false }
  async history() { return { events: [], pendingInteractions: [] } }
  async reconcile(_session: NativeSessionReference, correlation: string) {
    return this.histories.get(correlation) ?? { events: [], pendingInteractions: [] }
  }
  async close() {}
}

const pin = (value: FileWithRevision) => ({ fileId: value.file.fileId, revisionId: value.revision.revisionId })
const digest = (json: string) => createHash('sha256').update(json).digest('hex')
async function waitFor(check: () => Promise<boolean>) {
  await readUntil(check, value => value, { timeoutMs: 10_000, description: 'chat settlement' })
}

describe.skipIf(!postgresEnabled)('FIL-10b attachment-only admission and legacy replay', { timeout: 60_000 }, () => {
  let database: Awaited<ReturnType<typeof agent3Database>>, root: string, app: FastifyInstance
  let access: PostgresAccessService, owner: Awaited<ReturnType<PostgresAccessService['issue']>>
  let reader: Awaited<ReturnType<PostgresAccessService['issue']>>
  let operator: OperatorChatService, agent: AgentChatService
  let operatorRepo: PostgresOperatorConversationRepository, agentRepo: PostgresAgentChatRepository
  let fixture: ReturnType<typeof makeCurrentWorkflowFixture>
  const managers = new Map<string, AttachmentOnlyNative>()
  const headers = (token = owner.token) => ({ host: 'localhost', authorization: `Bearer ${token}` })
  const operatorPath = (id: string) => `/api/operator/conversations/${id}`
  const agentPath = () => `/api/workspaces/${fixture.scope.workspaceId}/agent-chat`
  const query = (): AgentChatQuery => ({ workflowId: fixture.scope.workflowId,
    workflowNodeId: fixture.version.definition.nodes[0]!.id, agentId: fixture.version.definition.nodes[0]!.agentId })
  const request = (id: string | null, extra: Partial<SendAgentChatMessageRequest> = {}): SendAgentChatMessageRequest => ({
    requestId: randomUUID(), content: 'review', context: query(), intent: 'next_turn', expectedConversationId: id, ...extra,
  })
  const operatorSend = (id: string, payload: unknown) => app.inject({
    method: 'POST', url: `${operatorPath(id)}/messages`, headers: headers(), payload: payload as never,
  })
  const agentSend = (payload: SendAgentChatMessageRequest, token = owner.token) => app.inject({
    method: 'POST', url: `${agentPath()}/messages`, headers: headers(token), payload,
  })
  const nativeEffects = () => ({
    turns: [...managers.values()].reduce((n, manager) => n + manager.prompts.length, 0),
    sessions: [...managers.values()].reduce((n, manager) => n + manager.sessions, 0),
  })
  async function settleOperator(id: string) { await waitFor(async () => !(await operatorRepo.active(id))?.active_request_id) }
  async function settleAgent(id: string) {
    await waitFor(async () => !(await agentRepo.state(id))?.turns.some((turn) => ['queued', 'submitting', 'accepted'].includes(turn.delivery)))
  }
  async function persisted(id: string, requestId: string) {
    const args = [id, requestId]
    // Compare the complete persisted rows, including timestamps and receipt metadata,
    // as serialized bytes rather than a reduced DTO that could hide a replay mutation.
    const messages = await database.pool.query<{ bytes: string }>(`select row_to_json(m)::text as bytes
      from operator_conversation_messages m where conversation_id=$1 and client_request_id=$2 order by id`, args)
    const turns = await database.pool.query<{ bytes: string }>(`select row_to_json(t)::text as bytes
      from operator_conversation_turns t where conversation_id=$1 and request_id=$2`, args)
    return { messages: messages.rows.map((row) => row.bytes), turns: turns.rows.map((row) => row.bytes) }
  }

  beforeAll(async () => {
    database = await agent3Database()
    const present = await database.pool.query('select 1 from application_migrations where version=$1', [fileStorageMigration.version])
    if (!present.rowCount) {
      const client = await database.pool.connect()
      try {
        await client.query('begin'); await client.query(fileStorageMigration.sql)
        await client.query('insert into application_migrations(version) values($1)', [fileStorageMigration.version]); await client.query('commit')
      } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
    }
    root = await mkdtemp(join(homedir(), '.fil10b-test-'))
    fixture = await seedAgent3(database.pool, root, makeCurrentWorkflowFixture(randomUUID().slice(0, 8), 'sequential'), { run: false })
    access = new PostgresAccessService(database.pool)
    owner = await access.issue({ name: 'FIL-10b owner', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: [...ManagementActionSchema.options], scope: {} }] })
    reader = await access.issue({ name: 'FIL-10b reader', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['agent_chat:read'], scope: { workspaceIds: [fixture.scope.workspaceId] } }] })
    const native = (id: string) => {
      let manager = managers.get(id)
      if (!manager) { manager = new AttachmentOnlyNative(); managers.set(id, manager) }
      return manager
    }
    operatorRepo = new PostgresOperatorConversationRepository(database.pool)
    agentRepo = new PostgresAgentChatRepository(database.pool)
    const operatorManager = Object.assign((_configuration: unknown, id: string) => native(id), {
      hasFileInputs: (id: string, requestId: string) => operatorTurnHasFileInputs(database.pool, id, requestId),
      recordFileSubmission: (id: string, requestId: string, nativeTurnId: string) =>
        recordOperatorFileSubmission(database.pool, id, requestId, nativeTurnId),
    })
    operator = new OperatorChatService(operatorRepo, new PostgresOperatorRepository(database.pool),
      operatorManager, root, {
        current: (id) => access.currentOperator(id), assertConfiguration() {},
        setup: async (manager) => ({ harness: manager.harness, status: 'configured', endpoint: 'http://127.0.0.1:3000/mcp', checkedAt: new Date().toISOString() }),
        prepare: async (_manager, configuration) => ({ agentId: configuration.operatorId, variables: {} }), release: async () => {},
      })
    agent = new AgentChatService(database.pool, agentRepo, operatorRepo, new PostgresWorkflowRepository(database.pool), {
      getForWorkspace: async () => undefined, getExecution: async () => undefined, async *executionPages() { yield [] },
    }, (id) => native(id), root)
    app = Fastify()
    registerOperatorHttpSecurity(app, access)
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : error instanceof z.ZodError ? 400 : 500)
      .send({ error: { code: error instanceof DomainError ? error.code : 'INVALID_REQUEST' } }))
    registerOperatorChatRoutes(app, operator); registerAgentChatRoutes(app, agent)
    registerFileRoutes(app, new TemporaryFileService(new PostgresFileRepository(database.pool),
      new FileByteStorage(join(root, 'files'), MAX_FILE_BYTES), new PostgresFileConversationAuthorization(database.pool)))
    await app.ready()
  })
  afterAll(async () => {
    await app?.close(); await operator?.shutdown(); await agent?.shutdown()
    if (root) await removeFixtureDirectory(root)
    await database?.close()
  })
  async function upload(id: string, kind: 'operator' | 'agent') {
    const bytes = Buffer.from('# attachment-only'), requestId = randomUUID()
    const url = kind === 'operator' ? `${operatorPath(id)}/files` : `${agentPath()}/conversations/${id}/files`
    const allocated = await app.inject({ method: 'POST', url: `${url}/uploads`, headers: headers(), payload: {
      requestId, filename: 'attachment.md', mediaType: 'text/markdown', byteSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    } })
    expect([200, 201], allocated.body).toContain(allocated.statusCode)
    const put = await app.inject({ method: 'PUT', url: `${url}/uploads/${requestId}`,
      headers: { ...headers(), 'content-type': 'application/octet-stream' }, payload: bytes })
    expect(put.statusCode, put.body).toBe(200)
    const finalized = await app.inject({ method: 'POST', url: `${url}/uploads/${requestId}/finalize`, headers: headers(), payload: {} })
    expect(finalized.statusCode, finalized.body).toBe(200)
    return FileWithRevisionSchema.parse(finalized.json().value)
  }
  async function ensureAgent() {
    const existing = (await agent.read(owner.principal, fixture.scope.workspaceId, query())).conversation?.id
    if (existing) { await settleAgent(existing); return existing }
    const response = await agentSend(request(null, { content: 'establish conversation' }))
    expect(response.statusCode, response.body).toBe(202)
    const id = AgentChatStateSchema.parse(response.json().state).conversation!.id
    await settleAgent(id)
    return id
  }

  it('rejects empty/no-file input in both services and HTTP without storing a command or creating an Agent session', async () => {
    const id = (await operator.create(owner.principal)).id
    const initial = await agent.read(owner.principal, fixture.scope.workspaceId, query())
    const before = nativeEffects()
    for (const content of ['', ' \t\r\n ']) {
      for (const fields of [{}, { attachments: [] }]) {
        const operatorInput = { requestId: randomUUID(), content, ...fields }
        const agentInput = request(initial.conversation?.id ?? null, { content, ...fields })
        await expect(operator.send(id, operatorInput, owner.principal)).rejects.toBeInstanceOf(z.ZodError)
        await expect(agent.send(owner.principal, fixture.scope.workspaceId, agentInput)).rejects.toBeInstanceOf(z.ZodError)
        expect((await operatorSend(id, operatorInput)).statusCode).toBe(400)
        expect((await agentSend(agentInput)).statusCode).toBe(400)
        expect(await persisted(id, operatorInput.requestId)).toEqual({ messages: [], turns: [] })
        const turns = await database.pool.query('select 1 from operator_conversation_turns where request_id=$1', [agentInput.requestId])
        expect(turns.rows).toHaveLength(0)
      }
    }
    expect(await agent.read(owner.principal, fixture.scope.workspaceId, query())).toEqual(initial)
    expect(nativeEffects()).toEqual(before)
  })

  it.each(['', ' \t\r\n '])('accepts Operator content %j via service and HTTP, persists empty text and replays once', async (content) => {
    const id = (await operator.create(owner.principal)).id, file = await upload(id, 'operator')
    const input = { requestId: randomUUID(), content, attachments: [pin(file)] }
    const before = nativeEffects()
    if (content === '') expect((await operator.send(id, input, owner.principal)).replayed).toBe(false)
    else expect((await operatorSend(id, input)).statusCode).toBe(202)
    await settleOperator(id)
    expect((await operatorRepo.active(id))!.last_result?.outcome).toBe('succeeded')
    const stored = await persisted(id, input.requestId)
    expect(stored.messages).toHaveLength(1); expect(stored.turns).toHaveLength(1)
    expect(JSON.parse(stored.messages[0]!)).toMatchObject({ content: '', record: { content: '', attachmentRefs: [pin(file)] } })
    const history = await app.inject({ method: 'GET', url: `${operatorPath(id)}/history`, headers: headers() })
    expect(history.statusCode, history.body).toBe(200)
    expect(history.json().entries.find((entry: { message: { requestId?: string } }) => entry.message.requestId === input.requestId).message)
      .toMatchObject({ content: '', attachments: [file] })
    const replay = await operatorSend(id, { ...input, content: '' })
    expect(replay.statusCode, replay.body).toBe(200); expect(replay.json().replayed).toBe(true)
    expect(await persisted(id, input.requestId)).toEqual(stored)
    expect(nativeEffects().turns).toBe(before.turns + 1)
    const other = await upload(id, 'operator')
    expect((await operatorSend(id, { ...input, attachments: [pin(other)] })).statusCode).toBe(409)
    expect(await persisted(id, input.requestId)).toEqual(stored)
  })

  it.each(['', ' \t\r\n '])('accepts Agent content %j via service and HTTP and keeps its message/receipt pins', async (content) => {
    const id = await ensureAgent(), file = await upload(id, 'agent')
    const input = request(id, { content, attachments: [pin(file)] }), before = nativeEffects()
    if (content === '') expect((await agent.send(owner.principal, fixture.scope.workspaceId, input)).replayed).toBe(false)
    else expect((await agentSend(input)).statusCode).toBe(202)
    await settleAgent(id)
    const state = await agent.read(owner.principal, fixture.scope.workspaceId, query())
    expect(state.turns.find((turn) => turn.requestId === input.requestId)?.delivery).toBe('completed')
    expect(state.messages.find((message) => message.requestId === input.requestId && message.role === 'user'))
      .toMatchObject({ content: '', attachments: [file] })
    const stored = await persisted(id, input.requestId)
    expect(stored.messages).toHaveLength(1); expect(stored.turns).toHaveLength(1)
    expect(JSON.parse(stored.messages[0]!)).toMatchObject({ content: '', record: { content: '', attachmentRefs: [pin(file)] } })
    const replay = await agentSend({ ...input, content: '' })
    expect(replay.statusCode, replay.body).toBe(200); expect(replay.json().replayed).toBe(true)
    expect(await persisted(id, input.requestId)).toEqual(stored)
    expect(nativeEffects().turns).toBe(before.turns + 1)
    const other = await upload(id, 'agent')
    expect((await agentSend({ ...input, attachments: [pin(other)] })).statusCode).toBe(409)
    expect(await persisted(id, input.requestId)).toEqual(stored)
  })

  it('replays old Operator hashes and legacy sentinel receipts without changing a stored byte or submitting native work', async () => {
    const id = (await operator.create(owner.principal)).id, input = { requestId: randomUUID(), content: ' \told text\n ' }
    expect((await operatorSend(id, input)).statusCode).toBe(202); await settleOperator(id)
    // Literal pre-attachment hash input: no [] field, no replacement content.
    const oldHash = digest('{"content":"old text"}')
    const hash = (await database.pool.query('select input_hash from operator_conversation_turns where conversation_id=$1 and request_id=$2', [id, input.requestId])).rows[0].input_hash
    expect(hash).toBe(oldHash)
    const before = nativeEffects()
    for (const receiptHash of [oldHash, 'legacy']) {
      await database.pool.query('update operator_conversation_turns set input_hash=$3 where conversation_id=$1 and request_id=$2', [id, input.requestId, receiptHash])
      const stored = await persisted(id, input.requestId)
      for (const fields of [{}, { attachments: [] }, { attachments: [], recovery: 'receipt' as const }]) {
        const replay = await operatorSend(id, { ...input, ...fields })
        expect(replay.statusCode, replay.body).toBe(200); expect(replay.json().replayed).toBe(true)
        expect(await persisted(id, input.requestId)).toEqual(stored)
        expect(replay.json().state.messages.find((message: { requestId?: string; role: string }) => message.requestId === input.requestId && message.role === 'user'))
          .not.toHaveProperty('attachments')
      }
    }
    expect(nativeEffects()).toEqual(before)
  })

  it('replays an old Agent text receipt with omitted or [] attachments unchanged', async () => {
    const id = await ensureAgent(), input = request(id, { content: ' \told text\n ' })
    expect((await agentSend(input)).statusCode).toBe(202); await settleAgent(id)
    const oldHash = digest(JSON.stringify(['old text', 'next_turn', query()]))
    const hash = (await database.pool.query('select input_hash from operator_conversation_turns where conversation_id=$1 and request_id=$2', [id, input.requestId])).rows[0].input_hash
    expect(hash).toBe(oldHash)
    const stored = await persisted(id, input.requestId), before = nativeEffects()
    for (const fields of [{}, { attachments: [] }]) {
      const replay = await agentSend({ ...input, ...fields })
      expect(replay.statusCode, replay.body).toBe(200); expect(replay.json().replayed).toBe(true)
      expect(await persisted(id, input.requestId)).toEqual(stored)
      expect(replay.json().state.messages.find((message: { requestId?: string; role: string }) => message.requestId === input.requestId && message.role === 'user'))
        .not.toHaveProperty('attachments')
    }
    expect(nativeEffects()).toEqual(before)
  })

  it('supports attachment-only Agent sends through authenticated Operator MCP with persisted readback and denied-writer isolation', async () => {
    const id = await ensureAgent(), file = await upload(id, 'agent')
    const input = request(id, { content: '', attachments: [pin(file)] })
    const transport = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { agentChat: agent, commands: new PostgresCommandCoordinator(database.pool) } as unknown as OperatorServices } })
    const clients: Client[] = []
    try {
      const address = await transport.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => {
        const client = new Client({ name: 'fil10b', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
        return client
      }
      const writer = await connect(owner.token), denied = await connect(reader.token)
      const sent = await writer.callTool({ name: 'agent_chat_send', arguments: { workspaceId: fixture.scope.workspaceId, request: input } })
      expect(sent.isError).not.toBe(true); await settleAgent(id)
      const read = await writer.callTool({ name: 'agent_chat_read', arguments: { workspaceId: fixture.scope.workspaceId, query: query() } })
      expect(AgentChatStateSchema.parse(decodeMcpToolResult(read)).messages.find((message) => message.requestId === input.requestId && message.role === 'user'))
        .toMatchObject({ content: '', attachments: [file] })
      const stored = await persisted(id, input.requestId), before = nativeEffects()
      const replay = await writer.callTool({ name: 'agent_chat_send', arguments: { workspaceId: fixture.scope.workspaceId, request: input } })
      expect(replay.isError).not.toBe(true)
      expect(decodeMcpToolResult(replay)).toMatchObject({ replayed: true })
      expect(await persisted(id, input.requestId)).toEqual(stored)
      const rejected = { ...input, requestId: randomUUID() }
      expect((await denied.listTools()).tools.map((tool) => tool.name)).not.toContain('agent_chat_send')
      await expectMcpAccessDenied(denied.callTool({ name: 'agent_chat_send', arguments: { workspaceId: fixture.scope.workspaceId, request: rejected } }))
      expect((await agentSend(rejected, reader.token)).statusCode).toBe(403)
      expect(await persisted(id, rejected.requestId)).toEqual({ messages: [], turns: [] })
      expect(nativeEffects()).toEqual(before)
    } finally { await Promise.allSettled(clients.map((client) => client.close())); await transport.close() }
  })
})
