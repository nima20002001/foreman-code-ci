import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { removeFixtureDirectory } from './helpers/testResources.js'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import type { CallToolResult } from '@modelcontextprotocol/server'
import type pg from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'

import type { ApiConfig } from '../src/config.js'
import type { FileToolContext } from '../src/modules/files/tools/types.js'
import type { ChildProcessEnvironment, NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import type { NativeManagerResolver } from '../src/modules/conversations/operatorChat.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { WorkspaceSchema, CreateOperatorConversationResponseSchema, SendOperatorMessageResponseSchema, GetOperatorConversationResponseSchema } from '@foreman-code/contracts'
import { SavedManagedWorkflowCommandResultSchema, SavedManagedWorkflowSchema,
  SavedManagedWorkflowPageSchema } from '@foreman-code/contracts/wave25'
import { calls, emit, finish, fixtureQualification, input, until, type Fixture } from './fixtures/codex-test-helpers.js'
import { fileRuntimeFixture } from './fixtures/codex-file-runtime-helpers.js'

import { closeTestResources } from './support/cleanup.js'

// Provider qualification and protocol responses are fixtures; OS containment is real.
// Production manager selection, native session manager/bridge, receipt
// admission, PostgreSQL file tools, checksums and host materialization are REAL.
// Installed-provider qualification remains covered by native acceptance.
vi.doMock('../src/modules/harnesses/codexProtocol.js', async () => {
  const actual = await vi.importActual<typeof import('../src/modules/harnesses/codexProtocol.js')>('../src/modules/harnesses/codexProtocol.js')
  return { ...actual, qualifyCodex: fixtureQualification, assertCodexUnchanged: async () => undefined }
})
const { PostgresAccessService } = await import('../src/modules/access/postgres.js')
const { PostgresOperatorRepository } = await import('../src/modules/operators/postgres.js')
const { PostgresOperatorChatAuthority } =
  await import('../src/modules/conversations/operatorChatAuthority.js')
const { OperatorChatService, PostgresOperatorConversationRepository } = await import('../src/modules/conversations/operatorChat.js')
const { registerProductionFileStorage } = await import('../src/modules/files/production.js')
const { productionFileTools } = await import('../src/modules/files/tools/production.js')
const { NativeRollout } = await import('../src/modules/harnesses/nativeRollout.js')
const { NativeProcessRegistry } = await import('../src/modules/harnesses/recovery/processRegistry.js')
const { NativeResponseJournal } = await import('../src/modules/harnesses/recovery/responseJournal.js')
const { NativeHarnessFactories } = await import('../src/modules/harnesses/runtimeFactory.js')
const { productionOperatorManagers } = await import('../src/modules/harnesses/operatorFiles/managers.js')
const { buildApp } = await import('../src/app.js')
const { PostgresCommandCoordinator } = await import('../src/modules/commands/postgres.js')
const { WorkflowManagementService } = await import('../src/modules/workflows/management.js')
const { checkpointRuntimeFixture } = await import('./helpers/wave25Br1003Runtime.js')
const { RunManagementService } = await import('../src/modules/runs/management.js')
const { createCurrentNativeProductionFactory } = await import('../src/modules/runs/workflowProduction.js')
const { WorkspaceManagementService } = await import('../src/modules/workspaces/management.js')
const { AgentManagementService } = await import('../src/modules/workspaces/agents.js')
const { HarnessCatalogService } = await import('../src/modules/harnesses/catalog.js')
const { PostgresSettingsRepository } = await import('../src/modules/settings/postgres.js')
const nativeProcess = await import('../src/modules/harnesses/process.js')

const connectionString = process.env.TEST_DATABASE_URL
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
// Same constructor used by buildProductionApp; no alternate manager resolver or
// fake attachment admission is supplied by these sends.
describe.skipIf(!connectionString || process.platform === 'win32')('Operator management and file authority', () => {
  let pool: pg.Pool, f: Fixture, config: ApiConfig, vault: string, runtimeHome: string
  let workflowRuntime: Awaited<ReturnType<typeof checkpointRuntimeFixture>> | undefined
  let app: FastifyInstance
  let address: string
  let managementEndpoint: string
  let files: ReturnType<typeof registerProductionFileStorage>
  let tools: ReturnType<typeof productionFileTools>
  let operators: InstanceType<typeof PostgresOperatorRepository>
  let repository: InstanceType<typeof PostgresOperatorConversationRepository>
  let authority: InstanceType<typeof PostgresOperatorChatAuthority>
  let nativeFactories: InstanceType<typeof NativeHarnessFactories>
  let chat: InstanceType<typeof OperatorChatService>
  let resolve: NativeManagerResolver
  let access: InstanceType<typeof PostgresAccessService>
  let services: OperatorServices
  let prepare: ReturnType<typeof vi.spyOn>
  const issued: Array<{ context: FileToolContext; token: string }> = []
  const managers = new Map<string, NativeHarnessSessionManager>()

  async function rpc(token: string, name: string, args: Record<string, unknown>) {
    const response = await fetch(new URL('/mcp', address), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream',
        'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
    const text = await response.text()
    const data = text.split('\n').find(line => line.startsWith('data: '))
    const body = JSON.parse(data ? data.slice(6) : text) as {
      result?: CallToolResult; error?: { code: number; message: string }
    }
    return { response, body }
  }

  async function mcp(token: string, name: string, args: Record<string, unknown>) {
    const { response, body } = await rpc(token, name, args)
    expect(response.status).toBe(200)
    expect(body.error).toBeUndefined()
    assert(body.result)
    return body.result
  }

  function expectMcpError(result: CallToolResult, code: string) {
    expect(result.isError).toBe(true)
    const content = result.content[0]
    assert(content?.type === 'text')
    expect(JSON.parse(content.text)).toMatchObject({ error: { code } })
  }

  async function nativeMcp(nativeSessionId: string,
    name: string, args: Record<string, unknown>) {
    const id = randomUUID()
    await emit(f.directory, { id, method: 'fixture/management-call',
      params: { threadId: nativeSessionId, name, arguments: args } })
    return until(async () => {
      const result = (await calls(f.directory)).map(entry => entry.nativeManagementResult as {
        id: string; sessionId?: string; pid?: number; error?: string; result?: CallToolResult
      } | undefined).find(entry => entry?.id === id)
      if (!result) return undefined
      if (result.error) throw new Error(result.error)
      expect(result.pid).toBeGreaterThan(0)
      expect(result.sessionId).toBe(nativeSessionId)
      return result.result
    }, 10000)
  }

  async function sendSpec(credential: { token: string; principal: ManagementPrincipal }) {
    const created = await mcp(credential.token, 'operator_chat_create', {
      commandId: randomUUID(), title: 'Implement attached spec',
    })
    const conversation = CreateOperatorConversationResponseSchema.parse(decodeMcpToolResult(created)).conversation
    const target = { kind: 'operator' as const, conversationId: conversation.id }
    const bytes = Buffer.from('# Spec workflow\nCreate a workflow named Spec workflow.\n')
    const uploadId = randomUUID()
    await files.allocate(credential.principal, target, { requestId: uploadId, filename: 'spec.md',
      mediaType: 'text/markdown', byteSize: bytes.length, sha256: digest(bytes) })
    await files.upload(credential.principal, target, uploadId, Readable.from([bytes]))
    const ready = await files.finalize(credential.principal, target, uploadId)
    const ref = { fileId: ready.value.file.fileId, revisionId: ready.value.revision.revisionId }
    const request = { requestId: randomUUID(), content: 'Create the workflow described in the attached spec.', attachments: [ref] }
    const send = { conversationId: conversation.id, request }
    const accepted = SendOperatorMessageResponseSchema.parse(
      decodeMcpToolResult((await mcp(credential.token, 'operator_chat_send', send))))
    expect(accepted.replayed).toBe(false)
    await until(async () => {
      const state = await chat.get(conversation.id, credential.principal)
      expect(state.turnState, state.error ?? 'Operator native admission failed').not.toBe('error')
      return issued.length === 1
    }, 10000)
    const environment = await prepare.mock.results.at(-1)!.value as ChildProcessEnvironment
    return { conversation, bytes, ref, send, file: issued[0]!, environment }
  }

  beforeEach(async () => {
    const database = new URL(connectionString!)
    if (!['postgres:', 'postgresql:'].includes(database.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)
      || !/(?:^|[_-])test(?:db)?(?:$|[_-])/i.test(decodeURIComponent(database.pathname.slice(1)))
      || database.search || database.hash) throw new Error('Use a loopback PostgreSQL database explicitly named for tests.')
    const runtime = await checkpointRuntimeFixture()
    workflowRuntime = runtime
    pool = runtime.db.pool
    const portReservation = createServer()
    await new Promise<void>((done, reject) => {
      portReservation.once('error', reject)
      portReservation.listen(0, '127.0.0.1', done)
    })
    const reserved = portReservation.address()
    assert(reserved && typeof reserved !== 'string')
    const port = reserved.port
    await new Promise<void>((done, reject) => portReservation.close(error => error ? reject(error) : done()))
    address = `http://127.0.0.1:${port}`
    managementEndpoint = new URL('/mcp', address).toString()
    f = await fileRuntimeFixture()
    const runCommand = nativeProcess.runCommand
    vi.spyOn(nativeProcess, 'runCommand').mockImplementation(async (...args) => {
      const result = await runCommand(...args)
      const [binary, command] = args
      if (binary === f.binary && command[0] === 'mcp' && command[1] === 'get'
        && result.exitCode !== 0 && result.stderr.trim() !== `Error: No MCP server named '${command[2]}' found.`) {
        console.error('Fixture MCP inspection failed:', { exitCode: result.exitCode,
          stderr: result.stderr.slice(-4096) })
      }
      return result
    })
    // Outside /tmp: Codex workspace-write treats /tmp as writable, so the file host must not live there.
    vault = await privateFixtureDirectory('.af02-vault-')
    runtimeHome = await privateFixtureDirectory('.af02-runtime-')
    await writeFile(join(f.directory, 'file-turn'), '')
    await writeFile(join(f.directory, 'mcp.json'), JSON.stringify({ name: 'graphql', enabled: true, required: true,
      transport: { type: 'streamable_http', url: managementEndpoint, bearer_token_env_var: 'GRAPHQL_MCP_TOKEN' } }))
    // Audit key presence only, not credential values. The fixture's worker
    // default is absent because the actual Operator service supplies its input.
    const binary = await readFile(f.binary, 'utf8')
    const seam = "const agent = process.env.TEST_AGENT_ID || 'agent-a'"
    assert.equal(binary.split(seam).length, 2)
    await writeFile(f.binary, binary.replace(seam,
      `log({ af02CredentialKeys: Object.keys(process.env).filter((key) => /GRAPHQL.*(?:TOKEN|CREDENTIAL)/.test(key) && key !== 'GRAPHQL_HEAVY_JOB_TOKEN') })\n${seam}`))
    config = { host: '127.0.0.1', port, readinessTimeoutMs: 2000,
      database: { connectionString: connectionString!, maxConnections: 4, connectionTimeoutMs: 2000, queryTimeoutMs: 5000 },
      checkpoints: { schema: 'langgraph' }, workspaceStorageRoot: join(f.directory, 'projects'), fileStorageRoot: join(vault, 'files'),
      harnesses: { workspaceRoot: join(runtimeHome, 'runtime'), codexBinary: f.binary, timeoutMs: 10000 } }
    const cwd = join(config.harnesses.workspaceRoot, 'operator')
    await mkdir(cwd, { recursive: true })
    await mkdir(config.workspaceStorageRoot!, { recursive: true })
    access = new PostgresAccessService(pool)
    operators = new PostgresOperatorRepository(pool)
    repository = new PostgresOperatorConversationRepository(pool)
    const responseJournal = new NativeResponseJournal(join(f.directory, 'responses'))
    const processRegistry = new NativeProcessRegistry(join(f.directory, 'processes'))
    nativeFactories = new NativeHarnessFactories({ ...config.harnesses,
       responseJournal,
      auxiliaryRecovery: role => processRegistry.scope(`${role}:${randomUUID()}`),
      admitRecovery: async recovery => { Object.assign(recovery, await processRegistry.reserveLaunch(recovery.owner)) },
      abandonRecovery: async recovery => { await processRegistry.abandonReservedLaunch(recovery) },
      closeRecovery: async recovery => {
        if (!await processRegistry.closeOwner(recovery.owner)) throw new Error('Diagnostic native process closure is unconfirmed.')
      },
    })
    authority = new PostgresOperatorChatAuthority(pool, access, new NativeRollout({ NODE_ENV: 'test', HOST: '127.0.0.1' }), cwd,
      managementEndpoint, (manager) => nativeFactories.inspector(manager))
    prepare = vi.spyOn(authority, 'prepare')
    resolve = productionOperatorManagers({ app: () => app, pool, config, workingDirectory: cwd,
        managers,
      processRegistry,
      responseJournal, nativeFactories })
    chat = new OperatorChatService(repository, operators, resolve, cwd, authority)
    const commands = new PostgresCommandCoordinator(pool)
    const locations = runtime.locations
    const binding = createCurrentNativeProductionFactory({
      isRuntimeOpen: () => runtime.engine.acceptsCurrentWork(),
      reportDispatchFailure: (_id, error) => { throw error },
    })({ primaryPool: pool, commands, runs: runtime.runs, workflows: runtime.workflows,
      locations, engine: runtime.engine, nativeExecutions: runtime.native,
      interactions: runtime.service, checkpointer: runtime.checkpointer })
    services = {
      commands,
      locations,
      workflows: new WorkflowManagementService(pool, commands),
      workspaces: new WorkspaceManagementService(pool, commands, locations, undefined, config.workspaceStorageRoot),
      agents: new AgentManagementService(pool),
      harnesses: new HarnessCatalogService({
        qualify: (configuration, directory, signal) => nativeFactories.qualifyConfiguration(configuration, directory, signal),
      }, new PostgresSettingsRepository(pool), commands, config.harnesses.workspaceRoot),
      runs: new RunManagementService(pool, commands, runtime.runs, runtime.engine, locations, binding),
      operatorChat: chat,
    }
    app = buildApp({ logger: false, readiness: {
      database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined },
    }, operator: { access, services } })
    files = registerProductionFileStorage(app, pool, config)
    tools = productionFileTools(app)
    address = await app.listen({ host: '127.0.0.1', port })
    expect(new URL('/mcp', address).toString()).toBe(managementEndpoint)
    const issue = tools.sessions.issueForAcceptedSession.bind(tools.sessions)
    vi.spyOn(tools.sessions, 'issueForAcceptedSession').mockImplementation(async (context, expiry) => {
      // Issuance is forbidden until BOTH conversation ACK and original message
      // binding are durable. A callback failure must never issue a file token.
      const row = (await pool.query(`select c.active_native_turn_id,t.native_turn_id,t.message_id
        from operator_conversations c join operator_conversation_turns t on t.conversation_id=c.id
        where c.id=$1 and t.message_id=$2`, [context.scope.chat.conversationId, context.messageId])).rows[0]
      expect(row).toEqual({ active_native_turn_id: context.turnId, native_turn_id: context.turnId, message_id: context.messageId })
      const token = await issue(context, expiry)
      issued.push({ context: structuredClone(context), token })
      return token
    })
  }, 30000)

  afterEach(async () => {
    try {
      await closeTestResources([
        async () => chat?.shutdown(),
        async () => app?.close(),
        async () => workflowRuntime?.close(),
        async () => { if (f) await removeFixtureDirectory(f.directory) },
        async () => { if (vault) await removeFixtureDirectory(vault) },
        async () => { if (runtimeHome) await removeFixtureDirectory(runtimeHome) },
      ])
    } finally {
      workflowRuntime = undefined
      managers.clear()
      issued.length = 0
      vi.restoreAllMocks()
    }
  })

  it('Codex: manages workflows through authenticated MCP while processing a pinned spec', async () => {
    const workspace = WorkspaceSchema.parse({ id: randomUUID(), name: 'Spec project' })
    const foreign = WorkspaceSchema.parse({ id: randomUUID(), name: 'Other project' })
    for (const item of [workspace, foreign]) {
      await pool.query('insert into workspaces (id,record) values ($1,$2::jsonb)', [item.id, JSON.stringify(item)])
    }
    const credential = await access.issue({ name: 'Spec owner', audience: 'operator',
      grants: [
        { actions: ['operator_chat:read', 'operator_chat:write', 'harnesses:read'], scope: {} },
        { actions: ['workflows:create', 'workflows:read', 'workflows:update'],
          scope: { workspaceIds: [workspace.id] } },
      ], expiresAt: new Date(Date.now() + 600000) })
    const current = await operators.ensure()
    // Management grants do not change the accepted read-only file policy.
    const native = input(f.directory).request.configuration.harness
    await operators.update(native, current.operator.currentConfigurationVersionId)
    const { conversation, bytes, ref, send, file, environment } = await sendSpec(credential)
    expect(file.context.allowMutation).toBe(false)
    const read = await tools.read(file.token, ref)
    assert(read.status === 'ready')
    expect(Buffer.from(read.contentBase64, 'base64')).toEqual(bytes)
    await expect(tools.createWorkingCopy(file.token, {
      commandId: randomUUID(), source: ref, destination: file.context.scope,
    })).rejects.toThrow()
    const managementToken = environment.variables.GRAPHQL_MCP_TOKEN!
    expect(managementToken).toBeTruthy()
    expect(managementToken).not.toBe(file.token)
    await expect(tools.sessions.authenticate(managementToken)).rejects.toThrow()
    const delegated = await access.authenticate(managementToken)
    expect(delegated.grants.find((grant) => grant.actions.includes('workflows:create'))?.scope)
      .toEqual({ workspaceIds: [workspace.id] })
    expect(delegated.grants.flatMap((grant) => grant.actions)).not.toContain('operator_chat:write')
    // A file credential cannot authenticate to the management endpoint.
    expect((await rpc(file.token, 'workflow_create', {
      workspaceId: workspace.id, name: 'File token denied', commandId: randomUUID(),
    })).response.status).toBe(401)
    expect((await calls(f.directory)).some((entry) =>
      (entry.af02CredentialKeys as string[] | undefined)?.includes('GRAPHQL_MCP_TOKEN'))).toBe(true)
    const create = { workspaceId: workspace.id, commandId: randomUUID(), name: 'Spec workflow' }
    const created = SavedManagedWorkflowCommandResultSchema.parse(
      decodeMcpToolResult((await nativeMcp(file.context.nativeSessionId, 'workflow_create', create))))
    expect(created.replayed).toBe(false)
    expect(created.value.workflow.name).toBe('Spec workflow')
    expect(SavedManagedWorkflowCommandResultSchema.parse(
      decodeMcpToolResult((await nativeMcp(file.context.nativeSessionId, 'workflow_create', create)))))
      .toEqual({ ...created, replayed: true })
    const workflowId = created.value.workflow.id
    const deniedCommandId = randomUUID()
    expectMcpError(await nativeMcp(file.context.nativeSessionId, 'workflow_create', {
      ...create, workspaceId: foreign.id, commandId: deniedCommandId,
    }), 'ACCESS_DENIED')
    expectMcpError(await nativeMcp(file.context.nativeSessionId, 'workflow_update', { workspaceId: workspace.id, workflowId,
      commandId: randomUUID(), expectedRevision: created.value.revision + 1, name: 'Stale change' }), 'REVISION_CONFLICT')
    const readback = SavedManagedWorkflowSchema.parse(decodeMcpToolResult((await nativeMcp(file.context.nativeSessionId, 'workflow_get', {
      workspaceId: workspace.id, workflowId,
    }))))
    expect(readback).toEqual(created.value)
    expect(await services.workflows.get(credential.principal, workspace.id, workflowId)).toEqual(readback)
    expect((await pool.query('select id from workflows where workspace_id=$1', [workspace.id])).rowCount).toBe(1)
    expect((await pool.query('select id from workflows where workspace_id=$1', [foreign.id])).rowCount).toBe(0)
    expect((await pool.query('select command_id from management_command_receipts where command_id=$1',
      [deniedCommandId])).rowCount).toBe(0)
    const audit = await pool.query<{ action: string; outcome: string }>(
      'select action,outcome from management_audit where principal_id=$1 and source=$2', [delegated.id, 'mcp'])
    expect(audit.rows.filter((row) => row.action === 'workflow.create' && row.outcome === 'succeeded')).toHaveLength(1)
    expect(audit.rows.filter((row) => row.action === 'workflow_create' && row.outcome === 'denied')).toHaveLength(1)
    expect(SendOperatorMessageResponseSchema.parse(
      decodeMcpToolResult((await mcp(credential.token, 'operator_chat_send', send)))).replayed).toBe(true)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(issued).toHaveLength(1)
    await finish(f.directory, file.context.nativeSessionId)
    await until(async () => (await chat.get(conversation.id, credential.principal)).turnState === 'idle', 10000)
    await until(async () => managers.size === 0, 10000)
    await expect(access.authenticate(managementToken)).rejects.toThrow()
    await expect(tools.sessions.authenticate(file.token)).rejects.toThrow()
    const snapshot = GetOperatorConversationResponseSchema.parse(decodeMcpToolResult((await mcp(credential.token, 'operator_chat_get', {
      conversationId: conversation.id,
    }))))
    expect(snapshot.messages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(SavedManagedWorkflowSchema.parse(decodeMcpToolResult((await mcp(credential.token, 'workflow_get', {
      workspaceId: workspace.id, workflowId,
    }))))).toEqual(readback)
  }, 30000)

  it('Codex: attaching files preserves a management reader\'s write denial', async () => {
    const workspace = WorkspaceSchema.parse({ id: randomUUID(), name: 'Reader project' })
    await pool.query('insert into workspaces (id,record) values ($1,$2::jsonb)', [workspace.id, JSON.stringify(workspace)])
    const credential = await access.issue({ name: 'Read-only management owner', audience: 'operator',
      grants: [
        { actions: ['operator_chat:read', 'operator_chat:write', 'harnesses:read'], scope: {} },
        { actions: ['workflows:read'], scope: { workspaceIds: [workspace.id] } },
      ], expiresAt: new Date(Date.now() + 600000) })
    const current = await operators.ensure()
    await operators.update(input(f.directory).request.configuration.harness, current.operator.currentConfigurationVersionId)
    const { conversation, file, environment } = await sendSpec(credential)
    const managementToken = environment.variables.GRAPHQL_MCP_TOKEN!
    const delegated = await access.authenticate(managementToken)
    expect(delegated.grants.flatMap((grant) => grant.actions)).not.toContain('workflows:create')
    const commandId = randomUUID()
    const denied = await nativeMcp(file.context.nativeSessionId, 'workflow_create', {
      workspaceId: workspace.id, commandId, name: 'Denied workflow',
    })
    expectMcpError(denied, 'ACCESS_DENIED')
    expect((await pool.query('select outcome from management_audit where principal_id=$1 and action=$2',
      [delegated.id, 'workflow_create'])).rows).toEqual([{ outcome: 'denied' }])
    const page = SavedManagedWorkflowPageSchema.parse(decodeMcpToolResult((await nativeMcp(file.context.nativeSessionId, 'workflow_list', {
      workspaceId: workspace.id, detail: 'full',
    }))))
    expect(page.items).toEqual([])
    expect((await pool.query('select id from workflows where workspace_id=$1', [workspace.id])).rowCount).toBe(0)
    expect((await pool.query('select command_id from management_command_receipts where command_id=$1', [commandId])).rowCount).toBe(0)
    await finish(f.directory, file.context.nativeSessionId)
    await until(async () => (await chat.get(conversation.id, credential.principal)).turnState === 'idle', 10000)
    await until(async () => managers.size === 0, 10000)
    await expect(access.authenticate(managementToken)).rejects.toThrow()
    await expect(tools.sessions.authenticate(file.token)).rejects.toThrow()
  }, 30000)

})
