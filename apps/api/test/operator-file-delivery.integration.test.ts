import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { createFixtureSchema, dropFixtureSchema, removeFixtureDirectory } from './helpers/testResources.js'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { performance } from 'node:perf_hooks'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { closeTestResources } from './support/cleanup.js'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { FileMediaType, MessageAttachmentRef } from '@foreman-code/contracts/files'
import { AgentFileCreateWorkingCopyResultSchema, AgentFileWriteWorkingCopyResultSchema,
  AgentFilePublishResultSchema } from '@foreman-code/contracts/files'
import type { CodexFileCallResult } from '../src/modules/harnesses/codexFiles/port.js'
import { codexChatHostDirectory } from '../src/modules/harnesses/codexFiles/localHost.js'
import type { ApiConfig } from '../src/config.js'
import type { FileToolContext } from '../src/modules/files/tools/types.js'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { calls, emit, finish, fixtureQualification, input, processesForRequests, state, until, type Fixture } from './fixtures/codex-test-helpers.js'
import { fileRuntimeFixture } from './fixtures/codex-file-runtime-helpers.js'
import { appLauncherPath, installAppLauncher } from '../src/modules/harnesses/appMcpLauncher.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { reportIntegrationPhase } from './helpers/integrationPhase.js'

// Codex uses an executable protocol fixture with deterministic responses.
vi.doMock('../src/modules/harnesses/codexProtocol.js', async () => {
  const actual = await vi.importActual<typeof import('../src/modules/harnesses/codexProtocol.js')>('../src/modules/harnesses/codexProtocol.js')
  return { ...actual, qualifyCodex: fixtureQualification, assertCodexUnchanged: async () => undefined }
})
const { applyApplicationMigrations } = await import('../src/infrastructure/migrations.js')
const { PostgresAccessService } = await import('../src/modules/access/postgres.js')
const { PostgresOperatorRepository } = await import('../src/modules/operators/postgres.js')
const { PostgresOperatorChatAuthority, OPERATOR_MCP_ENVIRONMENT_VARIABLE } = await import('../src/modules/conversations/operatorChatAuthority.js')
const { OperatorChatService, PostgresOperatorConversationRepository } = await import('../src/modules/conversations/operatorChat.js')
const { registerProductionFileStorage } = await import('../src/modules/files/production.js')
const { productionFileTools } = await import('../src/modules/files/tools/production.js')
const { NativeRollout } = await import('../src/modules/harnesses/nativeRollout.js')
const { NativeProcessRegistry } = await import('../src/modules/harnesses/recovery/processRegistry.js')
const { NativeResponseJournal } = await import('../src/modules/harnesses/recovery/responseJournal.js')
const { NativeHarnessFactories } = await import('../src/modules/harnesses/runtimeFactory.js')
const { productionOperatorManagers } = await import('../src/modules/harnesses/operatorFiles/managers.js')
const { adoptOperatorFilePublications } = await import('../src/modules/harnesses/operatorFiles/postgres.js')

const connectionString = process.env.TEST_DATABASE_URL
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
// Valid, checksummed 1x1 PNG. The real image validation/preparation code reads it.
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQMnb5DwACrQGZOt75egAAAABJRU5ErkJggg==', 'base64')
const cases: Array<{ name: string; filename: string; mediaType: FileMediaType; bytes: Buffer }> = [
  { name: 'attachment-only Markdown', filename: 'notes.md', mediaType: 'text/markdown', bytes: Buffer.from('# Pinned Operator document\n') },
  { name: 'image', filename: 'pixel.png', mediaType: 'image/png', bytes: image },
]
async function paths(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? paths(join(directory, entry.name)) : [join(directory, entry.name)]))).flat()
}

/** Model Codex's durable declaration set, not a callback that can invent tools.
 * Resume reloads this field from the fixture's on-disk thread; it never replaces
 * it from resume parameters. The provider refuses to emit undeclared calls. */
async function retainCodexDeclarations(f: Fixture): Promise<void> {
  let binary = await readFile(f.binary, 'utf8')
  const replace = (before: string, after: string) => {
    assert.equal(binary.split(before).length, 2, `missing/ambiguous fixture seam: ${before}`)
    binary = binary.replace(before, after)
  }
  replace("historyMode: 'legacy', modelProvider: 'openai', model:",
    "dynamicTools: params.dynamicTools || [], historyMode: 'legacy', modelProvider: 'openai', model:")
  replace('if (message.id !== undefined && message.method && owner && !outstanding.has(message.id)) {', `
    if (message.method === 'item/tool/call' && !(owner?.dynamicTools || []).some((tool) =>
      tool.type === 'function' && tool.name === message.params.tool)) {
      log({ undeclaredFileTool: message.params.tool })
      continue
    }
    if (message.id !== undefined && message.method && owner && !outstanding.has(message.id)) {`)
  await writeFile(f.binary, binary)
}
async function retainedCodexDeclarations(f: Fixture, sessionId: string) {
  const persisted = JSON.parse(await readFile(join(f.directory, `state-${sessionId}.json`), 'utf8')) as {
    dynamicTools?: Array<{ type: string; name: string; inputSchema: unknown }>
  }
  return persisted.dynamicTools ?? []
}

