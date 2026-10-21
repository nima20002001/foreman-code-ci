import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { HostHarnessOverrideListSchema, HostHarnessOverrideSaveResultSchema, HostHarnessInstanceCheckResultSchema, type HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { applyApplicationMigrations, migrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { authorizeDeviceHost } from '../src/modules/devices/hostAuthorization.js'
import { deviceIdentityMigration } from '../src/modules/devices/migration.js'
import { harnessInstanceSettingsMigration } from '../src/modules/harnesses/instanceSettings/migration.js'
import { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import { HostHarnessInstanceProfileChecks } from '../src/modules/harnesses/instanceSettings/profileChecks.js'
import { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { harnessInstanceProfileEvidenceMigration } from '../src/modules/harnesses/instanceSettings/profileMigration.js'
import { HostHarnessOverrideService } from '../src/modules/harnesses/instanceSettings/service.js'
import { CLAUDE_FULL_ACCESS_REQUIRED } from '@foreman-code/contracts/claude'

const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL! })
const schema = `harness_instances_${randomUUID().replaceAll('-', '')}`
const pool = new pg.Pool({ ...admin.options, options: `-c search_path=${schema}` })
beforeAll(async () => {
  await createFixtureSchema(admin, schema)
  await applyApplicationMigrations(pool)
}, 60_000)
afterAll(async () => {
  await pool.end()
  try { await dropFixtureSchema(admin, schema) } finally { await admin.end() }
}, 60_000)

it('refuses non-full Claude host profiles and persists explicit Full access through authenticated MCP', async () => {
  const scenarioSchema = `claude_access_${randomUUID().replaceAll('-', '')}`
  await createFixtureSchema(admin, scenarioSchema)
  const scenarioPool = new pg.Pool({ ...admin.options, options: `-c search_path=${scenarioSchema}` })
  const access = new PostgresAccessService(scenarioPool)
  const commands = new PostgresCommandCoordinator(scenarioPool)
  const repository = new HarnessInstanceSettingsRepository(scenarioPool)
  const authority = { authorize: async (principal: import('@foreman-code/contracts/management').ManagementPrincipal,
    action: 'harnesses:read' | 'harnesses:update', host: import('@foreman-code/contracts/device-identity').CanonicalMachineReference,
    installation: string, client?: pg.PoolClient) => {
    if (!client) throw new Error('Host authorization requires its settings transaction')
    await authorizeDeviceHost(client, principal, action, host, installation)
  } }
  const service = new HostHarnessOverrideService(repository, commands, authority, async () => null)
  const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, harnessInstances: service } as unknown as OperatorServices } })
  const clients: Client[] = []
  const principals: string[] = []
  try {
    await applyApplicationMigrations(scenarioPool)
    const mainId = (await scenarioPool.query('select id from application_installation')).rows[0].id as string
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (actions: import('@foreman-code/contracts/management').ManagementAction[]) => {
      const issued = await access.issue({ name: 'Claude host access test', audience: 'operator',
        grants: [{ actions, scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
      principals.push(issued.principal.id)
      const client = new Client({ name: 'claude-host-access-test', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => issued.token } }))
      return client
    }
    const writer = await connect(['harnesses:read', 'harnesses:update'])
    const reader = await connect(['harnesses:read'])
    const instanceId = randomUUID()
    const target = { hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
      harnessInstallationId: 'recorded-claude-sdk', installationFingerprint: 'recorded-payload' }
    const configuration = { harness: 'claude', model: 'recorded-model', authMode: 'subscription',
      configDirectory: '/recorded/profile', permissionMode: 'default', sandbox: 'danger-full-access',
      tools: ['Write'], permissionRules: [], instructions: '', mcpServers: {} }
    const args = { commandId: randomUUID(), instanceId, expectedRevision: 0, target,
      presetId: 'recorded-full-access', enabled: true, configuration }
    const denied = await reader.callTool({ name: 'harness_instance_save', arguments: args })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    for (const sandbox of ['read-only', 'workspace-write']) {
      const rejected = await writer.callTool({ name: 'harness_instance_save', arguments: {
        ...args, commandId: randomUUID(), configuration: { ...configuration, sandbox },
      } })
      expect(rejected.isError).toBe(true)
      expect(JSON.stringify(rejected.content)).toContain(CLAUDE_FULL_ACCESS_REQUIRED)
    }
    expect((await scenarioPool.query('select instance_id from harness_instance_settings where instance_id=$1', [instanceId])).rows).toEqual([])
    const saved = HostHarnessOverrideSaveResultSchema.parse(decodeMcpToolResult((await writer.callTool({ name: 'harness_instance_save', arguments: args }))))
    expect(saved.value.configuration).toEqual(configuration)
    const readback = HostHarnessOverrideListSchema.parse(decodeMcpToolResult((await reader.callTool({ name: 'harness_instances_list', arguments: {
      hostRef: target.hostRef, applicationInstallationId: mainId,
    } }))))
    expect(readback.overrides.find(item => item.instanceId === instanceId)?.configuration).toEqual(configuration)
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await app.close()
    for (const id of principals) await access.revoke(id)
    await scenarioPool.end()
    await dropFixtureSchema(admin, scenarioSchema)
  }
}, 60_000)

