import { removeFixtureDirectory } from './helpers/testResources.js'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { AgentFileListResultSchema, AgentFileReadResultSchema,
  type PermanentFileScope, type MessageAttachmentRef } from '@foreman-code/contracts/files'
import type { ApiConfig } from '../src/config.js'
import type { FileReferenceService } from '../src/modules/files/references/service.js'
import type { FileToolContext } from '../src/modules/files/tools/types.js'
import type { CodexFileCallResult, CodexFileHostLease } from '../src/modules/harnesses/codexFiles/port.js'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { calls, emit, finish, fixtureQualification, input, until } from './fixtures/codex-test-helpers.js'
import { fileRuntimeFixture } from './fixtures/codex-file-runtime-helpers.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'

// Codex uses a protocol fixture and a fail-closed materialization spy.
vi.doMock('../src/modules/harnesses/codexProtocol.js', async () => {
  const actual = await vi.importActual<typeof import('../src/modules/harnesses/codexProtocol.js')>('../src/modules/harnesses/codexProtocol.js')
  return { ...actual, qualifyCodex: fixtureQualification, assertCodexUnchanged: async () => undefined }
})
const { PostgresAccessService } = await import('../src/modules/access/postgres.js')
const { PostgresCommandCoordinator } = await import('../src/modules/commands/postgres.js')
const { AgentChatService } = await import('../src/modules/conversations/agentChat.js')
const { PostgresAgentChatRepository, agentChatCorrelation } = await import('../src/modules/conversations/agentChatRepository.js')
const { PostgresOperatorConversationRepository } = await import('../src/modules/conversations/operatorChatRepository.js')
const { registerProductionFileStorage } = await import('../src/modules/files/production.js')
const { productionFileTools } = await import('../src/modules/files/tools/production.js')
const { CodexAppServerSessionManager } = await import('../src/modules/harnesses/codexAppServer.js')
const { postgresCodexChatFiles } = await import('../src/modules/harnesses/codexFiles/chatAdmission.js')
const { codexChatHostDirectory } = await import('../src/modules/harnesses/codexFiles/localHost.js')
const { productionCodexChatFiles } = await import('../src/modules/harnesses/codexFiles/production.js')
const { PostgresWorkflowRepository } = await import('../src/modules/workflows/postgres.js')
const { WorkflowManagementService } = await import('../src/modules/workflows/management.js')

interface ToolReply { ok: boolean; value?: unknown; wire: unknown }
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const pin = (value: { file: { fileId: string }; revision: { revisionId: string } }): MessageAttachmentRef => ({
  fileId: value.file.fileId, revisionId: value.revision.revisionId,
})

