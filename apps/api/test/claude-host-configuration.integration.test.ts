import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it, vi } from 'vitest'
import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts'
import { HarnessCatalogEntrySchema, HarnessDefaultsUpdateResultSchema, type ManagementAction, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { HarnessRegistryReadbackSchema, HostHarnessOverrideSaveResultSchema,
  HostHarnessInstanceCheckResultSchema, HostHarnessOverrideListSchema,
  type HostHarnessOverride, type HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { authorizeDeviceHost } from '../src/modules/devices/hostAuthorization.js'
import { HarnessCatalogService } from '../src/modules/harnesses/catalog.js'
import { ProductionHarnessRegistry } from '../src/modules/harnesses/productionRegistry.js'
import { CLAUDE_PROFILE_CHECK_REVISION } from '../src/modules/harnesses/claudeSdk/profileRevision.js'
import { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { HostHarnessInstanceProfileChecks } from '../src/modules/harnesses/instanceSettings/profileChecks.js'
import { HostHarnessOverrideService } from '../src/modules/harnesses/instanceSettings/service.js'
import { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { DomainError } from '../src/modules/errors.js'

it('discovers a saved Claude preset and configures and checks its host profile through authenticated HTTP and MCP', async () => {
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL! })
  const schema = `claude_host_${randomUUID().replaceAll('-', '')}`
  const pool = new pg.Pool({ ...admin.options, options: `-c search_path=${schema}` })
  const clients: Client[] = []
  let app: ReturnType<typeof buildApp> | undefined
  let registry: ProductionHarnessRegistry | undefined
  let service: HostHarnessOverrideService | undefined
  let catalog: HarnessCatalogService | undefined
  try {
    await createFixtureSchema(admin, schema)
    await applyApplicationMigrations(pool)
    const mainId = (await pool.query('select id from application_installation')).rows[0].id as string
    const hostRef = { kind: 'main' as const, mainId }
    const access = new PostgresAccessService(pool)
    const commands = new PostgresCommandCoordinator(pool)
    const settings = new PostgresSettingsRepository(pool)
    const profiles = new HostHarnessProfileEvidenceRepository(pool)
    const instances = new HarnessInstanceSettingsRepository(pool)
    // Replay the native boundary; registry, authorization, transport and persistence are real.
    const discovery: NonNullable<ConstructorParameters<typeof ProductionHarnessRegistry>[6]> = {
      launcher: async (requested, environment) => ({ requested, resolvedLauncher: null, fingerprint: null,
        status: 'missing', interpreter: null, diagnostics: [], environment, checkedAt: new Date().toISOString() }),
      payloads: async () => ({ complete: false, paths: [] }),
      claude: vi.fn(async (_host, environment) => ({ sdkVersion: '0.3.284', sdkIntegrity: 'recorded-integrity',
        declaration: { harnessInstallationId: 'recorded-sdk', requestedLauncher: '/recorded/claude',
          payloadPaths: ['/recorded/sdk.mjs'], driverId: 'claude', driverRevision: '1',
          protocolRevision: 'claude-sdk-0.3.284' },
        launcher: { requested: '/recorded/claude', resolvedLauncher: '/recorded/claude',
          fingerprint: 'recorded-payload', status: 'installed' as const, interpreter: null,
          diagnostics: [], environment, checkedAt: new Date().toISOString() },
      })),
    }
    registry = new ProductionHarnessRegistry(pool, { codexBinary: 'codex',  },
      client => settings.getManagedHarnessDefaults(client), profiles, () => null, { PATH: '/recorded' }, discovery)
    await registry.initialize(mainId)
    const authority = { authorize: async (principal: ManagementPrincipal,
      action: 'harnesses:read' | 'harnesses:update', host: CanonicalMachineReference,
      installation: string, client?: pg.PoolClient) => {
      if (!client) throw new Error('Host authorization requires the settings transaction.')
      await authorizeDeviceHost(client, principal, action, host, installation)
    } }
    const qualify = vi.fn(async (value: HostHarnessOverride): Promise<HostHarnessProfileEvidence> => {
      const installation = registry!.installations.list().find(item => item.driverId === 'claude')!
      return { target: value.target, instanceRevision: value.instanceRevision,
        configurationFingerprint: value.configurationFingerprint, driverId: 'claude',
        driverRevision: installation.driverRevision, protocolRevision: installation.protocolRevision,
        environmentGeneration: installation.environmentGeneration, connectionGeneration: installation.connectionGeneration,
        suiteRevision: CLAUDE_PROFILE_CHECK_REVISION, authenticated: true, compatible: true,
        qualified: true, checkedAt: new Date().toISOString() }
    })
    service = new HostHarnessOverrideService(instances, commands, authority,
      (value, client) => registry!.profileEvidence(value, client),
      new HostHarnessInstanceProfileChecks(instances, profiles, commands, authority, { qualify }))
    const inspectConfiguration = vi.fn(async () => {
      throw new DomainError('HARNESS_CHECK_TIMEOUT', 'The native check timed out.', 503)
    })
    catalog = new HarnessCatalogService({ qualify: inspectConfiguration },
      settings, commands, '/recorded/checks')
    app = buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { commands, harnesses: catalog, harnessRegistry: registry,
        harnessInstances: service } as unknown as OperatorServices } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (actions: ManagementAction[]) => {
      const issued = await access.issue({ name: 'Claude configuration test', audience: 'operator',
        grants: actions.length ? [{ actions, scope: {} }] : [], expiresAt: new Date(Date.now() + 600_000) })
      const client = new Client({ name: 'claude-host-configuration', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => issued.token },
      }))
      return { client, token: issued.token }
    }
    const writer = await connect(['harnesses:read', 'harnesses:update'])
    const reader = await connect(['harnesses:read'])
    const none = await connect([])
    const httpInventory = async () => {
      const response = await app!.inject({ method: 'GET',
        url: `/api/management/harnesses/registry?kind=main&mainId=${mainId}`,
        headers: { authorization: `Bearer ${reader.token}` } })
      expect(response.statusCode).toBe(200)
      return HarnessRegistryReadbackSchema.parse(response.json())
    }
    expect((await httpInventory()).instances.map(item => item.driverId)).toEqual(['codex'])
    const configuration: ClaudeHarnessConfiguration = {
      harness: 'claude', model: 'recorded-haiku', authMode: 'subscription', configDirectory: '/recorded/profile',
      permissionMode: 'default', sandbox: 'danger-full-access', tools: ['Write'],
      permissionRules: [], instructions: '', mcpServers: {},
    }
    const current = await settings.getManagedHarnessDefaults()
    const defaultsInput = { commandId: randomUUID(), expectedRevision: current.revision,
      defaults: { ...current.defaults, claude: configuration }, configure: ['claude'] }
    await expectMcpAccessDenied(reader.client.callTool({ name: 'harness_defaults_update', arguments: defaultsInput }))
    const savedDefaults = HarnessDefaultsUpdateResultSchema.parse(decodeMcpToolResult((await writer.client.callTool({
      name: 'harness_defaults_update', arguments: defaultsInput }))))
    const inventory = HarnessRegistryReadbackSchema.parse(decodeMcpToolResult((await reader.client.callTool({
      name: 'harness_registry_get', arguments: hostRef }))))
    expect(await httpInventory()).toEqual(inventory)
    const preset = inventory.instances.find(item => item.driverId === 'claude')!
    expect(preset).toMatchObject({ instanceId: 'local-default:claude',
      instanceRevision: String(savedDefaults.value.revision), availability: 'available', configuration })
    const installation = inventory.installations.find(item => item.driverId === preset.driverId)!
    expect(installation).toMatchObject({ installed: true, authenticated: null, qualified: null })
    expect(discovery.claude).toHaveBeenCalledOnce()
    expect(qualify).not.toHaveBeenCalled()
    await expectMcpAccessDenied(none.client.callTool({ name: 'harness_registry_get', arguments: hostRef }))
    expect((await writer.client.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'harness_registry_get', 'harness_instance_save', 'harness_instance_check', 'harness_instances_list',
    ]))
    const target = { hostRef, applicationInstallationId: mainId,
      harnessInstallationId: installation.harnessInstallationId,
      installationFingerprint: installation.installationFingerprint! }
    const saveInput = { commandId: randomUUID(), instanceId: randomUUID(), expectedRevision: 0,
      presetId: preset.instanceId, target, enabled: true,
      configuration: { ...configuration, configDirectory: '/recorded/different-profile' } }
    await expectMcpAccessDenied(reader.client.callTool({ name: 'harness_instance_save', arguments: saveInput }))
    const saved = HostHarnessOverrideSaveResultSchema.parse(decodeMcpToolResult((await writer.client.callTool({
      name: 'harness_instance_save', arguments: saveInput }))))
    expect(saved.value).toMatchObject({ configuration: saveInput.configuration, qualification: 'unqualified' })
    expect(HostHarnessOverrideSaveResultSchema.parse(decodeMcpToolResult((await writer.client.callTool({
      name: 'harness_instance_save', arguments: saveInput })))).replayed).toBe(true)
    const checkInput = { commandId: randomUUID(), instanceId: saved.value.instanceId,
      expectedRevision: saved.value.revision, target }
    await expectMcpAccessDenied(reader.client.callTool({ name: 'harness_instance_check', arguments: checkInput }))
    expect(qualify).not.toHaveBeenCalled()
    const checked = HostHarnessInstanceCheckResultSchema.parse(decodeMcpToolResult((await writer.client.callTool({
      name: 'harness_instance_check', arguments: checkInput }))))
    expect(checked.value).toMatchObject({ configuration: saveInput.configuration, qualification: 'qualified' })
    const replay = await writer.client.callTool({ name: 'harness_instance_check', arguments: checkInput })
    expect(HostHarnessInstanceCheckResultSchema.parse(decodeMcpToolResult(replay)).replayed).toBe(true)
    expect(qualify).toHaveBeenCalledOnce()
    const readInput = { hostRef, applicationInstallationId: mainId }
    const persisted = HostHarnessOverrideListSchema.parse(decodeMcpToolResult((await reader.client.callTool({
      name: 'harness_instances_list', arguments: readInput }))))
    expect(persisted.overrides).toEqual([checked.value])
    expect((await settings.getManagedHarnessDefaults()).defaults.claude).toEqual(configuration)
    const failedInspection = HarnessCatalogEntrySchema.parse(decodeMcpToolResult((await reader.client.callTool({
      name: 'harness_get', arguments: { harness: 'claude' },
    }))))
    expect(failedInspection.discoveryError).toMatchObject({ code: 'HARNESS_CHECK_TIMEOUT' })
    expect(inspectConfiguration).toHaveBeenCalledOnce()
    const afterFailure = HarnessRegistryReadbackSchema.parse(decodeMcpToolResult((await reader.client.callTool({
      name: 'harness_registry_get', arguments: hostRef,
    }))))
    expect(afterFailure.installations).toEqual(inventory.installations)
    expect(await httpInventory()).toEqual(afterFailure)
    expect(discovery.claude).toHaveBeenCalledOnce()
    expect(HostHarnessOverrideListSchema.parse(decodeMcpToolResult((await reader.client.callTool({
      name: 'harness_instances_list', arguments: readInput,
    })))).overrides).toEqual([checked.value])
    const audit = await pool.query('select action,outcome from management_audit where source=$1', ['mcp'])
    expect(audit.rows).toEqual(expect.arrayContaining([
      { action: 'harness_instance_save', outcome: 'denied' },
      { action: 'harness_instance_check', outcome: 'denied' },
      { action: 'harness.instance.save', outcome: 'succeeded' },
    ]))
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await app?.close()
    await service?.closeChecks()
    await catalog?.shutdownChecks()
    registry?.stop()
    await pool.end()
    try { await dropFixtureSchema(admin, schema) } finally { await admin.end() }
  }
}, 60_000)
