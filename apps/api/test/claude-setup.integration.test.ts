import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { ClaudeSetupOptionsSchema } from '@foreman-code/contracts/claude'
import { HarnessDefaultsUpdateResultSchema, ExecutionReadinessSchema, type HarnessOptions } from '@foreman-code/contracts/management'
import { HarnessCatalogService } from '../src/modules/harnesses/catalog.js'
import { NativeHarnessConfigurationQualifier } from '../src/modules/harnesses/nativeConfigurationQualifier.js'
import { ExecutionReadinessService } from '../src/modules/harnesses/executionReadiness.js'
import { NativeRollout } from '../src/modules/harnesses/nativeRollout.js'
import { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { buildApp } from '../src/app.js'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { initializeNativeDefaults } from '../src/modules/harnesses/initializeDefaults.js'

/** Real authenticated transport and persisted settings. Claude's actual factory
 * blocks qualification before native effects; no fabricated proof/model turn. */
it.skipIf(!postgresEnabled)('repairs a stale Claude MCP endpoint with denied writes, persisted readback and truthful blocked readiness', async () => {
  const f = await currentOperatorIntegration()
  const catalog = new HarnessCatalogService(new NativeHarnessConfigurationQualifier('codex'),
    new PostgresSettingsRepository(f.db.pool), f.commands, f.db.directory, new URL('/mcp', f.address).href)
  const app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
    operator: { access: f.access, services: { ...f.services, harnesses: catalog, executionReadiness: new ExecutionReadinessService(new NativeRollout({}), catalog) } } })
  const clients: Client[] = []
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const connect = async (token: string) => {
    const client = new Client({ name: 'claude-setup-test', version: '1' }); clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
    return client
  }
  try {
    const client = await connect(f.writer.token)
    const result = (value: { isError?: boolean | undefined; structuredContent?: unknown }) => { expect(value.isError).not.toBe(true); return decodeMcpToolResult(value) }
    const before = ExecutionReadinessSchema.parse(result(await client.callTool({ name: 'execution_readiness_get', arguments: { harness: 'claude' } })))
    expect(before).toMatchObject({ status: 'blocked', reason: { code: 'HARNESS_PROFILE_REQUIRED' } })
    const setup = ClaudeSetupOptionsSchema.parse(result(await client.callTool({ name: 'claude_setup_options_get', arguments: {} })))
    expect(setup.graphqlMcp).toEqual({ type: 'http', url: new URL('/mcp', f.address).href })
    const http = await fetch(new URL('/api/management/harnesses/claude/setup-options', address), { headers: { authorization: `Bearer ${f.writer.token}` } })
    expect(http.status).toBe(200); expect(await http.json()).toEqual(setup)
    const original = await new PostgresSettingsRepository(f.db.pool).getManagedHarnessDefaults()
    const configuration = { harness: 'claude', model: 'explicit-model', authMode: 'subscription', configDirectory: f.db.directory,
      permissionMode: 'default', sandbox: 'danger-full-access', tools: [], permissionRules: [], instructions: 'Keep saved instructions.',
      mcpServers: { graphql: { type: 'http', url: 'http://127.0.0.1:3999/mcp' } } }
    const input = { commandId: randomUUID(), expectedRevision: original.revision, defaults: { ...original.defaults, claude: configuration } }
    const reader = await f.access.issue({ name: 'Claude setup reader', audience: 'operator', expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['harnesses:read'], scope: {} }] })
    const readClient = await connect(reader.token)
    expect(ClaudeSetupOptionsSchema.parse(result(await readClient.callTool({ name: 'claude_setup_options_get', arguments: {} })))).toEqual(setup)
    await expectMcpAccessDenied(readClient.callTool({ name: 'harness_defaults_update', arguments: input }))
    const denied = await fetch(new URL('/api/management/harnesses/defaults', address), { method: 'PUT',
      headers: { authorization: `Bearer ${reader.token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) })
    expect(denied.status).toBe(403)
    expect((await new PostgresSettingsRepository(f.db.pool).getManagedHarnessDefaults()).revision).toBe(original.revision)
    const external = { ...input, commandId: randomUUID(), defaults: { ...input.defaults, claude: {
      ...configuration, tools: ['mcp__external__lookup'],
      permissionRules: [{ tool: 'mcp__external__lookup', effect: 'allow' }],
      mcpServers: { external: { type: 'http', url: 'https://external.example/mcp' } },
    } } }
    const rejected = await client.callTool({ name: 'harness_defaults_update', arguments: external })
    expect(rejected).toMatchObject({ isError: true,
      content: [{ type: 'text', text: expect.stringContaining('External MCP servers are not supported') }] })
    const rejectedHttp = await fetch(new URL('/api/management/harnesses/defaults', address), { method: 'PUT',
      headers: { authorization: `Bearer ${f.writer.token}`, 'content-type': 'application/json' }, body: JSON.stringify(external) })
    expect(rejectedHttp.status).toBe(400)
    expect(await new PostgresSettingsRepository(f.db.pool).getManagedHarnessDefaults()).toEqual(original)
    const saved = HarnessDefaultsUpdateResultSchema.parse(result(await client.callTool({ name: 'harness_defaults_update', arguments: input })))
    expect(saved.value.defaults.claude).toEqual(configuration)
    expect(HarnessDefaultsUpdateResultSchema.parse(result(await client.callTool({ name: 'harness_defaults_update', arguments: input })))).toEqual({ ...saved, replayed: true })
    expect(result(await client.callTool({ name: 'harness_get', arguments: { harness: 'claude' } }))).toMatchObject({ defaults: configuration,
      defaultsRevision: saved.value.revision, capability: null, discoveryError: { code: 'CLAUDE_NATIVE_QUALIFICATION_UNAVAILABLE' } })
    const repairedConfiguration = { ...configuration, mcpServers: { graphql: setup.graphqlMcp } }
    const repair = {
      commandId: randomUUID(), expectedRevision: saved.value.revision,
      defaults: { ...saved.value.defaults, claude: repairedConfiguration },
    }
    await expectMcpAccessDenied(readClient.callTool({ name: 'harness_defaults_update', arguments: repair }))
    expect(await client.callTool({ name: 'harness_defaults_update', arguments: {
      ...repair, commandId: randomUUID(), expectedRevision: original.revision,
    } })).toMatchObject({ isError: true,
      content: [{ type: 'text', text: expect.stringContaining('REVISION_CONFLICT') }] })
    expect(await new PostgresSettingsRepository(f.db.pool).getManagedHarnessDefaults()).toMatchObject(saved.value)
    const repaired = HarnessDefaultsUpdateResultSchema.parse(result(await client.callTool({
      name: 'harness_defaults_update', arguments: repair,
    })))
    expect(repaired.value.revision).toBe(saved.value.revision + 1)
    expect(repaired.value.defaults).toEqual(repair.defaults)
    expect(await new PostgresSettingsRepository(f.db.pool).getManagedHarnessDefaults()).toMatchObject(repaired.value)
    expect(result(await readClient.callTool({ name: 'harness_get', arguments: { harness: 'claude' } })))
      .toMatchObject({ defaults: repairedConfiguration, defaultsRevision: repaired.value.revision })
    expect(HarnessDefaultsUpdateResultSchema.parse(result(await client.callTool({
      name: 'harness_defaults_update', arguments: repair,
    })))).toEqual({ ...repaired, replayed: true })
    expect(ExecutionReadinessSchema.parse(result(await client.callTool({ name: 'execution_readiness_get', arguments: { harness: 'claude' } })))).toMatchObject({
      status: 'blocked', defaultsRevision: repaired.value.revision, reason: { code: 'CLAUDE_NATIVE_QUALIFICATION_UNAVAILABLE' },
    })
    const none = await f.access.issue({ name: 'No Claude setup access', audience: 'operator', expiresAt: new Date(Date.now() + 600000), grants: [] })
    await expectMcpAccessDenied((await connect(none.token)).callTool({ name: 'claude_setup_options_get', arguments: {} }))
    const audit = await f.db.pool.query("select source,action from management_audit where principal_id=$1 and action='harness.defaults.update'", [f.writer.principal.id])
    expect(audit.rows).toContainEqual({ source: 'mcp', action: 'harness.defaults.update' })
  } finally { await Promise.allSettled(clients.map(client => client.close())); await app.close(); await catalog.shutdownChecks(); await f.close() }
}, 60000)

it.skipIf(!postgresEnabled)('keeps fresh Claude board defaults incomplete until an authorized explicit Full access save', async () => {
  const f = await currentOperatorIntegration()
  const repository = new PostgresSettingsRepository(f.db.pool)
  const catalog = new HarnessCatalogService(new NativeHarnessConfigurationQualifier('codex'),
    repository, f.commands, f.db.directory)
  const app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
    operator: { access: f.access, services: { ...f.services, harnesses: catalog,
      executionReadiness: new ExecutionReadinessService(new NativeRollout({}), catalog) } } })
  const clients: Client[] = []
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const connect = async (token: string) => {
    const client = new Client({ name: 'claude-defaults-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
    return client
  }
  const options = async (harness: HarnessOptions['harness']): Promise<HarnessOptions> => ({
    harness, providerVersion: 'unit-catalog', authenticated: true,
    models: [{ id: 'detected-model', defaultPriority: 0, reasoningEfforts: ['medium'], variants: [], serviceTiers: ['standard'] }],
    nativeAgents: ['build'], settings: [], restrictions: [], checkedAt: new Date().toISOString(),
  })
  try {
    // Only Claude requires discovery in this fixture; existing Codex defaults are explicit.
    await initializeNativeDefaults({ pool: f.db.pool, options, appMcpEndpoint: new URL('/mcp', address).href })
    const original = await repository.getManagedHarnessDefaults()
    expect(original.defaults.claude?.sandbox).toBe('read-only')
    expect(original.unavailable).toContain('claude')
    const client = await connect(f.writer.token)
    const reader = await f.access.issue({ name: 'Claude defaults reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 120_000), grants: [{ actions: ['harnesses:read'], scope: {} }] })
    const readClient = await connect(reader.token)
    expect(decodeMcpToolResult((await readClient.callTool({ name: 'harness_get', arguments: { harness: 'claude' } }))))
      .toMatchObject({ defaults: original.defaults.claude, capability: null,
        discoveryError: { code: 'CLAUDE_FULL_ACCESS_REQUIRED' } })
    expect(decodeMcpToolResult((await readClient.callTool({ name: 'execution_readiness_get', arguments: { harness: 'claude' } }))))
      .toMatchObject({ status: 'blocked', reason: { code: 'CLAUDE_FULL_ACCESS_REQUIRED' } })
    await initializeNativeDefaults({ pool: f.db.pool, options, appMcpEndpoint: new URL('/mcp', address).href })
    expect(await repository.getManagedHarnessDefaults()).toEqual(original)
    const input = { commandId: randomUUID(), expectedRevision: original.revision, configure: ['claude'],
      defaults: { ...original.defaults, claude: { ...original.defaults.claude!, sandbox: 'danger-full-access' } } }
    await expectMcpAccessDenied(readClient.callTool({ name: 'harness_defaults_update', arguments: input }))
    const unsupported = await client.callTool({ name: 'harness_defaults_update', arguments: {
      ...input, commandId: randomUUID(), defaults: original.defaults,
    } })
    expect(unsupported).toMatchObject({ isError: true,
      content: [{ type: 'text', text: expect.stringContaining('Claude requires Full access') }] })
    expect(await repository.getManagedHarnessDefaults()).toEqual(original)
    const saved = HarnessDefaultsUpdateResultSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'harness_defaults_update', arguments: input }))))
    expect(saved.value.defaults.claude?.sandbox).toBe('danger-full-access')
    expect((await repository.getManagedHarnessDefaults()).unavailable ?? []).not.toContain('claude')
    expect(decodeMcpToolResult((await readClient.callTool({ name: 'harness_get', arguments: { harness: 'claude' } }))))
      .toMatchObject({ defaults: saved.value.defaults.claude, defaultsRevision: saved.value.revision })
  } finally {
    await Promise.allSettled(clients.map(client => client.close()))
    await app.close()
    await catalog.shutdownChecks()
    await f.close()
  }
}, 60_000)

it.skipIf(!postgresEnabled)('saves other provider defaults through HTTP and MCP while preserving incomplete Claude access', async () => {
  const f = await currentOperatorIntegration()
  const repository = new PostgresSettingsRepository(f.db.pool)
  const options = async (harness: HarnessOptions['harness']): Promise<HarnessOptions> => ({
    harness, providerVersion: 'fixture', authenticated: true,
    models: [{ id: 'detected-model', defaultPriority: 0, reasoningEfforts: ['medium'], variants: [], serviceTiers: ['standard'] }],
    nativeAgents: ['build'], settings: [], restrictions: [], checkedAt: new Date().toISOString(),
  })
  try {
    await initializeNativeDefaults({ pool: f.db.pool, options, appMcpEndpoint: new URL('/mcp', f.address).href })
    const original = await repository.getManagedHarnessDefaults()
    expect(original.defaults.claude?.sandbox).toBe('read-only')
    expect(original.unavailable).toContain('claude')
    const reader = await f.access.issue({ name: 'Defaults reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 120_000), grants: [{ actions: ['harnesses:read'], scope: {} }] })
    const readClient = await f.connect(reader.token)
    const input = { commandId: randomUUID(), expectedRevision: original.revision, configure: ['codex'],
      defaults: { ...original.defaults, codex: { ...original.defaults.codex, sandbox: 'workspace-write' } } }
    await expectMcpAccessDenied(readClient.callTool({ name: 'harness_defaults_update', arguments: input }))
    expect(await repository.getManagedHarnessDefaults()).toEqual(original)
    const saved = HarnessDefaultsUpdateResultSchema.parse(decodeMcpToolResult((await f.client.callTool({
      name: 'harness_defaults_update', arguments: input,
    }))))
    expect(saved.value.defaults.codex.sandbox).toBe('workspace-write')
    expect(saved.value.defaults.claude).toEqual(original.defaults.claude)
    expect((await repository.getManagedHarnessDefaults()).unavailable).toContain('claude')
    expect(HarnessDefaultsUpdateResultSchema.parse(decodeMcpToolResult((await f.client.callTool({
      name: 'harness_defaults_update', arguments: input,
    }))))).toEqual({ ...saved, replayed: true })
    const http = await fetch(new URL('/api/management/harnesses/defaults', f.address), { method: 'PUT',
      headers: { authorization: `Bearer ${f.writer.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: randomUUID(), expectedRevision: saved.value.revision, configure: ['codex'],
        defaults: { ...saved.value.defaults, codex: { ...saved.value.defaults.codex, model: 'http-selected-model' } } }),
    })
    expect(http.status).toBe(200)
    const httpSaved = HarnessDefaultsUpdateResultSchema.parse(await http.json())
    expect(httpSaved.value.defaults.codex.model).toBe('http-selected-model')
    const persisted = await repository.getManagedHarnessDefaults()
    expect(persisted.defaults).toEqual(httpSaved.value.defaults)
    expect(persisted.defaults.claude).toEqual(original.defaults.claude)
    expect(persisted.unavailable).toContain('claude')
    expect(decodeMcpToolResult((await readClient.callTool({ name: 'harness_get', arguments: { harness: 'claude' } }))))
      .toMatchObject({ defaults: original.defaults.claude, defaultsRevision: persisted.revision,
        capability: null, discoveryError: { code: 'CLAUDE_FULL_ACCESS_REQUIRED' } })
    for (const claude of [
      { ...original.defaults.claude!, model: 'edited-restricted-model' },
      { ...original.defaults.claude!, sandbox: 'danger-full-access',
        mcpServers: { external: { type: 'http', url: 'https://external.example/mcp' } } },
    ]) {
      const rejected = await f.client.callTool({ name: 'harness_defaults_update', arguments: {
        commandId: randomUUID(), expectedRevision: persisted.revision,
        defaults: { ...persisted.defaults, claude },
      } })
      expect(rejected).toMatchObject({ isError: true,
        content: [{ type: 'text', text: expect.stringMatching(/CLAUDE_FULL_ACCESS_REQUIRED|CLAUDE_EXTERNAL_MCP_UNSUPPORTED/) }] })
      expect(await repository.getManagedHarnessDefaults()).toEqual(persisted)
    }
  } finally { await f.close() }
}, 60_000)
