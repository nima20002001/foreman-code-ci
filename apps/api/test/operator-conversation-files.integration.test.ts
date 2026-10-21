import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import * as fileContracts from '@foreman-code/contracts/files'
import { AgentChatStateResponseSchema, AgentChatStateSchema } from '@foreman-code/contracts/agent-chat'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import type { ApiConfig } from '../src/config.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { registerProductionFileStorage } from '../src/modules/files/production.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { deferred } from './helpers/deferred.js'
import { agent3Database, seedAgent3 } from './helpers/wave25Agent3.js'

describe('Operator conversation file MCP parity', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let app: ReturnType<typeof buildApp>
  let access: PostgresAccessService
  let owner: Awaited<ReturnType<PostgresAccessService['issue']>>
  let reader: Awaited<ReturnType<PostgresAccessService['issue']>>
  let foreign: Awaited<ReturnType<PostgresAccessService['issue']>>
  let fixture: Awaited<ReturnType<typeof seedAgent3>>
  let files: ReturnType<typeof registerProductionFileStorage>
  let address: string
  const clients: Client[] = []
  const bytes = Buffer.from('# Attachment\nPersist these bytes.\n')
  const upload = () => ({ requestId: randomUUID(), filename: 'attachment.md', mediaType: 'text/markdown',
    byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })

  beforeAll(async () => {
    database = await agent3Database()
    fixture = await seedAgent3(database.pool, database.directory,
      makeCurrentWorkflowFixture(randomUUID(), 'sequential'), { run: false })
    access = new PostgresAccessService(database.pool)
    owner = await access.issue({ name: 'Conversation editor', audience: 'operator',
      grants: [{ actions: [...ManagementActionSchema.options], scope: {} }] })
    reader = await access.issue({ name: 'Conversation reader', audience: 'operator', grants: [
      { actions: ['agent_chat:read', 'operator_chat:read', 'workspaces:read', 'workflows:read'], scope: {} },
    ] })
    foreign = await access.issue({ name: 'Other conversation editor', audience: 'operator', grants: [
      { actions: ['agent_chat:read', 'agent_chat:write'], scope: { workspaceIds: ['other-workspace'] } },
      { actions: ['operator_chat:read', 'operator_chat:write'], scope: {} },
    ] })
    const messages = new PostgresOperatorConversationRepository(database.pool)
    const agentChat = new AgentChatService(database.pool, new PostgresAgentChatRepository(database.pool),
      messages, new PostgresWorkflowRepository(database.pool), {
        getForWorkspace: async () => { throw new Error('No Run is selected') },
        getExecution: async () => undefined,
        executionPages: async function* () { yield [] },
      }, () => { throw new Error('Preparing an attachment must not start a native session') }, database.directory)
    app = buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { agentChat, commands: new PostgresCommandCoordinator(database.pool) } as OperatorServices },
    })
    files = registerProductionFileStorage(app, database.pool, {
      fileStorageRoot: join(database.directory, 'file-store'),
      workspaceStorageRoot: join(database.directory, 'projects'),
      harnesses: { workspaceRoot: join(database.directory, 'harnesses') },
    } as ApiConfig)
    address = await app.listen({ host: '127.0.0.1', port: 0 })
  })
  afterAll(async () => {
    for (const client of clients) await client.close()
    await app?.close()
    await database?.close()
  })

  async function connect(token: string) {
    const client = new Client({ name: 'conversation-files', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => token },
    }))
    return client
  }
  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    return decodeMcpToolResult(result)
  }
  async function denied(client: Client, name: string, args: Record<string, unknown>, code: string) {
    const result = await client.callTool({ name, arguments: args })
    expect(result.isError).toBe(true)
    const content = result.content?.find(part => part.type === 'text')
    assert.ok(content && content.type === 'text')
    expect(JSON.parse(content.text)).toMatchObject({ error: { code } })
  }
  function context() {
    const node = fixture.version.definition.nodes[0]!
    assert.ok(node.agentId, 'The fixture must select an Agent node')
    return { workflowId: fixture.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId }
  }

  it('prepares an empty Agent conversation once, denies readers, and reads its persisted identity', async () => {
    const editor = await connect(owner.token)
    const readOnly = await connect(reader.token)
    const args = { workspaceId: fixture.scope.workspaceId, context: context() }
    await denied(readOnly, 'agent_chat_ensure_conversation', args, 'ACCESS_DENIED')
    const before = AgentChatStateSchema.parse(await call(editor, 'agent_chat_read', {
      workspaceId: fixture.scope.workspaceId, query: context(),
    }))
    expect(before.conversation).toBeNull()
    const prepared = AgentChatStateResponseSchema.parse(await call(editor, 'agent_chat_ensure_conversation', args))
    expect(prepared.state.conversation?.nativeSession).toBeNull()
    expect(prepared.state.messages).toEqual([])
    const repeated = AgentChatStateResponseSchema.parse(await call(editor, 'agent_chat_ensure_conversation', args))
    expect(repeated.state.conversation?.id).toBe(prepared.state.conversation?.id)
    const persisted = AgentChatStateSchema.parse(await call(await connect(owner.token), 'agent_chat_read', {
      workspaceId: fixture.scope.workspaceId, query: context(), conversationId: prepared.state.conversation!.id,
    }))
    expect(persisted.conversation).toEqual(prepared.state.conversation)
    await denied(await connect(foreign.token), 'agent_chat_ensure_conversation', args, 'ACCESS_DENIED')
  })

  for (const kind of ['operator', 'agent'] as const) {
    for (const change of ['revoke', 'remove-write'] as const) {
      it(`rejects ${kind} staging when access changes during upload: ${change}`, async () => {
        const credential = await access.issue({ name: 'Revocable attachment editor', audience: 'operator', grants: [
          { actions: kind === 'operator' ? ['operator_chat:read', 'operator_chat:write']
            : ['agent_chat:read', 'agent_chat:write'], scope: {} },
        ] })
        const editor = await connect(credential.token)
        const messages = new PostgresOperatorConversationRepository(database.pool)
        const operator = await new PostgresOperatorRepository(database.pool).ensure()
        const conversationId = kind === 'operator'
          ? (await messages.create(operator.operator.id, operator.configuration, credential.principal.id)).id
          : AgentChatStateResponseSchema.parse(await call(editor, 'agent_chat_ensure_conversation', {
            workspaceId: fixture.scope.workspaceId, context: context(),
          })).state.conversation!.id
        const conversation = kind === 'operator' ? { kind, conversationId }
          : { kind, workspaceId: fixture.scope.workspaceId, conversationId }
        const metadata = { ...upload(), filename: `attachment-${randomUUID()}.md` }
        const entered = deferred()
        const release = deferred()
        const receive = files.bytes.receive.bind(files.bytes)
        const receiving = vi.spyOn(files.bytes, 'receive').mockImplementationOnce((key, source, expected, signal) => {
          const paused = Readable.from((async function* () {
            for await (const chunk of source) {
              const bytes = Buffer.from(chunk as Uint8Array)
              yield bytes.subarray(0, 2)
              entered.resolve()
              await release.promise
              yield bytes.subarray(2)
            }
          })())
          return receive(key, paused, expected, signal)
        })
        const writing = editor.callTool({ name: 'conversation_file_upload', arguments: {
          conversation, upload: metadata, contentBase64: bytes.toString('base64'),
        } })
        try {
          await entered.promise
          if (change === 'revoke') {
            expect(await access.revoke(credential.principal.id)).toBe(true)
          } else {
            const grants = [{ actions: [kind === 'operator' ? 'operator_chat:read' : 'agent_chat:read'], scope: {} }]
            await database.pool.query('update management_principals set grants=$2::jsonb where id=$1',
              [credential.principal.id, JSON.stringify(grants)])
          }
        } finally {
          release.resolve()
        }
        let result: Awaited<typeof writing>
        try { result = await writing } finally { receiving.mockRestore() }
        // Restore the fixture caller so endpoint readback can inspect the interrupted allocation.
        await database.pool.query('update management_principals set revoked_at=null,grants=$2::jsonb where id=$1',
          [credential.principal.id, JSON.stringify(credential.principal.grants)])
        expect(result.isError).toBe(true)
        expect(decodeMcpToolResult(result)).toMatchObject({
          error: { code: change === 'revoke' ? 'AUTH_REVOKED' : 'ACCESS_DENIED' },
        })
        const readback = await connect(credential.token)
        const page = fileContracts.FilePageSchema.parse(await call(readback, 'conversation_files_list', { conversation }))
        const items = page.items.filter(item => item.revision.filename === metadata.filename)
        expect(items).toHaveLength(1)
        const row = items[0]!
        expect(row.file.state).toBe('pending')
        const pins = { fileId: row.file.fileId, revisionId: row.revision.revisionId }
        expect((await call(readback, 'conversation_file_read', { conversation, ...pins })).value)
          .toMatchObject({ status: 'unavailable', reason: 'pending' })
        await denied(readback, 'conversation_file_finalize', { conversation, requestId: metadata.requestId },
          'FILE_UPLOAD_INCOMPLETE')
        await call(readback, 'conversation_file_upload', {
          conversation, upload: metadata, contentBase64: bytes.toString('base64'),
        })
        const ready = await call(readback, 'conversation_file_finalize', { conversation, requestId: metadata.requestId })
        expect(ready.value).toMatchObject({ file: { fileId: pins.fileId, state: 'ready' } })
        expect((await call(readback, 'conversation_file_read', { conversation, ...pins })).value)
          .toMatchObject({ status: 'ready', contentBase64: bytes.toString('base64') })
      })
    }
  }

  for (const kind of ['operator', 'agent'] as const) {
    it(`uploads, finalizes, cancels and reads persisted ${kind} attachments with conversation authority`, async () => {
      const credential = await access.issue({ name: 'Scoped attachment editor', audience: 'operator', grants: [
        { actions: kind === 'operator' ? ['operator_chat:read', 'operator_chat:write']
          : ['agent_chat:read', 'agent_chat:write'],
        scope: kind === 'operator' ? {} : { workspaceIds: [fixture.scope.workspaceId] } },
      ] })
      const editor = await connect(credential.token)
      const listed = await editor.listTools()
      expect(listed.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
        'conversation_file_upload', 'conversation_file_finalize', 'conversation_file_cancel',
        'conversation_files_list', 'conversation_file_read',
      ]))
      const messages = new PostgresOperatorConversationRepository(database.pool)
      const operator = await new PostgresOperatorRepository(database.pool).ensure()
      const conversationId = kind === 'operator'
        ? (await messages.create(operator.operator.id, operator.configuration, credential.principal.id)).id : undefined
      const target = kind === 'operator' ? { kind, conversationId: conversationId! }
        : { kind, workspaceId: fixture.scope.workspaceId, conversationId: AgentChatStateResponseSchema.parse(
          await call(editor, 'agent_chat_ensure_conversation', { workspaceId: fixture.scope.workspaceId, context: context() })
        ).state.conversation!.id }
      const metadata = upload()
      const args = { conversation: target, upload: metadata, contentBase64: bytes.toString('base64') }
      await denied(await connect(reader.token), 'conversation_file_upload', args, 'ACCESS_DENIED')
      await denied(await connect(foreign.token), 'conversation_file_upload', args,
        kind === 'operator' ? 'FILE_CONVERSATION_NOT_FOUND' : 'ACCESS_DENIED')
      const staged = await call(editor, 'conversation_file_upload', args)
      const row = fileContracts.FileWithRevisionSchema.parse(staged.value)
      expect(row.file.state).toBe('pending')
      expect((await call(editor, 'conversation_file_upload', args)).replayed).toBe(true)
      const pins = { fileId: row.file.fileId, revisionId: row.revision.revisionId }
      expect((await call(editor, 'conversation_file_read', { conversation: target, ...pins })).value)
        .toMatchObject({ status: 'unavailable', reason: 'pending' })
      const command = { conversation: target, requestId: metadata.requestId }
      await denied(await connect(reader.token), 'conversation_file_finalize', command, 'ACCESS_DENIED')
      const ready = await call(editor, 'conversation_file_finalize', command)
      expect(ready.value).toMatchObject({ file: { fileId: pins.fileId, currentRevisionId: pins.revisionId, state: 'ready' } })
      expect((await call(editor, 'conversation_file_finalize', command)).replayed).toBe(true)
      const readback = await connect(credential.token)
      const page = fileContracts.FilePageSchema.parse(await call(readback, 'conversation_files_list', { conversation: target }))
      expect(page.items).toContainEqual(ready.value)
      const content = (await call(readback, 'conversation_file_read', { conversation: target, ...pins })).value
      expect(content).toMatchObject({ status: 'ready', contentBase64: bytes.toString('base64'), eof: true })
      await denied(await connect(foreign.token), 'conversation_file_read', { conversation: target, ...pins },
        kind === 'operator' ? 'FILE_CONVERSATION_NOT_FOUND' : 'ACCESS_DENIED')
      const canceledUpload = upload()
      await call(editor, 'conversation_file_upload', { ...args, upload: canceledUpload })
      const cancel = { conversation: target, requestId: canceledUpload.requestId }
      await denied(await connect(reader.token), 'conversation_file_cancel', cancel, 'ACCESS_DENIED')
      const canceled = await call(editor, 'conversation_file_cancel', cancel)
      expect(canceled.value).toMatchObject({ file: { state: 'removed' } })
      expect((await call(editor, 'conversation_file_cancel', cancel)).replayed).toBe(true)
      const canceledRow = fileContracts.FileWithRevisionSchema.parse(canceled.value)
      const canceledPins = { fileId: canceledRow.file.fileId, revisionId: canceledRow.revision.revisionId }
      expect((await call(readback, 'conversation_file_read', { conversation: target, ...canceledPins })).value)
        .toMatchObject({ status: 'unavailable', reason: 'removed' })
      await denied(editor, 'conversation_file_finalize', cancel, 'FILE_UPLOAD_CANCELED')
      await denied(editor, 'conversation_file_cancel', command, 'FILE_ALREADY_FINALIZED')
    })
  }

  it('uses shared reference envelopes for authenticated mutations, denied callers and persisted readback', async () => {
    const schemas = fileContracts as unknown as Record<string, z.ZodType>
    expect(schemas.FileReferenceAddInputSchema).toBeDefined()
    expect(schemas.FileReferenceMutationResultSchema).toBeDefined()
    const editor = await connect(owner.token)
    const scope = { kind: 'workspace_reference', workspaceId: fixture.scope.workspaceId }
    const input = z.record(z.string(), z.unknown()).parse(schemas.FileReferenceAddInputSchema!.parse({
      scope, upload: upload(), contentBase64: bytes.toString('base64'),
    }))
    await denied(await connect(reader.token), 'reference_file_add', input, 'ACCESS_DENIED')
    const added = z.object({ value: fileContracts.FileWithRevisionSchema }).parse(
      schemas.FileReferenceMutationResultSchema!.parse(await call(editor, 'reference_file_add', input)))
    const pins = { fileId: added.value.file.fileId, revisionId: added.value.revision.revisionId }
    const readInput = z.record(z.string(), z.unknown()).parse(schemas.FileReferenceReadInputSchema!.parse({ scope, ...pins }))
    const result = z.object({ value: fileContracts.AgentFileReadResultSchema }).parse(
      schemas.FileReferenceReadResultSchema!.parse(await call(await connect(reader.token), 'reference_file_read', readInput)))
    expect(result.value).toMatchObject({ status: 'ready', contentBase64: bytes.toString('base64') })
    const removal = z.record(z.string(), z.unknown()).parse(
      schemas.FileReferenceRemoveToolInputSchema!.parse({ scope, ...pins, commandId: randomUUID() }))
    await denied(await connect(reader.token), 'reference_file_remove', removal, 'ACCESS_DENIED')
    const removed = z.object({ value: fileContracts.FileWithRevisionSchema }).parse(
      schemas.FileReferenceMutationResultSchema!.parse(await call(editor, 'reference_file_remove', removal)))
    expect(removed.value.file.state).toBe('removed')
    const page = fileContracts.FilePageSchema.parse(await call(await connect(owner.token), 'reference_files_list', { scope }))
    expect(page.items).toContainEqual(removed.value)
  })
})
