import { verificationRuntimeFixture } from '../../../../test/helpers/verificationRuntimeFixture.js'
import { JobVerificationPolicyRequirementsSchema } from '@foreman-code/contracts/job-verification-policy'
import { verificationFixture } from '../../../../test/helpers/jobVerificationFixture.js'
import { VerificationJobExecutionSchema, jobPolicyRequirementsRecord } from '@foreman-code/contracts/job-verification'
import { createVerificationProfile } from '../../jobs/verificationProfiles.js'
import { JOB_VERIFICATION_APPROVAL_LIFETIME_MS } from '@foreman-code/contracts/job-verification-policy'
import { readAcceptedJobSource, readAcceptedJobCleanupSource } from './jobAcceptedSource.js'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { jobExecution } from '../../../../test/helpers/jobFixture.js'
import { jobSpecDigests } from '@foreman-code/contracts/jobs-node'
import { SourceRootRecordSchema, SourceMaterializationRecordSchema } from '@foreman-code/contracts/source-admission'
import { JobRuntimeProfileSchema } from '@foreman-code/contracts/job-runtime'
import type { RemoteJobDispatchIntent } from '@foreman-code/contracts/remote-job-execution'
import { manifestDigest, sourceSha256 } from '../../sources/manifest.js'
import { sourceBindingHash, sourceMaterializationDigest } from '../../sources/bindingHash.js'
import { JobApplicationBridge } from './jobApplicationBridge.js'
vi.mock('../../access/liveManagementPrincipal.js', () => ({ readLiveManagementPrincipal: async () => { throw new Error('revoked starter') } }))
function fixture() {
  const execution = jobExecution(), spec = execution.acceptedSpec, id = randomUUID(), deviceId = randomUUID()
  const registration = { workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1 }
  spec.target.hostRef = { kind: 'device', mainId: spec.target.mainId, deviceId }; spec.target.registration = registration; spec.target.mainInstallationId = spec.target.mainId
  const binding = { mainId: spec.target.mainId, deviceId, ...registration, bootId: randomUUID(), connectionGeneration: 1, connectionEpoch: randomUUID() }
  const manifestBase = { version: 1 as const, snapshotId: spec.source.snapshotId, approvedSourceId: spec.source.approvedSourceId, capturePolicy: 'git-tree-v1' as const, executablePolicy: 'strip' as const,
    git: { commit: spec.source.commit, tree: '3'.repeat(40), objectFormat: 'sha1' as const }, entries: [], deletions: [], totalEntries: 0, totalBytes: 0 }
  const manifest = { ...manifestBase, manifestDigest: manifestDigest(manifestBase) }; spec.source.manifestDigest = manifest.manifestDigest
  const root = SourceRootRecordSchema.parse({ version: 1, source: { approvedSourceId: spec.source.approvedSourceId, snapshotId: spec.source.snapshotId, manifestDigest: manifest.manifestDigest },
    selection: { hostRef: spec.target.hostRef, rootPolicyId: spec.target.destination.rootPolicyId, rootPolicyRevision: '1', locationRevision: '1' },
    binding: { version: 1, mainId: spec.target.mainId, deviceId, workerInstallationId: registration.workerInstallationId, workspaceId: execution.workspaceId, rootId: id, bindingRevision: 1,
      locationRevision: 1, canonicalPath: join(spec.target.destination.managedRuntimeRoot, 'source-materializations', spec.target.destination.rootPolicyId), filesystem: { device: '1', inode: '2', mountId: '3' }, accessMode: 'exclusive-write', snapshotId: spec.source.snapshotId, manifestDigest: manifest.manifestDigest },
    ownerPrincipalId: 'accepted-owner', authorizedByPrincipalId: 'accepted-owner', registration, attestationId: spec.target.destination.attestationId, attestationDigest: spec.target.destination.attestationHash, boundAt: execution.createdAt })
  const attempt = { executionId: execution.id, attemptId: execution.attemptId, keyRevision: 1, authorizationRevision: 1 }
  const sourceHash = sourceBindingHash(root, attempt, execution.operationId)
  const materialization = SourceMaterializationRecordSchema.parse({ receipt: { version: 1, materializationId: spec.source.materializationId, binding: root.binding, placementHash: sourceHash, ...attempt,
    verifiedManifestDigest: manifest.manifestDigest, verifiedEntries: 0, verifiedBytes: 0, verifiedAt: execution.createdAt, localTreeIdentity: { device: '1', inode: '4', mountId: '3' } },
    rootPolicyId: root.selection.rootPolicyId, rootPolicyRevision: '1', operationId: execution.operationId, reservationId: id, sourceBindingHash: sourceHash, finalDispatchBindingHash: null, state: 'prepared' })
  Object.assign(spec.target.destination, { canonicalProjectRoot: join(root.binding.canonicalPath, spec.source.materializationId, 'tree'), canonicalCwd: join(root.binding.canonicalPath, spec.source.materializationId, 'tree'), directoryIdentityHash: sourceSha256(Buffer.from(JSON.stringify(materialization.receipt.localTreeIdentity))) })
  spec.source.materializationDigest = sourceMaterializationDigest(materialization); Object.assign(spec, jobSpecDigests(spec, null)); materialization.finalDispatchBindingHash = spec.bindingHash
  const profile = JobRuntimeProfileSchema.parse({ schemaVersion: 1, id: spec.policy.isolationPolicyId, workspaceId: execution.workspaceId, revision: 1, name: 'Original', root, policy: spec.policy,
    limits: { cpuLimit: 1, memoryBytes: 1048576, pidsLimit: 64, diskBytes: 1048576 }, specDigest: 'a'.repeat(64), status: 'unqualified', measurement: null, createdAt: execution.createdAt, updatedAt: execution.createdAt })
  const approved = { version: 1, workspaceId: execution.workspaceId, mainId: spec.target.mainId, ownerPrincipalId: 'accepted-owner', approvedByPrincipalId: 'accepted-owner', locationRevision: 1,
    originIdentityHash: `sha256:${'a'.repeat(64)}`, manifest, approvedAt: execution.createdAt, availability: 'retained' }
  const intent: RemoteJobDispatchIntent = { schemaVersion: 1, protocolVersion: 1, mainId: binding.mainId, subject: { kind: 'manual-job', workspaceId: execution.workspaceId, jobExecutionId: execution.id, definitionId: spec.definitionId },
    executionId: execution.id, attemptId: execution.attemptId, operationId: execution.operationId, bindingHash: spec.bindingHash, inputDigest: `sha256:${spec.specDigest}`, owner: execution.owner }
  const state: { materializationState: string; missing: string; denied: boolean; profile: unknown | null; measurement?: unknown }
    = { materializationState: 'running', missing: '', denied: false, profile: null }
  const query = vi.fn(async (text: string) => {
    if (text === 'begin' || text === 'commit' || text === 'rollback') return { rows: [] }
    if (state.missing && text.includes(state.missing)) return { rows: [] }
    if (text.startsWith('select record,accepted_spec')) return { rows: [{ record: execution, accepted_spec: spec }] }
    if (text.startsWith('select intent')) return { rows: [{ intent }] }
    if (text.includes('source_execution_materializations')) return { rows: [{ record: materialization, state: state.materializationState }] }
    if (text.includes('source_root_bindings')) return { rows: [{ record: root }] }
    if (text.includes('source_snapshots')) return { rows: [{ record: approved }] }
    if (text.includes('job_runtime_qualification_approvals')) return { rows: [{ measurement: state.measurement }] }
    if (text.includes('job_runtime_profile_versions')) return { rows: [{ record: state.profile ?? profile }] }
    throw new Error('Unexpected source read SQL')
  })
  const sql = { query, release: vi.fn() } as unknown as pg.PoolClient, pool = { connect: async () => sql } as unknown as pg.Pool
  const dispatch = { requireLaunch: vi.fn(), require: vi.fn(), requireControl: vi.fn(), requireEvidence: vi.fn(async () => { if (state.denied) throw new Error('evidence denied') }), observeReceipt: vi.fn() }
  const bridge = new JobApplicationBridge(pool, dispatch, { appendLog: vi.fn() }, { authorizePublication: vi.fn() })
  return { execution, intent, binding, materialization, root, profile, approved, state, query, sql, dispatch, bridge }
}
describe('authenticated original Job source producer with SQL doubles, no DB/physical proof', () => {
  it('returns exact persisted metadata under read authority without starter credentials or qualification claims', async () => {
    const f = fixture(), result = await f.bridge.resolveAcceptedSource(f.intent, f.binding)
    expect(result).toEqual({ execution: f.execution, materialization: { ...f.materialization, state: 'running' }, root: f.root, diskQuotaBytes: 1048576 })
    expect(f.dispatch.requireEvidence).toHaveBeenCalledOnce(); expect(f.dispatch.require).not.toHaveBeenCalled()
    expect(f.query.mock.calls[0]![0]).toBe('begin'); expect(f.query.mock.calls.at(-1)![0]).toBe('commit'); expect(f.sql.release).toHaveBeenCalledOnce()
    expect(result).not.toHaveProperty('privateGit'); expect(result).not.toHaveProperty('qualified')
  })
  it('reads verification profile policy and quota without weakening immutable source checks', async () => {
    const f = fixture()
    const facts = verificationFixture()
    const measured = verificationRuntimeFixture().measurement
    measured.identity = { ...facts.profile }
    measured.fingerprint = { ...measured.fingerprint, profileId: facts.profile.profileId,
      root: f.root, hostRef: f.root.selection.hostRef, registration: f.root.registration,
      mainInstallationId: f.root.binding.mainId, sourceCommit: f.execution.acceptedSpec.source.commit }
    measured.identity = { ...measured.identity, rootId: f.root.binding.rootId,
      approvalExpiresAt: measured.expiresAt, qualificationExpiresAt: measured.expiresAt }
    measured.fingerprint.quotaPool!.slots = measured.fingerprint.quotaPool!.slots.map(slot => ({ ...slot,
      filesystem: { ...f.root.binding.filesystem, inode: slot.filesystem.inode } }))
    const slot = measured.fingerprint.quotaPool!.slots[0]!
    f.materialization.receipt.quota = slot
    f.execution.acceptedSpec.source.materializationDigest = sourceMaterializationDigest(f.materialization)
    const projectRoot = join(f.root.binding.canonicalPath, slot.namespace, f.execution.acceptedSpec.source.materializationId, 'tree')
    f.execution.acceptedSpec.target.destination.canonicalProjectRoot = projectRoot
    f.execution.acceptedSpec.target.destination.canonicalCwd = projectRoot
    f.state.measurement = measured
    const execution = VerificationJobExecutionSchema.parse({ ...f.execution, schemaVersion: 2,
      acceptedSpec: { ...f.execution.acceptedSpec, schemaVersion: 2, policy: facts.spec.policy,
        outputs: facts.spec.outputs, verification: facts.spec.verification, profile: measured.identity,
        reservationId: randomUUID(), lifecycle: facts.lifecycle,
        resourcePolicyRevision: measured.fingerprint.resourcePolicyRevision,
        resourcePolicyDigest: measured.fingerprint.resourcePolicyDigest,
        runtimeApprovalId: measured.fingerprint.runtimeApprovalId,
        runtimeApprovalRevision: measured.fingerprint.runtimeApprovalRevision } })
    const profile = createVerificationProfile({
      id: facts.profile.profileId, revision: facts.profile.profileRevision, workspaceId: execution.workspaceId,
      name: 'Verification runtime', root: f.root, sourceCommit: execution.acceptedSpec.source.commit,
      spec: { rootId: f.root.binding.rootId, bindingRevision: f.root.binding.bindingRevision,
        resources: facts.resources, policy: JobVerificationPolicyRequirementsSchema.parse(jobPolicyRequirementsRecord(facts.spec.policy)),
        suites: ['unit'], approvalConfig: { approvalLifetimeMs: JOB_VERIFICATION_APPROVAL_LIFETIME_MS } },
      previous: null, now: execution.createdAt,
    })
    measured.fingerprint.specDigest = profile.specDigest
    measured.fingerprint.approvalConfig = profile.approvalConfig
    f.state.profile = profile
    expect(await readAcceptedJobSource(f.sql, execution)).toMatchObject({ execution, root: f.root,
      diskQuotaBytes: facts.resources.limits.diskBytes })
    delete f.materialization.receipt.quota
    const flatRoot = join(f.root.binding.canonicalPath, execution.acceptedSpec.source.materializationId, 'tree')
    const historical = VerificationJobExecutionSchema.parse({ ...execution, acceptedSpec: {
      ...execution.acceptedSpec, source: { ...execution.acceptedSpec.source,
        materializationDigest: sourceMaterializationDigest(f.materialization) },
      target: { ...execution.acceptedSpec.target, destination: { ...execution.acceptedSpec.target.destination,
        canonicalProjectRoot: flatRoot, canonicalCwd: flatRoot } },
    } })
    await expect(readAcceptedJobSource(f.sql, historical)).rejects.toMatchObject({ code: 'JOB_ACCEPTED_SOURCE_CONFLICT' })
    expect(await readAcceptedJobCleanupSource(f.sql, historical)).toMatchObject({ execution: historical, root: f.root })
    profile.spec.policy.toolchainDigest = '0'.repeat(64)
    await expect(readAcceptedJobSource(f.sql, execution)).rejects.toMatchObject({ code: 'JOB_ACCEPTED_SOURCE_CONFLICT' })
    await expect(readAcceptedJobCleanupSource(f.sql, historical)).rejects.toMatchObject({ code: 'JOB_ACCEPTED_SOURCE_CONFLICT' })
  })
  it('denies the wrong authenticated installation before reading source metadata', async () => {
    const f = fixture(); await expect(f.bridge.resolveAcceptedSource(f.intent, { ...f.binding, workerInstallationId: randomUUID() })).rejects.toThrow('does not own')
    expect(f.query.mock.calls.some(([text]) => text.includes('source_execution_materializations'))).toBe(false)
    expect(f.query.mock.calls.at(-1)![0]).toBe('rollback')
  })
  it('denies stale dispatch and current evidence fences before source lookup', async () => {
    const f = fixture(); await expect(f.bridge.resolveAcceptedSource({ ...f.intent, attemptId: 'foreign' }, f.binding)).rejects.toThrow('stale job')
    f.state.denied = true; await expect(f.bridge.resolveAcceptedSource(f.intent, f.binding)).rejects.toThrow('evidence denied')
    expect(f.query.mock.calls.some(([text]) => text.includes('source_execution_materializations'))).toBe(false)
  })
  it.each(['source_execution_materializations', 'source_root_bindings', 'source_snapshots', 'job_runtime_profile_versions'])('requires original %s rather than current defaults', async missing => {
    const f = fixture(); f.state.missing = missing; await expect(f.bridge.resolveAcceptedSource(f.intent, f.binding)).rejects.toMatchObject({ code: 'JOB_ACCEPTED_SOURCE_CONFLICT' })
  })
  it.each(['state', 'operation', 'finalBinding', 'sourceDigest', 'root', 'commit', 'policy', 'quota', 'directory'] as const)('rejects changed %s immutable facts', async field => {
    const f = fixture()
    if (field === 'state') f.state.materializationState = 'uncertain'
    if (field === 'operation') f.materialization.operationId = 'foreign'
    if (field === 'finalBinding') f.materialization.finalDispatchBindingHash = 'b'.repeat(64)
    if (field === 'sourceDigest') f.materialization.receipt.verifiedManifestDigest = 'b'.repeat(64)
    if (field === 'root') f.root.attestationDigest = 'b'.repeat(64)
    if (field === 'commit') { f.approved.manifest.git.commit = '4'.repeat(40); f.approved.manifest.manifestDigest = manifestDigest(f.approved.manifest) }
    if (field === 'policy') f.profile.policy.toolchainDigest = 'b'.repeat(64)
    if (field === 'quota') f.profile.limits.diskBytes = Number.MAX_SAFE_INTEGER + 1
    if (field === 'directory') f.execution.acceptedSpec.target.destination.directoryIdentityHash = 'b'.repeat(64)
    await expect(f.bridge.resolveAcceptedSource(f.intent, f.binding)).rejects.toThrow()
    expect(f.query.mock.calls.at(-1)![0]).toBe('rollback')
  })
})
