import { describe, expect, it } from 'vitest'
import { JobRuntimeProfileInputSchema, JobRuntimeProfileListSchema } from './jobRuntime.js'
const id = '11111111-1111-4111-8111-111111111111', digest = 'a'.repeat(64), now = '2026-10-02T18:00:00.000Z'
const limits = { cpuLimit: 1, memoryBytes: 67108864, pidsLimit: 64, diskBytes: 2097152 }
const hostRef = { kind: 'main', mainId: id }
const root = { version: 1, source: { approvedSourceId: id, snapshotId: id, manifestDigest: digest },
  selection: { hostRef, rootPolicyId: id, rootPolicyRevision: '1', locationRevision: '1' },
  binding: { version: 1, mainId: id, deviceId: null, workerInstallationId: null, workspaceId: id, rootId: id, bindingRevision: 1,
    locationRevision: 1, canonicalPath: '/approved/source', filesystem: { device: '12', inode: '34', mountId: '56' },
    accessMode: 'exclusive-write', snapshotId: id, manifestDigest: digest },
  ownerPrincipalId: id, authorizedByPrincipalId: id, registration: null, attestationId: id, attestationDigest: digest, boundAt: now }
const fingerprint = { schemaVersion: 1, profileId: id, profileRevision: 1, specDigest: digest, hostRef,
  registration: null, mainInstallationId: id, bootId: id, root, runtimeExecutable: '/usr/bin/podman', runtimeBinarySha256: digest,
  ociExecutable: '/usr/bin/crun', ociBinarySha256: digest, configurationDigest: digest, imageDigest: `sha256:${digest}`, toolchainDigest: digest, limits }
const approval = { schemaVersion: 1, id, qualificationId: id, workspaceId: id, profileId: id, profileRevision: 1,
  fingerprint, fingerprintDigest: digest, requestedByPrincipalId: id, status: 'awaiting-approval', approvedByPrincipalId: null,
  approvedAt: null, expiresAt: '2026-10-02T19:00:00.000Z' }
const profile = { schemaVersion: 1, id, workspaceId: id, revision: 1, name: 'Runtime profile', root,
  policy: { isolationPolicyId: id, isolationPolicyRevision: 1, imageDigest: `sha256:${digest}`, toolchainDigest: digest,
    environmentScopeRefs: [], network: 'none', queueTimeoutMs: 1000, preparationTimeoutMs: 1000, executionTimeoutMs: 1000,
    cancellationGraceMs: 1000, maxLogChunkBytes: 1024, maxLogBytes: 4096, maxWorkerSpoolBytes: 4096, logOverflow: 'stop',
    maxOutputBytes: 4096, retentionSeconds: 3600 }, limits, specDigest: digest,
  status: 'awaiting-approval', measurement: null, createdAt: now, updatedAt: now }
const result = { profiles: [{ profile, ready: false, reasons: ['approval_required'], sideEffects: false }], approvals: [approval] }
describe('runtime profile metadata and pending approval discovery', () => {
  it('requires save-time spool and resource bounds that the qualification candidate can accept', () => {
    const { isolationPolicyId, isolationPolicyRevision, ...policy } = profile.policy
    expect(isolationPolicyId).toBe(id); expect(isolationPolicyRevision).toBe(1)
    const input = { rootId: id, bindingRevision: 1, limits: { ...limits, diskBytes: 134217728 }, policy }
    for (const maxWorkerSpoolBytes of [131072, 67108864]) {
      expect(JobRuntimeProfileInputSchema.safeParse({ ...input, policy: { ...policy, maxWorkerSpoolBytes } }).success).toBe(true)
    }
    for (const maxWorkerSpoolBytes of [131071, 67108865, 134217729]) {
      expect(JobRuntimeProfileInputSchema.safeParse({ ...input, policy: { ...policy, maxWorkerSpoolBytes } }).success).toBe(false)
    }
    for (const change of [{ cpuLimit: 257 }, { pidsLimit: 0 }, { memoryBytes: Number.MAX_SAFE_INTEGER + 1 }, { diskBytes: 131071 }]) {
      expect(JobRuntimeProfileInputSchema.safeParse({ ...input, limits: { ...input.limits, ...change }, policy: { ...policy, maxWorkerSpoolBytes: 131072 } }).success).toBe(false)
    }
  })

  it('preserves scoped profile and pending approval facts without side effects', () => {
    expect(JobRuntimeProfileListSchema.parse(result)).toEqual(result)
    expect(JobRuntimeProfileListSchema.parse({ profiles: [], approvals: [] })).toEqual({ profiles: [], approvals: [] })
  })
  it('requires explicit approvals and side-effect-free readiness metadata', () => {
    for (const value of [
      { profiles: result.profiles }, { ...result, unexpected: true },
      { ...result, profiles: [{ ...result.profiles[0], sideEffects: true }] },
      { ...result, profiles: [{ ...result.profiles[0], reasons: [123] }] },
      { ...result, profiles: [{ ...result.profiles[0], repairCommand: 'launch' }] },
      { ...result, approvals: [{ ...approval, status: 'invented' }] },
      { ...result, approvals: [{ ...approval, principal: 'invented' }] },
    ]) expect(JobRuntimeProfileListSchema.safeParse(value).success).toBe(false)
  })
})