it('persists host overrides through authenticated MCP with denial, CAS, replay, cold readback and canonical revocation', async () => {
  let app: ReturnType<typeof buildApp> | undefined
  const clients: Client[] = []
  try {
    if (!(await pool.query("select to_regclass('device_registrations') as relation")).rows[0]?.relation) await pool.query(deviceIdentityMigration.sql)
    expect(migrations.some(migration => migration.version === harnessInstanceSettingsMigration.version)).toBe(true)
    expect((await pool.query("select to_regclass('harness_instance_settings') as relation")).rows[0]?.relation).toBeTruthy()
    expect(migrations.some(migration => migration.version === harnessInstanceProfileEvidenceMigration.version)).toBe(true)
    const mainId = (await pool.query('select id from application_installation')).rows[0].id as string
    const deviceId = randomUUID(), workerInstallationId = randomUUID()
    const registration = { mainId, deviceId, workerInstallationId, publicKeyFingerprint: 'a'.repeat(64), keyRevision: 1, authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'] }
    await pool.query('insert into device_registrations(id,main_id,worker_installation_id,public_key,record) values($1,$2,$3,$4,$5::jsonb)', [deviceId, mainId, workerInstallationId, 'fixture-public-key', JSON.stringify(registration)])
    const access = new PostgresAccessService(pool), commands = new PostgresCommandCoordinator(pool)
    const settings = new HarnessInstanceSettingsRepository(pool), proofs = new HostHarnessProfileEvidenceRepository(pool)
    const authority = { authorize: async (principal: import('@foreman-code/contracts/management').ManagementPrincipal, action: 'harnesses:read' | 'harnesses:update', host: import('@foreman-code/contracts/device-identity').CanonicalMachineReference, installation: string, client?: pg.PoolClient) => {
      if (!client) throw new Error('Host authorization must share settings transaction.')
      await authorizeDeviceHost(client, principal, action, host, installation)
    } }
    let currentEnvironment = 'fixture-env-1'
    // Typed native-port replay: tests HTTP/MCP admission and persistence, never qualifies a physical CLI.
    const nativeReplay = vi.fn(async (value: import('@foreman-code/contracts/harness-registry').HostHarnessOverride, input: { checkId: string; signal: AbortSignal }): Promise<HostHarnessProfileEvidence> => {
      input.signal.throwIfAborted()
      return { target: value.target, instanceRevision: value.instanceRevision, configurationFingerprint: value.configurationFingerprint,
        driverId: value.driverId, driverRevision: 'fixture-driver', protocolRevision: 'fixture-protocol', suiteRevision: 'fixture-suite',
        environmentGeneration: currentEnvironment, connectionGeneration: 'fixture-connection', authenticated: true, compatible: true, qualified: true, checkedAt: new Date().toISOString() }
    })
    const createService = () => new HostHarnessOverrideService(settings, commands, authority, async (value, client?: pg.PoolClient) => {
      const proof = await proofs.latest(value.instanceId, value.revision, client)
      if (!proof) return null
      return { target: proof.target, configurationFingerprint: proof.configurationFingerprint,
        qualified: proof.authenticated === true && proof.compatible === true && proof.qualified === true && proof.driverId === value.driverId
          && proof.driverRevision === 'fixture-driver' && proof.protocolRevision === 'fixture-protocol' && proof.suiteRevision === 'fixture-suite'
          && proof.environmentGeneration === currentEnvironment && proof.connectionGeneration === 'fixture-connection' }
    }, new HostHarnessInstanceProfileChecks(settings, proofs, commands, authority, { qualify: nativeReplay }))
    let service = createService()
    const services = { commands, harnessInstances: {
      list: (...args: Parameters<HostHarnessOverrideService['list']>) => service.list(...args),
      save: (...args: Parameters<HostHarnessOverrideService['save']>) => service.save(...args),
      check: (...args: Parameters<HostHarnessOverrideService['check']>) => service.check(...args),
      get qualificationSupported() { return service.qualificationSupported },
    } } as unknown as OperatorServices
    app = buildApp({ logger: false, readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } }, operator: { access, services } })
    app.addHook('onClose', async () => { await service.closeChecks() })
    const owner = await access.issue({ name: 'writer', audience: 'operator', grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const reader = await access.issue({ name: 'reader', audience: 'operator', grants: [{ actions: ['harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => { const client = new Client({ name: 'host-instance-mcp', version: '1' }); clients.push(client); await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } })); return client }
    const writer = await connect(owner.token), denied = await connect(reader.token)
    expect((await writer.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['harness_instances_list', 'harness_instance_save', 'harness_instance_check']))
    expect((await denied.listTools()).tools.map(tool => tool.name)).not.toContain('harness_instance_save')
    const deniedSave = await denied.callTool({ name: 'harness_instance_save', arguments: {} })
    expect(deniedSave.isError).toBe(true)
    expect(JSON.stringify(deniedSave.content)).toContain('ACCESS_DENIED')
    expect((await pool.query("select principal_id,action from management_audit where outcome='denied' and source='mcp' and action='harness_instance_save'")).rows)
      .toEqual([{ principal_id: reader.principal.id, action: 'harness_instance_save' }])
    expect((await pool.query('select count(*)::int as count from harness_instance_settings')).rows[0].count).toBe(0)
    const hostRef = { kind: 'device', mainId, deviceId }
    const args = { commandId: randomUUID(), instanceId: randomUUID(), expectedRevision: 0, target: { hostRef, applicationInstallationId: workerInstallationId, harnessInstallationId: 'codex-native', installationFingerprint: 'sha' }, presetId: 'local-default:codex', enabled: true,
      configuration: { harness: 'codex', model: 'test', reasoningEffort: 'high', sandbox: 'read-only', serviceTier: 'standard' } }
    const first = HostHarnessOverrideSaveResultSchema.parse(decodeMcpToolResult((await writer.callTool({ name: 'harness_instance_save', arguments: args }))))
    expect(first).toMatchObject({ replayed: false, value: { revision: 1, qualification: 'unqualified' } })
    const replay = HostHarnessOverrideSaveResultSchema.parse(decodeMcpToolResult((await writer.callTool({ name: 'harness_instance_save', arguments: args }))))
    expect(replay.value).toEqual(first.value); expect(replay.replayed).toBe(true)
    const secondArgs = { ...args, commandId: randomUUID(), expectedRevision: 1, configuration: { ...args.configuration, model: 'changed' } }
    expect(HostHarnessOverrideSaveResultSchema.parse(decodeMcpToolResult((await writer.callTool({ name: 'harness_instance_save', arguments: secondArgs })))).value.revision).toBe(2)
    expect((await writer.callTool({ name: 'harness_instance_save', arguments: { ...secondArgs, commandId: randomUUID() } })).isError).toBe(true)
    expect((await writer.callTool({ name: 'harness_instance_save', arguments: { ...secondArgs, commandId: randomUUID(), expectedRevision: 2, target: { ...args.target, hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId } } })).isError).toBe(true)
    expect((await pool.query('select count(*)::int as count from harness_instance_settings')).rows[0].count).toBe(2)
    const listInput = { hostRef, applicationInstallationId: workerInstallationId }
    await service.closeChecks()
    service = createService()
    const listed = HostHarnessOverrideListSchema.parse(decodeMcpToolResult((await denied.callTool({ name: 'harness_instances_list', arguments: listInput }))))
    expect(listed.overrides[0]).toMatchObject({ revision: 2, configuration: { model: 'changed' }, qualification: 'unqualified' })
    const checkInput = { commandId: randomUUID(), instanceId: args.instanceId, expectedRevision: 2, target: args.target }
    const checked = HostHarnessInstanceCheckResultSchema.parse(decodeMcpToolResult((await writer.callTool({ name: 'harness_instance_check', arguments: checkInput }))))
    expect(checked).toMatchObject({ replayed: false, value: { revision: 2, qualification: 'qualified' }, proof: { instanceRevision: '2', qualified: true } })
    expect(HostHarnessInstanceCheckResultSchema.parse(decodeMcpToolResult((await writer.callTool({ name: 'harness_instance_check', arguments: checkInput })))).replayed).toBe(true)
    expect(nativeReplay).toHaveBeenCalledTimes(1)
    expect((await pool.query('select count(*)::int as count from harness_instance_profile_evidence')).rows[0].count).toBe(1)
    expect((await denied.callTool({ name: 'harness_instance_check', arguments: checkInput })).isError).toBe(true)
    currentEnvironment = 'fixture-env-2'
    expect(HostHarnessOverrideListSchema.parse(decodeMcpToolResult((await denied.callTool({ name: 'harness_instances_list', arguments: listInput })))).overrides[0]?.qualification).toBe('unqualified')
    expect(nativeReplay).toHaveBeenCalledTimes(1) // Reading stale evidence never starts a replacement native check.
    expect((await denied.callTool({ name: 'harness_instance_save', arguments: args })).isError).toBe(true)
    expect((await pool.query("select count(*)::int as count from management_audit where outcome='denied' and source='mcp' and action='harness_instance_save'")).rows[0].count).toBe(2)
    expect((await writer.callTool({ name: 'harness_instance_save', arguments: { ...args, commandId: randomUUID(), instanceId: randomUUID(), target: { ...args.target, applicationInstallationId: randomUUID() } } })).isError).toBe(true)
    const claudeArgs = { ...args, commandId: randomUUID(), instanceId: randomUUID(), expectedRevision: 0,
      presetId: 'claude', target: { ...args.target, harnessInstallationId: 'claude-sdk' },
      configuration: { harness: 'claude', model: 'profile-model', authMode: 'subscription',
        configDirectory: '/worker/profile', permissionMode: 'default', sandbox: 'danger-full-access', tools: [], permissionRules: [],
        instructions: '', mcpServers: {} } }
    const claudeSaved = HostHarnessOverrideSaveResultSchema.parse(decodeMcpToolResult((await writer.callTool({
      name: 'harness_instance_save', arguments: claudeArgs }))))
    const claudeCheck = { commandId: randomUUID(), instanceId: claudeSaved.value.instanceId,
      expectedRevision: claudeSaved.value.revision, target: claudeSaved.value.target }
    expect((await denied.callTool({ name: 'harness_instance_check', arguments: claudeCheck })).isError).toBe(true)
    expect(nativeReplay).toHaveBeenCalledTimes(1)
    const claudeChecked = HostHarnessInstanceCheckResultSchema.parse(decodeMcpToolResult((await writer.callTool({
      name: 'harness_instance_check', arguments: claudeCheck }))))
    expect(claudeChecked).toMatchObject({ value: { configuration: { harness: 'claude' }, qualification: 'qualified' },
      proof: { driverId: 'claude', target: claudeArgs.target } })
    await service.closeChecks()
    service = createService()
    const cold = HostHarnessOverrideListSchema.parse(decodeMcpToolResult((await denied.callTool({
      name: 'harness_instances_list', arguments: listInput }))))
    expect(cold.overrides.find(value => value.instanceId === claudeArgs.instanceId)).toEqual(claudeChecked.value)
    expect(nativeReplay).toHaveBeenCalledTimes(2)
    await pool.query('update device_registrations set record=$2::jsonb where id=$1', [deviceId, JSON.stringify({ ...registration, status: 'revoked', authorizationRevision: 2 })])
    expect((await writer.callTool({ name: 'harness_instance_save', arguments: args })).isError).toBe(true)
    expect((await denied.callTool({ name: 'harness_instances_list', arguments: listInput })).isError).toBe(true)
    expect((await pool.query('select count(*)::int as count from harness_instance_settings')).rows[0].count).toBe(3)
    expect(JSON.stringify((await pool.query('select record from harness_instance_settings')).rows)).not.toContain('credential')
  } finally {
    await Promise.all(clients.map(client => client.close())); await app?.close()
  }
})