async function fixture({ readOnly }: { readOnly: boolean }) {
  const database = await agent3Database()
  const root = await mkdtemp(join(homedir(), '.r2-inherited-'))
  const f = await fileRuntimeFixture()
  const app = Fastify({ logger: false })
  const managers = new Map<string, NativeHarnessSessionManager>()
  const chat: { current?: InstanceType<typeof AgentChatService> } = {}
  onTestFinished(async () => {
    try { await chat.current?.shutdown() }
    finally {
      try { await app.close() }
      finally {
        await database.close()
        await removeFixtureDirectory(root)
        await removeFixtureDirectory(f.directory)
      }
    }
  })
  const project = join(root, 'project')
  await mkdir(project)
  await writeFile(join(f.directory, 'file-turn'), '')
  // Observe key presence, never values; AgentChatService supplies the native env.
  const binary = await readFile(f.binary, 'utf8')
  const seam = "const agent = process.env.TEST_AGENT_ID || 'agent-a'"
  assert.equal(binary.split(seam).length, 2)
  await writeFile(f.binary, binary.replace(seam,
    `log({ referenceCredentialKeys: Object.keys(process.env).filter((key) => /GRAPHQL.*(?:TOKEN|CREDENTIAL)/.test(key) && key !== 'GRAPHQL_HEAVY_JOB_TOKEN') })\n${seam}`))
  const config: ApiConfig = {
    host: '127.0.0.1', port: 4100, readinessTimeoutMs: 2000,
    database: { connectionString: process.env.TEST_DATABASE_URL!, maxConnections: 4, connectionTimeoutMs: 2000, queryTimeoutMs: 5000 },
    checkpoints: { schema: 'langgraph' }, fileStorageRoot: join(root, 'vault'), workspaceStorageRoot: join(root, 'projects'),
    harnesses: { workspaceRoot: join(f.directory, 'runtime'), codexBinary: f.binary, timeoutMs: 10000 },
  }
  const hostRoot = codexChatHostDirectory(config.fileStorageRoot!)
  await Promise.all([mkdir(config.workspaceStorageRoot!), mkdir(config.harnesses.workspaceRoot)])
  const files = registerProductionFileStorage(app, database.pool, config)
  await app.ready()
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  config.port = Number(new URL(address).port)
  const tools = productionFileTools(app)
  const references = app.getDecorator<FileReferenceService>('fileReferenceService')
  const seed = makeCurrentWorkflowFixture(randomUUID().slice(0, 8), 'sequential')
  for (const configuration of seed.configurations) {
    const value = input(f.directory).request.configuration.harness
    if (value.harness !== 'codex') throw new Error('Expected Codex fixture')
    configuration.harness = { ...value, sandbox: readOnly ? 'read-only' : 'workspace-write' }
  }
  const seeded = await seedAgent3(database.pool, project, seed, { run: false })
  const foreign = await seedAgent3(database.pool, project,
    makeCurrentWorkflowFixture(randomUUID().slice(0, 8), 'sequential'), { run: false })
  const access = new PostgresAccessService(database.pool)
  // The initiating human can manage references. The native child must NOT
  // inherit those permissions or the human's credential from its file session.
  const owner = await access.issue({ name: 'R2 reference owner', audience: 'operator',
    grants: [{ actions: [...ManagementActionSchema.options], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
  const otherWorkflow = (await new WorkflowManagementService(database.pool, new PostgresCommandCoordinator(database.pool))
    .create(owner.principal, 'http', { workspaceId: seeded.scope.workspaceId, commandId: randomUUID(), name: 'Other workflow' })).value.workflow.id
  async function add(scope: PermanentFileScope, text: string) {
    const bytes = Buffer.from(text)
    const result = await references.add(owner.principal, { scope, upload: { requestId: randomUUID(),
      filename: 'reference.md', mediaType: 'text/markdown', byteSize: bytes.length, sha256: digest(bytes) },
    contentBase64: bytes.toString('base64') })
    return { scope, text, value: result.value, ref: pin(result.value) }
  }
  const inherited = [
    await add({ kind: 'workspace_reference', workspaceId: seeded.scope.workspaceId }, '# Workspace inherited reference\n'),
    await add({ kind: 'workflow_reference', workspaceId: seeded.scope.workspaceId, workflowId: seeded.scope.workflowId }, '# Workflow inherited reference\n'),
  ]
  const excluded = [
    await add({ kind: 'workspace_reference', workspaceId: foreign.scope.workspaceId }, '# Foreign workspace secret\n'),
    await add({ kind: 'workflow_reference', workspaceId: seeded.scope.workspaceId, workflowId: otherWorkflow }, '# Foreign workflow secret\n'),
  ]
  const host: CodexFileHostLease = {
    executionHostId: 'reference-test-host', pathStyle: 'posix',
    materialize: vi.fn(async () => { throw new Error('Reference-only reads must not materialize a native input') }),
    async sealCompleted() { throw new Error('No native working copy exists') },
    close: vi.fn(async () => undefined),
  }
  const admission = postgresCodexChatFiles(database.pool, () => files, async () => host, hostRoot)
  const repository = new PostgresAgentChatRepository(database.pool)
  // Same credential-free manager/bridge composition as buildProductionApp.
  // Crucially, every send goes through the REAL AgentChatService and manager;
  // the test does not call resolve/prepare/activate instead of native startTurn.
  chat.current = new AgentChatService(database.pool, repository, new PostgresOperatorConversationRepository(database.pool),
    new PostgresWorkflowRepository(database.pool), { getForWorkspace: async () => undefined, getExecution: async () => undefined, async *executionPages() {} },
    (conversationId) => {
      const existing = managers.get(conversationId)
      if (existing) return existing
      const manager = new CodexAppServerSessionManager(f.binary, undefined, undefined, undefined, 'none',
        productionCodexChatFiles(() => app, conversationId, admission))
      managers.set(conversationId, manager)
      return manager
    }, config.harnesses.workspaceRoot)
  const issued: Array<{ context: FileToolContext; token: string }> = []
  const issue = tools.sessions.issueForAcceptedSession.bind(tools.sessions)
  vi.spyOn(tools.sessions, 'issueForAcceptedSession').mockImplementation(async (context, expiry) => {
    const row = (await database.pool.query<{ native_turn_id: string; message_id: string; sender: string; record: { attachmentRefs?: unknown[] } }>(`
      select t.native_turn_id,t.message_id,t.payload->>'ownerPrincipalId' as sender,m.record
      from operator_conversation_turns t join operator_conversation_messages m on m.id=t.message_id
      where t.conversation_id=$1 and t.message_id=$2`, [context.scope.chat.conversationId, context.messageId])).rows[0]!
    expect(row.native_turn_id).toBe(context.turnId)
    expect(row.message_id).toBe(context.messageId)
    expect(row.sender).toBe(owner.principal.id)
    expect(row.record.attachmentRefs ?? []).toEqual([])
    const token = await issue(context, expiry)
    issued.push({ context: structuredClone(context), token })
    return token
  })
  const node = seeded.version.definition.nodes[0]!
  const context = { workflowId: seeded.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId }
  async function send(conversationId: string | null) {
    const requestId = randomUUID()
    const previous = issued.length
    const result = await chat.current!.send(owner.principal, seeded.scope.workspaceId, {
      requestId, context, content: 'List and read the inherited workspace and workflow references.', intent: 'next_turn',
      expectedConversationId: conversationId,
      // Exercise both an omitted attachment field and an explicit empty array.
      ...(conversationId ? { attachments: [] } : {}),
    })
    const id = result.state.conversation!.id
    try {
      // Credential activation starts after the native acknowledgement, not while its process is starting.
      await until(async () => issued.length === previous + 1, 10000)
    } catch (error) {
      const state = await chat.current!.readConversation(owner.principal, seeded.scope.workspaceId, id)
      const turn = state.turns.find(turn => turn.requestId === requestId)
      const details = { sessionState: state.sessionState, availability: state.availability,
        delivery: turn?.delivery, error: turn?.error }
      throw new Error(`Inherited-file credential delivery failed: ${JSON.stringify(details)}`, { cause: error })
    }
    const active = issued.at(-1)!

    expect(active.context.scope).toEqual({ kind: 'temporary', chat: { kind: 'agent',
      conversationId: id, agentId: node.agentId, workspaceId: seeded.scope.workspaceId, workflowId: seeded.scope.workflowId } })
    const complete = async () => {
      await finish(f.directory, active.context.nativeSessionId)
      await until(async () => !(await repository.get(id))?.active_request_id, 10000)
      await expect(tools.sessions.authenticate(active.token)).rejects.toThrow()
    }
    return { id, requestId, ...active, complete }
  }
  async function call(active: Awaited<ReturnType<typeof send>>, name: string, arguments_: unknown): Promise<ToolReply> {
    const id = randomUUID()
    await emit(f.directory, { id, method: 'item/tool/call', params: {
      threadId: active.context.nativeSessionId, turnId: active.context.turnId, callId: id, namespace: null,
      tool: name.replaceAll('.', '_'), arguments: arguments_,
    } })
    const result = await until(async () => (await calls(f.directory))
      .map((entry) => entry.wire as { id?: string; result?: CodexFileCallResult } | undefined)
      .find((entry) => entry?.id === id && entry.result)?.result)
    const text = result.contentItems.find((item) => item.type === 'inputText')
    return { ok: result.success, value: result.success && text?.type === 'inputText' ? JSON.parse(text.text) : undefined, wire: result }
  }
  return { database, app, f, tools, references, owner, host, issued, inherited, excluded,
    send, call }
}

afterEach(() => vi.restoreAllMocks())
describe.skipIf(!postgresEnabled || process.platform !== 'linux')('R2-2 attachment-free Agent inherited references', { timeout: 90_000 }, () => {
  for (const readOnly of [true, false]) {
    it(`Codex: ${readOnly ? 'read' : 'write'} mode can read inherited scopes without acquiring permanent write or management authority`, async () => {
      const f = await fixture({ readOnly })
      const active = await f.send(null)
      expect(active.context.allowMutation).toBe(!readOnly)
      if (!readOnly) {
        const conversation = (await f.database.pool.query<{ provider_version: string }>(
          'select provider_version from operator_conversations where id=$1', [active.id])).rows[0]!
        const unsafe = postgresCodexChatFiles(f.database.pool, () => { throw new Error('unused') },
          async () => f.host, '/tmp')
        await expect(unsafe.resolve({ conversationId: active.id,
          clientCorrelationId: agentChatCorrelation(active.id, active.requestId),
          session: { harness: 'codex', nativeSessionId: active.context.nativeSessionId,
            providerVersion: conversation.provider_version }, signal: new AbortController().signal }))
          .rejects.toMatchObject({ code: 'CODEX_FILE_HOST_UNAVAILABLE' })
      }
      const expected = ['files.list', 'files.read', ...(readOnly ? [] : [
        'files.create_working_copy', 'files.write_working_copy', 'files.apply_format_edit', 'files.publish_result',
      ])].sort()
      expect([...active.context.allowedTools].sort()).toEqual(expected)
      const temporary = await f.call(active, 'files.list', { scope: active.context.scope })
      expect(temporary.ok).toBe(true)
      expect(AgentFileListResultSchema.parse(temporary.value).items).toEqual([])
      for (const reference of f.inherited) {
        const listed = await f.call(active, 'files.list', { scope: reference.scope })
        expect(listed.ok, JSON.stringify(listed.wire)).toBe(true)
        expect(AgentFileListResultSchema.parse(listed.value).items.map(pin)).toEqual([reference.ref])
        const read = await f.call(active, 'files.read', { ...reference.ref, offset: 0, length: 65536 })
        expect(read.ok, JSON.stringify(read.wire)).toBe(true)
        const value = AgentFileReadResultSchema.parse(read.value)
        expect(value.status).toBe('ready')
        if (value.status !== 'ready') throw new Error('Expected inherited bytes')
        expect(value.file.scope).toEqual(reference.scope)
        expect(value.revision.revisionId).toBe(reference.ref.revisionId)
        expect(Buffer.from(value.contentBase64, 'base64').toString()).toBe(reference.text)
        // Even write-mode native tools can target only a TEMPORARY working copy.
        expect((await f.call(active, 'files.create_working_copy', { commandId: randomUUID(),
          source: reference.ref, destination: reference.scope })).ok).toBe(false)
        expect((await f.call(active, 'files.publish_result', { commandId: randomUUID(), artifactId: reference.ref.fileId,
          scope: reference.scope, filename: 'overwrite.md', mediaType: 'text/markdown' })).ok).toBe(false)
        expect((await f.call(active, 'files.write_working_copy', { artifactId: reference.ref.fileId,
          contentBase64: Buffer.from('overwrite').toString('base64') })).ok).toBe(false)
      }
      for (const reference of f.excluded) {
        const listed = await f.call(active, 'files.list', { scope: reference.scope })
        if (listed.ok) expect(AgentFileListResultSchema.parse(listed.value).items).toEqual([])
        const read = await f.call(active, 'files.read', { ...reference.ref, offset: 0, length: 65536 })
        if (read.ok) expect(AgentFileReadResultSchema.parse(read.value).status).toBe('unavailable')
        expect(JSON.stringify(read.wire)).not.toContain(Buffer.from(reference.text).toString('base64'))
      }
      expect((await f.call(active, 'reference_file.remove', { commandId: randomUUID(),
        scope: f.inherited[0]!.scope, ...f.inherited[0]!.ref })).ok).toBe(false)
      expect((await f.database.pool.query('select count(*)::int as count from operator_chat_credentials')).rows[0].count).toBe(0)
      expect((await f.database.pool.query('select count(*)::int as count from file_tool_artifacts')).rows[0].count).toBe(0)
      const audit = await calls(f.f.directory)
      const thread = audit.map((entry) => entry.wire as { method?: string; params?: { dynamicTools?: Array<{ name: string }> } } | undefined)
        .find((entry) => entry?.method === 'thread/start')
      expect(thread?.params?.dynamicTools?.map((tool) => tool.name).sort()).toEqual(expected.map((name) => name.replaceAll('.', '_')).sort())
      const environments = audit.filter((entry) => 'referenceCredentialKeys' in entry)
      expect(environments.length).toBeGreaterThan(0)
      expect(environments.every((entry) => (entry.referenceCredentialKeys as unknown[]).length === 0)).toBe(true)
      expect(JSON.stringify(audit)).not.toContain(active.token)
      expect(f.host.materialize).not.toHaveBeenCalled()
      await active.complete()

      // Repeat terminal adoption with zero inputs, then a second empty-input turn
      // in the SAME native session. No stale token, mount or cleanup fence remains.
      const next = await f.send(active.id)
      expect(next.context.nativeSessionId).toBe(active.context.nativeSessionId)
      expect(next.context.messageId).not.toBe(active.context.messageId)
      expect(next.token).not.toBe(active.token)
      const readAgain = await f.call(next, 'files.read', { ...f.inherited[1]!.ref, offset: 0, length: 65536 })
      expect(readAgain.ok).toBe(true)
      expect(AgentFileReadResultSchema.parse(readAgain.value).status).toBe('ready')
      await next.complete()
      for (const reference of f.inherited) {
        const unchanged = await f.references.read(f.owner.principal, reference.scope, { ...reference.ref, offset: 0, length: 65536 })
        expect(unchanged.status).toBe('ready')
        if (unchanged.status === 'ready') {
          expect(unchanged.file.currentRevisionId).toBe(reference.ref.revisionId)
          expect(Buffer.from(unchanged.contentBase64, 'base64').toString()).toBe(reference.text)
        }
      }
    })
  }
})
