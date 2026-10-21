import type { OperatorServices } from '../src/mcp/operator/types.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { ManagedAgentDefaultsSchema } from '@foreman-code/contracts/management'
import { DEFAULT_AGENT_DEFAULTS } from '@foreman-code/contracts'
import { describe, expect, it } from 'vitest'
import { OperatorChatService, type OperatorChatAuthority } from '../src/modules/conversations/operatorChat.js'
import { nativeCorrelation } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { FoundationSettingsManagementService } from '../src/modules/settings/management.js'
import { buildApp } from '../src/app.js'
import { OPERATOR_MCP_ENVIRONMENT_VARIABLE, PostgresOperatorChatAuthority } from '../src/modules/conversations/operatorChatAuthority.js'
import { NativeRollout } from '../src/modules/harnesses/nativeRollout.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'
import { registerOperatorChatFixture, type OperatorChatFixture, waitFor } from './helpers/operatorChatFixture.js'
import { withTransaction } from '../src/infrastructure/transaction.js'

const connectionString = process.env.TEST_DATABASE_URL

let pool: OperatorChatFixture['pool']
let access: OperatorChatFixture['access']
let operators: OperatorChatFixture['operators']
let repository: OperatorChatFixture['repository']
let manager: OperatorChatFixture['manager']
let authority: OperatorChatFixture['authority']
let chat: OperatorChatFixture['chat']
let runtimeDirectory: OperatorChatFixture['runtimeDirectory']

registerOperatorChatFixture(fixture => {
  ({ pool, access, operators, repository, manager, authority, chat, runtimeDirectory } = fixture)
}, () => chat)

