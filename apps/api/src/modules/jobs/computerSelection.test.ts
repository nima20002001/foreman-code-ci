import { randomUUID } from 'node:crypto'
import { createSourceManifest, sourceSha256 } from '../sources/manifest.js'
import { sourceMaterializationBytes } from '../sources/footprint.js'
import { SOURCE_AGGREGATE_LIMITS } from '../sources/reservations.js'
import { describe, expect, it, vi } from 'vitest'
import { verificationCapacityFixture } from '../../../test/helpers/verificationCapacityFixture.js'
import { sourceStorageCapacityFixture } from '../../../test/helpers/sourceStorageCapacityFixture.js'
import { verificationFixture } from '../../../test/helpers/jobVerificationFixture.js'
import { JobDefinitionRecordSchema, jobPolicyRequirementsRecord } from '@foreman-code/contracts/job-verification'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { BuildComputerPreference } from '@foreman-code/contracts/build-computers'
import { buildComputerTarget, type BuildComputerSettings } from '../settings/buildComputers.js'
import type { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import type { JobSql } from './repository.js'
import { buildComputerFixture } from '../../../test/helpers/buildComputerFixture.js'
import { JobComputerSelection, compatibleJobComputer, jobComputerCapacity, jobComputerCapacityDecision, jobEligibilityReason, orderBuildComputers, orderForPlacement } from './computerSelection.js'

const mainId = '11111111-1111-4111-8111-111111111111'

function settingsFixture(read: (target: ReturnType<typeof buildComputerTarget>) => BuildComputerPreference) {
  return {
    preferences: async (_sql: JobSql, targets: ReturnType<typeof buildComputerTarget>[]) => targets.map(read),
    requireEnabled: async (_sql: JobSql, target: ReturnType<typeof buildComputerTarget>) => read(target),
  } as unknown as BuildComputerSettings
}

it('inspects an explicit launch override without reserving and permits an offline computer to wait', async () => {
  const { candidate, auto } = buildComputerFixture(mainId, 'workspace-fixture')
  candidate.ready = false
  candidate.reasons = ['offline']
  const preference = { target: buildComputerTarget(candidate.spec.target), revision: 1, buildEnabled: true,
    buildPriority: 100, buildAllowancePercent: 100 }
  const candidates = vi.fn(async () => ({ candidates: [candidate], diagnosticCodes: [] }))
  const settings = settingsFixture(() => preference)
  const selection = new JobComputerSelection(settings, { candidates },
    { requireEnabled: vi.fn() } as unknown as WorkerExecutionPolicy)
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
  const sql = { query } as unknown as JobSql
  const principal = {} as ManagementPrincipal
  const placementOverride = { kind: 'explicit' as const, target: candidate.spec.target }
  expect(await selection.validateRequest(sql, principal, 'workspace-fixture', auto, placementOverride))
    .toEqual({ valid: false, canQueue: true, reasons: ['offline'], sideEffects: false })
  expect(candidates).toHaveBeenCalledWith(sql, principal, 'workspace-fixture', auto, placementOverride, {})
  expect(query).toHaveBeenCalledTimes(1)
  candidate.reasons = ['AUTH_REVOKED']
  expect(await selection.validateRequest(sql, principal, 'workspace-fixture', auto, placementOverride))
    .toMatchObject({ valid: false, canQueue: false })
  candidate.reasons = ['offline']
  expect(await selection.validateRequest(sql, principal, 'workspace-fixture', auto, {
    kind: 'explicit', target: { ...candidate.spec.target, mainInstallationId: 'replacement-installation' },
  })).toMatchObject({ valid: false, canQueue: false, reasons: ['incompatible'] })
  // A later listing re-attests the same root; the explicit choice still names this computer and root.
  const destination = candidate.spec.target.destination
  expect(await selection.validateRequest(sql, principal, 'workspace-fixture', auto, { kind: 'explicit', target: {
    ...candidate.spec.target, destination: { ...destination, attestationId: '22222222-2222-4222-8222-222222222222',
      attestationHash: 'f'.repeat(64) } } })).toEqual({ valid: false, canQueue: true, reasons: ['offline'], sideEffects: false })
  expect(await selection.validateRequest(sql, principal, 'workspace-fixture', auto, { kind: 'explicit', target: {
    ...candidate.spec.target, destination: { ...destination, canonicalCwd: `${destination.canonicalCwd}/other` } } }))
    .toMatchObject({ valid: false, canQueue: false, reasons: ['incompatible'] })
})

function capacityRows(profile: ReturnType<typeof verificationCapacityFixture>, computing: number, retained = 0): JobSql {
  const rows = Array.from({ length: computing + retained }, (_, index) => ({
    limits: profile.spec.resources.limits, compute_closed: index >= computing,
  }))
  return { query: vi.fn(async () => ({ rows, rowCount: rows.length,
    command: 'SELECT', fields: [], oid: 0 })) } as unknown as JobSql
}

describe('reviewed verification admission capacity', () => {
  it('reports held source storage as busy', () => {
    expect(jobEligibilityReason('SOURCE_CAPACITY')).toBe('busy')
    expect(jobEligibilityReason('SOURCE_DISK_CAPACITY')).toBe('busy')
    expect(jobEligibilityReason('SOURCE_CAPACITY_UNAVAILABLE')).toBe('busy')
  })
  it('reports busy for a ready computer without adding setup reasons from its unused profiles', async () => {
    const profile = verificationCapacityFixture('device')
    const { spec } = verificationFixture()
    const definition = JobDefinitionRecordSchema.parse({ schemaVersion: 2, id: 'queued-verification',
      workspaceId: profile.workspaceId, name: 'Waiting verification', revision: 1, versionId: 'queued-version',
      createdAt: profile.createdAt, updatedAt: profile.updatedAt,
      spec: { ...spec, target: { kind: 'auto' }, policy: jobPolicyRequirementsRecord(spec.policy),
        limits: profile.spec.resources.limits } })
    const sourceReservation = { scopeId: 'approved-source', reservedBytes: 1024 * 1024 }
    const ready = { spec, profile, ready: true, reasons: [], sourceReservation }
    const unqualified = { ...ready, ready: false, reasons: ['runtime_setup_required'] }
    const preference = { target: buildComputerTarget(spec.target), revision: 1, buildEnabled: true,
      buildPriority: 100, buildAllowancePercent: 100 }
    const settings = settingsFixture(() => preference)
    const selection = new JobComputerSelection(settings, {
      candidates: async () => ({ candidates: [unqualified, ready], diagnosticCodes: [] }),
    }, { requireEnabled: vi.fn() } as unknown as WorkerExecutionPolicy)
    const sql = { query: async () => ({ rowCount: 0, rows: [{ bytes: '0', verification_bytes: '0', materializations: '0', verification_materializations: '2' }] }) } as unknown as JobSql
    expect(await selection.claim(sql, {} as ManagementPrincipal, definition,
      { executionId: 'waiting', attemptId: 'attempt', operationId: 'source-operation' }))
      .toMatchObject({ spec: null, reasons: ['busy'] })
    expect(await selection.validateRequest(sql, {} as ManagementPrincipal, definition.workspaceId, definition.spec))
      .toEqual({ valid: false, canQueue: true, reasons: ['busy'], sideEffects: false })
  })
  it.each(['unqualified', 'qualifying'] as const)('waits for a %s profile instead of treating missing measurements as a zero maximum', async status => {
    const measured = verificationCapacityFixture('main')
    const profile = { ...measured, status, measurement: null }
    const { spec } = verificationFixture()
    const definition = JobDefinitionRecordSchema.parse({ schemaVersion: 2, id: 'queued-verification',
      workspaceId: profile.workspaceId, name: 'Waiting verification', revision: 1, versionId: 'queued-version',
      createdAt: profile.createdAt, updatedAt: profile.updatedAt,
      spec: { ...spec, target: { kind: 'auto' }, policy: jobPolicyRequirementsRecord(spec.policy),
        limits: profile.spec.resources.limits } })
    const candidate = { spec, profile, ready: false, reasons: ['runtime_setup_required'],
      sourceReservation: { scopeId: 'approved-source', reservedBytes: 1024 * 1024 } }
    const preference = { target: buildComputerTarget(spec.target), revision: 1, buildEnabled: true, buildPriority: 100, buildAllowancePercent: 100 }
    const settings = settingsFixture(() => preference)
    const workerExecution = { requireEnabled: vi.fn() } as unknown as WorkerExecutionPolicy
    const selection = new JobComputerSelection(settings,
      { candidates: async () => ({ candidates: [candidate], diagnosticCodes: [] }) }, workerExecution)
    const sql = { query: async () => ({ rowCount: 0, rows: [] }) } as unknown as JobSql
    expect(await selection.claim(sql, {} as ManagementPrincipal, definition,
      { executionId: 'queued-execution', attemptId: 'queued-attempt', operationId: 'queued-operation' }))
      .toMatchObject({ spec: null, exceedsMaximum: false, compatibleTargetCount: 1,
        reasons: ['runtime_setup_required'], selectedHost: null })
    expect(workerExecution.requireEnabled).not.toHaveBeenCalled()
  })
  it('admits the fourth Main Job and leaves a fifth waiting', async () => {
    const profile = verificationCapacityFixture('main')
    const target = { mainId, hostRef: profile.root.selection.hostRef }
    expect(await jobComputerCapacityDecision(capacityRows(profile, 3), target, profile)).toEqual({ fits: true })
    expect(await jobComputerCapacityDecision(capacityRows(profile, 4), target, profile))
      .toEqual({ fits: false, reason: 'busy' })
  })
  it('leaves a Job waiting once the owner build allowance of the computer is used', async () => {
    const profile = verificationCapacityFixture('main')
    const target = { mainId, hostRef: profile.root.selection.hostRef }
    const full = jobComputerCapacity(profile), job = profile.spec.resources.limits
    const percent = Math.max(10, Math.ceil(100 * job.memoryBytes / full.memoryBytes))
    expect(await jobComputerCapacityDecision(capacityRows(profile, 0), target, profile, undefined, percent)).toEqual({ fits: true })
    expect(await jobComputerCapacityDecision(capacityRows(profile, 1), target, profile, undefined, percent))
      .toEqual({ fits: false, reason: 'busy' })
    expect(await jobComputerCapacityDecision(capacityRows(profile, 1), target, profile)).toEqual({ fits: true })
  })
  it('reports a request that cannot fit even an empty computer at the saved allowance', async () => {
    const profile = verificationCapacityFixture('main')
    profile.measurement!.fingerprint.deviceLimits!.cpuLimit = 4
    const target = { mainId, hostRef: profile.root.selection.hostRef }
    expect(await jobComputerCapacityDecision(capacityRows(profile, 0), target, profile, undefined, 10))
      .toEqual({ fits: false, reason: 'request_exceeds_maximum' })
    expect(await jobComputerCapacityDecision(capacityRows(profile, 0), target, profile)).toEqual({ fits: true })
  })
  it('accounts for the provisioned independent byte and inode quotas, including closed retained owners', async () => {
    const profile = verificationCapacityFixture('main')
    const fingerprint = profile.measurement!.fingerprint
    fingerprint.quotaPool!.slots = fingerprint.quotaPool!.slots.slice(0, 4)
    const target = { mainId, hostRef: profile.root.selection.hostRef }
    expect(jobComputerCapacity(profile).diskBytes).toBe(profile.spec.resources.limits.diskBytes * 4)
    expect(await jobComputerCapacityDecision(capacityRows(profile, 2, 2), target, profile))
      .toEqual({ fits: false, reason: 'busy' })
    const inodes = profile.spec.resources.mutableInodes
    const sql = { query: async () => ({ rows: [{ limits: profile.spec.resources.limits,
      compute_closed: false, inodes: inodes * 4 }], rowCount: 1 }) } as unknown as JobSql
    expect(await jobComputerCapacityDecision(sql, target, profile)).toEqual({ fits: false, reason: 'busy' })
  })
  it('requires fresh laptop memory and includes the incoming claim in the headroom calculation', async () => {
    const profile = verificationCapacityFixture('device')
    const target = { mainId, hostRef: profile.root.selection.hostRef }
    const sql = capacityRows(profile, 1)
    expect(await jobComputerCapacityDecision(sql, target, profile, async () => null))
      .toEqual({ fits: false, reason: 'memory_unavailable' })
    expect(await jobComputerCapacityDecision(sql, target, profile, async () => 8 * 2 ** 30 - 1))
      .toEqual({ fits: false, reason: 'memory_headroom_required' })
    expect(await jobComputerCapacityDecision(sql, target, profile, async () => 8 * 2 ** 30)).toEqual({ fits: true })
    expect(await jobComputerCapacityDecision(capacityRows(profile, 2), target, profile, async () => 14 * 2 ** 30))
      .toEqual({ fits: false, reason: 'busy' })
  })
  it('releases closed compute but retains storage and the independently measured concurrency cap', async () => {
    const profile = verificationCapacityFixture('main')
    const target = { mainId, hostRef: profile.root.selection.hostRef }
    expect(await jobComputerCapacityDecision(capacityRows(profile, 0, 3), target, profile)).toEqual({ fits: true })
    expect(await jobComputerCapacityDecision(capacityRows(profile, 0, 7), target, profile))
      .toEqual({ fits: false, reason: 'busy' })
    const measuredOne = verificationCapacityFixture('main', 1)
    expect(await jobComputerCapacityDecision(capacityRows(measuredOne, 1), target, measuredOne))
      .toEqual({ fits: false, reason: 'busy' })
  })
})
function enrolled(priority: number, enabled = true, deviceId?: string) {
  const fixture = buildComputerFixture(mainId, 'workspace', deviceId)
  return { ...fixture.candidate, preference: { target: fixture.target, revision: 1,
    buildEnabled: enabled, buildPriority: priority, buildAllowancePercent: 100 } }
}
describe('build computer ordering', () => {
  it.each([
    ['busy', 'busy'], ['qualification_expired', 'qualification_expired'],
    ['AUTH_REVOKED', 'authorization_revoked'], ['ACCESS_DENIED', 'authorization_revoked'],
    ['JOB_ROOT_PIN_CONFLICT', 'root_changed'], ['JOB_RUNTIME_UNQUALIFIED', 'runtime_unqualified'],
    ['BUILD_COMPUTER_DISABLED', 'disabled'], ['WORKER_EXECUTION_DISABLED', 'remote_execution_disabled'],
    ['unexpected_runtime_error', 'eligibility_check_failed'],
  ])('reports %s as %s without treating unknown eligibility failures as capacity', (code, reason) => {
    expect(jobEligibilityReason(code)).toBe(reason)
  })
  it('tries the calling Agent\'s own computer first, then the rest in build order', () => {
    const primary = enrolled(100, true, '11111111-1111-4111-8111-111111111112')
    const backup = enrolled(90, true, '11111111-1111-4111-8111-111111111113')
    const agentHost = enrolled(10, true, '11111111-1111-4111-8111-111111111114')
    const prefer = { kind: 'prefer' as const, hostRef: agentHost.spec.target.hostRef }
    expect(orderForPlacement([primary, backup, agentHost], prefer)).toEqual([agentHost, primary, backup])
    expect(orderForPlacement([primary, backup, agentHost], { kind: 'auto' })).toEqual([primary, backup, agentHost])
    // A busy or offline own computer is skipped like any other; the job spills to the next computer.
    const offline = { ...agentHost, ready: false, reasons: ['offline'] }
    expect(orderForPlacement([primary, backup, offline], prefer)).toEqual([primary, backup])
  })
  it('skips a disabled high priority computer and prefers 100 to 50', () => {
    const disabled = enrolled(100, false)
    const lower = enrolled(50)
    const higher = enrolled(100)
    expect(orderBuildComputers([lower, disabled, higher])).toEqual([higher, lower])
  })
  it.each(['offline', 'busy', 'incompatible'])('skips a preferred %s computer', reason => {
    const higher = { ...enrolled(100), ready: false, reasons: [reason] }
    const lower = enrolled(50)
    expect(orderBuildComputers([higher, lower])).toEqual([lower])
  })
  it('breaks equal priorities by canonical computer identity regardless of input order', () => {
    const a = enrolled(50, true, '11111111-1111-4111-8111-111111111112')
    const b = enrolled(50, true, '11111111-1111-4111-8111-111111111113')
    expect(orderBuildComputers([b, a])).toEqual([a, b])
    expect(orderBuildComputers([a, b])).toEqual([a, b])
  })
  it('orders every computer by one priority, highest first', () => {
    const low = enrolled(10, true, '11111111-1111-4111-8111-111111111115')
    const high = enrolled(100, true, '11111111-1111-4111-8111-111111111114')
    const middle = enrolled(60, true, '11111111-1111-4111-8111-111111111116')
    expect(orderBuildComputers([low, middle, high])).toEqual([high, middle, low])
  })
  it('lends only the owner build allowance of CPU and memory', () => {
    const candidate = enrolled(50), full = jobComputerCapacity(candidate.profile)
    expect(jobComputerCapacity(candidate.profile, 50)).toEqual({ ...full, cpuLimit: full.cpuLimit / 2,
      memoryBytes: Math.floor(full.memoryBytes / 2) })
    expect(jobComputerCapacity(candidate.profile, 100)).toEqual(full)
  })
  it('keeps an empty pool empty and uses only measured runtime limits', () => {
    expect(orderBuildComputers([enrolled(100, false)])).toEqual([])
    const candidate = enrolled(50)
    expect(jobComputerCapacity(candidate.profile)).toEqual(candidate.profile.limits)
  })
  it('requires the same source, image, toolchain, security, outputs and resource limits', () => {
    const f = buildComputerFixture(mainId, 'workspace')
    expect(compatibleJobComputer(f.candidate, f.auto)).toBe(true)
    for (const changed of [
      { ...f.auto, source: { ...f.auto.source, manifestDigest: '2'.repeat(64) } },
      { ...f.auto, policy: { ...f.auto.policy, imageDigest: `sha256:${'2'.repeat(64)}` } },
      { ...f.auto, policy: { ...f.auto.policy, toolchainDigest: '2'.repeat(64) } },
      { ...f.auto, policy: { ...f.auto.policy, network: 'approved-dependency-fetch' as const } },
      { ...f.auto, limits: { ...f.auto.limits, memoryBytes: f.auto.limits.memoryBytes * 2 } },
      { ...f.auto, outputs: [{ path: 'dist/required.txt', required: true, mediaType: 'text/plain' as const }] },
    ]) expect(compatibleJobComputer(f.candidate, changed)).toBe(false)
  })
})


it.each([false, true])('checks only the requesting source pool during placement (verification: %s)', async verification => {
  const ordinary = buildComputerFixture(mainId, 'workspace-fixture')
  const profile = verification ? verificationCapacityFixture('device') : ordinary.candidate.profile
  const { spec } = verificationFixture()
  const candidate = verification ? { spec, profile, ready: true, reasons: [],
    sourceReservation: { scopeId: 'same-filesystem', reservedBytes: 1024 } } : ordinary.candidate
  const requested = verification ? JobDefinitionRecordSchema.parse({ schemaVersion: 2, id: 'pool-request',
    versionId: 'pool-version', workspaceId: profile.workspaceId, name: 'Independent pools', revision: 1,
    createdAt: profile.createdAt, updatedAt: profile.updatedAt,
    spec: { ...spec, target: { kind: 'auto' }, policy: jobPolicyRequirementsRecord(spec.policy),
      limits: candidate.profile.schemaVersion === 2 ? candidate.profile.spec.resources.limits
      : candidate.profile.limits } }).spec : ordinary.auto
  const preference = { target: buildComputerTarget(candidate.spec.target), revision: 1, buildEnabled: true,
    buildPriority: 100, buildAllowancePercent: 100 }
  const selection = new JobComputerSelection(settingsFixture(() => preference),
    { candidates: async () => ({ candidates: [candidate], diagnosticCodes: [] }) },
    { requireEnabled: vi.fn() } as unknown as WorkerExecutionPolicy)
  const storage = { bytes: '0', verification_bytes: '0',
    materializations: verification ? String(SOURCE_AGGREGATE_LIMITS.materializations) : '0',
    verification_materializations: verification ? '0' : '2' }
  const sql = { query: async (...args: [string, unknown[]?]) => {
    const rows = args[1]?.[0] === candidate.sourceReservation.scopeId ? [storage] : []
    return { rowCount: rows.length, rows }
  } } as unknown as JobSql
  const validate = () => selection.validateRequest(sql, {} as ManagementPrincipal, profile.workspaceId, requested)
  expect(await validate()).toEqual({ valid: true, canQueue: true, reasons: [], sideEffects: false })
  if (verification) storage.verification_materializations = '2'
  else storage.materializations = String(SOURCE_AGGREGATE_LIMITS.materializations)
  expect(await validate()).toMatchObject({ valid: false, canQueue: true, reasons: ['busy'] })
})

function measuredSourcePlacement() {
  const { candidate, auto } = buildComputerFixture(mainId, 'workspace-fixture')
  const capacity = sourceStorageCapacityFixture()
  const storage = { capacity, bytes: '0', verification_bytes: '0', materializations: '0',
    verification_materializations: '0', pending_bytes: '0', preparing: '0' }
  const preference = { target: buildComputerTarget(candidate.spec.target), revision: 1, buildEnabled: true,
    buildPriority: 100, buildAllowancePercent: 100 }
  const selection = new JobComputerSelection(settingsFixture(() => preference),
    { candidates: async () => ({ candidates: [candidate], diagnosticCodes: [] }) },
    { requireEnabled: vi.fn() } as unknown as WorkerExecutionPolicy)
  const sql = { query: async (_text: string, values?: unknown[]) => {
    const rows = values?.[0] === candidate.sourceReservation.scopeId ? [storage] : []
    return { rowCount: rows.length, rows }
  } } as unknown as JobSql
  const validate = () => selection.validateRequest(sql, {} as ManagementPrincipal, candidate.profile.workspaceId, auto)
  return { capacity, storage, validate }
}

it('waits at the measured source slot limit and restores eligibility after reclamation', async () => {
  const f = measuredSourcePlacement()
  f.storage.materializations = '2'
  expect(await f.validate()).toMatchObject({ valid: false, canQueue: true, reasons: ['busy'] })
  f.storage.materializations = '0'
  expect(await f.validate()).toEqual({ valid: true, canQueue: true, reasons: [], sideEffects: false })
})

it.each(['bytes', 'free-space', 'preparing'] as const)('defers placement at the measured %s limit', async limit => {
  const f = measuredSourcePlacement()
  if (limit === 'bytes') f.storage.bytes = String(2 ** 30)
  if (limit === 'free-space') f.storage.pending_bytes = String(3 * 2 ** 30)
  if (limit === 'preparing') f.storage.preparing = '2'
  expect(await f.validate()).toMatchObject({ valid: false, canQueue: true, reasons: ['busy'] })
})

it.each([-60_000, 60_000])('leaves final reservation to remeasure an out-of-date host reading (%s ms)', async offset => {
  const f = measuredSourcePlacement()
  f.capacity.observedAt = new Date(Date.now() + offset).toISOString()
  f.storage.materializations = '2'
  expect(await f.validate()).toEqual({ valid: true, canQueue: true, reasons: [], sideEffects: false })
})


it('selects the fallback computer when only it fits the captured source and Git metadata', async () => {
  const first = buildComputerFixture(mainId, 'workspace-fixture')
  const second = buildComputerFixture(mainId, 'workspace-fixture')
  const bytes = Buffer.from('source')
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'git-tree-v1', executablePolicy: 'strip', deletions: [],
    git: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), objectFormat: 'sha1',
      metadata: { byteSize: 8 * 1024 * 1024, sha256: 'c'.repeat(64) } },
    entries: [{ path: 'source.ts', kind: 'file', byteSize: bytes.length,
      sha256: sourceSha256(bytes), executable: false }] })
  for (const computer of [first, second]) {
    computer.candidate.sourceReservation.reservedBytes = sourceMaterializationBytes(manifest)
  }
  const preference = (target: ReturnType<typeof buildComputerTarget>) => ({ target, revision: 1, buildEnabled: true,
    buildPriority: target.hostRef.kind === 'device' && target.hostRef.deviceId === first.registration.deviceId ? 100 : 50,
    buildAllowancePercent: 100 })
  const settings = settingsFixture(preference)
  const selection = new JobComputerSelection(settings,
    { candidates: async () => ({ candidates: [first.candidate, second.candidate], diagnosticCodes: [] }) },
    { requireEnabled: vi.fn() } as unknown as WorkerExecutionPolicy)
  let saved: { spec: unknown; bytes: number } | undefined
  const sql = { query: async (text: string, values?: unknown[]) => {
    if (text.includes('coalesce(sum(bytes)')) return { rowCount: 1, rows: [{
      bytes: values![0] === first.candidate.sourceReservation.scopeId
        ? String(SOURCE_AGGREGATE_LIMITS.bytes - 4 * 1024 * 1024) : '0',
      verification_bytes: '0', materializations: '0', verification_materializations: '0',
    }] }
    if (text.startsWith('insert into job_computer_selections')) {
      saved = { spec: JSON.parse(String(values![6])), bytes: Number(values![10]) }
    }
    return { rowCount: 0, rows: [] }
  } } as unknown as JobSql
  const definition = JobDefinitionRecordSchema.parse({ schemaVersion: 1, id: randomUUID(), versionId: randomUUID(),
    workspaceId: 'workspace-fixture', name: 'Metadata placement', revision: 1, spec: first.auto,
    createdAt: first.candidate.profile.createdAt, updatedAt: first.candidate.profile.updatedAt })
  const result = await selection.claim(sql, {} as ManagementPrincipal, definition,
    { executionId: randomUUID(), attemptId: randomUUID(), operationId: randomUUID() })
  expect(result.spec?.target.hostRef).toEqual(second.candidate.spec.target.hostRef)
  expect(saved).toEqual({ spec: second.candidate.spec, bytes: sourceMaterializationBytes(manifest) })
})
