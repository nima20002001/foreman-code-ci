import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import Fastify from 'fastify'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { AgentFileCreateWorkingCopyResultSchema, AgentFilePublishResultSchema } from '@foreman-code/contracts/files'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ApiConfig } from '../src/config.js'
import type { ClaudeNativeSessionManager } from '../src/modules/harnesses/claudeSdk/sessionManager.js'
import type { WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresOperatorConversationRepository, nativeCorrelation } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresClaudeInteractionAuthority } from '../src/modules/harnesses/claudeSdk/domainAuthority.js'
import { MainWorkerConversationBridge } from '../src/modules/conversations/workerBridge.js'
import { createMainWorkerClaudeFiles } from '../src/modules/conversations/mainWorkerClaudeFiles.js'
import { createWorkerClaudeFiles } from '../src/modules/conversations/workerClaudeFiles.js'
import { readConversationPublicationReceipts } from '../src/modules/conversations/messagePublications.js'
import { registerProductionFileStorage } from '../src/modules/files/production.js'
import { productionFileTools } from '../src/modules/files/tools/production.js'
import { PostgresFileConversationAuthorization } from '../src/modules/files/authorization.js'
import { workerConversationFixture } from '../src/modules/conversations/workerFixtures.test-support.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { rejectableDeferred } from './helpers/deferred.js'

