import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { createFixtureSchema, dropFixtureSchema, removeFixtureDirectory } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { ExecutionReadinessSchema, HarnessCatalogEntrySchema, HarnessDefaultsUpdateResultSchema } from '@foreman-code/contracts/management'
import { HostHarnessOverrideListSchema, HostHarnessOverrideSaveResultSchema, type HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import { loadConfig } from '../src/config.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import { ProductionHarnessRegistry } from '../src/modules/harnesses/productionRegistry.js'
import { NativeHarnessFactories } from '../src/modules/harnesses/runtimeFactory.js'
import { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'
import { buildProductionApp } from '../src/production.js'

it('saves Claude templates through authenticated MCP while unavailable API-key delivery blocks qualification and preserves historical proof', async () => {
  const connectionString = process.env.HRT_F14_ADMIN_DATABASE_URL
  if (!connectionString || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('Requires an explicit loopback HRT_F14_ADMIN_DATABASE_URL; only a fresh owned schema is modified.')
  }
  const admin = new pg.Pool({ connectionString })
  const schema = `hrt_f14_${randomUUID().replaceAll('-', '')}`
  await createFixtureSchema(admin, schema)
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
  const root = await mkdtemp(join(tmpdir(), 'hrt-f14-'))
  const config = loadConfig({ DATABASE_URL: connectionString, HARNESS_WORKSPACE_ROOT: root })
  config.harnesses.workspaceRoot = root
  config.fileStorageRoot = join(root, 'files')
  config.workspaceStorageRoot = join(root, 'workspaces')
  const checkpoints = createCheckpointStore(connectionString, schema, config.database)
  const database = { pool, migrate: () => applyApplicationMigrations(pool), ping: async () => { await pool.query('select 1') }, close: () => pool.end() }
  const clients: Client[] = []
  let production: ReturnType<typeof buildProductionApp> | undefined
  vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-inherited-key')
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('HOST', '127.0.0.1')
  const allocation = vi.spyOn(NativeHarnessFactories.prototype, 'allocateAdmittedClaude')
  try {
    await database.migrate()
    const mainId = (await pool.query('select id from application_installation')).rows[0].id as string
    const harness = { harness: 'claude' as const, model: 'recorded-model', authMode: 'api-key' as const,
      configDirectory: join(root, 'recorded-profile'), permissionMode: 'default' as const, sandbox: 'danger-full-access' as const,
      tools: [], permissionRules: [], instructions: '', mcpServers: {} }
    // Historical persisted settings/native-proof fixtures are not physical qualification.
    await new PostgresSettingsRepository(pool).saveHarnessDefaults({ ...DEFAULT_HARNESS_DEFAULTS, claude: harness })
    const access = new PostgresAccessService(pool)
    const writer = await access.issue({ name: 'F14 writer', audience: 'operator', grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const reader = await access.issue({ name: 'F14 reader', audience: 'operator', grants: [{ actions: ['harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    production = buildProductionApp(config, database, checkpoints, false)
    const address = await production.app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'hrt-f14', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const allowed = await connect(writer.token), denied = await connect(reader.token)
    expect((await denied.listTools()).tools.map(tool => tool.name)).not.toContain('harness_instance_check')
    const deniedCheck = await denied.callTool({ name: 'harness_instance_check', arguments: {} })
    expect(deniedCheck).toMatchObject({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: {
      code: 'ACCESS_DENIED', message: 'The caller is not authorized for this host harness operation.',
    } }) }] })
    expect((await pool.query(`select principal_id,source,action,target_key,outcome from management_audit
      where principal_id=$1 and action='harness_instance_check'`, [reader.principal.id])).rows).toEqual([{
      principal_id: reader.principal.id, source: 'mcp', action: 'harness_instance_check',
      target_key: 'mcp:harness_instance_check', outcome: 'denied',
    }])
    const readiness = ExecutionReadinessSchema.parse(decodeMcpToolResult((await denied.callTool({ name: 'execution_readiness_get', arguments: { harness: 'claude' } }))))
    expect.soft(readiness).toMatchObject({ status: 'blocked', defaultsRevision: 1,
      reason: { code: 'CLAUDE_API_KEY_DELIVERY_UNAVAILABLE', message: expect.stringContaining('managed Claude account') } })
    const httpReadiness = await production.app.inject({ method: 'GET', url: '/api/management/harnesses/claude/execution-readiness', headers: { authorization: `Bearer ${reader.token}` } })
    expect(httpReadiness.statusCode).toBe(200)
    expect(ExecutionReadinessSchema.parse(httpReadiness.json())).toMatchObject({ status: readiness.status, defaultsRevision: readiness.defaultsRevision, reason: readiness.reason })
    const catalog = HarnessCatalogEntrySchema.parse(decodeMcpToolResult((await denied.callTool({ name: 'harness_get', arguments: { harness: 'claude' } }))))
    expect(catalog.defaults).toEqual(harness)
    expect.soft(catalog).toMatchObject({ capability: null, discoveryError: { code: 'CLAUDE_API_KEY_DELIVERY_UNAVAILABLE' } })
    const proposed = await denied.callTool({ name: 'harness_configuration_check', arguments: { configuration: harness } })
    expect(proposed.isError).toBe(true)
    expect(JSON.stringify(proposed.content)).toContain('CLAUDE_API_KEY_DELIVERY_UNAVAILABLE')
    const updateInput = { commandId: randomUUID(), expectedRevision: 1,
      defaults: { ...DEFAULT_HARNESS_DEFAULTS, claude: { ...harness, model: 'changed' } } }
    expect((await denied.listTools()).tools.map(tool => tool.name)).not.toContain('harness_defaults_update')
    const deniedMcpUpdate = await denied.callTool({ name: 'harness_defaults_update', arguments: updateInput })
    expect(deniedMcpUpdate.isError).toBe(true)
    expect(JSON.stringify(deniedMcpUpdate.content)).toContain('ACCESS_DENIED')
    const deniedUpdate = await production.app.inject({ method: 'PUT', url: '/api/management/harnesses/defaults',
      headers: { authorization: `Bearer ${reader.token}` }, payload: updateInput })
    expect(deniedUpdate.statusCode).toBe(403)
    expect(await new PostgresSettingsRepository(pool).getManagedHarnessDefaults()).toMatchObject({ revision: 1, defaults: { claude: harness } })
    // Preset persistence is independent of exact-host native qualification.
    const defaultsUpdate = await allowed.callTool({ name: 'harness_defaults_update', arguments: updateInput })
    expect(defaultsUpdate.isError).not.toBe(true)
    const updated = HarnessDefaultsUpdateResultSchema.parse(decodeMcpToolResult(defaultsUpdate))
    expect(updated).toEqual({ value: { revision: 2, defaults: updateInput.defaults }, replayed: false })
    expect(HarnessDefaultsUpdateResultSchema.parse(decodeMcpToolResult((await allowed.callTool({ name: 'harness_defaults_update', arguments: updateInput })))))
      .toEqual({ ...updated, replayed: true })
    const staleUpdate = await allowed.callTool({ name: 'harness_defaults_update', arguments: { ...updateInput, commandId: randomUUID() } })
    expect(staleUpdate.isError).toBe(true)
    expect(JSON.stringify(staleUpdate.content)).toContain('REVISION_CONFLICT')
    expect(await new PostgresSettingsRepository(pool).getManagedHarnessDefaults()).toEqual(updated.value)
    expect(HarnessCatalogEntrySchema.parse(decodeMcpToolResult((await denied.callTool({ name: 'harness_get', arguments: { harness: 'claude' } })))))
      .toMatchObject({ defaults: updateInput.defaults.claude, defaultsRevision: 2, capability: null,
        discoveryError: { code: 'CLAUDE_API_KEY_DELIVERY_UNAVAILABLE' } })
    expect(ExecutionReadinessSchema.parse(decodeMcpToolResult((await denied.callTool({ name: 'execution_readiness_get', arguments: { harness: 'claude' } })))))
      .toMatchObject({ status: 'blocked', defaultsRevision: 2, reason: { code: 'CLAUDE_API_KEY_DELIVERY_UNAVAILABLE' } })
    expect((await pool.query("select source,action,outcome from management_audit where principal_id=$1 and action='harness.defaults.update'",
      [writer.principal.id])).rows).toContainEqual({ source: 'mcp', action: 'harness.defaults.update', outcome: 'succeeded' })
    const target = { hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
      harnessInstallationId: 'recorded-cli', installationFingerprint: 'recorded-payload' }
    const saved = HostHarnessOverrideSaveResultSchema.parse(decodeMcpToolResult((await allowed.callTool({ name: 'harness_instance_save', arguments: {
      commandId: randomUUID(), instanceId: randomUUID(), expectedRevision: 0, target, presetId: 'recorded', enabled: true, configuration: harness,
    } }))))
    expect(saved.value.qualification).toBe('unqualified')
    const proof: HostHarnessProfileEvidence = { target, instanceRevision: saved.value.instanceRevision,
      configurationFingerprint: saved.value.configurationFingerprint, driverId: 'claude', driverRevision: 'recorded',
      protocolRevision: 'recorded', suiteRevision: 'recorded', environmentGeneration: 'recorded', connectionGeneration: 'recorded',
      authenticated: true, compatible: true, qualified: true, checkedAt: new Date().toISOString() }
    const proofs = new HostHarnessProfileEvidenceRepository(pool)
    const proofClient = await pool.connect()
    try { await proofs.append(proofClient, randomUUID(), saved.value, proof) } finally { proofClient.release() }
    // Replay the existing exact-profile evidence resolver to isolate the missing delivery gate.
    const readProof = vi.spyOn(ProductionHarnessRegistry.prototype, 'profileEvidence').mockImplementation((value, client) => proofs.latest(value.instanceId, value.revision, client))
    const listInput = { hostRef: target.hostRef, applicationInstallationId: mainId }
    const listed = HostHarnessOverrideListSchema.parse(decodeMcpToolResult((await denied.callTool({ name: 'harness_instances_list', arguments: listInput }))))
    expect.soft(listed.overrides[0]).toMatchObject({ revision: 1, configuration: harness, qualification: 'unqualified' })
    const checked = await allowed.callTool({ name: 'harness_instance_check', arguments: {
      commandId: randomUUID(), instanceId: saved.value.instanceId, expectedRevision: 1, target,
    } })
    expect(checked.isError).toBe(true)
    expect.soft(JSON.stringify(checked.content)).toContain('CLAUDE_API_KEY_DELIVERY_UNAVAILABLE')
    expect.soft(readProof).not.toHaveBeenCalled()
    expect(allocation).not.toHaveBeenCalled()
    // Cold repository reads retain the exact original saved revision and historical facts.
    expect(await new HarnessInstanceSettingsRepository(pool).readAuthorized(client => new HarnessInstanceSettingsRepository(pool).latest(client, saved.value.instanceId))).toEqual(saved.value)
    expect(await new HostHarnessProfileEvidenceRepository(pool).latest(saved.value.instanceId, 1)).toEqual(proof)
    expect((await pool.query('select count(*)::int as count from harness_instance_profile_evidence')).rows[0].count).toBe(1)
    expect(JSON.stringify((await pool.query('select record from harness_instance_settings')).rows)).not.toContain('synthetic-inherited-key')
    expect(JSON.stringify((await pool.query('select record from application_settings')).rows)).not.toContain('synthetic-inherited-key')
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await production?.app.close(); await checkpoints.close(); await pool.end()
    await dropFixtureSchema(admin, schema); await admin.end()
    await removeFixtureDirectory(root)
    vi.restoreAllMocks(); vi.unstubAllEnvs()
  }
}, 60_000)
