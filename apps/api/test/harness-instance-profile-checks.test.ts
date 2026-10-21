import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import type { HostHarnessOverride, HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import type { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { HostHarnessInstanceProfileChecks, nativeProfileCheckId } from '../src/modules/harnesses/instanceSettings/profileChecks.js'
import { DomainError } from '../src/modules/errors.js'
import { DeviceApplicationError } from '../src/modules/devices/deviceApplicationError.js'
import { assertDeviceHostInstallation } from '../src/modules/devices/hostAuthorization.js'
import { harnessConnectionGeneration } from '../src/modules/harnesses/hostConnectionGeneration.js'
import type { HarnessInstallationRecord } from '../src/modules/harnesses/installationRegistry.js'
import type { NativeQualificationRetention } from '../src/modules/harnesses/installedNativeQualificationRetention.js'
import { completedNativeQualificationChecks } from '../src/modules/harnesses/installedNativeQualification.js'
import { HostHarnessOverrideService } from '../src/modules/harnesses/instanceSettings/service.js'

vi.mock('../src/modules/devices/hostAuthorization.js', () => ({ assertDeviceHostInstallation: vi.fn() }))

const mainId = '00000000-0000-4000-8000-000000000001'
const principal: ManagementPrincipal = { id: 'writer', name: 'Writer', audience: 'operator', revokedAt: null, expiresAt: '9999-12-31T00:00:00.000Z', grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }] }
function fixture(nativeRetention?: NativeQualificationRetention) {
  let current: HostHarnessOverride = { instanceId: randomUUID(), revision: 1, instanceRevision: '1', target: { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId, harnessInstallationId: 'codex', installationFingerprint: 'sha' },
    presetId: 'local-default:codex', driverId: 'codex', enabled: true, configuration: { harness: 'codex', model: 'test', reasoningEffort: 'high', sandbox: 'read-only', serviceTier: 'standard' }, configurationFingerprint: 'profile-sha', qualification: 'unqualified' }
  const client = { query: vi.fn(async () => undefined) } as unknown as pg.PoolClient
  const profiles = new Map([[current.instanceId, current]])
  let readTransaction = false
  const settings = { latest: async (_client: pg.PoolClient, id: string) => structuredClone(profiles.get(id) ?? null),
    list: async () => structuredClone([...profiles.values()]),
    prioritizeForRuns: vi.fn(async (values: HostHarnessOverride[]) => values),
    withProfileConnection: async (work: (client: pg.PoolClient) => Promise<unknown>) => work(client),
    lockRevision: vi.fn(async () => undefined),
    readAuthorized: async (work: (client: pg.PoolClient) => Promise<unknown>) => { readTransaction = true; try { return await work(client) } finally { readTransaction = false } } } as unknown as HarnessInstanceSettingsRepository
  const stored = new Map<string, { value: HostHarnessOverride; proof: HostHarnessProfileEvidence }>()
  const append = vi.fn(async (_client: pg.PoolClient, checkId: string, value: HostHarnessOverride, proof: HostHarnessProfileEvidence) => {
    stored.set(checkId, { value: structuredClone(value), proof })
  })
  const proofs = { findCheck: async (id: string) => stored.get(id)?.proof ?? null,
    latest: async (id: string, revision: number) => [...stored.values()]
      .filter(entry => entry.value.instanceId === id && entry.value.revision === revision).at(-1)?.proof ?? null,
    previouslyQualified: async (value: HostHarnessOverride) => [...stored.values()].some(entry =>
      entry.value.instanceId === value.instanceId && entry.value.instanceRevision === value.instanceRevision
      && entry.proof.qualified && entry.proof.authenticated && entry.proof.compatible),
    append } as unknown as HostHarnessProfileEvidenceRepository
  const commands = { execute: vi.fn(async (command: { authorize: (client: pg.PoolClient) => Promise<void>; perform: (client: pg.PoolClient) => Promise<unknown> }) => {
    await command.authorize(client); return { value: await command.perform(client), replayed: false }
  }) } as unknown as PostgresCommandCoordinator
  const authorize = vi.fn(async () => undefined)
  const proof = (value: HostHarnessOverride): HostHarnessProfileEvidence => ({ target: value.target, instanceRevision: value.instanceRevision, configurationFingerprint: value.configurationFingerprint, driverId: value.driverId,
    driverRevision: '1', protocolRevision: '1', suiteRevision: 'suite', environmentGeneration: 'env', connectionGeneration: 'local', authenticated: true, compatible: true, qualified: true, checkedAt: new Date().toISOString() })
  const qualify = vi.fn<(value: HostHarnessOverride, input: { checkId: string; signal: AbortSignal }) => Promise<HostHarnessProfileEvidence>>(async value => {
    expect(readTransaction).toBe(false)
    return proof(value)
  })
  const service = new HostHarnessInstanceProfileChecks(settings, proofs, commands, { authorize }, { qualify }, nativeRetention)
  const input = { commandId: randomUUID(), instanceId: current.instanceId, expectedRevision: current.revision, target: current.target }
  return { service, qualify, append, proof, input, authorize, settings, commands, proofs,
    seed: (evidence: HostHarnessProfileEvidence, value = current) => stored.set(`previous:${value.instanceId}`, { value, proof: evidence }),
    setOverride: (value: HostHarnessOverride) => { current = value; profiles.set(value.instanceId, value) },
    change: () => {
      current = { ...current, revision: 2, instanceRevision: '2' }
      profiles.set(current.instanceId, current)
    } }
}
describe('explicit exact-host native profile checks', () => {
  it('checks outside authority transactions and recovers persisted proof without repeating native effects', async () => {
    const f = fixture()
    const first = await f.service.check(principal, 'mcp', f.input)
    expect(first.value.proof.qualified).toBe(true)
    expect(f.commands.execute).toHaveBeenCalledWith(expect.objectContaining({ dedicatedConnection: true, operation: 'harness.instance.check' }))
    expect(f.settings.lockRevision).toHaveBeenCalled()
    expect((await f.service.check(principal, 'http', f.input)).value.proof).toEqual(first.value.proof)
    expect(f.qualify).toHaveBeenCalledTimes(1)
    await f.service.close()
  })
  it('requires both grants and rejects another target profile or a concurrently changed revision', async () => {
    const f = fixture()
    await expect(f.service.check({ ...principal, grants: [{ actions: ['harnesses:read'], scope: {} }] }, 'mcp', f.input)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    f.qualify.mockImplementationOnce(async value => ({ ...f.proof(value), configurationFingerprint: 'other' }))
    await expect(f.service.check(principal, 'mcp', f.input)).rejects.toMatchObject({ code: 'HARNESS_PROFILE_EVIDENCE_MISMATCH' })
    f.qualify.mockImplementationOnce(async value => { f.change(); return f.proof(value) })
    await expect(f.service.check(principal, 'mcp', f.input)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(f.append).not.toHaveBeenCalled()
    await f.service.close()
  })
  it('returns Worker contention to explicit callers without retrying or recording a failure', async () => {
    const f = fixture()
    f.qualify.mockRejectedValue(new DomainError('DEVICE_BUSY', 'The device is busy.', 503))
    await expect(f.service.check(principal, 'mcp', f.input)).rejects.toMatchObject({ code: 'DEVICE_BUSY' })
    expect(f.qualify).toHaveBeenCalledTimes(1)
    expect(f.append).not.toHaveBeenCalled()
    await f.service.close()
  })
  it('aborts and joins owned checks on shutdown without persisting a late success', async () => {
    const f = fixture()
    let started!: () => void
    const admitted = new Promise<void>(resolve => { started = resolve })
    f.qualify.mockImplementationOnce(async value => { started(); await new Promise<void>(resolve => setTimeout(resolve, 10)); return f.proof(value) })
    const check = f.service.check(principal, 'http', f.input)
    await admitted
    const rejected = expect(check).rejects.toThrow('stopping')
    await f.service.close(); await rejected
    expect(f.append).not.toHaveBeenCalled()
    await expect(f.service.check(principal, 'http', f.input)).rejects.toMatchObject({ code: 'HARNESS_CHECK_SHUTTING_DOWN' })
  })
  it('keeps native check identity distinct from caller command and other principals/mains', () => {
    const commandId = randomUUID(), id = nativeProfileCheckId(mainId, principal.id, commandId)
    expect(id).not.toBe(commandId)
    expect(nativeProfileCheckId(mainId, principal.id, commandId)).toBe(id)
    expect(nativeProfileCheckId(mainId, 'other', commandId)).not.toBe(id)
    expect(nativeProfileCheckId('other-main', principal.id, commandId)).not.toBe(id)
  })
})

function workerFixture(nativeRetention?: NativeQualificationRetention) {
  const f = fixture(nativeRetention)
  const binding = { mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(), bootId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, connectionGeneration: 2, connectionEpoch: randomUUID() }
  const host = { kind: 'device' as const, mainId, deviceId: binding.deviceId }
  const override: HostHarnessOverride = { instanceId: f.input.instanceId, revision: 1, instanceRevision: '1',
    target: { ...f.input.target, hostRef: host, applicationInstallationId: binding.workerInstallationId },
    presetId: 'worker-codex', driverId: 'codex', enabled: true,
    configuration: { harness: 'codex', model: 'test', reasoningEffort: 'high', sandbox: 'read-only', serviceTier: 'standard' },
    configurationFingerprint: 'profile-sha', qualification: 'unqualified' }
  f.setOverride(override)
  vi.mocked(assertDeviceHostInstallation).mockResolvedValue({ ...binding,
    publicKeyFingerprint: 'a'.repeat(64), status: 'paired', scopes: ['connect', 'heartbeat'] })
  f.qualify.mockImplementation(async selected => ({ ...f.proof(selected),
    connectionGeneration: harnessConnectionGeneration(binding) }))
  return { ...f, binding, host, override }
}

describe('persisted native profile failures', () => {
  it.each(['requested', 'installation'] as const)(
    'keeps the native reason when discovery fails after a %s check commits', async mode => {
      let release!: () => void
      const refreshBlocked = new Promise<void>(resolve => { release = resolve })
      let refreshed!: () => void
      const refreshStarted = new Promise<void>(resolve => { refreshed = resolve })
      const refreshFailure = new DeviceApplicationError('timeout')
      const retention: NativeQualificationRetention = {
        retain: async () => async () => {},
        refresh: async () => {
          refreshed()
          await refreshBlocked
          throw refreshFailure
        },
      }
      const f = workerFixture(retention)
      f.seed(f.proof(f.override))
      const failure = { code: 'CODEX_MODEL_UNAVAILABLE', message: 'The selected native model is unavailable.' }
      f.qualify.mockImplementation(async (value, input) => {
        const checkedAt = new Date().toISOString()
        const binarySha256 = 'a'.repeat(64)
        return { ...f.proof(value), authenticated: null, compatible: null, qualified: false, failure,
          completedNativeQualification: { purpose: 'explicit-host-qualification', checkId: input.checkId,
            binding: f.binding, target: value.target, binarySha256,
            record: { harness: 'codex', version: '0.156.1', binarySha256, profile: 'codex-0.156',
              suiteRevision: 'codex-live-5', status: 'failed', startedAt: checkedAt, checkedAt,
              failureReason: failure.message, checks: completedNativeQualificationChecks().map(id => ({
                id, passed: id !== 'selected-profile', detail: id === 'selected-profile' ? failure.code : null,
              })) } },
        }
      })
      const installation: HarnessInstallationRecord = { hostRef: f.host,
        harnessInstallationId: f.override.target.harnessInstallationId,
        installationFingerprint: f.override.target.installationFingerprint,
        driverId: 'codex', driverRevision: '1', protocolRevision: '1', environmentGeneration: 'env',
        connectionGeneration: harnessConnectionGeneration(f.binding), observedVersion: null,
        installed: true, authenticated: null, compatible: null, qualified: null,
        launcher: { requested: 'codex', resolvedLauncher: null, fingerprint: null, status: 'installed',
          interpreter: null, diagnostics: [], checkedAt: new Date().toISOString(),
          environment: { generation: 'env', provenance: 'worker', cwd: '/workspace', path: '/usr/bin' } } }
      const task = (mode === 'requested'
        ? f.service.checkAutomatically(f.override, installation)
        : f.service.recheckInstallation({ host: f.host, driverId: 'codex',
          applicationInstallationId: f.binding.workerInstallationId, generation: 'updated-generation',
          signal: new AbortController().signal, authorize: async () => {}, installation: () => installation }))
        .then(() => undefined, error => error)
      try {
        await refreshStarted
        expect(await f.service.failure(f.override)).toEqual(failure)
        release()
        expect(await task).toBeDefined()
        expect(await f.service.failure(f.override)).toEqual(failure)
        expect(f.append).toHaveBeenCalledTimes(1)
        expect(f.service.pending(f.override)).toBe(false)
        const readback = new HostHarnessOverrideService(f.settings, f.commands,
          { authorize: f.authorize }, value => f.proofs.latest(value.instanceId, value.revision), f.service)
        const result = await readback.list(principal, { hostRef: f.host,
          applicationInstallationId: f.binding.workerInstallationId }, 'mcp')
        expect(result.overrides[0]).toMatchObject({ qualification: 'unqualified', qualificationFailure: failure })
        await expect(readback.ensureReady(f.override)).rejects.toMatchObject({ code: failure.code })
      } finally {
        release()
        await task
        await f.service.close()
      }
    })
})

describe('automatic installation profile checks', () => {
  function updatedFixture() {
    const f = fixture()
    const saved = { instanceId: f.input.instanceId, revision: 1, instanceRevision: '1', target: f.input.target,
      presetId: 'local-default:codex', driverId: 'codex', enabled: true, qualification: 'unqualified' as const,
      configuration: { harness: 'codex' as const, model: 'test', reasoningEffort: 'high' as const,
        sandbox: 'read-only' as const, serviceTier: 'standard' as const }, configurationFingerprint: 'profile-sha' }
    f.seed(f.proof(saved))
    const installation: HarnessInstallationRecord = { hostRef: saved.target.hostRef,
      harnessInstallationId: saved.target.harnessInstallationId, installationFingerprint: 'updated-fingerprint',
      driverId: 'codex', driverRevision: '1', protocolRevision: 'codex-native-adapter-v1',
      environmentGeneration: 'env', connectionGeneration: 'local', observedVersion: null,
      installed: true, authenticated: null, compatible: null, qualified: null,
      launcher: { requested: '/installed/codex', resolvedLauncher: '/installed/codex',
        fingerprint: 'updated-fingerprint', status: 'installed', interpreter: null, diagnostics: [],
        checkedAt: new Date().toISOString(),
        environment: { generation: 'env', provenance: 'terminal', cwd: '/workspace', path: '/usr/bin' } } }
    f.settings.replaceInstallation = vi.fn(async (_client, previous, target) => {
      const value = { ...previous, target, revision: previous.revision + 1 }
      f.setOverride(value)
      return value
    })
    const authorize = vi.fn(async () => {})
    const request = { host: saved.target.hostRef, driverId: 'codex', applicationInstallationId: mainId,
      generation: 'updated-generation', signal: new AbortController().signal, authorize,
      installation: () => installation }
    return { ...f, saved, installation, request }
  }
  it.each(['requested', 'installation'] as const)(
    'keeps a %s check pending through repeated Worker contention, then persists qualification', async mode => {
      const f = updatedFixture()
      let busy = true
      f.qualify.mockImplementation(async value => {
        if (busy) throw new DomainError('DEVICE_BUSY', 'The device is busy.', 503)
        return f.proof(value)
      })
      const task = (mode === 'requested'
        ? f.service.checkAutomatically(f.saved, f.installation)
        : f.service.recheckInstallation(f.request)).then(() => null, error => error)
      try {
        await vi.waitFor(() => expect(f.qualify.mock.calls.length).toBeGreaterThanOrEqual(2))
        const selected = f.qualify.mock.calls[0]![0]
        expect(f.service.pending(selected)).toBe(true)
        expect(await f.service.failure(selected)).toBeUndefined()
        expect(f.append).not.toHaveBeenCalled()
        busy = false
        expect(await task).toBeNull()
        expect(f.append).toHaveBeenCalledTimes(1)
        expect(f.append.mock.calls[0]![3]).toMatchObject({ qualified: true })
        expect(f.service.pending(selected)).toBe(false)
      } finally {
        busy = false
        await f.service.close()
        await task
      }
    })
  it('cancels an automatic busy retry on shutdown without persisting a qualification failure', async () => {
    const f = updatedFixture()
    f.qualify.mockRejectedValue(new DomainError('DEVICE_BUSY', 'The device is busy.', 503))
    const task = f.service.checkAutomatically(f.saved, f.installation).then(() => null, error => error)
    try {
      await vi.waitFor(() => expect(f.qualify.mock.calls.length).toBeGreaterThanOrEqual(2))
      expect(f.service.pending(f.saved)).toBe(true)
      await f.service.close()
      expect(await task).toBeInstanceOf(Error)
      expect(f.append).not.toHaveBeenCalled()
      expect(f.service.pending(f.saved)).toBe(false)
    } finally {
      await f.service.close()
      await task
    }
  })
  it('revalidates the profile revision before retrying a busy automatic check', async () => {
    const f = updatedFixture()
    f.qualify.mockImplementationOnce(async () => {
      f.change()
      throw new DomainError('DEVICE_BUSY', 'The device is busy.', 503)
    })
    try {
      await expect(f.service.checkAutomatically(f.saved, f.installation))
        .rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
      expect(f.qualify).toHaveBeenCalledTimes(1)
      expect(f.append).not.toHaveBeenCalled()
    } finally {
      await f.service.close()
    }
  })
  it('deduplicates requested automatic checks per instance revision and persists their result', async () => {
    const f = updatedFixture()
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    f.qualify.mockImplementation(async value => {
      await waiting
      return f.proof(value)
    })
    const task = f.service.checkAutomatically(f.saved, f.installation)
    expect(f.service.checkAutomatically(f.saved, f.installation)).toBe(task)
    expect(f.service.pending(f.saved)).toBe(true)
    const explicit = f.service.check(principal, 'mcp', f.input)
    release()
    await task
    expect((await explicit).value.proof.qualified).toBe(true)
    expect(f.qualify).toHaveBeenCalledTimes(1)
    expect(f.append).toHaveBeenCalledTimes(1)
    expect(f.service.pending(f.saved)).toBe(false)
    const changed = { ...f.saved, revision: 2, instanceRevision: '2' }
    f.setOverride(changed)
    await f.service.checkAutomatically(changed, f.installation)
    expect(f.qualify).toHaveBeenCalledTimes(2)
    await f.service.close()
  })
  it('persists the real reason when a requested automatic check throws', async () => {
    const f = updatedFixture()
    f.qualify.mockRejectedValueOnce(new DomainError('CODEX_MODEL_UNAVAILABLE', 'Model unavailable.', 422))
    await expect(f.service.checkAutomatically(f.saved, f.installation))
      .rejects.toMatchObject({ code: 'CODEX_MODEL_UNAVAILABLE' })
    expect(await f.service.failure(f.saved)).toEqual({ code: 'CODEX_MODEL_UNAVAILABLE', message: 'Model unavailable.' })
    expect(f.service.pending(f.saved)).toBe(false)
    await f.service.close()
  })
  it('leaves qualified Codex profiles and their proofs unchanged after a Claude installation update', async () => {
    const f = updatedFixture()
    const beforeChecks = vi.fn(async () => {})
    await f.service.recheckInstallation({ ...f.request, driverId: 'claude', beforeChecks })
    expect(beforeChecks).not.toHaveBeenCalled()
    expect(f.qualify).not.toHaveBeenCalled()
    expect(f.settings.replaceInstallation).not.toHaveBeenCalled()
    expect(f.append).not.toHaveBeenCalled()
    await f.service.close()
  })
  it('deduplicates an update and reports pending until the replacement profile is persisted', async () => {
    const f = updatedFixture()
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    f.qualify.mockImplementationOnce(async selected => {
      started()
      await waiting
      return f.proof(selected)
    })
    const task = f.service.recheckInstallation(f.request)
    expect(f.service.recheckInstallation(f.request)).toBe(task)
    await entered
    const selected = f.qualify.mock.calls[0]![0]
    expect(() => f.service.assertReady(selected)).toThrow(expect.objectContaining({ code: 'HARNESS_PROFILE_CHECK_PENDING' }))
    release()
    await task
    expect(() => f.service.assertReady(selected)).not.toThrow()
    expect(selected.instanceRevision).toBe(f.saved.instanceRevision)
    expect(selected.revision).toBe(2)
    expect(selected.configuration).toEqual(f.saved.configuration)
    expect(selected.target.installationFingerprint).toBe(f.installation.installationFingerprint)
    expect(f.append).toHaveBeenCalledTimes(1)
    await f.service.close()
  })
  it('persists a thrown qualification failure with a reason on the updated profile', async () => {
    const f = updatedFixture()
    f.qualify.mockRejectedValueOnce(new Error('Native check failed'))
    await expect(f.service.recheckInstallation(f.request)).rejects.toThrow('Automatic harness profile checks failed')
    const proof = f.append.mock.calls[0]![3]
    expect(proof.qualified).toBe(false)
    expect(proof.target.installationFingerprint).toBe(f.installation.installationFingerprint)
    expect(proof.failure).toMatchObject({ code: 'HARNESS_QUALIFICATION_FAILED' })
    expect(proof.failure!.message).not.toContain('Native check failed')
    expect(f.service.pending(f.saved)).toBe(false)
    await f.service.close()
  })
  it('does not record a stale Worker target as the updated profile verdict', async () => {
    const f = updatedFixture()
    f.qualify.mockRejectedValueOnce(new DeviceApplicationError('HARNESS_QUALIFICATION_TARGET_CHANGED'))
    await expect(f.service.recheckInstallation(f.request)).rejects.toThrow('Automatic harness profile checks failed')
    expect(f.append).not.toHaveBeenCalled()
    const updated = f.qualify.mock.calls[0]![0]
    expect(await f.service.failure(updated)).toBeUndefined()
    expect(f.service.pending(updated)).toBe(false)
    f.qualify.mockRejectedValueOnce(new DomainError('CODEX_MODEL_UNAVAILABLE', 'Model unavailable.', 422))
    await expect(f.service.recheckInstallation(f.request)).rejects.toThrow('Automatic harness profile checks failed')
    expect(await f.service.failure(updated)).toMatchObject({ code: 'CODEX_MODEL_UNAVAILABLE' })
    await f.service.close()
  })
  it('rechecks stale higher-priority profiles on the refreshed inventory before lower-priority profiles', async () => {
    const f = updatedFixture()
    const unused = [randomUUID(), randomUUID(), randomUUID()].map(instanceId => ({ ...f.saved, instanceId }))
    for (const value of unused) {
      f.setOverride(value)
      f.seed(f.proof(value), value)
    }
    const active = f.saved.instanceId
    const stale = new Set([active, unused[0]!.instanceId])
    f.qualify.mockImplementation(async value => {
      if (stale.delete(value.instanceId)) throw new DeviceApplicationError('HARNESS_QUALIFICATION_TARGET_CHANGED')
      return f.proof(value)
    })
    const refresh = vi.fn(async () => {})
    const outcome = await f.service.recheckInstallation({ ...f.request, refresh }).then(() => null, error => error)
    const checked = f.qualify.mock.calls.map(([value]) => value.instanceId)
    // Both slots retry their stale profile before any lower-priority profile is checked.
    expect(checked.slice(0, 4).sort()).toEqual([active, active, unused[0]!.instanceId, unused[0]!.instanceId].sort())
    expect(checked.slice(4).sort()).toEqual([unused[1]!.instanceId, unused[2]!.instanceId].sort())
    expect(refresh).toHaveBeenCalled()
    expect(outcome).toBeNull()
    expect(f.append.mock.calls.map(call => call[2].instanceId).sort())
      .toEqual([active, ...unused.map(value => value.instanceId)].sort())
    expect(f.append.mock.calls.every(call => call[3].qualified)).toBe(true)
    for (const [value] of f.qualify.mock.calls) expect(f.service.pending(value)).toBe(false)
    await f.service.close()
  })
  it('releases each updated profile after its own check while another profile remains pending', async () => {
    const f = updatedFixture()
    const other = { ...f.saved, instanceId: randomUUID() }
    f.setOverride(other)
    f.seed(f.proof(other), other)
    const releases = new Map<string, () => void>()
    let draining = false
    f.qualify.mockImplementation(async selected => {
      if (!draining) await new Promise<void>(resolve => { releases.set(selected.instanceId, resolve) })
      return f.proof(selected)
    })
    const task = f.service.recheckInstallation(f.request)
    try {
      await vi.waitFor(() => expect(releases.size).toBe(2))
      const selected = f.qualify.mock.calls.find(([value]) => value.instanceId === f.saved.instanceId)![0]
      const pending = f.qualify.mock.calls.find(([value]) => value.instanceId === other.instanceId)![0]
      expect(() => f.service.assertReady(selected)).toThrow(expect.objectContaining({
        code: 'HARNESS_PROFILE_CHECK_PENDING', details: expect.objectContaining({ retryable: true }),
      }))
      releases.get(selected.instanceId)!()
      await vi.waitFor(() => expect(f.service.pending(selected)).toBe(false))
      expect(() => f.service.assertReady(selected)).not.toThrow()
      expect(() => f.service.assertReady(pending)).toThrow(expect.objectContaining({
        code: 'HARNESS_PROFILE_CHECK_PENDING', details: expect.objectContaining({ retryable: true }),
      }))
      expect(f.append.mock.calls.map(call => call[2].instanceId)).toEqual([selected.instanceId])
    } finally {
      draining = true
      for (const release of releases.values()) release()
      await task
      await f.service.close()
    }
  })
  it('refuses to retain success when the host authority changes during the native check', async () => {
    const f = updatedFixture()
    f.qualify.mockImplementationOnce(async selected => {
      f.request.authorize.mockRejectedValue(new Error('Host registration changed'))
      return f.proof(selected)
    })
    await expect(f.service.recheckInstallation(f.request)).rejects.toThrow('Host registration changed')
    expect(f.append).not.toHaveBeenCalled()
    await f.service.close()
  })
})

describe('Worker reconnect profile checks', () => {
  it('retries a busy reconnect check until the Worker can qualify the profile', async () => {
    const f = workerFixture()
    f.seed(f.proof(f.override))
    f.qualify.mockRejectedValueOnce(new DomainError('DEVICE_BUSY', 'The device is busy.', 503))
    try {
      await f.service.recheckWorker(f.binding, new AbortController().signal, () => f.binding)
      expect(f.qualify).toHaveBeenCalledTimes(2)
      expect(f.append).toHaveBeenCalledTimes(1)
      expect(f.append.mock.calls[0]![3]).toMatchObject({
        qualified: true, connectionGeneration: harnessConnectionGeneration(f.binding),
      })
      expect(f.service.pending(f.override)).toBe(false)
    } finally {
      await f.service.close()
    }
  })
  it('checks at most two profiles at once and admits each completed revision independently', async () => {
    const f = workerFixture()
    const profiles = [f.override, ...Array.from({ length: 3 }, () => ({ ...f.override, instanceId: randomUUID() }))]
    for (const profile of profiles) {
      f.setOverride(profile)
      f.seed(f.proof(profile), profile)
    }
    const releases = new Map<string, () => void>()
    let draining = false
    let active = 0
    let maximum = 0
    f.qualify.mockImplementation(async selected => {
      active++
      maximum = Math.max(maximum, active)
      if (!draining) await new Promise<void>(resolve => { releases.set(selected.instanceId, resolve) })
      active--
      return { ...f.proof(selected), connectionGeneration: harnessConnectionGeneration(f.binding) }
    })
    const task = f.service.recheckWorker(f.binding, new AbortController().signal, () => f.binding)
    try {
      await vi.waitFor(() => expect(releases.size).toBe(2))
      expect(f.qualify).toHaveBeenCalledTimes(2)
      for (const profile of profiles) expect(f.service.pending(profile)).toBe(true)
      releases.get(profiles[0]!.instanceId)!()
      await vi.waitFor(() => expect(releases.size).toBe(3))
      expect(() => f.service.assertReady(profiles[0]!)).not.toThrow()
      expect(() => f.service.assertReady(profiles[1]!)).toThrow(expect.objectContaining({
        code: 'HARNESS_PROFILE_CHECK_PENDING', details: expect.objectContaining({ retryable: true }),
      }))
      releases.get(profiles[1]!.instanceId)!()
      await vi.waitFor(() => expect(releases.size).toBe(4))
      expect(maximum).toBe(2)
    } finally {
      draining = true
      for (const release of releases.values()) release()
      await task
      await f.service.close()
    }
    expect(f.append).toHaveBeenCalledTimes(4)
    for (const profile of profiles) expect(() => f.service.assertReady(profile)).not.toThrow()
  })
  it('checks an enabled qualified profile once per connection and refuses Start while it runs', async () => {
    const f = workerFixture()
    f.seed(f.proof(f.override))
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    f.qualify.mockImplementationOnce(async selected => {
      started()
      await waiting
      return { ...f.proof(selected), connectionGeneration: harnessConnectionGeneration(f.binding) }
    })
    const signal = new AbortController().signal
    const task = f.service.recheckWorker(f.binding, signal, () => f.binding)
    expect(f.service.recheckWorker(f.binding, signal, () => f.binding)).toBe(task)
    await entered
    expect(() => f.service.assertReady(f.override)).toThrow(expect.objectContaining({
      code: 'HARNESS_PROFILE_CHECK_PENDING', details: expect.objectContaining({ retryable: true }),
    }))
    release()
    await task
    expect(() => f.service.assertReady(f.override)).not.toThrow()
    await f.service.recheckWorker(f.binding, signal, () => f.binding)
    expect(f.qualify).toHaveBeenCalledTimes(1)
    expect(f.append).toHaveBeenCalledTimes(1)
    await f.service.close()
  })

  it.each(['disabled', 'unqualified', 'never-checked'] as const)('leaves a %s profile unchecked', async state => {
    const f = workerFixture()
    if (state !== 'never-checked') f.seed({ ...f.proof(f.override), qualified: state !== 'unqualified' })
    if (state === 'disabled') f.setOverride({ ...f.override, enabled: false })
    await f.service.recheckWorker(f.binding, new AbortController().signal, () => f.binding)
    expect(f.qualify).not.toHaveBeenCalled()
    expect(f.append).not.toHaveBeenCalled()
    await f.service.close()
  })

  it('discards a successful native result when the Worker restarts before persistence', async () => {
    const f = workerFixture()
    f.seed(f.proof(f.override))
    let current = f.binding
    f.qualify.mockImplementationOnce(async selected => {
      current = { ...current, bootId: randomUUID(), connectionGeneration: 3 }
      return { ...f.proof(selected), connectionGeneration: harnessConnectionGeneration(f.binding) }
    })
    await expect(f.service.recheckWorker(f.binding, new AbortController().signal, () => current))
      .rejects.toThrow('Automatic Worker profile checks failed')
    expect(f.append).not.toHaveBeenCalled()
    expect(() => f.service.assertReady(f.override)).not.toThrow()
    await f.service.close()
  })
})