// Native frames are recorded; PostgreSQL admission, SDK MCP and the file service are production code.
async function fixture(readOnly: boolean) {
  const db = await agent3Database()
  const app = Fastify({ logger: false })
  const resources: { close?: () => Promise<void> } = {}
  onTestFinished(async () => {
    try { await resources.close?.() }
    finally { try { await app.close() } finally { await db.close() } }
  })
  const config: ApiConfig = { host: '127.0.0.1', port: 4100, readinessTimeoutMs: 2000,
    database: { connectionString: process.env.TEST_DATABASE_URL!, maxConnections: 4,
      connectionTimeoutMs: 2000, queryTimeoutMs: 5000 }, checkpoints: { schema: 'langgraph' },
    fileStorageRoot: join(db.directory, 'vault'), workspaceStorageRoot: join(db.directory, 'projects'),
    harnesses: { workspaceRoot: join(db.directory, 'runtime'), codexBinary: 'recorded', timeoutMs: 5000 } }
  await mkdir(config.harnesses.workspaceRoot)
  await mkdir(config.workspaceStorageRoot!)
  const storage = registerProductionFileStorage(app, db.pool, config)
  await app.ready()
  const service = productionFileTools(app)
  const access = new PostgresAccessService(db.pool)
  const sender = await access.issue({ name: 'File sender', audience: 'operator',
    grants: [{ actions: ['operator_chat:read', 'operator_chat:write'], scope: {} }],
    expiresAt: new Date(Date.now() + 600_000) })
  const operators = new PostgresOperatorRepository(db.pool)
  const initial = await operators.ensure()
  const recorded = workerConversationFixture('operator', 'claude')
  if (recorded.configuration.harness.harness !== 'claude') throw new Error('Claude configuration required')
  const selected = await operators.update({ ...recorded.configuration.harness, model: 'recorded',
    sandbox: readOnly ? 'read-only' : 'workspace-write' }, initial.configuration.id)
  const repository = new PostgresOperatorConversationRepository(db.pool)
  const conversation = await repository.create(selected.operator.id, selected.configuration, sender.principal.id)
  const requestId = randomUUID()
  await repository.beginTurn(conversation.id, { requestId, content: 'Read the attached document.' }, sender.principal.id)
  const session = recorded.session
  await repository.bind(conversation.id, requestId, session.providerVersion, session.nativeSessionId)
  const correlationId = nativeCorrelation(conversation.id, requestId)
  const submission = { kind: 'message' as const, nativeSessionId: session.nativeSessionId,
    nativeMessageId: randomUUID(), clientCorrelationId: correlationId }
  const identity = { nativeSessionId: session.nativeSessionId, nativeMessageId: submission.nativeMessageId,
    clientCorrelationId: correlationId, ownerPrincipalId: sender.principal.id, attemptId: requestId,
    generation: 'recorded-query', toolUseId: 'observed-root' }
  const context = { nativeSessionId: session.nativeSessionId, nativeMessageId: submission.nativeMessageId,
    clientCorrelationId: correlationId, generation: identity.generation }
  const native = { waitNativeCallbackContext: async (id: string) => {
    if (id !== identity.toolUseId) throw new Error('Unknown root tool')
    return context
  }, nativeCallbackContext: () => context,
  callbackAuthority: () => ({ ownerPrincipalId: identity.ownerPrincipalId, attemptId: requestId }) }
  const domain = { kind: 'operator' as const, conversationId: conversation.id, repository }
  const authority = new PostgresClaudeInteractionAuthority(db.pool, domain, native)
  const mainFiles = createMainWorkerClaudeFiles({ pool: db.pool, binding: domain,
    service: () => service, allowMutation: !readOnly })
  const bridge = new MainWorkerConversationBridge()
  const binding = { ...recorded.binding, owner: { kind: 'operator' as const, conversationId: conversation.id,
    operatorId: selected.operator.id, configurationVersionId: selected.configuration.id,
    configurationHash: commandInputHash(selected.configuration) } }
  const source: WorkerConversationRpcRequest = { method: 'conversation.start-turn', binding, session,
    prompt: 'Read the attached document.', correlationId }
  const fileCompleted = rejectableDeferred()
  let fileSignal: AbortSignal | undefined
  const lease = bridge.capture({ request: source, channel: { binding: recorded.connection,
    request: async () => ({ payload: {} }) }, current: async () => { await authority.callbackAdmission() },
  callbacks: { submitted: async (_correlationId, value) => {
    expect(await repository.submittedMessage(conversation.id, requestId, value.nativeSubmission!)).toBe(true)
  }, claudeAuthority: async (request, signal) => {
    if (request.phase !== 'file') throw new Error('Expected file callback')
    fileSignal = signal
    const root = { nativeSessionId: request.identity.nativeSessionId, nativeMessageId: request.identity.nativeMessageId,
      clientCorrelationId: request.identity.clientCorrelationId, ownerPrincipalId: request.identity.ownerPrincipalId,
      attemptId: request.identity.attemptId, generation: request.identity.generation, toolUseId: request.identity.toolUseId }
    try {
      await authority.validate(root)
      return await mainFiles.call(request, root, signal)
    } finally { fileCompleted.resolve() }
  } } })
  const lifetime = new AbortController()
  const workerFiles = createWorkerClaudeFiles({ sdk: { createSdkMcpServer, tool }, allowMutation: !readOnly,
    manager: () => native as unknown as ClaudeNativeSessionManager, signal: lifetime.signal,
    authority: { file: (callbackIdentity, operation, args, signal) => bridge.handle({
      method: 'conversation.claude-authority', binding, admissionId: lease.admissionId,
      request: { phase: 'file', identity: callbackIdentity, operation, args },
    }, recorded.connection, signal) } })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'Worker file caller', version: '1.0.0' })
  resources.close = async () => {
    lifetime.abort()
    await lease.close()
    try { await workerFiles.close() }
    finally { try { await client.close() } finally { await mainFiles.close() } }
  }
  await workerFiles.server.instance.connect(serverTransport)
  await client.connect(clientTransport)
  const target = { kind: 'operator' as const, conversationId: conversation.id }
  const scope = await new PostgresFileConversationAuthorization(db.pool).resolve(sender.principal, target,
    readOnly ? 'read' : 'write')
  const bytes = Buffer.from('Worker attachment contents')
  const uploadId = randomUUID()
  await storage.allocate(sender.principal, target, { requestId: uploadId, filename: 'source.md',
    mediaType: 'text/markdown', byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  await storage.upload(sender.principal, target, uploadId, Readable.from([bytes]))
  const uploaded = await storage.finalize(sender.principal, target, uploadId)
  const ref = { fileId: uploaded.value.file.fileId, revisionId: uploaded.value.revision.revisionId }
  const call = (name: string, args: Record<string, unknown>,
    options: { toolUseId?: string; signal?: AbortSignal } = {}) => client.callTool({
    name, arguments: args, _meta: { 'claudecode/toolUseId': options.toolUseId ?? identity.toolUseId },
  }, undefined, { ...(options.signal ? { signal: options.signal } : {}) })
  const acknowledge = () => bridge.handle({ method: 'conversation.submitted', binding,
    admissionId: lease.admissionId, correlationId, identity: { nativeSubmission: submission } },
  recorded.connection, AbortSignal.timeout(5000))
  return { db, client, call, acknowledge, ref, scope, sender, lease, mainFiles, service,
    fileSignal: () => fileSignal, fileCompleted: fileCompleted.promise,
    readConversation: () => repository.get(conversation.id) }
}

describe.skipIf(!postgresEnabled)('Claude worker file calls on admitted native messages', () => {
  it('rejects cancellation during Main credential issuance and revokes the credential on closure', async () => {
    const f = await fixture(false)
    await f.acknowledge()
    const entered = rejectableDeferred()
    const release = rejectableDeferred()
    const issue = f.service.sessions.issueForAcceptedSession.bind(f.service.sessions)
    const issuance = vi.spyOn(f.service.sessions, 'issueForAcceptedSession').mockImplementationOnce(async (...args) => {
      const token = await issue(...args)
      entered.resolve()
      await release.promise
      return token
    })
    const controller = new AbortController()
    const result = f.call('files.create_working_copy', {
      commandId: randomUUID(), source: f.ref, destination: f.scope,
    }, { signal: controller.signal }).catch(error => error)
    try {
      await Promise.race([entered.promise, result.then(() => {
        throw new Error('The file call ended before the credential issuance barrier.')
      })])
      controller.abort()
      await vi.waitFor(() => expect(f.fileSignal()?.aborted).toBe(true))
      release.resolve()
      await result
      await f.fileCompleted
      const token = await issuance.mock.results[0]!.value
      const artifacts = await f.db.pool.query('select count(*)::int as count from file_tool_artifacts')
      expect(artifacts.rows[0].count).toBe(0)
      await f.mainFiles.close()
      await expect(f.service.sessions.authenticate(token)).rejects.toMatchObject({ code: 'FILE_SESSION_EXPIRED' })
    } finally {
      release.resolve()
      await result
      if (f.fileSignal()) await f.fileCompleted
      issuance.mockRestore()
    }
  })

  it('reads back an accepted mutation after its SDK file request is cancelled', async () => {
    const f = await fixture(false)
    await f.acknowledge()
    const entered = rejectableDeferred()
    const release = rejectableDeferred()
    const create = f.service.createWorkingCopy.bind(f.service)
    const accepted = vi.spyOn(f.service, 'createWorkingCopy').mockImplementationOnce(async (...args) => {
      const result = await create(...args)
      entered.resolve()
      await release.promise
      return result
    })
    const controller = new AbortController()
    const args = { commandId: randomUUID(), source: f.ref, destination: f.scope }
    const result = f.call('files.create_working_copy', args, { signal: controller.signal }).catch(error => error)
    try {
      await Promise.race([entered.promise, result.then(() => {
        throw new Error('The file call ended before the accepted mutation barrier.')
      })])
      controller.abort()
      await vi.waitFor(() => expect(f.fileSignal()?.aborted).toBe(true))
      release.resolve()
      await result
      await f.fileCompleted
      const replay = AgentFileCreateWorkingCopyResultSchema.parse(
        (await f.call('files.create_working_copy', args)).structuredContent)
      expect(replay.replayed).toBe(true)
      expect(replay.value).toEqual((await accepted.mock.results[0]!.value).value)
      await f.mainFiles.close()
      const live = await f.db.pool.query('select count(*)::int as count from file_tool_sessions where revoked_at is null')
      expect(live.rows[0].count).toBe(0)
    } finally {
      release.resolve()
      await result
      if (f.fileSignal()) await f.fileCompleted
      accepted.mockRestore()
    }
  })

  it('requires persisted ACK, reads bytes, publishes once and denies another conversation or revoked sender', async () => {
    const f = await fixture(false)
    expect((await f.call('files.read', f.ref)).isError).toBe(true)
    await f.acknowledge()
    expect((await f.call('files.read', f.ref, { toolUseId: 'foreign-tool' })).isError).toBe(true)
    const read = await f.call('files.read', f.ref)
    expect(read.structuredContent).toMatchObject({ status: 'ready',
      contentBase64: Buffer.from('Worker attachment contents').toString('base64') })
    const copyResult = await f.call('files.create_working_copy', {
      commandId: randomUUID(), source: f.ref, destination: f.scope,
    })
    expect(copyResult.isError, JSON.stringify(copyResult.content)).not.toBe(true)
    const copied = AgentFileCreateWorkingCopyResultSchema.parse(copyResult.structuredContent)
    const publish = { commandId: randomUUID(), artifactId: copied.value.artifactId,
      scope: f.scope, filename: 'result.md', mediaType: 'text/markdown' }
    const first = AgentFilePublishResultSchema.parse((await f.call('files.publish_result', publish)).structuredContent)
    const replay = AgentFilePublishResultSchema.parse((await f.call('files.publish_result', publish)).structuredContent)
    expect(replay.replayed).toBe(true)
    expect(replay.value).toEqual(first.value)
    const saved = await f.db.pool.query('select file_id,revision_id from file_tool_publications')
    expect(saved.rows).toEqual([{ file_id: first.value.file.fileId, revision_id: first.value.revision.revisionId }])
    const state = await f.readConversation()
    expect(state).toBeDefined()
    const receipts = await readConversationPublicationReceipts(f.db.pool, state!.conversation.id,
      state!.messages.map(message => message.id))
    expect(receipts).toEqual([expect.objectContaining({ fileId: first.value.file.fileId,
      fileRevisionId: first.value.revision.revisionId })])
    expect((await f.call('files.list', { scope: { ...f.scope, chat: {
      ...f.scope.chat, conversationId: randomUUID(),
    } } })).isError).toBe(true)
    await f.db.pool.query('update management_principals set revoked_at=now() where id=$1', [f.sender.principal.id])
    expect((await f.call('files.read', f.ref)).isError).toBe(true)
  })

  it('lists only reads for a read-only worker and rejects calls after Main detaches', async () => {
    const f = await fixture(true)
    expect((await f.client.listTools()).tools.map(value => value.name)).toEqual(['files.list', 'files.read'])
    await f.acknowledge()
    expect((await f.call('files.read', f.ref)).isError).not.toBe(true)
    expect((await f.call('files.create_working_copy', {})).isError).toBe(true)
    await f.lease.close()
    expect((await f.call('files.read', f.ref)).isError).toBe(true)
    await f.mainFiles.close()
    const live = await f.db.pool.query('select count(*)::int as count from file_tool_sessions where revoked_at is null')
    expect(live.rows[0].count).toBe(0)
  })
})
