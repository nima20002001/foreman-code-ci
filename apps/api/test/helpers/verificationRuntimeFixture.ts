import { createHash, randomUUID } from 'node:crypto'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { JobQualificationCandidateSchema, JOB_RUNTIME_PROVISIONING_SUITE, type JobQualificationCandidate }
  from '@foreman-code/contracts/job-runtime'
import { JobVerificationRuntimeMeasurementSchema, JOB_VERIFICATION_BASE_CHECKS }
  from '@foreman-code/contracts/job-verification-runtime'
import { AcceptedVerificationJobSpecSchema } from '@foreman-code/contracts/job-verification'
import { verificationJobLifecycle } from '@foreman-code/contracts/job-verification-policy'
import type { QualifiedJobProfile } from '../../src/modules/jobs/executor.js'
import { JOB_PRIVATE_GIT_LAYOUT } from '../../src/modules/jobs/privateGitMounts.js'
import { verificationFixture } from './jobVerificationFixture.js'
const id = '00000000-0000-4000-8000-000000000001'
const digest = 'a'.repeat(64)
const hash = (value: unknown) => createHash('sha256').update(canonicalGraphJson(value)).digest('hex')
function candidate(): JobQualificationCandidate {
  return JobQualificationCandidateSchema.parse({ qualificationId: id, operationId: id, approvalId: id,
    fingerprint: { workspaceLayout:JOB_PRIVATE_GIT_LAYOUT,schemaVersion: 1, profileId: id, profileRevision: 1, specDigest: digest,
      hostRef: { kind: 'main', mainId: id }, registration: null, mainInstallationId: id, bootId: id,
      runtimeExecutable: '/usr/bin/podman', runtimeBinarySha256: digest, ociExecutable: '/usr/bin/crun', ociBinarySha256: digest,
      imageDigest: `sha256:${digest}`, toolchainDigest: digest, configurationDigest: digest,
      limits: { cpuLimit: 1, memoryBytes: 67108864, pidsLimit: 64, diskBytes: 2097152 },
      root: { version: 1, source: { approvedSourceId: id, snapshotId: id, manifestDigest: digest },
        selection: { hostRef: { kind: 'main', mainId: id }, rootPolicyId: id, rootPolicyRevision: '1', locationRevision: '1' },
        binding: { version: 1, mainId: id, deviceId: null, workerInstallationId: null, workspaceId: id, rootId: id, bindingRevision: 1,
          locationRevision: 1, canonicalPath: '/approved/source', filesystem: { device: '12', inode: '34', mountId: '56' },
          accessMode: 'exclusive-write', snapshotId: id, manifestDigest: digest }, ownerPrincipalId: id, authorizedByPrincipalId: id,
        registration: null, attestationId: id, attestationDigest: digest, boundAt: '2026-10-01T00:00:00Z' } },
    backingFile: '/approved/ci-volume.ext4', backingBytes: 2097152,
    findmntBinary: '/usr/bin/findmnt', findmntBinarySha256: digest, controllerEnvironment: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/1000', LANG: 'C.UTF-8' },
    sourceParent: '/approved/source', runtimeRoot: '/approved/runtime', spoolBytes: 131072, ttlSeconds: 600 })
}
export function verificationRuntimeFixture() {
  const f = verificationFixture()
  const approvedAt = Date.now()
  const now = new Date(approvedAt).toISOString()
  const expiry = new Date(approvedAt + 3_600_000).toISOString()
  const baseline = candidate().fingerprint
  const resources = f.resources
  const fingerprint = {
    ...baseline, schemaVersion: 3 as const, profileId: f.profile.profileId, profileRevision: f.profile.profileRevision,
    limits: resources.limits, imageDigest: f.profile.imageDigest, toolchainDigest: f.profile.toolchainDigest,
    resourcePolicyRevision: 1, resourcePolicyDigest: digest, runtimeApprovalId: id, runtimeApprovalRevision: 1,
    provisioningSuite: JOB_RUNTIME_PROVISIONING_SUITE,
    deviceLimits: { cpuLimit: 4, memoryBytes: 8 * 2 ** 30, pidsLimit: 1024, diskBytes: 64 * 2 ** 30 },
    quotaPool: { queryExecutable: '/usr/lib/foreman-code/job-quota-query', queryBinarySha256: digest,
      blockDevice: '/dev/loop0', volumeCapacityInodes: 1000 + resources.mutableInodes * 4,
      slots: Array.from({ length: 4 }, (_, index) => ({ namespace: randomUUID(), projectId: 2 + index,
        hardLimitBytes: resources.limits.diskBytes, hardInodes: resources.mutableInodes,
        filesystem: { ...baseline.root.binding.filesystem, inode: String(100 + index) } })) },
    quota: { volumeId: id, mountIdentityDigest: digest, volumeCapacityBytes: 64 * 2 ** 30,
      growthMode: 'filesystem-project-quota' as const, reservedHostBytes: 2 ** 30, controlProjectId: 1, workloadProjectId: 2,
      controlHardLimitBytes: 2 ** 30, controlUsageBytes: 0, workloadHardLimitBytes: resources.limits.diskBytes,
      workloadUsageBytes: 0, controlHardInodes: 1000, controlUsedInodes: 0,
      workloadHardInodes: resources.mutableInodes, workloadUsedInodes: 0, quotaRevision: 1, quotaDigest: digest,
      accountingEnabled: true as const, enforcementEnabled: true as const,
      inheritanceVerified: true as const, rootlessAccountingVerified: true as const },
    aggregateCgroupIdentityDigest: digest, imageManifestDigest: f.profile.imageDigest, imageConfigDigest: f.profile.imageDigest,
    network: f.profile.network, resources,
    approvalConfig: { schemaVersion: 1 as const, revision: 1, approvalLifetimeMs: 3_600_000,
      review: { reviewedByPrincipalId: 'owner', reviewedAt: now, decisionDigest: digest } }, tools: [{ kind: 'codex' as const, executable: '/opt/graphql-ci/tools/codex',
      version: 'qualified-schema-binary', binarySha256: digest }], seedReceiptSha256: digest,
    sourceCommit: f.build.source.commit,
  }
  const profile = { ...f.profile, rootId: baseline.root.binding.rootId, fingerprintDigest: hash(fingerprint),
    approvalExpiresAt: expiry, qualificationExpiresAt: expiry }
  const measurement = JobVerificationRuntimeMeasurementSchema.parse({ schemaVersion: 2, identity: profile, fingerprint,
    origin: 'real-runtime', approvedAt: now, checkedAt: now, expiresAt: expiry,
    checks: [...JOB_VERIFICATION_BASE_CHECKS, 'network-none'].map(check => ({ id: check, passed: true, evidenceDigest: digest })),
    suites: [{ suite: 'unit', resources, coldCachePeakBytes: 2 ** 30, coldCachePeakInodes: 1000,
      maxConcurrentHeavyJobs: 1, maxUnitWorkers: 1, maxIntegrationShards: 1, evidenceDigest: digest }],
  })
  const target = { ...f.spec.target, hostRef: baseline.hostRef, mainId: baseline.mainInstallationId,
    mainInstallationId: baseline.mainInstallationId, destination: { ...f.spec.target.destination,
      canonicalProjectRoot: `/approved/source/${f.acceptedBuild.source.materializationId}/tree`,
      canonicalCwd: `/approved/source/${f.acceptedBuild.source.materializationId}/tree` } }
  const spec = AcceptedVerificationJobSpecSchema.parse({ ...f.acceptedBuild, ...f.spec, target, schemaVersion: 2,
    source: { ...f.acceptedBuild.source }, profile, reservationId: id, lifecycle: verificationJobLifecycle(now, f.spec.policy),
    resourcePolicyRevision: 1, resourcePolicyDigest: digest, runtimeApprovalId: id, runtimeApprovalRevision: 1 })
  const runtime: QualifiedJobProfile = { ...resources.limits, workspaceLayout: JOB_PRIVATE_GIT_LAYOUT,
    policyId: profile.profileId, policyRevision: profile.profileRevision, imageDigest: profile.imageDigest,
    toolchainDigest: profile.toolchainDigest, qualificationId: profile.qualificationId,
    runtimeVersion: 'measured-podman', ociRuntimeVersion: 'measured-crun', kernelVersion: 'measured-kernel',
    rootless: true, cgroupV2: true, filesystemBounded: true, descendantContainment: true, network: 'none' }
  return { spec, measurement, runtime }
}
