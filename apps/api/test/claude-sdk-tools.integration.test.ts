import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { ManagedWorkspaceCommandResultSchema } from '@foreman-code/contracts/management'
import { createHash, randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { reportIntegrationPhase } from './helpers/integrationPhase.js'
import { expect, it, vi } from 'vitest'
import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { OperatorChatService, PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChat.js'
import { PostgresOperatorChatAuthority } from '../src/modules/conversations/operatorChatAuthority.js'
import { NativeRollout } from '../src/modules/harnesses/nativeRollout.js'
import { registerProductionFileStorage } from '../src/modules/files/production.js'
import { productionFileTools } from '../src/modules/files/tools/production.js'
import { nim2691TaskDatabase } from './helpers/nim2691Database.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { readUntil } from './helpers/observableCondition.js'
import { graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { productionClaudeFixture } from './support/claudeProduction.js'
import { claudeSdkToolTransport } from './support/claudeSdkToolTransport.js'

it('reuses the production Claude SDK query with fresh revoked turn credentials through authenticated MCP', async () => {
  await nim2691TaskDatabase(async (pool, directory) => {
    await applyApplicationMigrations(pool)
    const access = new PostgresAccessService(pool)
    const owner = await access.issue({ name: 'Warm SDK owner', audience: 'operator', grants: [{ scope: {}, actions: [
      'operator_chat:read', 'operator_chat:write', 'operator_chat:respond', 'harnesses:read', 'workspaces:read',
    ] }] })
    const repository = new PostgresOperatorConversationRepository(pool)
    const operators = new PostgresOperatorRepository(pool)
    const services = { commands: new PostgresCommandCoordinator(pool) } as OperatorServices
    const app = buildApp({ logger: false, readiness: {
      database: { ping: async () => {} }, checkpoints: { ping: async () => {} },
    }, operator: { access, services } })
    let chat: OperatorChatService | undefined
    try {
      const endpoint = `${await app.listen({ host: '127.0.0.1', port: 0 })}/mcp`
      const mainId = randomUUID()
      const selection = { instanceId: randomUUID(), instanceRevision: 'profile-1', target: {
        hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
        harnessInstallationId: 'recorded-cli', installationFingerprint: 'recorded-payload',
      } }
      const harness: ClaudeHarnessConfiguration = { harness: 'claude', model: 'recorded-model', authMode: 'subscription',
        configDirectory: '/recorded/profile', permissionMode: 'default', sandbox: 'danger-full-access',
        tools: [], permissionRules: [], instructions: '', mcpServers: { graphql: { type: 'http', url: endpoint } } }
      const settings = new PostgresFoundationSettingsRepository(pool)
      const defaults = await settings.getAgentDefaults()
      await settings.updateAgentDefaults({ ...defaults.value,
        operator: { ...defaults.value.operator, harness, harnessProfileSelection: selection },
      }, defaults.revision)
      const configuration = (await operators.ensure()).configuration
      const conversation = await repository.create(configuration.operatorId, configuration, owner.principal.id)
      const tokens: string[] = []
      const transport = claudeSdkToolTransport(directory, () => [], { replyText: () => tokens[0] ?? 'First answer' })
      const start = { kind: 'operator' as const, correlationId: `operator:${conversation.id}:cold-production`, configuration,
        workingDirectory: directory, environment: { agentId: configuration.operatorId, variables: {} } }
      const native = productionClaudeFixture('operator', undefined, endpoint, undefined,
        { database: pool, binding: { kind: 'operator', conversationId: conversation.id, repository }, start, sdk: transport.sdk })
      const authority = new PostgresOperatorChatAuthority(pool, access, new NativeRollout({ NODE_ENV: 'test' }),
        directory, endpoint, manager => native.factories.inspector(manager), async (_manager, configuration, environment, signal) => {
          const token = readProductEnvironment(environment.variables, 'MCP_TOKEN')!
          await native.manager.refreshInspectionCredentials({ ...start, configuration, environment }, {
            graphql: { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${token}` } },
          }, signal)
        })
      const prepared = vi.spyOn(authority, 'prepare')
      chat = new OperatorChatService(repository, operators, () => native.manager, directory, authority)
      services.operatorChat = chat
      const durations: number[] = []
      const initialSettings = (await chat.get(conversation.id, owner.principal)).settings
      if (initialSettings?.harness !== 'claude') throw new Error('Claude Operator settings required')
      for (const requestId of ['cold-production', 'warm-production']) {
        const startedAt = performance.now()
        let firstOutput!: (value: number) => void
        let outputFailed!: (error: Error) => void
        const output = new Promise<number>((resolve, reject) => { firstOutput = resolve; outputFailed = reject })
        const unsubscribe = chat.events.subscribe(conversation.id, event => {
          if (event.type === 'delta' && event.data.requestId === requestId) firstOutput(performance.now() - startedAt)
          if (event.type === 'state' && event.data.requestId === requestId
            && ['error', 'uncertain'].includes(String(event.data.turnState))) outputFailed(new Error('Native turn failed before output'))
        })
        try {
          const sent = await graphRpc(app, owner.token, 'tools/call', { name: 'operator_chat_send', arguments: {
            conversationId: conversation.id, request: { requestId, content: 'Reply once',
              ...(requestId === 'warm-production'
                ? { settings: { ...initialSettings, showThinking: !initialSettings.showThinking } } : {}),
            },
          } })
          expect(sent.result?.isError, JSON.stringify(sent)).not.toBe(true)
          durations.push(await output.catch(async error => {
            const state = await repository.get(conversation.id)
            throw new Error(JSON.stringify({ error: state?.error, result: state?.lastResult }), { cause: error })
          }))
          await readUntil(async () => chat!.get(conversation.id, owner.principal), state => state.turnState === 'idle',
            { timeoutMs: 15000, description: `production SDK turn completion (${requestId})` }).catch(async error => {
            const state = await repository.get(conversation.id)
            const terminal = await repository.terminal(conversation.id, requestId)
            throw new Error(JSON.stringify({ requestId, turnState: state?.turnState, error: state?.error,
              terminal: terminal && { closureState: terminal.closureState, historyPersisted: terminal.historyPersisted,
                outcome: terminal.observation.result.outcome } }), { cause: error })
          })
          const environment = await prepared.mock.results.at(-1)!.value
          tokens.push(readProductEnvironment(environment.variables, 'MCP_TOKEN')!)
          await expect(access.authenticate(tokens.at(-1)!)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
          expect(transport.queries).toHaveLength(1)
          expect(transport.queries[0]!.closed).toBe(false)
        } finally { unsubscribe() }
      }
      expect(tokens[1]).not.toBe(tokens[0])
      expect(transport.offers).toHaveLength(2)
      const state = await chat.get(conversation.id, owner.principal)
      const messages = state.messages
      expect(messages.filter(message => message.role === 'assistant')).toHaveLength(2)
      expect(JSON.stringify(messages)).not.toContain(tokens[0]!)
      expect(JSON.stringify(state)).not.toContain(tokens[0]!)
      expect((await authority.setup(native.manager, new AbortController().signal)).status).toBe('configured')
      expect(transport.queries).toHaveLength(1)
      reportIntegrationPhase('production-cold-first-reply', durations[0]!)
      reportIntegrationPhase('production-warm-first-reply', durations[1]!)
      console.info('Production Operator Claude timing', { coldMs: durations[0], warmMs: durations[1], queryStarts: transport.queries.length })
    } finally { try { await chat?.shutdown() } finally { await app.close() } }
  })
}, 60000)

it.each([
  { scenario: 'management', serverName: 'graphql' },
  { scenario: 'denied-management', serverName: 'graphql' },
  { scenario: 'files', serverName: 'graphql-files' },
  { scenario: 'management', serverName: 'foreman-code' },
  { scenario: 'denied-management', serverName: 'foreman-code' },
] as const)(
  'executes $scenario on $serverName through the official SDK and production composition with persisted readback',
  async ({ scenario, serverName }) => {
    const vault = await privateFixtureDirectory('claude-sdk-files-')
    await nim2691TaskDatabase(async (pool, directory) => {
      await applyApplicationMigrations(pool)
      const access = new PostgresAccessService(pool)
      const permissions = ['operator_chat:read', 'operator_chat:write', 'operator_chat:respond', 'workspaces:read'] as const
      const owner = await access.issue({ name: 'SDK tool owner', audience: 'operator',
        grants: [{ actions: [...permissions, ...(scenario === 'denied-management' ? [] : ['workspaces:create' as const])], scope: {} }],
        expiresAt: new Date(Date.now() + 600_000) })
      const reader = await access.issue({ name: 'SDK tool reader', audience: 'operator',
        grants: [{ actions: ['operator_chat:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
      const repository = new PostgresOperatorConversationRepository(pool)
      const operators = new PostgresOperatorRepository(pool)
      const commands = new PostgresCommandCoordinator(pool)
      const locations = new WorkspaceLocationService(pool, commands)
      const workspaces = new WorkspaceManagementService(pool, commands, locations)
      const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access, services: { commands, locations, workspaces,
          operatorChat: { get: (...args: Parameters<OperatorChatService['get']>) => chat.get(...args),
            respond: (...args: Parameters<OperatorChatService['respond']>) => chat.respond(...args) },
        } as OperatorServices } })
      const files = registerProductionFileStorage(app, pool, {
        host: '127.0.0.1', port: 0, readinessTimeoutMs: 2_000,
        database: { connectionString: 'postgresql://graphql:graphql@127.0.0.1/graphql_test',
          maxConnections: 4, connectionTimeoutMs: 2_000, queryTimeoutMs: 5_000 }, checkpoints: { schema: 'langgraph' },
        fileStorageRoot: vault, workspaceStorageRoot: join(directory, 'workspaces'),
        harnesses: { workspaceRoot: join(directory, 'runtime'), codexBinary: 'unused', timeoutMs: 10_000 },
      })
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const endpoint = `${address}/mcp`
      const tool = scenario === 'files' ? 'mcp__graphql-files__files.read' : `mcp__${serverName}__workspace_create`
      const harness: ClaudeHarnessConfiguration = { harness: 'claude', model: 'recorded-model', authMode: 'subscription',
        configDirectory: '/recorded/profile', permissionMode: 'default', sandbox: 'danger-full-access', tools: [tool],
        permissionRules: [{ tool, effect: 'ask' }], instructions: '',
        mcpServers: scenario === 'files' ? {} : { [serverName]: { type: 'http', url: endpoint } } }
      const mainId = randomUUID()
      const selection = { instanceId: randomUUID(), instanceRevision: 'profile-1', target: {
        hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
        harnessInstallationId: 'recorded-cli', installationFingerprint: 'recorded-payload',
      } }
      const settings = new PostgresFoundationSettingsRepository(pool)
      const defaults = await settings.getAgentDefaults()
      await settings.updateAgentDefaults({ ...defaults.value,
        operator: { ...defaults.value.operator, harness, harnessProfileSelection: selection },
      }, defaults.revision)
      const configuration = (await operators.ensure()).configuration
      const conversation = await repository.create(configuration.operatorId, configuration, owner.principal.id)
      const requestId = randomUUID()
      let arguments_: Record<string, unknown> = { commandId: randomUUID(), name: `SDK workspace ${randomUUID()}` }
      if (scenario === 'files') {
        const bytes = Buffer.from('# File read by the official SDK\n')
        const uploadId = randomUUID()
        const target = { kind: 'operator' as const, conversationId: conversation.id }
        await files.allocate(owner.principal, target, { requestId: uploadId, filename: 'sdk.md', mediaType: 'text/markdown',
          byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
        await files.upload(owner.principal, target, uploadId, Readable.from([bytes]))
        const ready = await files.finalize(owner.principal, target, uploadId)
        arguments_ = { fileId: ready.value.file.fileId, revisionId: ready.value.revision.revisionId }
      }
      const gatePermission = scenario === 'management' && serverName === 'graphql'
      let releasePermission!: () => void
      const permissionReady = new Promise<void>(resolve => { releasePermission = resolve })
      let permissionWaiting = false
      const transport = claudeSdkToolTransport(directory, () => [{ name: scenario === 'files' ? 'files.read' : 'workspace_create',
        arguments: arguments_, server: serverName, source: scenario === 'files' ? 'sdk' : 'dynamic' }], {
        beforePermission: async () => {
          if (gatePermission) {
            permissionWaiting = true
            await permissionReady
          }
        },
      })
      const start = { kind: 'operator' as const, correlationId: `operator:${conversation.id}:${requestId}`, configuration,
        workingDirectory: directory, environment: { agentId: configuration.operatorId, variables: {} } }
      const f = productionClaudeFixture('operator', undefined, endpoint, scenario === 'files' ? productionFileTools(app) : undefined,
        { database: pool, binding: { kind: 'operator', conversationId: conversation.id, repository }, start, sdk: transport.sdk })
      const nativeAuthority = new PostgresOperatorChatAuthority(pool, access, new NativeRollout({ NODE_ENV: 'test' }),
        directory, endpoint, manager => f.factories.inspector(manager), async (manager, configuration, environment, signal) => {
          expect(manager).toBe(f.manager)
          const token = readProductEnvironment(environment.variables, 'MCP_TOKEN')!
          const variables = { ...environment.variables }
          if (serverName === 'foreman-code') {
            variables.FOREMAN_CODE_MCP_TOKEN = token
            delete variables.GRAPHQL_MCP_TOKEN
          }
          const scoped = { ...start, configuration, environment: { ...environment, variables } }
          const delegate = await access.authenticate(token)
          expect(delegate.id).not.toBe(owner.principal.id)
          expect(delegate.grants.flatMap(grant => grant.actions)).not.toContain('operator_chat:write')
          await f.manager.refreshInspectionCredentials(scoped, { [serverName]: { type: 'http', url: endpoint,
            headers: { Authorization: `Bearer ${token}` } } }, signal)
        })
      const chat: OperatorChatService = new OperatorChatService(repository, operators, () => f.manager, directory, {
        current: id => nativeAuthority.current(id), assertConfiguration: value => nativeAuthority.assertConfiguration(value),
        setup: async () => ({ harness: 'claude', status: 'configured', endpoint, checkedAt: new Date().toISOString() }),
        prepare: async (manager, configuration, conversationId, principalId, signal) => {
          await f.manager.prepareInspection(start, signal)
          if (scenario !== 'files') {
            return nativeAuthority.prepare(manager, configuration, conversationId, principalId, signal)
          }
          return start.environment
        }, release: id => nativeAuthority.release(id),
      })
      try {
        await chat.send(conversation.id, { requestId, content: 'Call the configured tool' }, owner.principal)
        if (gatePermission) {
          await readUntil(async () => permissionWaiting, Boolean, {
            timeoutMs: 15_000, description: 'native tool waiting before permission',
          })
          const waiting = await chat.get(conversation.id, owner.principal)
          expect(waiting.activeRequestId).toBe(requestId)
          expect(waiting.pendingInteraction).toBeUndefined()
          expect(transport.results).toEqual([])
          expect((await pool.query("select count(*)::int as n from workspaces where record->>'name'=$1",
            [arguments_.name])).rows[0]?.n).toBe(0)
          releasePermission()
        }
        if (scenario !== 'denied-management') {
          const state = await readUntil(async () => {
            const current = await chat.get(conversation.id, owner.principal)
            if (current.error) throw new Error(JSON.stringify(current.error))
            if (!current.activeRequestId && !current.pendingInteraction) {
              throw new Error('The tool turn ended without requesting its configured approval.')
            }
            return current
          }, current => current.pendingInteraction !== undefined, {
            timeoutMs: 15_000, description: 'SDK tool approval',
          })
          const pending = state.pendingInteraction!
          expect(transport.results).toEqual([])
          const input = { commandId: randomUUID(), requestId, nativeRequestId: pending.turn.nativeRequestId,
            optionId: pending.responseOptions[0]!.optionId }
          const denied = await graphRpc(app, reader.token, 'tools/call', { name: 'operator_chat_respond',
            arguments: { conversationId: conversation.id, request: input } })
          expect(denied.error || denied.result?.isError).toBeTruthy()
          const approved = await graphRpc(app, owner.token, 'tools/call', { name: 'operator_chat_respond',
            arguments: { conversationId: conversation.id, request: input } })
          // Hook acknowledgment arrives after the permission control response.
          expect(approved.result || approved.error).toBeDefined()
        }
        try {
          await vi.waitFor(async () => {
            await chat.reconcileActive()
            const state = await chat.get(conversation.id, owner.principal)
            expect(state.activeRequestId, JSON.stringify({ error: state.error, progress: transport.progress,
              transportErrors: transport.errors })).toBeNull()
          }, { timeout: 15_000 })
        } catch (error) {
          const waiting = (await pool.query(`select state,wait_event_type,wait_event,query
            from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()`)).rows
          const receipts = (await pool.query(`select operation,result->>'status' as status
            from management_command_receipts`)).rows
          throw new Error(JSON.stringify({ progress: transport.progress, transportErrors: transport.errors,
            waiting, receipts }), { cause: error })
        }
        expect(transport.offers).toHaveLength(1)
        expect(transport.results).toHaveLength(1)
        expect(transport.results[0]!.allowed).toBe(scenario !== 'denied-management')
        if (scenario === 'management') {
          const result = transport.results[0]!.result as Parameters<typeof decodeMcpToolResult>[0] & { isError?: boolean }
          expect(result.isError).not.toBe(true)
          const created = ManagedWorkspaceCommandResultSchema.parse(decodeMcpToolResult(result))
          const id = created.value.workspace.id
          const read = await graphRpc(app, owner.token, 'tools/call', { name: 'workspace_get', arguments: { workspaceId: id } })
          expect(graphRpcValue(read.result)).toMatchObject({ workspace: { id, name: arguments_.name } })
          expect((await pool.query('select record from workspaces where id=$1', [id])).rows[0]?.record)
            .toMatchObject({ id, name: arguments_.name })
        } else if (scenario === 'files') {
          expect(transport.results[0]!.result).toMatchObject({ structuredContent: {
            contentBase64: Buffer.from('# File read by the official SDK\n').toString('base64'),
          }, content: expect.arrayContaining([{ type: 'text', text: '# File read by the official SDK\n' }]) })
          expect((await pool.query('select count(*)::int as n from file_tool_sessions where revoked_at is null')).rows[0]?.n).toBe(0)
        } else expect((await pool.query("select count(*)::int as n from workspaces where record->>'name'=$1", [arguments_.name])).rows[0]?.n).toBe(0)
        if (scenario !== 'denied-management') {
          const receipt = (await pool.query("select result from management_command_receipts where operation='operator_chat_control' and target_key=$1",
            [conversation.id])).rows[0]?.result
          expect(receipt).toMatchObject({ status: 'completed', providerAcknowledgment: { semantic: 'approve_once' } })
        }
        const credentials = (await pool.query(`select p.revoked_at from operator_chat_credentials c
          join management_principals p on p.id=c.principal_id where c.conversation_id=$1`, [conversation.id])).rows
        expect(credentials).toHaveLength(scenario === 'files' ? 0 : 1)
        expect(credentials.every(row => row.revoked_at !== null)).toBe(true)
      } finally {
        releasePermission()
        try { await chat.shutdown() } finally { await app.close() }
      }
    }).finally(() => rm(vault, { recursive: true, force: true }))
  }, 60_000)