async function expectCodexCredentialIsolation(directory: string, auditOffset = 0) {
  const audit = (await calls(directory)).slice(auditOffset)
  const executionPids = new Set((await processesForRequests(directory, 'thread/start', 'thread/resume'))
    .map(entry => entry.pid))
  const metadataPids = new Set((await processesForRequests(directory, 'model/list')).map(entry => entry.pid))
  const environments = audit.filter(entry => 'af02CredentialKeys' in entry)
  const execution = environments.filter(entry => executionPids.has(entry.processPid))
  const metadata = environments.filter(entry => metadataPids.has(entry.processPid))
  expect(execution.length).toBeGreaterThan(0)
  expect(metadata.length).toBeGreaterThan(0)
  expect(execution.every(entry => (entry.af02CredentialKeys as string[])
    .includes(OPERATOR_MCP_ENVIRONMENT_VARIABLE))).toBe(true)
  expect(metadata.every(entry => (entry.af02CredentialKeys as string[]).length === 0)).toBe(true)
  const connections = audit.filter(entry => typeof entry.appMcpEnabled === 'boolean')
  const metadataConnections = connections.filter(entry => metadataPids.has(entry.processPid))
  const executionConnections = connections.filter(entry => executionPids.has(entry.processPid))
  expect(metadataConnections.length).toBeGreaterThan(0)
  expect(executionConnections.length).toBeGreaterThan(0)
  expect(metadataConnections.every(entry => entry.appMcpEnabled === false)).toBe(true)
  expect(executionConnections.every(entry => entry.appMcpEnabled === true)).toBe(true)
}
function fileCallValue(result: CodexFileCallResult): unknown {
  expect(result.success).toBe(true)
  const content = result.contentItems[0]
  assert(content?.type === 'inputText')
  return JSON.parse(content.text) as unknown
}

