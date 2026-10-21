import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, withAdvancedDefaults } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import { inspectInstalledCodex } from '../src/modules/harnesses/installedCodexInspection.js'
import { createInstalledNativeQualifier, CODEX_COMPLETED_QUALIFICATION_CHECKS, completedNativeQualificationChecks } from '../src/modules/harnesses/installedNativeQualification.js'

import { createInstalledNativeQualificationRetention } from '../src/modules/harnesses/installedNativeQualificationRetention.js'
import { requireHarnessQualification } from '../src/modules/harnesses/qualification/gate.js'
import { runWithReadOnlyQualification } from '../src/modules/harnesses/qualification/gate.js'
import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'
import { nativeQualification } from '../src/modules/harnesses/nativeQualification.js'
import { HarnessQualificationRegistry } from '../src/modules/harnesses/qualification/registry.js'
import { HarnessQualificationRepository } from '../src/modules/harnesses/qualification/repository.js'
import { HostHarnessInstanceProfileChecks, nativeProfileCheckId } from '../src/modules/harnesses/instanceSettings/profileChecks.js'
import type { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import type { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { QualificationSuite } from '../src/modules/harnesses/qualification/types.js'

/** Genuine gate/ownership/profile/transaction code with model-free native port
 * fixtures. No binary is executed and no PostgreSQL connection is opened. */
async function fixture(harness: 'codex' = 'codex') {
  const version = harness === 'codex' ? '0.132.0' : '1.18.33'
  const directory = await mkdtemp(join(tmpdir(), 'remote-qualification-'))
  const binary = join(directory, 'codex'), path = join(directory, 'selection.json')
  await writeFile(binary, Buffer.concat([Buffer.from('7f454c46', 'hex'), Buffer.from('fixture-native-image')]), { mode: 0o700 })
  await writeFile(path, JSON.stringify({ schemaVersion: 1, codexBinary: binary, expectedVersion: '0.132.0',
    appMcpLauncher: '/installed/app-mcp-launcher', payloadPaths: [],
    ...({}) }), { mode: 0o600 })
  const binding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(), bootId: randomUUID(),
    connectionEpoch: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 }
  let current = binding
  const inspect = async (_binding: typeof binding, signal: AbortSignal) => (inspectInstalledCodex)({ binding: _binding,
    configuration: { path, ownerUid: process.getuid!() }, environment: { PATH: '/usr/bin' }, cwd: directory, signal })
  const installation = (await inspect(binding, new AbortController().signal)).currentTarget!
  const configuration = DEFAULT_HARNESS_DEFAULTS[harness]
  const value: HostHarnessOverride = { instanceId: randomUUID(), revision: 1, instanceRevision: 'original-profile-revision', target: installation.target,
    presetId: `local-default:${harness}`, enabled: true, driverId: harness, configuration,
    configurationFingerprint: commandInputHash(withAdvancedDefaults(configuration)), qualification: 'unqualified' }
  const checkId = randomUUID(), registry = {
    reserveLaunch: vi.fn(async (owner: string) => ({ root: directory, owner, launchId: randomUUID() })),
    abandonReservedLaunch: vi.fn(async () => true), closeOwner: vi.fn(async () => true),
  }
  const probe = { inspect: vi.fn(async () => ({ executable: binary, identity: 'fixture-stat-generation', version })),
    probe: vi.fn(async () => 'a'.repeat(64)), assertUnchanged: vi.fn(async () => undefined), close: vi.fn(async () => undefined) }
  const run = vi.fn<QualificationSuite['run']>(async input => {
    await requireHarnessQualification(harness, input.version, input.binary)
    return { checks: completedNativeQualificationChecks().filter(id => !['static-compatibility', 'selected-profile', 'owned-resource-closure'].includes(id))
      .map(id => ({ id, passed: true, detail: null })), evidence: { fixtureOnly: true } }
  })
  const checkConfiguration = vi.fn(async () => {
    await requireHarnessQualification(harness, version, binary)
    return nativeQualification(value.configuration, harness === 'codex' ? `codex-cli ${version}` : version)
  })
  const qualifier = createInstalledNativeQualifier({ harness, binding, trustedCurrentBinding: () => current, inspect, registry,
    workingRoot: directory, environment: { PATH: '/usr/bin', CODEX_HOME: join(directory, 'account') }, checkConfiguration,
    suite: { harness, revision: `${harness}-live-4`, run }, probe: () => probe })
  return { directory, binary, binding, value, checkId, qualifier, registry, probe, run, checkConfiguration, installation,
    setBinding: (next: typeof binding) => { current = next } }
}
async function release(f: Awaited<ReturnType<typeof fixture>>) { await f.qualifier.close(); await rm(f.directory, { recursive: true, force: true }) }

describe('explicit actual-suite worker qualification adapter', () => {

  it('keeps Worker execution denied until completed native qualification is retained by Main', async () => {
    const f = await fixture()
    const reader = new HarnessQualificationRegistry({ list: async () => [], find: async () => null },
      { codex: 'codex-live-4+identity-v1' })
    const requireWorker = () => runWithReadOnlyQualification(reader, () => requireHarnessQualification('codex', '0.132.0', f.binary))
    try {
      await expect(requireWorker()).rejects.toMatchObject({ result: { error: { code: 'HARNESS_UNQUALIFIED' } } })
      const proof = await f.qualifier.qualify(f.value, { checkId: f.checkId, signal: new AbortController().signal })
      expect(proof).toMatchObject({ authenticated: true, compatible: true, qualified: true,
        completedNativeQualification: { purpose: 'explicit-host-qualification', checkId: f.checkId, binding: f.binding,
          binarySha256: f.installation.binarySha256, record: { version: '0.132.0', status: 'qualified', suiteRevision: 'codex-live-4+identity-v1' } } })
      expect(f.checkConfiguration).toHaveBeenCalledWith(f.value, expect.stringContaining('codex-qualification-'), expect.any(AbortSignal),
        expect.objectContaining({ owner: expect.stringContaining('qualification:codex:') }), expect.any(Function))
      expect(f.probe.close).toHaveBeenCalledOnce()
      expect(f.registry.closeOwner).toHaveBeenCalledTimes(2)
      expect(proof.completedNativeQualification?.record.checks.map(check => check.id)).toEqual([...CODEX_COMPLETED_QUALIFICATION_CHECKS])
      await expect(requireWorker()).rejects.toMatchObject({ result: { error: { code: 'HARNESS_UNQUALIFIED' } } })
      expect((await readdir(f.directory)).some(name => name.startsWith('codex-qualification-'))).toBe(false)
    } finally { await release(f) }
  })
  it('retains a completed static failure without inventing authentication or issuing a model turn', async () => {
    const f = await fixture()
    try {
      f.probe.probe.mockRejectedValueOnce(new Error('schema rejected'))
      const proof = await f.qualifier.qualify(f.value, { checkId: f.checkId, signal: new AbortController().signal })
      expect(proof).toMatchObject({ authenticated: null, compatible: false, qualified: false,
        completedNativeQualification: { record: { status: 'failed', version: '0.132.0' } } })
      expect(f.run).not.toHaveBeenCalled(); expect(f.checkConfiguration).not.toHaveBeenCalled()
      expect(proof.completedNativeQualification?.record.checks).toEqual([{ id: 'static-compatibility', passed: false, detail: null },
        { id: 'owned-resource-closure', passed: true, detail: null }])
    } finally { await release(f) }
  })
  it('records a native selected-setting refusal only after actual suite and physical closure', async () => {
    const f = await fixture()
    try {
      f.checkConfiguration.mockRejectedValueOnce(new HarnessExecutionError('CODEX_SETTING_UNSUPPORTED', 'actual native setting refusal'))
      const proof = await f.qualifier.qualify(f.value, { checkId: f.checkId, signal: new AbortController().signal })
      expect(proof).toMatchObject({ authenticated: null, compatible: null, qualified: false,
        completedNativeQualification: { record: { status: 'failed' } } })
      expect(proof.completedNativeQualification?.record.checks).toContainEqual({
        id: 'selected-profile', passed: false, detail: 'CODEX_SETTING_UNSUPPORTED',
      })
      expect(f.run).toHaveBeenCalledOnce()
      expect(f.checkConfiguration).toHaveBeenCalledOnce()
      expect(f.probe.close).toHaveBeenCalledOnce()
      expect(f.registry.closeOwner).toHaveBeenCalledTimes(2)
    } finally { await release(f) }
  })
  it('does not publish completed evidence after failed physical closure and retries the exact owned cleanup', async () => {
    const f = await fixture()
    try {
      f.registry.closeOwner.mockResolvedValue(false)
      await expect(f.qualifier.qualify(f.value, { checkId: f.checkId, signal: new AbortController().signal })).rejects.toBeInstanceOf(AggregateError)
      await expect(f.qualifier.qualify(f.value, { checkId: f.checkId, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'HARNESS_QUALIFICATION_CLEANUP_PENDING' })
      expect(f.run).not.toHaveBeenCalled()
      f.registry.closeOwner.mockResolvedValue(true)
      await f.qualifier.close()
      expect(f.registry.reserveLaunch).toHaveBeenCalledOnce()
    } finally { await release(f) }
  })
  it('retains suite resources and its temporary directory until positive closure can be retried', async () => {
    const f = await fixture()
    try {
      f.registry.closeOwner.mockResolvedValueOnce(true).mockResolvedValue(false)
      await expect(f.qualifier.qualify(f.value, { checkId: f.checkId, signal: new AbortController().signal })).rejects.toBeInstanceOf(AggregateError)
      const directory = f.run.mock.calls[0]![0].workDirectory
      expect((await stat(directory)).isDirectory()).toBe(true)
      f.registry.closeOwner.mockResolvedValue(true)
      await f.qualifier.close()
      await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(f.registry.reserveLaunch).toHaveBeenCalledTimes(2)
    } finally { await release(f) }
  })
  it('keeps independently owned concurrent checks and their directories separate', async () => {
    const f = await fixture()
    try {
      let arrivals = 0, releaseBoth!: () => void
      const both = new Promise<void>(resolve => { releaseBoth = resolve })
      f.run.mockImplementation(async input => {
        await requireHarnessQualification('codex', input.version, input.binary)
        if (++arrivals === 2) releaseBoth()
        await both
        return { checks: CODEX_COMPLETED_QUALIFICATION_CHECKS.filter(id => !['static-compatibility', 'selected-profile', 'owned-resource-closure'].includes(id))
          .map(id => ({ id, passed: true, detail: null })), evidence: {} }
      })
      const results = await Promise.all([f.qualifier.qualify(f.value, { checkId: f.checkId, signal: new AbortController().signal }),
        f.qualifier.qualify({ ...f.value, instanceId: randomUUID() }, { checkId: randomUUID(), signal: new AbortController().signal })])
      expect(results.every(proof => proof.qualified)).toBe(true)
      expect(f.registry.reserveLaunch).toHaveBeenCalledTimes(4)
      for (const [call] of f.run.mock.calls) {
        await expect(stat(call.workDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    } finally { await release(f) }
  })
  it('rejects foreign check IDs, target changes and channel replacement before suite admission', async () => {
    const f = await fixture()
    try {
      await expect(f.qualifier.qualify(f.value, { checkId: 'not-a-check', signal: new AbortController().signal })).rejects.toBeDefined()
      expect(f.registry.reserveLaunch).not.toHaveBeenCalled()
      f.probe.probe.mockImplementationOnce(async () => { f.setBinding({ ...f.binding, keyRevision: 2 }); return 'a'.repeat(64) })
      await expect(f.qualifier.qualify(f.value, { checkId: f.checkId, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'HARNESS_QUALIFICATION_TARGET_CHANGED' })
      expect(f.run).not.toHaveBeenCalled()
    } finally { await release(f) }
  })
})

async function mainFixture() {
  const f = await fixture()
  const principal: ManagementPrincipal = { id: 'main-owner', name: 'Main owner', audience: 'operator', expiresAt: '9999-01-01T00:00:00.000Z',
    revokedAt: null, grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }] }
  const commandId = randomUUID(), checkId = nativeProfileCheckId(f.binding.mainId, principal.id, commandId)
  const proof = await f.qualifier.qualify(f.value, { checkId, signal: new AbortController().signal })
  let binding = f.binding, selected = f.value
  const query = vi.fn<(sql: string, parameters?: unknown[]) => Promise<{ rows: unknown[] }>>(async () => ({ rows: [] }))
  const client = { query } as unknown as pg.PoolClient, poolQuery = vi.fn()
  const repository = new HarnessQualificationRepository({ query: poolQuery } as unknown as pg.Pool)
  const refreshInstallation = vi.fn(async () => {})
  const retention = createInstalledNativeQualificationRetention({ repository, currentBinding: () => binding,
    currentInstallation: () => f.installation.installation, suiteRevision: 'codex-live-4+identity-v1', refreshInstallation })
  const transactions: string[] = []
  const settings = { latest: async () => selected, lockRevision: async () => undefined,
    readAuthorized: async (work: (sql: pg.PoolClient) => Promise<unknown>) => {
      transactions.push('begin')
      try { const result = await work(client); transactions.push('commit'); return result }
      catch (error) { transactions.push('rollback'); throw error }
    } } as unknown as HarnessInstanceSettingsRepository
  const stored = new Map<string, typeof proof>()
  const append = vi.fn(async (_client: pg.PoolClient, id: string, _value: HostHarnessOverride, value: typeof proof) => { stored.set(id, value) })
  const proofs = { findCheck: async (id: string) => stored.get(id) ?? null, append } as unknown as HostHarnessProfileEvidenceRepository
  const commands = { execute: async (command: { authorize(sql: pg.PoolClient): Promise<void>; perform(sql: pg.PoolClient): Promise<unknown> }) => {
    await command.authorize(client); return { value: await command.perform(client), replayed: false }
  } } as unknown as PostgresCommandCoordinator
  const qualify = vi.fn(async () => proof), authority = { authorize: vi.fn(async () => undefined) }
  const checks = new HostHarnessInstanceProfileChecks(settings, proofs, commands, authority, { qualify }, retention)
  const input = { commandId, instanceId: f.value.instanceId, expectedRevision: 1, target: f.value.target }
  return { ...f, principal, proof, query, client, poolQuery, append, qualify, checks, input, transactions, refreshInstallation,
    replaceBinding: () => { binding = { ...binding, connectionEpoch: randomUUID() } },
    changeRevision: () => { selected = { ...selected, revision: 2, instanceRevision: '2' } } }
}
describe('Main retention through existing authorized idempotent profile check', () => {
  it('refreshes a committed qualification on retry without repeating native checks', async () => {
    const f = await mainFixture()
    try {
      f.refreshInstallation.mockRejectedValueOnce(new Error('Inventory refresh interrupted'))
      await expect(f.checks.check(f.principal, 'mcp', f.input)).rejects.toThrow('Inventory refresh interrupted')
      expect(f.transactions).toContain('commit')
      await f.checks.check(f.principal, 'mcp', f.input)
      expect(f.qualify).toHaveBeenCalledOnce()
      expect(f.append).toHaveBeenCalledOnce()
      expect(f.refreshInstallation).toHaveBeenCalledTimes(2)
    } finally {
      await f.checks.close()
      await release(f)
    }
  })
  it('saves the exact completed qualification and profile with one authorized SQL client and replays without native repetition', async () => {
    const f = await mainFixture()
    try {
      await f.checks.check(f.principal, 'mcp', f.input)
      const insert = f.query.mock.calls.find(([sql]) => String(sql).includes('insert into harness_qualifications'))
      expect(insert).toBeDefined(); expect(f.poolQuery).not.toHaveBeenCalled()
      expect(f.append.mock.calls[0]?.[0]).toBe(f.client)
      expect(f.transactions).not.toContain('rollback')
      await f.checks.check(f.principal, 'http', f.input)
      expect(f.qualify).toHaveBeenCalledOnce()
      expect(f.query.mock.calls.filter(([sql]) => String(sql).includes('insert into harness_qualifications'))).toHaveLength(1)
      expect(f.refreshInstallation).toHaveBeenCalledTimes(2)
    } finally { await f.checks.close(); await release(f) }
  })
  it('denies a read-only MCP caller before native checks or persistence', async () => {
    const f = await mainFixture()
    try {
      await expect(f.checks.check({ ...f.principal, grants: [{ actions: ['harnesses:read'], scope: {} }] }, 'mcp', f.input)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      expect(f.qualify).not.toHaveBeenCalled(); expect(f.append).not.toHaveBeenCalled()
      expect(f.query).not.toHaveBeenCalled()
    } finally { await f.checks.close(); await release(f) }
  })
  it('rolls back a connection replacement after profile insertion and rejects changed revisions before saving', async () => {
    const f = await mainFixture()
    try {
      f.append.mockImplementationOnce(async () => { f.replaceBinding() })
      await expect(f.checks.check(f.principal, 'http', f.input)).rejects.toMatchObject({ code: 'HARNESS_PROFILE_EVIDENCE_MISMATCH' })
      expect(f.transactions.at(-1)).toBe('rollback')
      f.qualify.mockImplementationOnce(async () => { f.changeRevision(); return f.proof })
      await expect(f.checks.check(f.principal, 'http', f.input)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
      expect(f.append).toHaveBeenCalledOnce()
    } finally { await f.checks.close(); await release(f) }
  })
  it.each(['check-id', 'host-sha', 'suite', 'closure', 'profile'] as const)('rejects invalid completed %s evidence before persisting', async kind => {
    const f = await mainFixture()
    try {
      const receipt = f.proof.completedNativeQualification!
      if (kind === 'check-id') receipt.checkId = randomUUID()
      if (kind === 'host-sha') receipt.binarySha256 = 'f'.repeat(64)
      if (kind === 'suite') receipt.record.suiteRevision = 'previous-suite'
      if (kind === 'closure') receipt.record.checks = receipt.record.checks.filter(check => check.id !== 'owned-resource-closure')
      if (kind === 'profile') receipt.record.profile = 'codex-0.154'
      await expect(f.checks.check(f.principal, 'mcp', f.input)).rejects.toMatchObject({ code: 'HARNESS_PROFILE_EVIDENCE_MISMATCH' })
      expect(f.query.mock.calls.some(([sql]) => String(sql).includes('insert into harness_qualifications'))).toBe(false)
      expect(f.append).not.toHaveBeenCalled()
    } finally { await f.checks.close(); await release(f) }
  })
})


it('passes the selected account environment to native qualification scenarios', async () => {
  const f = await fixture()
  const run = f.run.getMockImplementation()!
  f.run.mockImplementation(async input => {
    if (input.environment?.CODEX_HOME !== join(f.directory, 'account')) {
      return { checks: [{ id: 'thread-start', passed: false, detail: 'Default account signed out' }], evidence: {} }
    }
    return run(input)
  })
  try {
    await expect(f.qualifier.qualify(f.value, { checkId: f.checkId, signal: new AbortController().signal }))
      .resolves.toMatchObject({ qualified: true, authenticated: true })
  } finally { await release(f) }
})
