import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { createFixtureSchema, dropFixtureSchema, removeFixtureDirectory } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, HarnessCompatibilityListSchema } from '@foreman-code/contracts'
import { FileCompatibilityCache } from '../src/modules/harnesses/compatibility/cache.js'
import { HarnessCompatibilityService } from '../src/modules/harnesses/compatibility/service.js'
import { HarnessQualificationListSchema } from '@foreman-code/contracts/harness-qualification'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { fileReferenceAccessMigration } from '../src/infrastructure/fileReferenceAccessMigration.js'
import { harnessQualificationMigration } from '../src/infrastructure/harnessQualificationMigration.js'
import { migrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresLocalHumanAccess } from '../src/modules/access/localHuman.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'
import { HarnessQualificationRepository } from '../src/modules/harnesses/qualification/repository.js'
import { HostHarnessProfileEvidenceSchema, type HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { harnessConnectionGeneration } from '../src/modules/harnesses/hostConnectionGeneration.js'
import { HarnessQualificationRegistry } from '../src/modules/harnesses/qualification/registry.js'
import { HarnessQualificationService } from '../src/modules/harnesses/qualification/service.js'
import { nativeCompatibilityProbe } from '../src/modules/harnesses/compatibility/probe.js'
import { runWithReadOnlyQualification, requireHarnessQualification } from '../src/modules/harnesses/qualification/gate.js'
import type { QualificationSuite } from '../src/modules/harnesses/qualification/types.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

it('registers the qualification migration after earlier blocks', () => {
  const prerequisite = migrations.indexOf(fileReferenceAccessMigration)
  expect(prerequisite).toBeGreaterThanOrEqual(0)
  expect(migrations.indexOf(harnessQualificationMigration)).toBeGreaterThan(prerequisite)
  expect(new Set(migrations.map((migration) => migration.version)).size).toBe(migrations.length)
})

it.skipIf(!process.env.TEST_DATABASE_URL)('reads compatibility through authenticated MCP, denying unauthorized retries', async () => {
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
  const schema = `harness_qualification_${randomUUID().replaceAll('-', '')}`
  await createFixtureSchema(admin, schema)
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` })
  const home = await mkdtemp(join(tmpdir(), 'harness-qualification-test-'))
  const binary = join(home, 'fake-codex')
  await writeFile(binary, '#!/bin/sh\necho "codex-cli 0.158.0"\n')
  await chmod(binary, 0o700)
  const clients: Client[] = []
  let app: ReturnType<typeof buildApp> | undefined
  let compatibility: HarnessCompatibilityService | undefined
  try {
    await applyApplicationMigrations(pool)
    const access = new PostgresAccessService(pool)
    const commands = new PostgresCommandCoordinator(pool)
    const settings = new PostgresSettingsRepository(pool)
    const repository = new HarnessQualificationRepository(pool)
    const registry = new HarnessQualificationRegistry(repository, { codex: 'fake-v1' })
    const suite: QualificationSuite = { harness: 'codex', revision: 'fake-v1', run: vi.fn(async () => ({
      checks: [{ id: 'protocol', passed: true, detail: null }], evidence: { fixture: true },
    })) }
    const staticCheck = vi.fn(async () => 'a'.repeat(64))
    const service = new HarnessQualificationService(repository, registry, { codex: suite },
      { codex: binary }, commands, settings, staticCheck)
    const compatibilityOptions = { commands, cache: new FileCompatibilityCache(join(home, 'compatibility-cache')),
      probe: { inspect: async (harness: 'codex') => ({ executable: binary,
        identity: `${harness}-fixture-payload`, version: harness === 'codex' ? '0.160.0' : '2.0.0' }),
      probe: async () => 'a'.repeat(64), assertUnchanged: async () => undefined } }
    const initialCompatibility = new HarnessCompatibilityService(compatibilityOptions)
    await initialCompatibility.checkAll()
    await initialCompatibility.close()
    compatibility = new HarnessCompatibilityService(compatibilityOptions)
    await compatibility.checkAll()
    const services = { commands, harnessQualifications: service, harnessCompatibility: compatibility } as unknown as OperatorServices
    app = buildApp({ logger: false, localHuman: new PostgresLocalHumanAccess(pool, access),
      readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access, services } })
    const writer = await access.issue({ name: 'Qualification writer', audience: 'operator', grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const reader = await access.issue({ name: 'Qualification reader', audience: 'operator', grants: [{ actions: ['harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'qualification-test', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const writeClient = await connect(writer.token)
    const readClient = await connect(reader.token)
    expect((await readClient.listTools()).tools.map((tool) => tool.name)).not.toContain('harness_qualification_run')
    await expectMcpAccessDenied(readClient.callTool({ name: 'harness_qualification_run', arguments: { harness: 'codex' } }))
    const compatible = HarnessCompatibilityListSchema.parse(decodeMcpToolResult((await readClient.callTool({
      name: 'harness_compatibility_list', arguments: {},
    }))))
    expect(compatible.harnesses[0]).toMatchObject({ installedVersion: '0.160.0', status: 'probe-passed', source: 'cache' })
    expect(compatible.canRetry).toBe(false)
    await expectMcpAccessDenied(readClient.callTool({ name: 'harness_compatibility_retry', arguments: { harness: 'codex' } }))
    const other = await access.issue({ name: 'No harness grants', audience: 'operator',
      grants: [{ actions: ['runs:read'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })
    const deniedClient = await connect(other.token)
    await expectMcpAccessDenied(deniedClient.callTool({ name: 'harness_compatibility_list', arguments: {} }))
    expect((await writeClient.callTool({ name: 'harness_compatibility_retry', arguments: { harness: 'codex' } })).isError).not.toBe(true)
    await compatibility.checkAll()
    const started = await writeClient.callTool({ name: 'harness_qualification_run', arguments: { harness: 'codex' } })
    expect(started.isError).not.toBe(true)
    await service.join()
    expect((await repository.list())[0]?.status).toBe('qualified')
    const listed = HarnessQualificationListSchema.parse(decodeMcpToolResult((await readClient.callTool({ name: 'harness_qualifications_list', arguments: {} }))))
    expect(listed.qualifications[0]).toMatchObject({ harness: 'codex', version: '0.158.0', status: 'qualified', suiteRevision: 'fake-v1',
      checks: [{ id: 'static-compatibility', passed: true }, { id: 'protocol', passed: true }] })
    expect(await registry.trusted('codex', '0.158.0', listed.qualifications[0]!.binarySha256!)).toBe(true)
    const stalledBinary = join(home, 'stalled-codex')
    await writeFile(stalledBinary, `#!${process.execPath}\nsetInterval(() => {}, 1000)\n`, { mode: 0o700 })
    // Keep a short real deadline to exercise cancellation of the spawned stalled process.
    const stalledService = new HarnessQualificationService(repository, registry, { codex: suite },
      { codex: stalledBinary }, commands, settings, staticCheck, undefined,
      () => nativeCompatibilityProbe({ codex: stalledBinary }, home, process.env, 100))
    services.harnessQualifications = stalledService
    try {
      await expectMcpAccessDenied(readClient.callTool({
        name: 'harness_qualification_run', arguments: { harness: 'codex' },
      }))
      const timedOut = await writeClient.callTool({ name: 'harness_qualification_run', arguments: { harness: 'codex' } })
      expect(timedOut).toMatchObject({ isError: true, content: [{ type: 'text', text: JSON.stringify({
        error: { code: 'HARNESS_CHECK_TIMEOUT', message: 'The native check timed out. Try again.' },
      }) }] })
      await stalledService.join()
      const afterTimeout = HarnessQualificationListSchema.parse(decodeMcpToolResult((await readClient.callTool({
        name: 'harness_qualifications_list', arguments: {},
      }))))
      expect(afterTimeout).toEqual(listed)
      expect(suite.run).toHaveBeenCalledOnce()
    } finally {
      services.harnessQualifications = service
      await stalledService.shutdown()
    }
    await expect(requireHarnessQualification('codex', 'codex-cli 0.158.0', binary)).resolves.toBeUndefined()
    expect(await registry.trusted('codex', '0.158.0', '0'.repeat(64))).toBe(false)
    await writeFile(binary, '#!/bin/sh\n# another binary, same version\necho "codex-cli 0.158.0"\n')
    await expect(requireHarnessQualification('codex', 'codex-cli 0.158.0', binary)).resolves.toBeUndefined()
    expect((await service.verify('codex')).status).toBe('qualified')
    await service.join()
    expect((await repository.list()).filter((item) => item.suiteRevision === 'fake-v1' && item.status === 'qualified')).toHaveLength(2)
    expect(suite.run).toHaveBeenCalledTimes(2)
    expect(staticCheck).toHaveBeenCalledTimes(2)
    await expect(requireHarnessQualification('codex', 'codex-cli 0.158.0', binary)).resolves.toBeUndefined()
    const failedSuite: QualificationSuite = { harness: 'codex', revision: 'fake-v2', run: async () => ({
      checks: [{ id: 'protocol', passed: false, detail: 'fixture mismatch' }], evidence: { fixture: true },
    }) }
    const failedRegistry = new HarnessQualificationRegistry(repository, { codex: 'fake-v2' })
    const failedService = new HarnessQualificationService(repository, failedRegistry, { codex: failedSuite },
      { codex: binary }, commands, settings, staticCheck)
    await failedService.begin('codex')
    await failedService.join()
    expect((await repository.list()).find((item) => item.suiteRevision === 'fake-v2')?.status).toBe('failed')
    await expect(runWithReadOnlyQualification(failedRegistry, () => requireHarnessQualification('codex', 'codex-cli 0.158.0', binary))).rejects.toMatchObject({
      result: { error: { code: 'HARNESS_UNQUALIFIED' } },
    })
    const skippedSuite: QualificationSuite = { ...suite, revision: 'fake-v3', run: vi.fn(async () => ({ checks: [], evidence: {} })) }
    const staticFailure = new HarnessQualificationService(repository,
      new HarnessQualificationRegistry(repository, { codex: 'fake-v3' }),
      { codex: skippedSuite },
      { codex: binary }, commands, settings, async () => { throw new Error('schema missing required method') })
    await staticFailure.begin('codex')
    await staticFailure.join()
    expect((await repository.list()).find((item) => item.suiteRevision === 'fake-v3')).toMatchObject({
      status: 'failed', checks: [{ id: 'static-compatibility', passed: false, detail: 'schema missing required method' }],
    })
    expect(skippedSuite.run).not.toHaveBeenCalled()
    const installedSettings = new HarnessInstanceSettingsRepository(pool)
    const installedProofs = new HostHarnessProfileEvidenceRepository(pool)
    const mainId = randomUUID(), deviceId = randomUUID(), applicationInstallationId = randomUUID()
    const target = { hostRef: { kind: 'device' as const, mainId, deviceId }, applicationInstallationId,
      harnessInstallationId: 'codex-installation', installationFingerprint: 'payload-a' }
    const launcherSha = 'a'.repeat(64)
    const saveInstalled = async (selected: typeof target, version: string) => {
      const value: HostHarnessOverride = { instanceId: randomUUID(), instanceRevision: '1', revision: 1,
        target: selected, presetId: 'fixture', enabled: true, driverId: 'codex', configuration: DEFAULT_HARNESS_DEFAULTS.codex,
        configurationFingerprint: commandInputHash(DEFAULT_HARNESS_DEFAULTS.codex), qualification: 'qualified' }
      const binding = { mainId: selected.hostRef.mainId, deviceId: selected.hostRef.deviceId,
        workerInstallationId: selected.applicationInstallationId, keyRevision: 1, authorizationRevision: 1,
        bootId: randomUUID(), connectionGeneration: 1, connectionEpoch: randomUUID() }
      const record = { ...listed.qualifications[0]!, version, binarySha256: launcherSha, suiteRevision: 'installed-cache-fixture' }
      const checkId = randomUUID()
      const proof = HostHarnessProfileEvidenceSchema.parse({ target: selected, instanceRevision: value.instanceRevision,
        configurationFingerprint: value.configurationFingerprint, driverId: 'codex', driverRevision: '1',
        protocolRevision: 'codex-native-adapter-v1', suiteRevision: 'codex-profile-check-v1', environmentGeneration: 'fixture',
        connectionGeneration: harnessConnectionGeneration(binding), authenticated: true, compatible: true, qualified: true,
        checkedAt: record.checkedAt, completedNativeQualification: { purpose: 'explicit-host-qualification', checkId,
          binding, target: selected, binarySha256: launcherSha, record } })
      const client = await pool.connect()
      try {
        await client.query('begin')
        await installedSettings.append(client, writer.principal.id, 0, value)
        await installedProofs.append(client, checkId, value, proof)
        await client.query('commit')
      } catch (error) {
        await client.query('rollback')
        throw error
      } finally { client.release() }
      return record
    }
    const oldRecord = await saveInstalled(target, '0.158.0')
    const currentTarget = { ...target, installationFingerprint: 'payload-b' }
    const currentRecord = await saveInstalled(currentTarget, '0.160.0')
    const otherTarget = { ...target, hostRef: { ...target.hostRef, deviceId: randomUUID() },
      applicationInstallationId: randomUUID(), installationFingerprint: 'payload-c' }
    const otherRecord = await saveInstalled(otherTarget, '0.160.0')
    expect(await repository.findInstalled(currentTarget, launcherSha, 'installed-cache-fixture')).toEqual([currentRecord])
    expect(await repository.findInstalled(target, launcherSha, 'installed-cache-fixture')).toEqual([oldRecord])
    expect(await repository.findInstalled(otherTarget, launcherSha, 'installed-cache-fixture')).toEqual([otherRecord])

  } finally {
    await Promise.allSettled(clients.map((client) => client.close()))
    await app?.close()
    await compatibility?.close()
    await pool.end()
    await removeFixtureDirectory(home)
    await dropFixtureSchema(admin, schema)
    await admin.end()
  }
}, 60_000)
