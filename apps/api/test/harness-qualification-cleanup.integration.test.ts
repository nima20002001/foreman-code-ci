import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { withAdvancedDefaults } from '@foreman-code/contracts'
import {
  HostHarnessInstanceCheckResultSchema,
  HostHarnessOverrideListSchema,
  HostHarnessOverrideSaveResultSchema,
} from '@foreman-code/contracts/harness-registry'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { authorizeDeviceHost } from '../src/modules/devices/hostAuthorization.js'
import { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import { HostHarnessInstanceProfileChecks } from '../src/modules/harnesses/instanceSettings/profileChecks.js'
import type { HostHarnessProfileQualifier } from '../src/modules/harnesses/instanceSettings/profileChecks.js'
import { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { HostHarnessOverrideService } from '../src/modules/harnesses/instanceSettings/service.js'
import type { HostHarnessOverrideAuthority } from '../src/modules/harnesses/instanceSettings/service.js'
import { NativeHarnessFactories } from '../src/modules/harnesses/runtimeFactory.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { fixtureProtocol } from './fixtures/codex-test-helpers.js'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'

const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL! })
const schema = `qualification_cleanup_${randomUUID().replaceAll('-', '')}`
const pool = new pg.Pool({ ...admin.options, options: `-c search_path=${schema}` })

beforeAll(async () => {
  await createFixtureSchema(admin, schema)
  await applyApplicationMigrations(pool)
}, 60_000)
afterAll(async () => {
  await pool.end()
  try { await dropFixtureSchema(admin, schema) } finally { await admin.end() }
}, 60_000)