// Same constructor used by buildProductionApp; no alternate manager resolver or
// fake attachment admission is supplied by these sends.
describe.skipIf(!connectionString || process.platform === 'win32')('AF-02 production Operator native file delivery', () => {
  let schema: string, admin: pg.Pool, pool: pg.Pool, f: Fixture, config: ApiConfig, vault: string, runtimeHome: string
  let app: FastifyInstance
  let managementEndpoint: string
  let files: ReturnType<typeof registerProductionFileStorage>
  let tools: ReturnType<typeof productionFileTools>
  let operators: InstanceType<typeof PostgresOperatorRepository>
  let repository: InstanceType<typeof PostgresOperatorConversationRepository>
  let authority: InstanceType<typeof PostgresOperatorChatAuthority>
  let chat: InstanceType<typeof OperatorChatService>
  let owner: ManagementPrincipal
  let productionAccess: InstanceType<typeof PostgresAccessService>
  let setup: ReturnType<typeof vi.spyOn>, prepare: ReturnType<typeof vi.spyOn>
  const issued: Array<{ context: FileToolContext; token: string }> = []
  const managers = new Map<string, NativeHarnessSessionManager>()

  beforeEach(async () => {
    const database = new URL(connectionString!)
    if (!['postgres:', 'postgresql:'].includes(database.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)
      || !/(?:^|[_-])test(?:db)?(?:$|[_-])/i.test(decodeURIComponent(database.pathname.slice(1)))
      || database.search || database.hash) throw new Error('Use a loopback PostgreSQL database explicitly named for tests.')
    schema = `af02_${randomUUID().replaceAll('-', '')}`
    admin = new pg.Pool({ connectionString })
    await createFixtureSchema(admin, schema)
    pool = new pg.Pool({ connectionString, max: 4, options: `-c search_path=${schema}` })
    await applyApplicationMigrations(pool)
    f = await fileRuntimeFixture()
    // Outside /tmp: Codex workspace-write treats /tmp as writable, so the file host must not live there.
    vault = await privateFixtureDirectory('.af02-vault-')
    runtimeHome = await privateFixtureDirectory('.af02-runtime-')
    await writeFile(join(f.directory, 'file-turn'), '')
    // Audit key presence only, not credential values. The fixture's worker
    // default is absent because the actual Operator service supplies its input.
    let binary = await readFile(f.binary, 'utf8')
    const connectionSeam = 'log({ cli: args })'
    assert.equal(binary.split(connectionSeam).length, 2)
    binary = binary.replace(connectionSeam, `const configuredAppMcp = read('mcp.json', {})
      log({ cli: args, appMcpEnabled: configuredAppMcp.enabled !== false
        && !processDisabledMcp.has(configuredAppMcp.name) })`)
    const seam = "const agent = process.env.TEST_AGENT_ID || 'agent-a'"
    assert.equal(binary.split(seam).length, 2)
    await writeFile(f.binary, binary.replace(seam,
      `log({ af02CredentialKeys: Object.keys(process.env).filter((key) => /^(?:GRAPHQL|FOREMAN_CODE).*(?:TOKEN|CREDENTIAL)/.test(key) && key !== 'GRAPHQL_HEAVY_JOB_TOKEN' && key !== 'FOREMAN_CODE_HEAVY_JOB_TOKEN') })\n${seam}`))
    const reservation = createServer()
    await new Promise<void>((resolve, reject) => {
      reservation.once('error', reject)
      reservation.listen(0, '127.0.0.1', resolve)
    })
    const address = reservation.address()
    assert(address && typeof address !== 'string')
    const port = address.port
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
    managementEndpoint = `http://127.0.0.1:${port}/mcp`
    await writeFile(join(f.directory, 'mcp.json'), JSON.stringify({ name: 'graphql', enabled: true, required: true,
      transport: { type: 'streamable_http', url: managementEndpoint,
        bearer_token_env_var: OPERATOR_MCP_ENVIRONMENT_VARIABLE } }))
    config = { host: '127.0.0.1', port, readinessTimeoutMs: 2000,
      database: { connectionString: connectionString!, maxConnections: 4, connectionTimeoutMs: 2000, queryTimeoutMs: 5000 },
      checkpoints: { schema: 'langgraph' }, workspaceStorageRoot: join(f.directory, 'projects'), fileStorageRoot: join(vault, 'files'),
      harnesses: { workspaceRoot: join(runtimeHome, 'runtime'), codexBinary: f.binary, timeoutMs: 10000 } }
    const cwd = join(config.harnesses.workspaceRoot, 'operator')
    await mkdir(cwd, { recursive: true })
    await mkdir(config.workspaceStorageRoot!, { recursive: true })
    const access = new PostgresAccessService(pool)
    productionAccess = access
    owner = (await access.issue({ name: 'AF-02 owner', audience: 'operator',
      grants: [{ actions: ['operator_chat:read', 'operator_chat:write', 'operator_chat:cancel', 'operator_chat:respond', 'harnesses:read'], scope: {} }],
      expiresAt: new Date(Date.now() + 600000) })).principal
    operators = new PostgresOperatorRepository(pool)
    repository = new PostgresOperatorConversationRepository(pool)
    const responseJournal = new NativeResponseJournal(join(f.directory, 'responses'))
    const processRegistry = new NativeProcessRegistry(join(f.directory, 'processes'))
    const nativeFactories = new NativeHarnessFactories({ ...config.harnesses,
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
    setup = vi.spyOn(authority, 'setup')
    prepare = vi.spyOn(authority, 'prepare')
    const resolve = productionOperatorManagers({ app: () => app, pool, config, workingDirectory: cwd,
        managers,
      processRegistry,
      responseJournal, nativeFactories })
    chat = new OperatorChatService(repository, operators, resolve, cwd, authority)
    app = buildApp({ logger: false, readiness: {
      database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined },
    }, operator: { access, services: {
      commands: new PostgresCommandCoordinator(pool), operatorChat: chat,
    } as unknown as OperatorServices } })
    files = registerProductionFileStorage(app, pool, config)
    tools = productionFileTools(app)
    await app.listen({ host: '127.0.0.1', port })
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
        async () => chat?.shutdown(), async () => app?.close(), async () => pool?.end(),
        async () => { if (schema) await (admin ? dropFixtureSchema(admin, schema) : Promise.resolve()) },
        async () => admin?.end(),
        async () => { if (f) await removeFixtureDirectory(f.directory) },
        async () => { if (vault) await removeFixtureDirectory(vault) },
        async () => { if (runtimeHome) await removeFixtureDirectory(runtimeHome) },
      ])
    } finally {
      managers.clear()
      issued.length = 0
      vi.unstubAllEnvs()
      vi.restoreAllMocks()
    }
  })

  async function waitForFileCredential(conversationId: string) {
    await until(async () => {
      const state = await chat.get(conversationId, owner)
      expect(state.turnState, state.error ?? 'Operator file admission failed').not.toBe('error')
      return issued.length === 1
    }, 10000)
  }

  it('keeps the production managed launcher process warm while replacing and revoking each turn credential', async () => {
    vi.stubEnv('FOREMAN_CODE_APP_MCP_DIRECTORY', join(runtimeHome, 'app-mcp'))
    vi.stubEnv('GRAPHQL_APP_MCP_DIRECTORY', undefined)
    await installAppLauncher()
    await writeFile(join(f.directory, 'mcp.json'), JSON.stringify({ name: 'foreman-code', enabled: true, required: true,
      transport: { type: 'stdio', command: process.execPath, args: [appLauncherPath()],
        env_vars: [OPERATOR_MCP_ENVIRONMENT_VARIABLE] } }))
    const current = await operators.ensure()
    await operators.update(input(f.directory).request.configuration.harness, current.operator.currentConfigurationVersionId)
    const conversation = await chat.create(owner)
    const access = new PostgresAccessService(pool)
    const delegateTokens: string[] = []
    const issuedCredentials = vi.spyOn(productionAccess, 'issue')
    const durations: number[] = []
    const settings = (await chat.get(conversation.id, owner)).settings
    if (settings?.harness !== 'codex') throw new Error('Codex Operator settings required')
    let client: Client | undefined
    let sessionId: string | undefined
    let coldInitializations: unknown[] | undefined
    try {
      for (const requestId of ['cold-production', 'warm-production']) {
        const startedAt = performance.now()
        let firstOutput!: (value: number) => void
        const output = new Promise<number>(resolve => { firstOutput = resolve })
        const unsubscribe = chat.events.subscribe(conversation.id, event => {
          if (event.type === 'delta' && event.data.requestId === requestId) firstOutput(performance.now() - startedAt)
        })
        try {
          await chat.send(conversation.id, { requestId, content: 'wait',
            ...(requestId === 'warm-production' ? { settings: { ...settings, showThinking: !settings.showThinking } } : {}),
          }, owner)
          const row = await until(async () => {
            const active = await repository.active(conversation.id)
            return active?.active_native_turn_id ? active : undefined
          }, 10000)
          sessionId ??= row.native_session_id!
          expect(row.native_session_id).toBe(sessionId)
          await emit(f.directory, { method: 'item/agentMessage/delta', params: {
            threadId: sessionId, turnId: row.active_native_turn_id, itemId: `reply-${requestId}`, delta: 'First output',
          } })
          durations.push(await output)
          const environment = await prepare.mock.results.at(-1)!.value
          const processToken = environment.variables[OPERATOR_MCP_ENVIRONMENT_VARIABLE]!
          delegateTokens.push((await issuedCredentials.mock.results.at(-1)!.value).token)
          const route = await readFile(join(appLauncherPath(), '..', 'routes', `${digest(Buffer.from(processToken))}.json`), 'utf8')
          expect(route).not.toContain(delegateTokens.at(-1)!)
          await expect(access.authenticate(processToken)).rejects.toMatchObject({ code: 'AUTH_INVALID' })
          if (!client) {
            client = new Client({ name: 'warm-production-authority', version: '1' })
            await client.connect(new StdioClientTransport({ command: process.execPath, args: [appLauncherPath()],
              env: { ...process.env, [OPERATOR_MCP_ENVIRONMENT_VARIABLE]: processToken } }))
          }
          const tools = await client.listTools()
          expect(tools.tools.some(tool => tool.name === 'operator_handoff_history_get')).toBe(true)
          await expectMcpAccessDenied(client.callTool({ name: 'workspace_create', arguments: { name: 'Denied warm write' } }))
          expect((await access.authenticate(delegateTokens.at(-1)!)).grants)
            .toEqual([{ actions: ['harnesses:read', 'operator_handoff:read'], scope: {} }])
          await finish(f.directory, sessionId)
          await until(async () => (await chat.get(conversation.id, owner)).turnState === 'idle', 10000)
          await expect(access.authenticate(delegateTokens.at(-1)!)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
          await expect(client.listTools()).rejects.toThrow()
          const processes = await processesForRequests(f.directory, 'thread/start', 'thread/resume', 'turn/start')
          expect(processes).toHaveLength(1)
          const initialized = (await calls(f.directory)).filter(entry =>
            (entry.wire as { method?: string } | undefined)?.method === 'initialize').map(entry => entry.processPid)
          coldInitializations ??= initialized
          expect(initialized).toEqual(coldInitializations)
          expect(initialized.filter(pid => pid === processes[0]!.pid)).toHaveLength(1)
          expect(managers.size).toBe(1)
        } finally { unsubscribe() }
      }
      expect(delegateTokens[1]).not.toBe(delegateTokens[0])
      expect(durations[1]).toBeLessThan(durations[0]!)
      expect(prepare).toHaveBeenCalledTimes(2)
      expect(setup).toHaveBeenCalledTimes(1)
      await expectCodexCredentialIsolation(f.directory)
      reportIntegrationPhase('production-cold-first-reply', durations[0]!)
      reportIntegrationPhase('production-warm-first-reply', durations[1]!)
      console.info('Production Operator Codex timing', { coldMs: durations[0], warmMs: durations[1],
        processStarts: 1 })
    } finally { await client?.close() }
  })

  it('revokes each text turn credential before a following turn receives fresh management authority', async () => {
    await writeFile(join(f.directory, 'mcp.json'), JSON.stringify({ name: 'graphql', enabled: true, required: true,
      transport: { type: 'streamable_http', url: managementEndpoint, bearer_token_env_var: 'GRAPHQL_MCP_TOKEN' } }))
    const current = await operators.ensure()
    await operators.update(input(f.directory).request.configuration.harness, current.operator.currentConfigurationVersionId)
    const conversation = await chat.create(owner)
    const access = new PostgresAccessService(pool)
    const tokens: string[] = []
    const sessions: string[] = []
    for (const content of ['First text turn', 'Second text turn']) {
      await chat.send(conversation.id, { requestId: randomUUID(), content }, owner)
      const row = await until(async () => {
        const active = await repository.active(conversation.id)
        return active?.active_native_turn_id ? active : undefined
      }, 10000)
      sessions.push(row.native_session_id!)
      const environment = await prepare.mock.results.at(-1)!.value
      const token = environment.variables[OPERATOR_MCP_ENVIRONMENT_VARIABLE]!
      tokens.push(token)
      const delegate = await access.authenticate(token)
      expect(delegate.id).not.toBe(owner.id)
      expect(delegate.grants).toEqual([{ actions: ['harnesses:read', 'operator_handoff:read'], scope: {} }])
      await finish(f.directory, row.native_session_id!)
      await until(async () => (await chat.get(conversation.id, owner)).turnState === 'idle', 10000)
      await expect(access.authenticate(token)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
      expect(managers.size).toBe(0)
    }
    expect(sessions[1]).toBe(sessions[0])
    expect(tokens[1]).not.toBe(tokens[0])
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(setup).toHaveBeenCalledTimes(2)
    expect((await calls(f.directory)).filter(entry =>
      (entry.wire as { method?: string } | undefined)?.method === 'turn/start')).toHaveLength(2)
  })

  it.each(['codex-cli 0.154.0', 'codex-cli 0.156.1'])(
    'R2-1 %s: a completed text-first Operator thread retains callable file tools on attachment resume', async (version) => {
      await retainCodexDeclarations(f)
      await writeFile(join(f.directory, 'version.json'), JSON.stringify(version))
      // Exercise the real text-mode setup/credential path, not a mocked authority.
      await writeFile(join(f.directory, 'mcp.json'), JSON.stringify({ name: 'graphql', enabled: true, required: true,
        transport: { type: 'streamable_http', url: managementEndpoint, bearer_token_env_var: 'GRAPHQL_MCP_TOKEN' } }))
      const current = await operators.ensure()
      const native = input(f.directory).request.configuration.harness
      assert(native.harness === 'codex')
      // Mutation tools require an explicitly accepted Write configuration. This
      // regression must not weaken the separate read-only declaration policy.
      await operators.update({ ...native, sandbox: 'workspace-write' }, current.operator.currentConfigurationVersionId)
      const conversation = await chat.create(owner)
      const target = { kind: 'operator' as const, conversationId: conversation.id }
      const scope = { kind: 'temporary' as const, chat: { ...target,
        ownerPrincipalId: owner.id, operatorId: current.operator.id } }
      const list = vi.spyOn(tools, 'list')
      await chat.send(conversation.id, { requestId: randomUUID(), content: 'Remember this conversation.' }, owner)
      const first = await until(async () => {
        const row = await repository.active(conversation.id)
        expect(row?.turn_state, `Text-first admission failed before native ACK: ${row?.last_error ?? 'no persisted error'}`).not.toBe('error')
        return row?.active_native_turn_id ? row : undefined
      }, 10000)
      const nativeSessionId = first.native_session_id!
      const textManager = managers.get(conversation.id)
      expect(textManager).toBeDefined()
      const declarations = await retainedCodexDeclarations(f, nativeSessionId)
      expect(declarations.map((tool) => tool.name)).toEqual([
        'files_list', 'files_read', 'files_create_working_copy', 'files_publish_result',
        'files_write_working_copy', 'files_apply_format_edit',
      ])
      expect(declarations.every((tool) => tool.type === 'function')).toBe(true)

      const call = async (turnId: string, tool: string, arguments_: unknown): Promise<CodexFileCallResult> => {
        const id = `r2-1-${randomUUID()}`
        // Sent through the executable provider and its stored-declaration gate,
        // not injected into the manager or the production bridge directly.
        await emit(f.directory, { id, method: 'item/tool/call', params: {
          threadId: nativeSessionId, turnId, callId: id, tool, arguments: arguments_,
        } })
        return until(async () => {
          const wire = (await calls(f.directory)).map((entry) => entry.wire as {
            id?: string; result?: CodexFileCallResult; error?: unknown
          } | undefined).find((entry) => entry?.id === id)
          if (wire?.error) throw new Error(`Native file callback failed: ${JSON.stringify(wire.error)}`)
          return wire?.result
        }, 10000)
      }
      // Declarations alone must not create file authority in the credentialed
      // text-mode child, even when Codex attempts one of the advertised tools.
      expect((await call(first.active_native_turn_id!, 'files_list', { scope })).success).toBe(false)
      expect(issued).toHaveLength(0)
      expect(list).not.toHaveBeenCalled()
      expect(prepare).toHaveBeenCalledTimes(1)
      expect(setup).toHaveBeenCalledTimes(1)
      const access = new PostgresAccessService(pool)
      const textEnvironment = await prepare.mock.results[0]!.value
      const textToken = textEnvironment.variables[OPERATOR_MCP_ENVIRONMENT_VARIABLE]!
      const textDelegate = await access.authenticate(textToken)
      expect(textDelegate.id).not.toBe(owner.id)
      expect((await calls(f.directory)).some((entry) =>
        (entry.af02CredentialKeys as string[] | undefined)?.includes('GRAPHQL_MCP_TOKEN'))).toBe(true)
      await finish(f.directory, nativeSessionId, 'Text-only turn completed.')
      await until(async () => (await chat.get(conversation.id, owner)).turnState === 'idle', 10000)
      await until(async () => managers.size === 0, 10000)
      await expect(access.authenticate(textToken)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
      const textHistory = structuredClone((await state(f.directory, nativeSessionId)).turns)
      expect(textHistory).toHaveLength(1)
      expect(textHistory[0]!.status).toBe('completed')
      const fileAuditOffset = (await calls(f.directory)).length

      // Only after that text turn has completed does the first attachment exist.
      const bytes = Buffer.from('# Original Operator document\n')
      const uploadId = randomUUID()
      await files.allocate(owner, target, { requestId: uploadId, filename: 'notes.md', mediaType: 'text/markdown',
        byteSize: bytes.length, sha256: digest(bytes) })
      await files.upload(owner, target, uploadId, Readable.from([bytes]))
      const ready = await files.finalize(owner, target, uploadId)
      const ref = { fileId: ready.value.file.fileId, revisionId: ready.value.revision.revisionId }
      const command = { requestId: randomUUID(), content: 'Edit and publish the attached document.', attachments: [ref] }
      await chat.send(conversation.id, command, owner)
      await until(async () => issued.length === 1, 10000)
      const { context, token } = issued[0]!
      expect(context.nativeSessionId).toBe(nativeSessionId)
      expect(context.scope).toEqual(scope)
      expect(context.ownerPrincipalId).toBe(owner.id)
      expect(managers.get(conversation.id)).not.toBe(textManager)
      expect(await retainedCodexDeclarations(f, nativeSessionId)).toEqual(declarations)
      expect((await state(f.directory, nativeSessionId)).turns[0]).toEqual(textHistory[0])
      expect(prepare).toHaveBeenCalledTimes(2)
      expect(setup).toHaveBeenCalledTimes(2)
      const fileManagementEnvironment = await prepare.mock.results[1]!.value
      const managementToken = fileManagementEnvironment.variables[OPERATOR_MCP_ENVIRONMENT_VARIABLE]!
      expect(managementToken).not.toBe(textToken)
      expect(managementToken).not.toBe(token)
      const fileDelegate = await access.authenticate(managementToken)
      expect(fileDelegate.id).not.toBe(textDelegate.id)
      expect(fileDelegate.grants).toEqual(textDelegate.grants)
      expect(fileDelegate.grants.flatMap(grant => grant.actions)).not.toContain('operator_chat:write')
      await expect(tools.sessions.authenticate(managementToken)).rejects.toThrow()
      const wire = (await calls(f.directory)).map((entry) => entry.wire as {
        method?: string; params?: Record<string, unknown>
      } | undefined)
      const starts = wire.filter((entry) => entry?.method === 'thread/start')
      expect(starts).toHaveLength(1)
      expect(starts[0]!.params!.dynamicTools).toEqual(declarations)
      const resumes = wire.filter((entry) => entry?.method === 'thread/resume')
      expect(resumes).toHaveLength(1)
      expect(resumes[0]!.params!.threadId).toBe(nativeSessionId)
      expect(resumes[0]!.params).not.toHaveProperty('dynamicTools')
      await expectCodexCredentialIsolation(f.directory, fileAuditOffset)
      expect((await pool.query(`select count(*)::int as count from operator_chat_credentials c
        join management_principals p on p.id=c.principal_id
        where c.conversation_id=$1 and p.revoked_at is null`, [conversation.id])).rows[0].count).toBe(1)

      const nativeTurnId = context.turnId
      assert.ok(nativeTurnId, 'This Codex fixture requires an observed native turn binding.')
      const copy = AgentFileCreateWorkingCopyResultSchema.parse(fileCallValue(await call(nativeTurnId,
        'files_create_working_copy', { commandId: randomUUID(), source: ref, destination: scope })))
      const edited = Buffer.from('# Edited by the resumed Operator\n')
      const write = AgentFileWriteWorkingCopyResultSchema.parse(fileCallValue(await call(nativeTurnId,
        'files_write_working_copy', { artifactId: copy.value.artifactId, contentBase64: edited.toString('base64') })))
      expect(write.sha256).toBe(digest(edited))
      const published = AgentFilePublishResultSchema.parse(fileCallValue(await call(nativeTurnId,
        'files_publish_result', { commandId: randomUUID(), artifactId: copy.value.artifactId,
          scope, filename: 'edited.md', mediaType: 'text/markdown' })))
      const publishedRef = { fileId: published.value.file.fileId, revisionId: published.value.revision.revisionId }
      expect(publishedRef.fileId).not.toBe(ref.fileId)
      expect(published.value.revision.sha256).toBe(digest(edited))
      const last = (await state(f.directory, nativeSessionId)).turns.at(-1)!
      assert(Array.isArray(last.items))
      await emit(f.directory, { method: 'turn/completed', params: { threadId: nativeSessionId, turn: {
        ...last, status: 'completed', completedAt: 2, items: [...last.items,
          { type: 'agentMessage', id: `published-${context.turnId}`, text: 'Published edited.md.', phase: 'final_answer' }],
      } } })
      await until(async () => (await chat.get(conversation.id, owner)).turnState === 'idle', 10000)
      await until(async () => managers.size === 0, 10000)
      await expect(tools.sessions.authenticate(token)).rejects.toThrow()
      await expect(access.authenticate(managementToken)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
      const transcript = await chat.get(conversation.id, owner)
      expect(transcript.messages.filter((message) => message.role === 'user')).toHaveLength(2)
      expect(transcript.messages.flatMap((message) => message.attachments ?? [])
        .filter((attachment) => attachment.file.fileId === publishedRef.fileId)
        .map(({ revision }) => ({ fileId: revision.fileId, revisionId: revision.revisionId }))).toEqual([publishedRef])
      const downloaded = await files.download(owner, target, publishedRef)
      const chunks: Buffer[] = []
      for await (const chunk of downloaded.stream) chunks.push(Buffer.from(chunk))
      expect(Buffer.concat(chunks)).toEqual(edited)
      expect((await chat.send(conversation.id, command, owner)).replayed).toBe(true)
      expect(issued).toHaveLength(1)
      expect((await calls(f.directory)).filter((entry) =>
        (entry.wire as { method?: string } | undefined)?.method === 'turn/start')).toHaveLength(2)
      expect((await calls(f.directory)).some((entry) => 'undeclaredFileTool' in entry)).toBe(false)
    }, 30000)

  for (const item of cases) {
    it(`Codex: ${item.name} reaches the native request once with separate file and management authority`, async () => {
      const current = await operators.ensure()
      const native = input(f.directory).request.configuration.harness
      await operators.update(native, current.operator.currentConfigurationVersionId)
      const conversation = await chat.create(owner)
      const target = { kind: 'operator' as const, conversationId: conversation.id }
      const uploadId = randomUUID()
      await files.allocate(owner, target, { requestId: uploadId, filename: item.filename, mediaType: item.mediaType,
        byteSize: item.bytes.length, sha256: digest(item.bytes) })
      await files.upload(owner, target, uploadId, Readable.from([item.bytes]))
      const ready = await files.finalize(owner, target, uploadId)
      const ref: MessageAttachmentRef = { fileId: ready.value.file.fileId, revisionId: ready.value.revision.revisionId }
      const command = { requestId: randomUUID(), content: '', attachments: [ref] }
      const read = vi.spyOn(tools, 'readAccepted')
      expect((await chat.send(conversation.id, command, owner)).replayed).toBe(false)
      await waitForFileCredential(conversation.id)
      const context = issued[0]!.context
      expect(context.scope).toEqual({ kind: 'temporary', chat: {
        kind: 'operator', ownerPrincipalId: owner.id, operatorId: current.operator.id, conversationId: conversation.id,
      } })
      expect(context.ownerPrincipalId).toBe(owner.id)
      await expect(tools.list(issued[0]!.token, { scope: { kind: 'workspace_reference', workspaceId: 'foreign-workspace' } }))
        .rejects.toThrow()
      expect(context.messageId).toBeTruthy()
      expect(read.mock.calls.length).toBeGreaterThan(0)
      for (const [, request] of read.mock.calls) expect(request).toMatchObject(ref)
      expect(setup).toHaveBeenCalledTimes(1)
      expect(prepare).toHaveBeenCalledTimes(1)
      expect((await pool.query('select count(*)::int as count from operator_chat_credentials')).rows[0].count).toBe(1)
      const nativeSessionId = context.nativeSessionId
      const wire = (await calls(f.directory)).map((entry) => entry.wire as { method?: string; params?: Record<string, unknown> } | undefined)
      const turns = wire.filter((entry) => entry?.method === 'turn/start')
      expect(turns).toHaveLength(1)
      const parts = turns[0]!.params!.input as Array<{ type: string; text?: string; path?: string }>
      const prompt = parts[0]!.text!
      const deliveredImage = parts.find((part) => part.type === 'localImage')?.path
      await expectCodexCredentialIsolation(f.directory)
      const thread = wire.find((entry) => entry?.method === 'thread/start')!
      expect(thread.params!.dynamicTools).toBeInstanceOf(Array)
      expect(prompt).toContain(item.filename)
      expect(prompt).not.toContain(config.fileStorageRoot!)
      expect(prompt).not.toContain('GRAPHQL_MCP_TOKEN')
      expect(prompt).not.toContain(issued[0]!.token)
      // Find the immutable original, not a model-selected/API-storage path.
      const hostFiles = await paths(codexChatHostDirectory(config.fileStorageRoot!))
      const original = (await Promise.all(hostFiles.map(async (path) => ({ path, bytes: await readFile(path) }))))
        .find((file) => digest(file.bytes) === ready.value.revision.sha256)
      expect(original).toBeDefined()
      expect(prompt).toContain(original!.path)
      if (item.mediaType.startsWith('image/')) {
        expect(deliveredImage).toBeTruthy()
        expect((await readFile(deliveredImage!)).length).toBeGreaterThan(0)
      } else expect(deliveredImage).toBeUndefined()
      const readsBeforeReplay = read.mock.calls.length
      expect((await chat.send(conversation.id, command, owner)).replayed).toBe(true)
      expect((await chat.send(conversation.id, { ...command, recovery: 'receipt' }, owner)).replayed).toBe(true)
      expect(issued).toHaveLength(1)
      expect(read.mock.calls).toHaveLength(readsBeforeReplay)
      await finish(f.directory, nativeSessionId)
      await until(async () => (await chat.get(conversation.id, owner)).turnState === 'idle', 10000)
      await until(async () => managers.size === 0, 10000)
      await expect(tools.sessions.authenticate(issued[0]!.token)).rejects.toThrow()
      expect((await chat.send(conversation.id, command, owner)).replayed).toBe(true)
      expect((await chat.send(conversation.id, { ...command, recovery: 'receipt' }, owner)).replayed).toBe(true)
      expect(issued).toHaveLength(1)
      expect(read.mock.calls).toHaveLength(readsBeforeReplay)
      expect((await calls(f.directory)).filter((entry) =>
        (entry.wire as { method?: string } | undefined)?.method === 'turn/start')).toHaveLength(1)
      expect((await chat.get(conversation.id, owner)).messages.filter((message) => message.role === 'user')).toHaveLength(1)
    }, 30000)
  }
  it('Codex: ten input pins and a publication remain distinct across adoption and readback', async () => {
    const current = await operators.ensure()
    const native = { ...input(f.directory).request.configuration.harness, sandbox: 'workspace-write' as const }
    await operators.update(native, current.operator.currentConfigurationVersionId)
    const conversation = await chat.create(owner)
    const target = { kind: 'operator' as const, conversationId: conversation.id }
    const attachments: MessageAttachmentRef[] = []
    for (let index = 0; index < 10; index++) {
      const bytes = Buffer.from(`# Operator input ${index}\n`), uploadId = randomUUID()
      await files.allocate(owner, target, { requestId: uploadId, filename: `input-${index}.md`,
        mediaType: 'text/markdown', byteSize: bytes.length, sha256: digest(bytes) })
      await files.upload(owner, target, uploadId, Readable.from([bytes]))
      const ready = await files.finalize(owner, target, uploadId)
      attachments.push({ fileId: ready.value.file.fileId, revisionId: ready.value.revision.revisionId })
    }
    const command = { requestId: randomUUID(), content: '', attachments }
    expect((await chat.send(conversation.id, command, owner)).replayed).toBe(false)
    await waitForFileCredential(conversation.id)
    const { context, token } = issued[0]!
    const receipt = async () => (await pool.query<{ input_hash: string; payload: unknown; message_id: string }>(
      'select input_hash,payload,message_id from operator_conversation_turns where conversation_id=$1 and request_id=$2',
      [conversation.id, command.requestId])).rows[0]!
    const acceptedReceipt = await receipt()
    const copy = await tools.createWorkingCopy(token, { commandId: randomUUID(), source: attachments[0], destination: context.scope })
    const published = await tools.publish(token, { commandId: randomUUID(), artifactId: copy.value.artifactId,
      scope: context.scope, filename: 'result.md', mediaType: 'text/markdown' })
    const output = { fileId: published.value.file.fileId, revisionId: published.value.revision.revisionId }
    const stored = async () => (await pool.query<{ record: { attachmentRefs: MessageAttachmentRef[]; publicationRefs?: MessageAttachmentRef[] } }>(
      'select record from operator_conversation_messages where id=$1', [context.messageId])).rows[0]!.record
    const readback = async () => {
      const fresh = new PostgresOperatorConversationRepository(pool)
      const page = await fresh.history(conversation.id)
      return page!.entries.find((entry) => entry.message.id === context.messageId)!.message.attachments!
        .map((value) => ({ fileId: value.file.fileId, revisionId: value.revision.revisionId }))
    }
    // A fresh repository has no bridge state. Codex recovers this finalized
    // publication from the ledger even before a close callback can adopt it.
    expect(await readback()).toEqual([...attachments, output])
    expect((await stored()).attachmentRefs).toEqual(attachments)
    await adoptOperatorFilePublications(pool, context, [output])
    await adoptOperatorFilePublications(pool, context, [output])
    expect((await stored()).attachmentRefs).toEqual(attachments)
    expect((await stored()).publicationRefs).toEqual([output])
    expect(await receipt()).toEqual(acceptedReceipt)
    expect(await readback()).toEqual([...attachments, output])
    expect(await readback()).toEqual([...attachments, output])
    expect((await chat.send(conversation.id, command, owner)).replayed).toBe(true)
    await finish(f.directory, context.nativeSessionId)
    await until(async () => (await chat.get(conversation.id, owner)).turnState === 'idle', 10000)
    expect(issued).toHaveLength(1)
    expect(await receipt()).toEqual(acceptedReceipt)
    expect(await readback()).toEqual([...attachments, output])
    expect((await stored()).attachmentRefs).toEqual(attachments)
  }, 90000)
  it.each([false, true])('requires management MCP for Operator turns (attachments: %s)', async attachments => {
    const current = await operators.ensure()
    await operators.update(input(f.directory).request.configuration.harness, current.operator.currentConfigurationVersionId)
    await writeFile(join(f.directory, 'mcp.json'), JSON.stringify({ name: 'graphql', enabled: false, required: false,
      transport: { type: 'streamable_http', url: managementEndpoint,
        bearer_token_env_var: OPERATOR_MCP_ENVIRONMENT_VARIABLE } }))
    const conversation = await chat.create(owner)
    const refs: MessageAttachmentRef[] = []
    if (attachments) {
      const target = { kind: 'operator' as const, conversationId: conversation.id }
      const bytes = Buffer.from('# Attached specification\n')
      const uploadId = randomUUID()
      await files.allocate(owner, target, { requestId: uploadId, filename: 'spec.md', mediaType: 'text/markdown',
        byteSize: bytes.length, sha256: digest(bytes) })
      await files.upload(owner, target, uploadId, Readable.from([bytes]))
      const ready = await files.finalize(owner, target, uploadId)
      refs.push({ fileId: ready.value.file.fileId, revisionId: ready.value.revision.revisionId })
    }
    await chat.send(conversation.id, { requestId: randomUUID(), content: 'Manage the app.',
      ...(attachments ? { attachments: refs } : {}) }, owner)
    // The native MCP configuration disables management for both message shapes.
    const failed = await until(async () => {
      const state = await chat.get(conversation.id, owner)
      return state.turnState === 'error' ? state : undefined
    }, 10000)
    expect(failed.lastResult).toMatchObject({ outcome: 'failed', error: { code: 'OPERATOR_MCP_SETUP_REQUIRED' } })
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(setup).toHaveBeenCalledTimes(1)
    expect(issued).toHaveLength(0)
    expect((await calls(f.directory)).some((entry) =>
      (entry.wire as { method?: string } | undefined)?.method === 'turn/start')).toBe(false)
  }, 30000)

})
