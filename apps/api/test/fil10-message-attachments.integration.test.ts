import { readUntil } from './helpers/observableCondition.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { removeFixtureDirectory } from './helpers/testResources.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { NativeHarnessEventSchema, type HarnessExecution, type NativeSessionReference } from '@foreman-code/contracts'
import { ClaudeHarnessConfigurationSchema } from '@foreman-code/contracts/claude'
import { AgentChatStateSchema, type AgentChatContext, type AgentChatQuery, type SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { FileWithRevisionSchema, MAX_FILE_BYTES, type FileWithRevision, type MessageAttachmentRef } from '@foreman-code/contracts/files'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { AcceptedRepeatStartV1Schema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'

import { buildApp } from '../src/app.js'
import { fileStorageMigration } from '../src/infrastructure/fileStorageMigration.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { registerOperatorHttpSecurity } from '../src/modules/access/http.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { agentChatInputHash, agentChatKey, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { commandHash, PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { validateMessageAttachments } from '../src/modules/conversations/messageAttachments.js'
import { bindingIdentity } from '../src/modules/files/tools/context.js'
import { DomainError } from '../src/modules/errors.js'
import { PostgresFileConversationAuthorization } from '../src/modules/files/authorization.js'
import { PostgresFileRepository } from '../src/modules/files/postgres.js'
import { TemporaryFileService } from '../src/modules/files/service.js'
import { postgresCodexChatFiles } from '../src/modules/harnesses/codexFiles/chatAdmission.js'
import { operatorTurnHasFileInputs, recordOperatorFileSubmission } from '../src/modules/harnesses/operatorFiles/postgres.js'
import { FileByteStorage } from '../src/modules/files/storage.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeTurnInput } from '../src/modules/harnesses/port.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import type { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { insertRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { registerAgentChatRoutes } from '../src/routes/agentChat.js'
import { registerFileRoutes } from '../src/routes/files.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'

/** Only native I/O and the finished-Run read projection are synthetic. File uploads,
 * disk bytes, grants, chat services, PostgreSQL receipts, HTTP and MCP are real. */
class AttachmentNative implements NativeHarnessSessionManager {
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
  async forkSession() { return this.createSession() }
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

const pin = (value: FileWithRevision): MessageAttachmentRef => ({ fileId: value.file.fileId, revisionId: value.revision.revisionId })
async function waitFor(check: () => Promise<boolean>) {
  await readUntil(check, value => value, { timeoutMs: 10_000, description: 'chat settlement' })
}

describe.skipIf(!postgresEnabled)('FIL-10 real chat attachments', { timeout: 60_000 }, () => {
  let database: Awaited<ReturnType<typeof agent3Database>>, root: string, app: FastifyInstance
  let access: PostgresAccessService, owner: Awaited<ReturnType<PostgresAccessService['issue']>>
  let reader: Awaited<ReturnType<PostgresAccessService['issue']>>
  let operator: OperatorChatService, agent: AgentChatService
  let operatorRepo: PostgresOperatorConversationRepository, agentRepo: PostgresAgentChatRepository
  let fileStorage: TemporaryFileService
  let fixture: ReturnType<typeof makeCurrentWorkflowFixture>
  const managers = new Map<string, AttachmentNative>()
  const runs = new Map<string, NonNullable<Awaited<ReturnType<PostgresRunRepository['getForWorkspace']>>>>(), executions = new Map<string, HarnessExecution[]>()
  const headers = (token = owner.token) => ({ host: 'localhost', authorization: `Bearer ${token}` })
  const operatorPath = (id: string) => `/api/operator/conversations/${id}`
  const agentPath = () => `/api/workspaces/${fixture.scope.workspaceId}/agent-chat`
  const filePath = (id: string, kind: 'operator' | 'agent' = 'operator') => kind === 'operator'
    ? `${operatorPath(id)}/files` : `${agentPath()}/conversations/${id}/files`
  const query = (runId?: string): AgentChatQuery => ({ workflowId: fixture.scope.workflowId,
    workflowNodeId: fixture.version.definition.nodes[0]!.id, agentId: fixture.version.definition.nodes[0]!.agentId,
    ...(runId ? { runId } : {}) })
  const request = (id: string | null, extra: Partial<SendAgentChatMessageRequest> = {}): SendAgentChatMessageRequest => ({
    requestId: randomUUID(), content: 'review', context: query(), intent: 'next_turn', expectedConversationId: id, ...extra,
  })
  const operatorSend = (id: string, payload: unknown, token = owner.token) => app.inject({
    method: 'POST', url: `${operatorPath(id)}/messages`, headers: headers(token), payload: payload as never,
  })
  const agentSend = (payload: SendAgentChatMessageRequest, token = owner.token) => app.inject({
    method: 'POST', url: `${agentPath()}/messages`, headers: headers(token), payload,
  })
  async function settleOperator(id: string) { await waitFor(async () => !(await operatorRepo.active(id))?.active_request_id) }
  async function settleAgent(id: string) {
    await waitFor(async () => !(await agentRepo.state(id))?.turns.some((turn) => ['queued', 'submitting', 'accepted'].includes(turn.delivery)))
  }
  const nativeEffects = () => ({
    turns: [...managers.values()].reduce((n, manager) => n + manager.prompts.length, 0),
    sessions: [...managers.values()].reduce((n, manager) => n + manager.sessions, 0),
  })

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
    root = await mkdtemp(join(process.env.FOREMAN_CODE_TEST_ROOT!, '.fil10-test-'))
    fixture = await seedAgent3(database.pool, root, makeCurrentWorkflowFixture(randomUUID().slice(0, 8), 'sequential'))
    access = new PostgresAccessService(database.pool)
    owner = await access.issue({ name: 'FIL-10 owner', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: [...ManagementActionSchema.options], scope: {} }] })
    reader = await access.issue({ name: 'FIL-10 reader', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['agent_chat:read'], scope: { workspaceIds: [fixture.scope.workspaceId] } }] })
    const native = (id: string) => {
      let manager = managers.get(id)
      if (!manager) { manager = new AttachmentNative(); managers.set(id, manager) }
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
      getForWorkspace: async (workspaceId, runId) => {
        const run = runs.get(runId)
        return run?.workspaceId === workspaceId ? run : undefined
      },
      getExecution: async (id) => [...executions.values()].flat().find(item => item.id === id),
      async *executionPages(runId) { yield executions.get(runId) ?? [] },
    }, (id) => native(id), root)
    app = Fastify()
    registerOperatorHttpSecurity(app, access)
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : error instanceof z.ZodError ? 400 : 500)
      .send({ error: { code: error instanceof DomainError ? error.code : 'INVALID_REQUEST' } }))
    registerOperatorChatRoutes(app, operator); registerAgentChatRoutes(app, agent)
    fileStorage = new TemporaryFileService(new PostgresFileRepository(database.pool),
      new FileByteStorage(join(root, 'files'), MAX_FILE_BYTES), new PostgresFileConversationAuthorization(database.pool))
    registerFileRoutes(app, fileStorage)
    await app.ready()
  })
  afterAll(async () => {
    await app?.close(); await operator?.shutdown(); await agent?.shutdown()
    if (root) await removeFixtureDirectory(root)
    await database?.close()
  })
  async function upload(id: string, bytes: Buffer, kind: 'operator' | 'agent' = 'operator', token = owner.token) {
    const requestId = randomUUID(), url = filePath(id, kind)
    const allocated = await app.inject({ method: 'POST', url: `${url}/uploads`, headers: headers(token), payload: {
      requestId, filename: 'same.md', mediaType: 'text/markdown', byteSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    } })
    expect([200, 201], allocated.body).toContain(allocated.statusCode)
    const put = await app.inject({ method: 'PUT', url: `${url}/uploads/${requestId}`,
      headers: { ...headers(token), 'content-type': 'application/octet-stream' }, payload: bytes })
    expect(put.statusCode, put.body).toBe(200)
    const finalized = await app.inject({ method: 'POST', url: `${url}/uploads/${requestId}/finalize`, headers: headers(token), payload: {} })
    expect(finalized.statusCode, finalized.body).toBe(200)
    return FileWithRevisionSchema.parse(finalized.json().value)
  }
  async function startAgent(context = query()) {
    const result = await agentSend(request(null, { context, content: 'establish conversation' }))
    expect(result.statusCode, result.body).toBe(202)
    const id = AgentChatStateSchema.parse(result.json().state).conversation!.id
    await settleAgent(id)
    return id
  }

  async function ensureAgent() {
    return (await agent.read(owner.principal, fixture.scope.workspaceId, query())).conversation?.id ?? startAgent()
  }

  it('resolves the persisted Codex sender, message, session and pinned attachment', async () => {
    const id = await ensureAgent()
    const file = await upload(id, Buffer.from('# admitted'), 'agent')
    const input = request(id, { attachments: [pin(file)] })
    expect((await agentSend(input)).statusCode).toBe(202)
    await settleAgent(id)
    const conversation = await agentRepo.get(id)
    const session = { harness: 'codex' as const, providerVersion: conversation!.provider_version!,
      nativeSessionId: conversation!.native_session_id! }
    const resolver = postgresCodexChatFiles(database.pool, () => fileStorage, async () => ({
      executionHostId: 'test-host', pathStyle: 'posix',
      materialize: async () => { throw new Error('unused') }, sealCompleted: async () => { throw new Error('unused') },
      close: async () => {},
    }), '/tmp')
    const admission = await resolver.resolve({ conversationId: id, session,
      clientCorrelationId: `agent-chat:${id}:${input.requestId}`, signal: new AbortController().signal })
    expect(admission?.accepted).toMatchObject({ ownerPrincipalId: owner.principal.id,
      messageId: (await agentRepo.turn(id, input.requestId))!.messageId, attachments: [pin(file)] })
    const opened = await admission!.dependencies.source.open(pin(file))
    const chunks: Buffer[] = []
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk as Uint8Array))
    expect(Buffer.concat(chunks).toString()).toBe('# admitted')
    const publication = await upload(id, Buffer.from('# published'), 'agent')
    const allocation = (await database.pool.query<{ request_id: string }>(
      'select request_id from file_allocations where file_id=$1', [publication.file.fileId])).rows[0]!
    const nativeTurnId = (await agentRepo.turn(id, input.requestId))!.nativeTurnId!
    const accepted = admission!.accepted
    const binding = bindingIdentity({ ownerPrincipalId: accepted.ownerPrincipalId, scope: accepted.scope,
      nativeSessionId: accepted.nativeSessionId, turnId: nativeTurnId, messageId: accepted.messageId,
      allowMutation: accepted.allowMutation, allowedTools: [...accepted.allowedTools] })
    await database.pool.query(`insert into file_tool_publications
      (owner_principal_id,request_id,binding,file_id,revision_id,record) values ($1,$2,$3,$4,$5,$6::jsonb)`,
    [owner.principal.id, allocation.request_id, binding, publication.file.fileId, publication.revision.revisionId,
      JSON.stringify({ ownerPrincipalId: owner.principal.id, requestId: allocation.request_id, binding,
        context: { ownerPrincipalId: accepted.ownerPrincipalId, scope: accepted.scope, nativeSessionId: accepted.nativeSessionId,
          turnId: nativeTurnId, messageId: accepted.messageId, allowMutation: accepted.allowMutation,
          allowedTools: accepted.allowedTools }, ref: pin(publication), createdAt: new Date().toISOString() })])
    await admission!.adoptPublished(nativeTurnId, [pin(publication)])
    await admission!.adoptPublished(nativeTurnId, [pin(publication)])
    const stored = (await database.pool.query<{ record: { attachmentRefs: MessageAttachmentRef[]; publicationRefs: MessageAttachmentRef[] } }>(
      'select record from operator_conversation_messages where id=$1', [accepted.messageId])).rows[0]!
    expect(stored.record.attachmentRefs).toEqual([pin(file)])
    expect(stored.record.publicationRefs).toEqual([pin(publication)])
    await expect(admission!.adoptPublished('foreign-turn', [pin(publication)]))
      .rejects.toMatchObject({ code: 'CODEX_FILE_PUBLICATION_MISMATCH' })
    await expect(resolver.resolve({ conversationId: id, session: { ...session, nativeSessionId: 'foreign' },
      clientCorrelationId: `agent-chat:${id}:${input.requestId}`, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'CODEX_FILE_ADMISSION_MISMATCH' })
    await admission!.dependencies.host.close()
  })

  it('keeps two Operator chats with identical filenames and different bytes distinct; Board context is not file scope', async () => {
    const a = (await operator.create(owner.principal)).id, b = (await operator.create(owner.principal)).id
    const bytesA = Buffer.from('# alpha'), bytesB = Buffer.from('# beta')
    const fa = await upload(a, bytesA), fb = await upload(b, bytesB)
    expect(fa.revision.sha256).not.toBe(fb.revision.sha256)
    expect(fa.file.scope).toMatchObject({ kind: 'temporary', chat: { conversationId: a, ownerPrincipalId: owner.principal.id } })
    expect(Object.keys(fa.file.scope.kind === 'temporary' ? fa.file.scope.chat : {}).sort())
      .toEqual(['conversationId', 'kind', 'operatorId', 'ownerPrincipalId'])
    const before = nativeEffects()
    const foreign = await operatorSend(b, { requestId: randomUUID(), content: 'no', attachments: [pin(fa)] })
    expect(foreign.statusCode, foreign.body).toBe(404); expect(nativeEffects()).toEqual(before)
    for (const [id, value, bytes] of [[a, fa, bytesA], [b, fb, bytesB]] as const) {
      const sent = await operatorSend(id, { requestId: randomUUID(), content: 'review', attachments: [pin(value)],
        context: { route: '/board', workspaceId: 'different-workspace', workflowId: 'different-workflow', runId: 'different-run' } })
      expect(sent.statusCode, sent.body).toBe(202); await settleOperator(id)
      const read = await app.inject({ method: 'GET', url: `${operatorPath(id)}/history`, headers: headers() })
      expect(read.statusCode, read.body).toBe(200)
      expect(read.json().entries.find((entry: { message: { role: string } }) => entry.message.role === 'user').message.attachments)
        .toEqual([value])
      const downloaded = await app.inject({ method: 'GET', url: `${filePath(id)}/${value.file.fileId}/revisions/${value.revision.revisionId}/content`, headers: headers() })
      expect(downloaded.rawPayload).toEqual(bytes)
    }
  })

  it('replays duplicate Operator sends once, conflicts on changed files, and reads expired/removed tombstones', async () => {
    const id = (await operator.create(owner.principal)).id
    const file = await upload(id, Buffer.from('# receipt')), other = await upload(id, Buffer.from('# other'))
    const input = { requestId: randomUUID(), content: 'review', attachments: [pin(file)] }
    const results = await Promise.all([operatorSend(id, input), operatorSend(id, input)])
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 202]); await settleOperator(id)
    expect((await operatorSend(id, { ...input, attachments: [pin(other)] })).statusCode).toBe(409)
    expect((await operatorSend(id, { ...input, attachments: [] })).statusCode).toBe(409)
    const stored = await database.pool.query('select record from operator_conversation_messages where conversation_id=$1 and client_request_id=$2', [id, input.requestId])
    expect(stored.rows).toHaveLength(1)
    expect(stored.rows[0].record.attachmentRefs).toEqual([pin(file)])
    expect(stored.rows[0].record).not.toHaveProperty('attachments')
    const expiryBefore = (await new PostgresFileRepository(database.pool).read(file.file.fileId, file.revision.revisionId))!.value.file
    expect(expiryBefore).toEqual(file.file) // Send does not extend retention.
    await database.pool.query("update files set state='expired' where file_id=$1", [file.file.fileId])
    expect((await operatorSend(id, input)).statusCode).toBe(200)
    expect((await operatorSend(id, { ...input, requestId: randomUUID() })).statusCode).toBe(410)
    const state = (await app.inject({ method: 'GET', url: operatorPath(id), headers: headers() })).json()
    expect(state.messages.find((message: { requestId?: string }) => message.requestId === input.requestId).attachments[0])
      .toMatchObject({ file: { state: 'expired', expiresAt: 'expiresAt' in file.file ? file.file.expiresAt : undefined }, revision: file.revision })
    await database.pool.query("update files set state='removed' where file_id=$1", [file.file.fileId])
    const history = (await app.inject({ method: 'GET', url: `${operatorPath(id)}/history`, headers: headers() })).json()
    expect(history.entries.find((entry: { message: { requestId?: string } }) => entry.message.requestId === input.requestId)
      .message.attachments[0].file.state).toBe('removed')
  })

  it('preserves old Operator receipts, including legacy-hash rows, but cannot add files to them', async () => {
    const id = (await operator.create(owner.principal)).id
    const input = { requestId: randomUUID(), content: 'old text' }
    expect((await operatorSend(id, input)).statusCode).toBe(202); await settleOperator(id)
    const receipt = (await database.pool.query('select input_hash from operator_conversation_turns where conversation_id=$1 and request_id=$2', [id, input.requestId])).rows[0]
    expect(receipt.input_hash).toBe(commandHash(input))
    expect((await operatorSend(id, { ...input, attachments: [] })).statusCode).toBe(200)
    await database.pool.query("update operator_conversation_turns set input_hash='legacy' where conversation_id=$1 and request_id=$2", [id, input.requestId])
    expect((await operatorSend(id, input)).statusCode).toBe(200)
    const file = await upload(id, Buffer.from('# new'))
    expect((await operatorSend(id, { ...input, attachments: [pin(file)] })).statusCode).toBe(409)
  })

  it('attaches to pre-Run Agent chat, pins delayed sends to that conversation, and rejects foreign files', async () => {
    const id = await ensureAgent(), file = await upload(id, Buffer.from('# pre-run'), 'agent')
    expect(file.file.scope).toEqual({ kind: 'temporary', chat: { kind: 'agent', conversationId: id,
      agentId: query().agentId, workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId } })
    const input = request(id, { attachments: [pin(file)] })
    const gate = await database.pool.connect()
    await gate.query('begin')
    await gate.query('select file_id from files where file_id=$1 for update', [file.file.fileId])
    const blockingPid = Number((await gate.query('select pg_backend_pid() as pid')).rows[0].pid)
    const sending = agentSend(input).then((response) => response)
    // A navigation read of another node cannot retarget the already parsed command.
    const otherNode = fixture.version.definition.nodes[1]!
    const otherContext = { workflowId: fixture.scope.workflowId, workflowNodeId: otherNode.id, agentId: otherNode.agentId }
    try {
      await waitFor(async () => Boolean((await database.pool.query(
        'select 1 from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))', [blockingPid])).rowCount))
      expect((await agent.read(owner.principal, fixture.scope.workspaceId, otherContext)).conversation).toBeNull()
    } finally { await gate.query('rollback'); gate.release() }
    expect((await sending).statusCode).toBe(202); await settleAgent(id)
    const duplicate = await agentSend(input)
    expect(duplicate.statusCode).toBe(200)
    expect(duplicate.json().state.messages.find((message: { requestId?: string }) => message.requestId === input.requestId).attachments).toEqual([file])
    expect((await agentSend({ ...input, attachments: [] })).statusCode).toBe(409)
    const before = nativeEffects()
    expect((await agentSend(request(null, { context: otherContext, attachments: [pin(file)] }))).statusCode).toBe(409)
    expect(nativeEffects()).toEqual(before)
    expect((await agent.read(owner.principal, fixture.scope.workspaceId, otherContext)).conversation).toBeNull()
  })

  it('rejects expired and unready Agent files; receipt replay survives later expiry', async () => {
    const id = await ensureAgent()
    const file = await upload(id, Buffer.from('# agent expiry'), 'agent')
    const input = request(id, { attachments: [pin(file)] })
    expect((await agentSend(input)).statusCode).toBe(202); await settleAgent(id)
    await database.pool.query("update files set state='expired' where file_id=$1", [file.file.fileId])
    expect((await agentSend(input)).statusCode).toBe(200)
    expect((await agentSend({ ...input, requestId: randomUUID() })).statusCode).toBe(410)
    const pending = await app.inject({ method: 'POST', url: `${filePath(id, 'agent')}/uploads`, headers: headers(), payload: {
      requestId: randomUUID(), filename: 'same.md', mediaType: 'text/markdown', byteSize: 1, sha256: 'a'.repeat(64),
    } })
    expect([200, 201], pending.body).toContain(pending.statusCode)
    expect((await agentSend(request(id, { attachments: [pin(FileWithRevisionSchema.parse(pending.json().value))] }))).statusCode).toBe(409)
    const history = await app.inject({ method: 'GET', url: `${agentPath()}/conversations/${id}/history`, headers: headers() })
    expect(history.json().messages.find((message: { requestId?: string }) => message.requestId === input.requestId).attachments[0].file.state).toBe('expired')
  })

  it('has authenticated Operator MCP parity, persisted readback, denied writers, and revoked HTTP access', async () => {
    const id = await ensureAgent()
    const file = await upload(id, Buffer.from('# mcp'), 'agent'), input = request(id, { attachments: [pin(file)] })
    const transport = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { agentChat: agent, commands: new PostgresCommandCoordinator(database.pool) } as unknown as OperatorServices } })
    const clients: Client[] = []
    try {
      const address = await transport.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => {
        const client = new Client({ name: 'fil10', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
        return client
      }
      const writer = await connect(owner.token), denied = await connect(reader.token)
      const sent = await writer.callTool({ name: 'agent_chat_send', arguments: { workspaceId: fixture.scope.workspaceId, request: input } })
      expect(sent.isError).not.toBe(true); await settleAgent(id)
      const read = await writer.callTool({ name: 'agent_chat_read', arguments: { workspaceId: fixture.scope.workspaceId, query: query() } })
      expect(AgentChatStateSchema.parse(decodeMcpToolResult(read)).messages.find((message) => message.requestId === input.requestId)!.attachments).toEqual([file])
      expect((await denied.listTools()).tools.map((tool) => tool.name)).not.toContain('agent_chat_send')
      await expectMcpAccessDenied(denied.callTool({ name: 'agent_chat_send', arguments: { workspaceId: fixture.scope.workspaceId, request: input } }))
      expect((await agentSend(input, reader.token)).statusCode).toBe(403)
      const credential = await access.issue({ name: 'revoked FIL-10 writer', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: ['agent_chat:read', 'agent_chat:write'], scope: { workspaceIds: [fixture.scope.workspaceId] } }] })
      await database.pool.query('update management_principals set revoked_at=now() where id=$1', [credential.principal.id])
      const before = nativeEffects()
      const revoked = await agentSend(input, credential.token)
      expect([401, 403]).toContain(revoked.statusCode); expect(nativeEffects()).toEqual(before)
    } finally { await Promise.allSettled(clients.map((client) => client.close())); await transport.close() }
  })

  it('reauthorizes Operator sends and receipt readback after owner revocation', async () => {
    const credential = await access.issue({ name: 'revoked Operator owner', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['operator_chat:read', 'operator_chat:write'], scope: {} }] })
    const id = (await operator.create(credential.principal)).id
    const file = await upload(id, Buffer.from('# private'), 'operator', credential.token)
    const input = { requestId: randomUUID(), content: 'review', attachments: [pin(file)] }
    expect((await operatorSend(id, input, credential.token)).statusCode).toBe(202); await settleOperator(id)
    await database.pool.query('update management_principals set revoked_at=now() where id=$1', [credential.principal.id])
    const before = nativeEffects()
    for (const payload of [input, { ...input, requestId: randomUUID() }]) {
      expect([401, 403]).toContain((await operatorSend(id, payload, credential.token)).statusCode)
    }
    const read = await app.inject({ method: 'GET', url: operatorPath(id), headers: headers(credential.token) })
    expect([401, 403]).toContain(read.statusCode); expect(nativeEffects()).toEqual(before)
  })

  it('isolates two Runs of the same workflow/Agent and never inherits pre-Run attachments', async () => {
    // Admit a second durable Run with the same saved board/configuration through the
    // repository's existing fixture seam, not a raw replacement of saved workflows.
    const revision = Number((await database.pool.query('select revision from workflows where id=$1', [fixture.scope.workflowId])).rows[0].revision)
    const location = fixture.run.executionLocation!, principalId = fixture.run.authorizationPrincipalId!
    const second = { ...fixture.run, id: randomUUID() }
    const accepted = AcceptedRepeatStartV1Schema.parse({ run: second, snapshot: {
      request: { workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId,
        workflowVersionId: fixture.version.id, executionSemanticsVersion: 3, commandId: randomUUID(),
        expectedWorkflowRevision: revision, expectedAgentConfigurationVersionIds: fixture.version.agentConfigurationVersionIds,
        expectedLocationRevision: location.locationRevision, input: fixture.run.input },
      authorizationPrincipalId: principalId, executable: { version: fixture.version, configurations: fixture.configurations },
      workflow: { id: fixture.scope.workflowId, workspaceId: fixture.scope.workspaceId, revision,
        currentVersionId: fixture.version.id, archived: false, definition: fixture.version.definition },
      workspace: { id: fixture.scope.workspaceId, archived: false, location }, draft: null,
    } })
    await withExclusiveGraphConnection(database.pool, (connection) => connection.transaction((sql) => insertRepeatRun(sql, accepted, repeatStartPublication)))
    const ids: string[] = [], files: FileWithRevision[] = []
    for (const run of [fixture.run, second]) {
      const execution: HarnessExecution = { id: randomUUID(), runId: run.id, workflowNodeId: query().workflowNodeId,
        agentId: query().agentId, agentConfigurationVersionId: fixture.version.agentConfigurationVersionIds[query().agentId]!,
        attempt: 1, nativeSessionId: randomUUID(), workingDirectory: root, input: {}, state: 'completed',
        result: { outcome: 'succeeded' }, createdAt: fixture.createdAt, finishedAt: fixture.createdAt }
      await database.pool.query('insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record) values($1,$2,$3,$4,1,$5::jsonb)',
        [execution.id, run.id, execution.workflowNodeId, execution.agentId, JSON.stringify(execution)])
      runs.set(run.id, { ...run, executionState: 'completed', outcome: 'succeeded', result: { outcome: 'succeeded' }, finishedAt: fixture.createdAt } as unknown as Parameters<typeof runs.set>[1])
      executions.set(run.id, [execution])
      if (files.length) {
        expect((await agentSend(request(null, { context: query(run.id), attachments: [pin(files[0]!)] }))).statusCode).toBe(409)
        expect((await agent.read(owner.principal, fixture.scope.workspaceId, query(run.id))).conversation).toBeNull()
      }
      const id = await startAgent(query(run.id)); ids.push(id)
      const file = await upload(id, Buffer.from(`# ${run.id}`), 'agent'); files.push(file)
      expect(file.file.scope).toMatchObject({ kind: 'temporary', chat: { conversationId: id, runId: run.id, executionId: execution.id } })
      const sent = await agentSend(request(id, { context: query(run.id), attachments: [pin(file)] }))
      expect(sent.statusCode, sent.body).toBe(202); await settleAgent(id)
    }
    expect(ids[0]).not.toBe(ids[1])
    const before = nativeEffects()
    expect((await agentSend(request(ids[1]!, { context: query(second.id), attachments: [pin(files[0]!)] }))).statusCode).toBe(404)
    expect(nativeEffects()).toEqual(before)
    const a = await agent.read(owner.principal, fixture.scope.workspaceId, query(fixture.run.id))
    const b = await agent.read(owner.principal, fixture.scope.workspaceId, query(second.id))
    expect(a.messages.flatMap((message) => message.attachments ?? []).map((value) => value.file.fileId)).toEqual([files[0]!.file.fileId])
    expect(b.messages.flatMap((message) => message.attachments ?? []).map((value) => value.file.fileId)).toEqual([files[1]!.file.fileId])
    const pre = await agent.read(owner.principal, fixture.scope.workspaceId, query())
    expect(pre.messages.flatMap((message) => message.attachments ?? []).some((value) => files.some((file) => file.file.fileId === value.file.fileId))).toBe(false)
  })

  it('rejects a cross-harness attachment handoff without creating a child or copying pins', async () => {
    const id = (await operator.create(owner.principal)).id
    const file = await upload(id, Buffer.from('# parent'))
    expect((await operatorSend(id, { requestId: randomUUID(), content: 'parent history' })).statusCode).toBe(202)
    await settleOperator(id)
    const input = { requestId: randomUUID(), content: 'continue', attachments: [pin(file)] }
    const claude = ClaudeHarnessConfigurationSchema.parse({
      harness: 'claude', model: 'synthetic-model', authMode: 'subscription',
      permissionMode: 'default', sandbox: 'danger-full-access', configDirectory: '/fixture/profile',
      tools: [], permissionRules: [], instructions: '', mcpServers: {},
    })
    await expect(operatorRepo.beginForkTurn(id, input, owner.principal.id, claude))
      .rejects.toMatchObject({ code: 'MESSAGE_ATTACHMENT_CONVERSATION_REQUIRED' })
    expect(await operatorRepo.active(`operator-fork:${input.requestId}`)).toBeUndefined()
  })

  it('observes expiry committed during a concurrent lifecycle lock', async () => {
    const id = (await operator.create(owner.principal)).id
    const file = await upload(id, Buffer.from('# raced'))
    const blocking = await database.pool.connect(), admission = await database.pool.connect()
    try {
      await blocking.query('begin'); await admission.query('begin')
      await blocking.query('select file_id from files where file_id=$1 for update', [file.file.fileId])
      const checking = validateMessageAttachments(admission, id, [pin(file)])
      const rejected = expect(checking).rejects.toMatchObject({ code: 'MESSAGE_ATTACHMENT_UNAVAILABLE' })
      await blocking.query("update files set state='expired' where file_id=$1", [file.file.fileId])
      await blocking.query('commit'); await rejected
      await admission.query('rollback')
    } finally {
      await blocking.query('rollback').catch(() => {}); await admission.query('rollback').catch(() => {})
      blocking.release(); admission.release()
    }
  })

  it('never appends files through the legacy Agent steer/urgent hash fallback', async () => {
    const id = await ensureAgent()
    const file = await upload(id, Buffer.from('# fallback'), 'agent')
    for (const intent of ['steer', 'interrupt_and_send'] as const) {
      const input = request(id, { intent }), context: AgentChatContext = { workspaceId: fixture.scope.workspaceId, ...input.context }
      const messageId = randomUUID()
      await database.pool.query(`insert into operator_conversation_messages(id,conversation_id,role,content,client_request_id,record)
        values($1,$2,'user',$3,$4,$5::jsonb)`, [messageId, id, input.content, input.requestId,
        JSON.stringify({ id: messageId, conversationId: id, role: 'user', content: input.content, requestId: input.requestId })])
      await database.pool.query(`insert into operator_conversation_turns(conversation_id,request_id,payload,input_hash,intent,delivery,message_id,target_native_turn_id)
        values($1,$2,$3::jsonb,$4,$5,'completed',$6,$7)`, [id, input.requestId, JSON.stringify({ content: input.content }),
        agentChatInputHash(input), intent, messageId, intent === 'steer' ? 'old-turn' : null])
      const replay = { ...input, expectedNativeTurnId: 'old-turn' }
      expect((await agentRepo.admit({ key: agentChatKey(context), context, request: replay, delivery: 'queued' })).replayed).toBe(true)
      await expect(agentRepo.admit({ key: agentChatKey(context), context, request: { ...replay, attachments: [pin(file)] }, delivery: 'queued' }))
        .rejects.toMatchObject({ code: 'AGENT_CHAT_REQUEST_CONFLICT' })
    }
  })

})