describe.skipIf(!connectionString)('Operator chat persistence and native binding with stubbed authority', () => {
  it('issues a usable delegated bearer when the native adapter cannot retain native turns', async () => {
    const parent = await access.issue({ name: 'Native chat owner', audience: 'operator',
      grants: [{ actions: ['operator_chat:read', 'operator_chat:write', 'harnesses:read'], scope: {} }] })
    const conversation = await chat.create(parent.principal)
    const configuration = (await operators.ensure()).configuration
    const nativeAuthority = new PostgresOperatorChatAuthority(pool, access,
      new NativeRollout({ NODE_ENV: 'test', HOST: '127.0.0.1' }), runtimeDirectory, 'http://127.0.0.1:1/mcp',
      () => ({ inspect: async request => ({ harness: request.harness, providerVersion: 'recorded-codex',
        runnerId: request.runnerId, workingDirectory: request.workingDirectory, inspectedAt: new Date().toISOString(),
        entry: { name: 'graphql', enabled: true, transport: 'stdio', automaticEndpoint: true,
          credentialEnvironmentVariable: 'GRAPHQL_MCP_TOKEN', status: 'connected' } }) }))
    try {
      const environment = await nativeAuthority.prepare(manager, configuration, conversation.id, parent.principal.id,
        AbortSignal.timeout(2_000))
      const token = environment.variables[OPERATOR_MCP_ENVIRONMENT_VARIABLE]
      const delegated = await access.authenticate(token)
      expect(delegated.id).not.toBe(parent.principal.id)
      expect(delegated.grants.flatMap(grant => grant.actions)).toContain('harnesses:read')
      expect(manager.sessions).toBe(0)
      expect(manager.turns).toBe(0)
      await nativeAuthority.release(conversation.id)
      await expect(access.authenticate(token)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    } finally { await nativeAuthority.release(conversation.id) }
  })

  it.each(['main', 'device'] as const)(
    'inspects persisted %s Claude setup through read-only HTTP and MCP without creating an execution owner', async host => {
    const settings = new PostgresFoundationSettingsRepository(pool)
    const commands = new PostgresCommandCoordinator(pool)
    const inspected: Array<{ principalId: string; configurationId: string; profileId?: string }> = []
    let endpoint = ''
    let managersCreated = 0
    const inspectionAuthority: OperatorChatAuthority = { ...authority,
      setupConfiguration: (principal, configuration, signal) => new PostgresOperatorChatAuthority(pool, access, {} as NativeRollout,
        runtimeDirectory, endpoint, undefined, async () => {}, async (current, selected) => {
          inspected.push({ principalId: current.id, configurationId: selected.id,
            ...(selected.harnessProfileSelection ? { profileId: selected.harnessProfileSelection.instanceId } : {}) })
          return { harness: 'claude', status: 'configured', endpoint, checkedAt: new Date().toISOString() }
        }).setupConfiguration(principal, configuration, signal),
    }
    chat = new OperatorChatService(repository, operators, () => { managersCreated++; throw new Error('Setup must not allocate a turn manager') },
      runtimeDirectory, inspectionAuthority)
    const service = new FoundationSettingsManagementService(settings, commands, undefined, operators)
    const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { settings: service, operatorChat: chat, commands } as unknown as OperatorServices } })
    registerOperatorChatRoutes(app, chat)
    const clients: Client[] = []
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 }); endpoint = `${address}/mcp`
      const mainId = '11111111-1111-4111-8111-111111111111'
      const hostRef = host === 'main' ? { kind: 'main' as const, mainId }
        : { kind: 'device' as const, mainId, deviceId: randomUUID() }
      const selector = { instanceId: randomUUID(), instanceRevision: '1', target: { hostRef,
        applicationInstallationId: host === 'main' ? mainId : randomUUID(),
        harnessInstallationId: 'synthetic-claude-installation', installationFingerprint: 'synthetic-payload' } }
      const saved = await settings.updateAgentDefaults({ ...DEFAULT_AGENT_DEFAULTS, operator: { ...DEFAULT_AGENT_DEFAULTS.operator,
        harnessProfileSelection: selector, harness: { harness: 'claude', model: 'synthetic-claude-model', authMode: 'subscription',
          configDirectory: '/synthetic/profile', permissionMode: 'default', sandbox: 'danger-full-access', tools: [], permissionRules: [], instructions: '',
          mcpServers: { graphql: { type: 'http', url: endpoint } } } } }, 0)
      const first = (await operators.ensure()).configuration
      const reader = await access.issue({ name: 'Claude installation reader', audience: 'operator',
        grants: [{ actions: ['settings:read', 'harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
      const response = await fetch(`${address}/api/operator/setup?harness=claude&expectedDefaultsRevision=${saved.revision}`, { headers: { Authorization: `Bearer ${reader.token}` } })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ status: 'configured', harness: 'claude', configurationVersionId: first.id })
      const client = new Client({ name: 'claude-setup-reader', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => reader.token } }))
      expect(decodeMcpToolResult((await client.callTool({ name: 'operator_mcp_setup_get', arguments: {} })))).toMatchObject({ status: 'configured', configurationVersionId: first.id })
      const readback = ManagedAgentDefaultsSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'agent_defaults_get', arguments: {} }))))
      expect(readback.value.operator.harnessProfileSelection).toEqual(selector)
      expect(readback.value.operator.harness).toMatchObject({ sandbox: 'danger-full-access' })
      const nextSelector = { ...selector, instanceId: randomUUID(), instanceRevision: '2' }
      const changed = await settings.updateAgentDefaults({ ...saved.value, operator: { ...saved.value.operator, harnessProfileSelection: nextSelector } }, saved.revision)
      const second = (await withTransaction(pool, connection =>
        operators.updateWithClient(connection, first.harness, first.id, first.showThinking, undefined, nextSelector))).configuration
      expect(changed.value.operator.harnessProfileSelection).toEqual(nextSelector)
      const transitioned = await fetch(`${address}/api/operator/setup?harness=claude&expectedDefaultsRevision=${changed.revision}`, { headers: { Authorization: `Bearer ${reader.token}` } })
      expect(transitioned.status).toBe(200)
      expect(await transitioned.json()).toMatchObject({ configurationVersionId: second.id })
      expect(inspected).toEqual([
        { principalId: reader.principal.id, configurationId: first.id, profileId: selector.instanceId },
        { principalId: reader.principal.id, configurationId: first.id, profileId: selector.instanceId },
        { principalId: reader.principal.id, configurationId: second.id, profileId: nextSelector.instanceId },
      ])
      expect((await repository.configuration(first.id))?.harnessProfileSelection).toEqual(selector)
      const denied = await access.issue({ name: 'No installation grant', audience: 'operator', grants: [{ actions: ['settings:read'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
      const deniedResponse = await fetch(`${address}/api/operator/setup?harness=claude`, { headers: { Authorization: `Bearer ${denied.token}` } })
      expect(deniedResponse.status).toBe(403)
      const deniedClient = new Client({ name: 'claude-setup-denied', version: '1' }); clients.push(deniedClient)
      await deniedClient.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => denied.token } }))
      expect((await deniedClient.listTools()).tools.map((tool) => tool.name)).not.toContain('operator_mcp_setup_get')
      await expectMcpAccessDenied(deniedClient.callTool({ name: 'operator_mcp_setup_get', arguments: {} }))
      await expectMcpAccessDenied(client.callTool({ name: 'operator_chat_create', arguments: {} }))
      expect(managersCreated).toBe(0)
      expect((await pool.query('select id from operator_conversations')).rowCount).toBe(0)
      expect((await pool.query('select request_id from operator_conversation_turns')).rowCount).toBe(0)
      expect((await pool.query('select principal_id from operator_chat_credentials')).rowCount).toBe(0)
    } finally { for (const client of clients) await client.close(); await app.close() }
  })

  it.each(['scope', 'missing grant', 'parent grant', 'parent write', 'revoked parent', 'expired parent', 'expired delegate', 'revoked delegate', 'dead turn'] as const)(
    'inspects an active chat-derived MCP setup without Run/root authority and denies %s', async (denial) => {
      const parent = await access.issue({ name: 'Read-only native delegation owner', audience: 'operator', grants: [{
        actions: ['operator_chat:read', 'operator_chat:write', 'harnesses:read', 'settings:read'], scope: {},
      }], expiresAt: new Date(Date.now() + 120_000) })
      const settings = new PostgresFoundationSettingsRepository(pool)
      const commands = new PostgresCommandCoordinator(pool)
      const inspected: string[] = []
      let endpoint = ''
      let token: string | undefined
      const makeAuthority = () => new PostgresOperatorChatAuthority(pool, access, new NativeRollout({ NODE_ENV: 'test', HOST: '127.0.0.1' }),
        runtimeDirectory, endpoint, () => ({ inspect: async (request) => ({ harness: request.harness,
          providerVersion: 'synthetic-codex-cli', runnerId: request.runnerId, workingDirectory: request.workingDirectory, inspectedAt: new Date().toISOString(),
          entry: { name: 'graphql', enabled: true, transport: 'stdio', automaticEndpoint: true,
            credentialEnvironmentVariable: 'GRAPHQL_MCP_TOKEN', status: 'connected' } }) }), async () => {},
        async (principal, configuration) => {
          inspected.push(principal.id)
          return { harness: 'claude', status: 'configured', endpoint: configuration.harness.harness === 'claude' ? configuration.harness.mcpServers.graphql!.url : '', checkedAt: new Date().toISOString() }
        })
      let nativeAuthority: PostgresOperatorChatAuthority
      const bound: OperatorChatAuthority = { current: (id) => nativeAuthority.current(id),
        assertConfiguration: (value) => nativeAuthority.assertConfiguration(value),
        setup: (...input) => nativeAuthority.setup(...input), setupConfiguration: (...input) => nativeAuthority.setupConfiguration(...input),
        prepare: async (...input) => { const environment = await nativeAuthority.prepare(...input); token = environment.variables.GRAPHQL_MCP_TOKEN; return environment },
        release: (id) => nativeAuthority.release(id) }
      manager.autoFinish = false
      chat = new OperatorChatService(repository, operators, () => manager, runtimeDirectory, bound)
      const service = new FoundationSettingsManagementService(settings, commands, undefined, operators)
      const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access, services: { settings: service, operatorChat: chat, commands } as unknown as OperatorServices } })
      const client = new Client({ name: 'actual-chat-delegate', version: '1' })
      try {
        const address = await app.listen({ host: '127.0.0.1', port: 0 }); endpoint = `${address}/mcp`
        nativeAuthority = makeAuthority()
        const conversation = await chat.create(parent.principal)
        await chat.send(conversation.id, { requestId: 'active-delegate-turn', content: 'Synthetic native admission fixture' }, parent.principal)
        await waitFor(async () => (await repository.active(conversation.id))?.active_phase === 'submitted')
        expect(token).toBeTruthy()
        const delegate = await access.authenticate(token)
        expect(delegate.id).not.toBe(parent.principal.id)
        await expect(access.currentOperator(delegate.id)).rejects.toMatchObject({ code: 'AUTH_INVALID' })
        const readAuthority = await access.currentHarnessInspectionPrincipal(delegate.id)
        expect(readAuthority.id).toBe(delegate.id)
        expect(readAuthority.grants.flatMap((grant) => grant.actions)).not.toContain('operator_chat:write')
        expect(readAuthority.grants.flatMap((grant) => grant.actions)).not.toContain('settings:update')
        const first = (await operators.ensure()).configuration
        const mainId = '11111111-1111-4111-8111-111111111111'
        const selector = { instanceId: randomUUID(), instanceRevision: '1', target: { hostRef: { kind: 'main' as const, mainId },
          applicationInstallationId: mainId, harnessInstallationId: 'synthetic-installed-claude', installationFingerprint: 'synthetic-native-payload' } }
        const harness = { harness: 'claude' as const, model: 'synthetic-claude', authMode: 'subscription' as const, configDirectory: '/synthetic/profile',
          permissionMode: 'default' as const, sandbox: 'danger-full-access' as const, tools: [], permissionRules: [], instructions: '',
          mcpServers: { graphql: { type: 'http' as const, url: endpoint } } }
        await settings.updateAgentDefaults({ ...DEFAULT_AGENT_DEFAULTS, operator: { ...DEFAULT_AGENT_DEFAULTS.operator, harness, harnessProfileSelection: selector } }, 0)
        await withTransaction(pool, connection =>
          operators.updateWithClient(connection, harness, first.id, false, undefined, selector))
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token! } }))
        expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('operator_mcp_setup_get')
        expect((await client.callTool({ name: 'operator_mcp_setup_get', arguments: {} })).isError).not.toBe(true)
        expect(inspected).toEqual([delegate.id])
        expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain('operator_chat_create')
        if (denial === 'dead turn') {
          manager.finish(nativeCorrelation(conversation.id, 'active-delegate-turn'))
          await waitFor(async () => (await repository.active(conversation.id))?.active_request_id === null)
        } else if (denial === 'revoked parent') await access.revoke(parent.principal.id)
        else if (denial === 'revoked delegate') await access.revoke(delegate.id)
        else if (denial === 'expired parent' || denial === 'expired delegate') await pool.query('update management_principals set expires_at=$2 where id=$1',
          [denial === 'expired parent' ? parent.principal.id : delegate.id, new Date(Date.now() - 1000)])
        else {
          const parentChange = denial === 'parent grant' || denial === 'parent write'
          const actions = parentChange ? parent.principal.grants[0]!.actions.filter((action) => action !== (denial === 'parent write' ? 'operator_chat:write' : 'harnesses:read'))
            : denial === 'missing grant' ? ['settings:read'] : ['harnesses:read']
          await pool.query('update management_principals set grants=$2::jsonb where id=$1', [parentChange ? parent.principal.id : delegate.id,
            JSON.stringify([{ actions, scope: denial === 'scope' ? { workspaceIds: ['unrelated-workspace'] } : {} }])])
        }
        const result = await client.callTool({ name: 'operator_mcp_setup_get', arguments: {} }).then((value) => value, (error: unknown) => error)
        expect(result instanceof Error || typeof result === 'object' && result !== null && 'isError' in result && result.isError === true).toBe(true)
        expect(inspected).toEqual([delegate.id])
      } finally {
        try { await client.close() } finally { await app.close() }
      }
    }, 30_000)

})
