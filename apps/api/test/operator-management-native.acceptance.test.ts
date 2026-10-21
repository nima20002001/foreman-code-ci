import { readUntil } from './helpers/observableCondition.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { removeFixtureDirectory } from './helpers/testResources.js'
import { referenceTestAuthenticationFile } from '../../../scripts/test-resources.mjs'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CreateOperatorConversationResponseSchema, GetOperatorConversationResponseSchema, SendOperatorMessageResponseSchema, type NativeHarnessEvent } from '@foreman-code/contracts'
import { FileWithRevisionSchema } from '@foreman-code/contracts/files'
import { ManagedWorkspaceCommandResultSchema } from '@foreman-code/contracts/management'
import { SavedManagedWorkflowSchema } from '@foreman-code/contracts/wave25'
import { APP_MCP_SERVER_NAMES } from '@foreman-code/contracts/product'
import { APP_MCP_SERVER_NAME, APP_MCP_TOKEN } from '../src/modules/harnesses/appMcpLauncher.js'
import type { ApiConfig } from '../src/config.js'
import { OperatorChatService, PostgresOperatorConversationRepository,
  type NativeManagerResolver } from '../src/modules/conversations/operatorChat.js'
import { PostgresOperatorChatAuthority } from '../src/modules/conversations/operatorChatAuthority.js'
import { registerProductionFileStorage } from '../src/modules/files/production.js'
import { harnessBinaries } from '../src/modules/harnesses/binaries.js'
import { NativeHarnessFactories } from '../src/modules/harnesses/runtimeFactory.js'
import { NativeRollout } from '../src/modules/harnesses/nativeRollout.js'
import type { NativeMcpInspectionEvidence } from '../src/modules/harnesses/mcpDetection.js'
import { productionOperatorManagers } from '../src/modules/harnesses/operatorFiles/managers.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { NativeResponseJournal } from '../src/modules/harnesses/recovery/responseJournal.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { callWorkspaceTool, workspaceMcpFixture } from './helpers/workspaceMcp.js'

const enabled = process.env.RUN_REAL_HARNESS_TESTS === '1'
const connectionString = process.env.OPERATOR_NATIVE_TEST_DATABASE_URL ?? process.env.ENG03_A_TEST_DATABASE_URL
const binaries = harnessBinaries(process.env)

function nativeCallCompleted(event: NativeHarnessEvent, name: string) {
  const item = event.payload.item as Record<string, unknown> | undefined
  return event.type === 'item.completed' && item?.tool === name
    && (name === 'files_read' ? item.type === 'dynamicToolCall' && item.success === true
      : item.type === 'mcpToolCall' && APP_MCP_SERVER_NAMES.some(server => server === item.server))
}

async function availablePort() {
  const reservation = createServer()
  await new Promise<void>((done, reject) => {
    reservation.once('error', reject)
    reservation.listen(0, '127.0.0.1', done)
  })
  const address = reservation.address()
  assert(address && typeof address !== 'string')
  await new Promise<void>((done, reject) => reservation.close(error => error ? reject(error) : done()))
  return address.port
}

