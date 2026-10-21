import { migratedDatabase } from './helpers/migratedDatabase.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import Fastify from 'fastify'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { AgentFileCreateWorkingCopyResultSchema, AgentFilePublishResultSchema } from '@foreman-code/contracts/files'
import type { ApiConfig } from '../src/config.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresLocalHumanAccess } from '../src/modules/access/localHuman.js'
import { DomainError } from '../src/modules/errors.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresOperatorConversationRepository, nativeCorrelation } from '../src/modules/conversations/operatorChatRepository.js'
import { readConversationPublicationReceipts } from '../src/modules/conversations/messagePublications.js'
import { registerProductionFileStorage } from '../src/modules/files/production.js'
import { productionFileTools } from '../src/modules/files/tools/production.js'
import { productionClaudeFileAdmission } from '../src/modules/harnesses/claudeSdk/fileProduction.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('Operator Claude publication recovery', () => {
  let db: Awaited<ReturnType<typeof migratedDatabase>>
  beforeAll(async () => {
    db = await migratedDatabase()
  })
  afterAll(async () => {
    await db?.close()
  })
  it('reads finalized MCP publications from the originating Operator message after credential revocation', async () => {
    const app = Fastify({ logger: false })
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof DomainError) {
        return reply.code(error.status).send({ error: { code: error.code, message: error.message } })
      }
      return reply.send(error)
    })
    const client = new Client({ name: 'Operator file publication test', version: '1' })
    onTestFinished(async () => {
      try { await client.close() }
      finally { await app.close() }
    })
    const config: ApiConfig = { host: '127.0.0.1', port: 4100, readinessTimeoutMs: 2000,
      database: { connectionString: db.databaseUrl, maxConnections: 4,
        connectionTimeoutMs: 2000, queryTimeoutMs: 5000 }, checkpoints: { schema: 'langgraph' },
      fileStorageRoot: join(db.directory, 'vault'), workspaceStorageRoot: join(db.directory, 'projects'),
      harnesses: { workspaceRoot: join(db.directory, 'runtime'), codexBinary: 'recorded', timeoutMs: 5000 } }
    await mkdir(config.harnesses.workspaceRoot)
    await mkdir(config.workspaceStorageRoot!)
    const storage = registerProductionFileStorage(app, db.pool, config)
    await app.ready()
    const service = productionFileTools(app)
    const access = new PostgresAccessService(db.pool)
    const owner = await new PostgresLocalHumanAccess(db.pool, access).current()
    const operators = new PostgresOperatorRepository(db.pool)
    const initial = await operators.ensure()
    const selected = await operators.update({ harness: 'claude', model: 'recorded', authMode: 'subscription',
      configDirectory: join(db.directory, 'recorded-profile'), permissionMode: 'default', sandbox: 'workspace-write',
      tools: [], permissionRules: [], instructions: '', mcpServers: {} }, initial.configuration.id)
    const repository = new PostgresOperatorConversationRepository(db.pool)
    const conversation = await repository.create(selected.operator.id, selected.configuration, owner.id)
    const requestId = randomUUID()
    await repository.beginTurn(conversation.id, { requestId, content: 'Read the supplied document.' }, owner.id)
    const nativeSessionId = randomUUID()
    await repository.bind(conversation.id, requestId, 'recorded-provider', nativeSessionId)
    const submission = { kind: 'message' as const, nativeSessionId, nativeMessageId: randomUUID(),
      clientCorrelationId: nativeCorrelation(conversation.id, requestId) }
    expect(await repository.submittedMessage(conversation.id, requestId, submission)).toBe(true)
    // The native callback is recorded; accepted PostgreSQL facts, file authority and MCP transport are real.
    const identity = { ...submission, ownerPrincipalId: owner.id, attemptId: requestId,
      generation: 'recorded-query', toolUseId: 'recorded-root' }
    const callback = { nativeSessionId, nativeMessageId: submission.nativeMessageId,
      clientCorrelationId: submission.clientCorrelationId, generation: identity.generation }
    const manager = {
      nativeCallbackContext: (sessionId: string, toolUseId: string) =>
        sessionId === nativeSessionId && toolUseId === identity.toolUseId ? callback : undefined,
      callbackAuthority: () => ({ ownerPrincipalId: owner.id, attemptId: requestId }),
    }
    const admission = productionClaudeFileAdmission({ pool: db.pool, allowMutation: true,
      binding: { kind: 'operator', conversationId: conversation.id, repository },
      manager: () => manager })
    const accepted = await admission.current(identity)
    expect(accepted).toBeDefined()
    const token = await service.sessions.issueForAcceptedSession(accepted!.context, accepted!.expiresAt)
    const endpoint = new URL('/mcp/files', await app.listen({ host: '127.0.0.1', port: 0 }))
    const denied = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(denied.status).toBe(401)
    await client.connect(new StreamableHTTPClientTransport(endpoint, { authProvider: { token: async () => token } }))
    const target = { kind: 'operator' as const, conversationId: conversation.id }
    const bytes = Buffer.from('# publication source\n')
    const uploadId = randomUUID()
    await storage.allocate(owner, target, { requestId: uploadId, filename: 'source.md', mediaType: 'text/markdown',
      byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    await storage.upload(owner, target, uploadId, Readable.from([bytes]))
    const uploaded = await storage.finalize(owner, target, uploadId)
    const source = { fileId: uploaded.value.file.fileId, revisionId: uploaded.value.revision.revisionId }
    const copy = AgentFileCreateWorkingCopyResultSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'files.create_working_copy',
      arguments: { commandId: randomUUID(), source, destination: accepted!.context.scope } }))))
    const args = { commandId: randomUUID(), artifactId: copy.value.artifactId, scope: accepted!.context.scope,
      filename: 'result.md', mediaType: 'text/markdown' }
    const publication = AgentFilePublishResultSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'files.publish_result', arguments: args }))))
    const replay = AgentFilePublishResultSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'files.publish_result', arguments: args }))))
    expect(replay.replayed).toBe(true)
    expect(replay.value).toEqual(publication.value)
    await service.sessions.revoke(token)
    const state = await repository.get(conversation.id)
    expect(state?.messages.find(message => message.role === 'user')?.attachments).toEqual([
      expect.objectContaining({ file: expect.objectContaining({ fileId: publication.value.file.fileId }),
        revision: expect.objectContaining({ revisionId: publication.value.revision.revisionId }) }),
    ])
    const receipts = await readConversationPublicationReceipts(db.pool, conversation.id, state!.messages.map(message => message.id))
    expect(receipts).toEqual([expect.objectContaining({ messageId: accepted!.context.messageId,
      fileId: publication.value.file.fileId, fileRevisionId: publication.value.revision.revisionId,
      nativeSessionId, nativeMessageId: submission.nativeMessageId })])
    const other = await repository.create(selected.operator.id, selected.configuration, owner.id)
    expect(await readConversationPublicationReceipts(db.pool, other.id, state!.messages.map(message => message.id))).toEqual([])
  })
})