it('reports failed Main reservation through authenticated MCP, then checks and persists a profile after owned cleanup', async () => {
  const access = new PostgresAccessService(pool)
  const commands = new PostgresCommandCoordinator(pool)
  const settings = new HarnessInstanceSettingsRepository(pool)
  const proofs = new HostHarnessProfileEvidenceRepository(pool)
  const root = await mkdtemp(join(tmpdir(), 'mcp-qualification-cleanup-'))
  const registry = new NativeProcessRegistry(root)
  const recovery = registry.scope('qualification:recorded')
  const admit = vi.fn(async () => { Object.assign(recovery, await registry.reserveLaunch(recovery.owner)) })
  const abandon = vi.fn(async () => { await registry.abandonReservedLaunch(recovery) })
  const close = vi.fn(async () => {
    if (!await registry.closeOwner(recovery.owner)) throw new Error('Diagnostic native process closure is unconfirmed.')
  })
  // Native protocol ports are recorded; reservation and closure use the Linux registry.
  const factories = new NativeHarnessFactories({ codexBinary: '/recorded/codex',
    auxiliaryRecovery: () => recovery, admitRecovery: admit, abandonRecovery: abandon, closeRecovery: close,
  }, { mode: 'native', codex: {
    mode: 'native', environment: () => ({}),
    qualify: async binary => ({ binary, identity: 'recorded', protocol: fixtureProtocol,
      providerVersion: '0.156.1', schemaManifestSha256: 'recorded', stableSchemaGitBlob: 'recorded',
      referenceSchemaManifestSha256: 'recorded' }),
    assertUnchanged: async () => undefined,
    qualifyModel: async () => undefined,
    runCommand: async () => { throw new Error('Unexpected native command.') },
    transport: () => { throw new Error('Unexpected native transport.') },
  } })
  const qualifier: HostHarnessProfileQualifier = { qualify: vi.fn<HostHarnessProfileQualifier['qualify']>(async (value, input) => {
    if (value.configuration.harness !== 'codex') throw new Error('Expected a Codex profile.')
    const checked = await factories.qualifyConfiguration(value.configuration, '/recorded/workspace', input.signal)
    return { target: value.target, instanceRevision: value.instanceRevision,
      configurationFingerprint: value.configurationFingerprint, driverId: value.driverId,
      driverRevision: 'recorded-driver', protocolRevision: 'recorded-protocol', suiteRevision: 'recorded-suite',
      environmentGeneration: 'recorded-environment', connectionGeneration: 'recorded-connection',
      authenticated: checked.authenticated, compatible: checked.structuredEvents, qualified: checked.ready,
      checkedAt: new Date().toISOString() }
  }) }
  const authority: HostHarnessOverrideAuthority = { authorize: async (principal, action, host, installation, client) => {
    if (!client) throw new Error('Host authorization requires the settings transaction.')
    await authorizeDeviceHost(client, principal, action, host, installation)
  } }
  const checks = new HostHarnessInstanceProfileChecks(settings, proofs, commands, authority, qualifier)
  const service = new HostHarnessOverrideService(settings, commands, authority,
    (value, client) => proofs.latest(value.instanceId, value.revision, client), checks)
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
    operator: { access, services: { commands, harnessInstances: service } as unknown as OperatorServices },
  })
  const clients: Client[] = []
  app.addHook('onClose', async () => {
    await service.closeChecks()
    await factories.disposeAuxiliaries()
  })
  try {
    const mainId = (await pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    const owner = await access.issue({ name: 'profile writer', audience: 'operator',
      grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }],
      expiresAt: new Date(Date.now() + 120_000) })
    const reader = await access.issue({ name: 'profile reader', audience: 'operator',
      grants: [{ actions: ['harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'qualification-cleanup', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    const writer = await connect(owner.token)
    const denied = await connect(reader.token)
    const target = { hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
      harnessInstallationId: 'recorded-codex', installationFingerprint: 'recorded-payload' }
    const saved = HostHarnessOverrideSaveResultSchema.parse(decodeMcpToolResult((await writer.callTool({
      name: 'harness_instance_save', arguments: { commandId: randomUUID(), instanceId: randomUUID(),
        expectedRevision: 0, target, presetId: 'local-default:codex', enabled: true,
        configuration: withAdvancedDefaults({ harness: 'codex', model: 'recorded-model',
          reasoningEffort: 'medium', sandbox: 'read-only', serviceTier: 'standard' }) },
    }))))
    const checkInput = { commandId: randomUUID(), instanceId: saved.value.instanceId,
      expectedRevision: saved.value.revision, target }
    const rejected = await denied.callTool({ name: 'harness_instance_check', arguments: checkInput })
    expect(rejected.isError).toBe(true)
    expect(JSON.stringify(rejected.content)).toContain('ACCESS_DENIED')
    expect(qualifier.qualify).not.toHaveBeenCalled()
    expect(await proofs.latest(saved.value.instanceId, saved.value.revision)).toBeNull()
    expect((await pool.query(`select action,target_key,outcome from management_audit
      where principal_id=$1 and source='mcp'`, [reader.principal.id])).rows).toEqual([{
      action: 'harness_instance_check', target_key: `harness-instance:${saved.value.instanceId}`, outcome: 'denied',
    }])
    admit.mockImplementationOnce(() => {
      throw new DomainError('HARNESS_RECOVERY_STORAGE_FULL', 'Native harness storage is full on this computer.', 503)
    })
    const failed = await writer.callTool({ name: 'harness_instance_check',
      arguments: { ...checkInput, commandId: randomUUID() } })
    expect(failed.isError).toBe(true)
    expect(JSON.stringify(failed.content)).toContain('HARNESS_RECOVERY_STORAGE_FULL')
    expect(JSON.stringify(failed.content)).not.toContain('INTERNAL_ERROR')
    expect(await proofs.latest(saved.value.instanceId, saved.value.revision)).toBeNull()
    expect(close).not.toHaveBeenCalled()
    expect(abandon).not.toHaveBeenCalled()
    expect(registry.snapshot().launches).toEqual([])
    const checked = HostHarnessInstanceCheckResultSchema.parse(decodeMcpToolResult((await writer.callTool({
      name: 'harness_instance_check', arguments: checkInput,
    }))))
    expect(checked.value.qualification).toBe('qualified')
    expect(checked.proof).toMatchObject({ authenticated: true, compatible: true, qualified: true })
    expect(checked.replayed).toBe(false)
    expect(admit).toHaveBeenCalledTimes(2)
    expect(admit).toHaveBeenLastCalledWith(recovery)
    expect(abandon).toHaveBeenCalledExactlyOnceWith(recovery)
    expect(close).toHaveBeenCalledExactlyOnceWith(recovery)
    expect(await registry.closeOwner(recovery.owner)).toBe(true)
    expect(await proofs.latest(saved.value.instanceId, saved.value.revision)).toEqual(checked.proof)
    const readback = HostHarnessOverrideListSchema.parse(decodeMcpToolResult((await denied.callTool({
      name: 'harness_instances_list', arguments: { hostRef: target.hostRef, applicationInstallationId: mainId },
    }))))
    expect(readback.overrides).toEqual([checked.value])
    const replay = HostHarnessInstanceCheckResultSchema.parse(decodeMcpToolResult((await writer.callTool({
      name: 'harness_instance_check', arguments: checkInput,
    }))))
    expect(replay.replayed).toBe(true)
    expect(replay.proof).toEqual(checked.proof)
    expect(qualifier.qualify).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledOnce()
  } finally {
    await Promise.all(clients.map(client => client.close()))
    try { await app.close() } finally { await rm(root, { recursive: true, force: true }) }
  }
}, 60_000)