describe.skipIf(!enabled)('installed native Operator management MCP', () => {
  for (const harness of ['codex'] as const) {
    it.each([false, true])(`${harness}: reads an attached spec and applies live management scope (denied: %s)`, async denied => {
      if (!connectionString) throw new Error('The root acceptance runner must supply a disposable test database.')
      const home = await privateFixtureDirectory('operator-management-native-')
      const environmentNames = ['CODEX_HOME'] as const
      const previousEnvironment = Object.fromEntries(environmentNames.map(name => [name, process.env[name]]))
      let f: Awaited<ReturnType<typeof workspaceMcpFixture>> | undefined
      const nativeEvents: NativeHarnessEvent[] = []
      let chatEvents: OperatorChatService['events'] | undefined
      const inspections: NativeMcpInspectionEvidence[] = []
      let state: ReturnType<typeof GetOperatorConversationResponseSchema.parse> | undefined
      const evidenceDirectory = process.env.OPERATOR_NATIVE_EVIDENCE_DIR
        ?? process.env.ENG03_A_EVIDENCE_DIR
        ?? join(process.cwd(), '.logs', 'operator-management-native')
      const evidencePath = join(evidenceDirectory, `${harness}-${denied ? 'denied' : 'allowed'}-${randomUUID()}.json`)
      try {
        const port = await availablePort()
        const endpoint = `http://127.0.0.1:${port}/mcp`
        const directory = join(home, 'runtime', 'operator')
        const codexHome = join(home, 'codex')
        await mkdir(directory, { recursive: true, mode: 0o700 })
        await mkdir(codexHome, { mode: 0o700 })
        if (!previousEnvironment.CODEX_HOME) throw new Error('The native runner must supply an owned Codex home.')
        referenceTestAuthenticationFile({ directory: process.env.FOREMAN_CODE_TEST_ROOT!,
          token: process.env.FOREMAN_CODE_TEST_OWNER! }, join(previousEnvironment.CODEX_HOME, 'auth.json'),
        join(codexHome, 'auth.json'))
        await writeFile(join(codexHome, 'config.toml'), [
          `[mcp_servers.${APP_MCP_SERVER_NAME}]`, `url = ${JSON.stringify(endpoint)}`,
          `bearer_token_env_var = ${JSON.stringify(APP_MCP_TOKEN)}`, '',
        ].join('\n'), { mode: 0o600 })
        process.env.CODEX_HOME = codexHome

        f = await workspaceMcpFixture({ connectionString, port, async configure({ app, pool, access, commands, parentPath, services }) {
          const fileStorageRoot = join(home, 'vault')
          const config: ApiConfig = { host: '127.0.0.1', port, readinessTimeoutMs: 2000,
            database: { connectionString, maxConnections: 4,
              connectionTimeoutMs: 2000, queryTimeoutMs: 5000 }, checkpoints: { schema: 'langgraph' },
            workspaceStorageRoot: parentPath, fileStorageRoot, harnesses: {
              ...binaries, workspaceRoot: join(home, 'runtime'), timeoutMs: 180000,
            } }
          const operators = new PostgresOperatorRepository(pool)
          const current = await operators.ensure()
          const native = { harness: 'codex' as const, model: process.env.CODEX_TEST_MODEL ?? 'gpt-6-luna',
              reasoningEffort: 'medium' as const, sandbox: 'read-only' as const, serviceTier: 'standard' as const }
          await operators.update(native, current.configuration.id)
          const responseJournal = new NativeResponseJournal(join(home, 'responses'))
          const factories = new NativeHarnessFactories({ ...binaries,  responseJournal, })
          const resolver = productionOperatorManagers({ app: () => app, pool, config, workingDirectory: directory,
              managers: new Map(), nativeFactories: factories,
            processRegistry: new NativeProcessRegistry(join(home, 'processes')), responseJournal })
          const recorded = new WeakSet()
          // Record the genuine provider stream while the conversation service owns admission and submission.
          const recordingResolver: NativeManagerResolver = Object.assign((...args: Parameters<NativeManagerResolver>) => {
            const manager = resolver(...args)
            if (!recorded.has(manager)) {
              recorded.add(manager)
              const turn = manager.startTurn.bind(manager)
              manager.startTurn = async function* (...input: Parameters<typeof turn>) {
                for await (const event of turn(...input)) {
                  nativeEvents.push(event)
                  yield event
                }
              }
            }
            return manager
          }, resolver)
          const authority = new PostgresOperatorChatAuthority(pool, access,
            new NativeRollout({ NODE_ENV: 'test', HOST: '127.0.0.1' }), directory, endpoint,
            manager => ({ async inspect(input) {
              const inspected = await factories.inspector(manager).inspect(input)
              inspections.push(inspected)

              return inspected
            } }))
          const chat = new OperatorChatService(new PostgresOperatorConversationRepository(pool),
            operators, recordingResolver, directory, authority)
          services.operatorChat = chat
          chatEvents = chat.events
          services.workflows = new WorkflowManagementService(pool, commands)
          registerProductionFileStorage(app, pool, config)
          app.addHook('preClose', () => chat.shutdown())
        } })
        const workspace = await callWorkspaceTool(f.owner.client, 'workspace_create',
          ManagedWorkspaceCommandResultSchema, { commandId: randomUUID(), name: 'Native management target' })
        const foreign = await callWorkspaceTool(f.owner.client, 'workspace_create',
          ManagedWorkspaceCommandResultSchema, { commandId: randomUUID(), name: 'Other native project' })
        const credential = await f.access.issue({ name: 'Native conversation owner', audience: 'operator', grants: [
          { actions: ['operator_chat:read', 'operator_chat:write', 'operator_chat:cancel', 'harnesses:read'], scope: {} },
          { actions: ['workflows:create', 'workflows:read'], scope: {
            workspaceIds: [denied ? foreign.value.workspace.id : workspace.value.workspace.id],
          } },
        ], expiresAt: new Date(Date.now() + 600000) })
        const caller = { ...credential, client: await f.connect(credential.token) }
        const { conversation } = await callWorkspaceTool(caller.client, 'operator_chat_create',
          CreateOperatorConversationResponseSchema, { commandId: randomUUID(), title: 'Implement attached specification' })
        const command = { workspaceId: workspace.value.workspace.id, commandId: randomUUID(),
          name: `Native spec ${randomUUID()}` }
        const spec = `Call the Foreman Code MCP workflow_create tool exactly once with ${JSON.stringify(command)}.\n`
          + 'If creation succeeds, call workflow_get with its workspaceId and workflowId.\n'
          + 'If access is denied, report ACCESS_DENIED and stop. Do not change any files.\n'
        const bytes = Buffer.from(spec)
        const uploadId = randomUUID()
        const root = `/api/operator/conversations/${conversation.id}/files`
        const headers = { authorization: `Bearer ${caller.token}` }
        const allocated = await f.app.inject({ method: 'POST', url: `${root}/uploads`, headers, payload: {
          requestId: uploadId, filename: 'spec.md', mediaType: 'text/markdown', byteSize: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        } })
        expect(allocated.statusCode, allocated.body).toBe(201)
        const uploaded = await f.app.inject({ method: 'PUT', url: `${root}/uploads/${uploadId}`,
          headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: bytes })
        expect(uploaded.statusCode, uploaded.body).toBe(200)
        const finalized = await f.app.inject({ method: 'POST', url: `${root}/uploads/${uploadId}/finalize`, headers, payload: {} })
        expect(finalized.statusCode, finalized.body).toBe(200)
        const attachment = FileWithRevisionSchema.parse(finalized.json().value)
        const ref = { fileId: attachment.file.fileId, revisionId: attachment.revision.revisionId }
        const request = { requestId: randomUUID(), attachments: [ref], content:
          `Read spec.md by calling the attached-file files_read tool with this exact JSON: ${JSON.stringify({
            ...ref, offset: 0, length: bytes.length,
          })}. Copy both IDs completely. Decode contentBase64 and follow its instructions using Foreman Code MCP. `
          + 'Do not use shell commands or change any files.' }
        const accepted = await callWorkspaceTool(caller.client, 'operator_chat_send', SendOperatorMessageResponseSchema,
          { conversationId: conversation.id, request })
        expect(accepted.replayed).toBe(false)
        state = await readUntil(() => callWorkspaceTool(caller.client, 'operator_chat_get',
          GetOperatorConversationResponseSchema, { conversationId: conversation.id }),
        value => !value.activeRequestId, { timeoutMs: 180000, description: 'native Operator completion',
          subscribe: changed => chatEvents!.subscribe(conversation.id, changed) })
        expect(state.lastResult, JSON.stringify(state.lastResult)).toMatchObject({ outcome: 'succeeded' })
        expect(inspections.length).toBeGreaterThan(0)
        expect(inspections.every(item => item.entry?.name === APP_MCP_SERVER_NAME
          && item.entry.transport === 'streamable-http' && item.entry.endpoint === endpoint
          && item.entry.credentialEnvironmentVariable === APP_MCP_TOKEN)).toBe(true)
        expect(nativeEvents.some(event => nativeCallCompleted(event, 'files_read'))).toBe(true)
        expect(nativeEvents.some(event => nativeCallCompleted(event, 'workflow_create'))).toBe(true)
        if (!denied) expect(nativeEvents.some(event => nativeCallCompleted(event, 'workflow_get'))).toBe(true)
        expect(state.messages.some(message => message.role === 'user'
          && message.attachments?.some(item => item.file.fileId === ref.fileId
            && item.revision.revisionId === ref.revisionId))).toBe(true)
        const download = await f.app.inject({ method: 'GET',
          url: `${root}/${ref.fileId}/revisions/${ref.revisionId}/content`, headers })
        expect(download.statusCode).toBe(200)
        expect(download.rawPayload).toEqual(bytes)
        const delegated = (await f.pool.query<{ principal_id: string }>(
          'select principal_id from operator_chat_credentials where conversation_id=$1', [conversation.id])).rows
        expect(delegated).toHaveLength(1)
        expect(delegated[0]!.principal_id).not.toBe(caller.principal.id)
        const workflows = await f.pool.query<{ id: string }>('select id from workflows where workspace_id=$1',
          [workspace.value.workspace.id])
        const audits = await f.pool.query<{ action: string; outcome: string }>(
          'select action,outcome from management_audit where principal_id=$1 and source=$2', [delegated[0]!.principal_id, 'mcp'])
        if (denied) {
          expect(workflows.rows).toEqual([])
          expect(audits.rows).toContainEqual({ action: 'workflow_create', outcome: 'denied' })
          expect(state.messages.some(message => message.role === 'assistant' && message.content.includes('ACCESS_DENIED'))).toBe(true)
          expect((await f.pool.query('select command_id from management_command_receipts where command_id=$1',
            [command.commandId])).rows).toEqual([])
        } else {
          expect(workflows.rows).toHaveLength(1)
          expect(audits.rows).toContainEqual({ action: 'workflow.create', outcome: 'succeeded' })
          const readback = await callWorkspaceTool(caller.client, 'workflow_get', SavedManagedWorkflowSchema,
            { workspaceId: workspace.value.workspace.id, workflowId: workflows.rows[0]!.id })
          expect(readback.workflow.name).toBe(command.name)
          const fresh = new WorkflowManagementService(f.pool, f.commands)
          expect(await fresh.get(caller.principal, workspace.value.workspace.id, workflows.rows[0]!.id)).toEqual(readback)
          expect((await f.pool.query(`select command_id,result from management_command_receipts
            where principal_id=$1 and operation='workflow.create'`, [delegated[0]!.principal_id])).rows)
            .toEqual([{ command_id: command.commandId, result: readback }])
        }
      } finally {
        try {
          await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 })
          await writeFile(evidencePath, JSON.stringify({ harness, denied, binaries, inspections,
            nativeEvents, state }, null, 2), { mode: 0o600 })
          process.stdout.write(`Operator native evidence ${evidencePath}\n`)
        } finally {
          try { await f?.close() }
          finally {
            try { await removeFixtureDirectory(home) }
            finally {
              for (const name of environmentNames) {
                const previous = previousEnvironment[name]
                if (previous === undefined) delete process.env[name]
                else process.env[name] = previous
              }
            }
          }
        }
      }
    }, 240000)
  }
})
