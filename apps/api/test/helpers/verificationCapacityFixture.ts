import { randomUUID } from 'node:crypto'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { JOB_RUNTIME_PROVISIONING_SUITE, JOB_RUNTIME_WORKSPACE_LAYOUT } from '@foreman-code/contracts/job-runtime'
import { JOB_VERIFICATION_BASE_CHECKS, JobVerificationProfileInputSchema, JobVerificationProfileSchema }
  from '@foreman-code/contracts/job-verification-runtime'
import { jobPolicyRequirementsRecord } from '@foreman-code/contracts/job-verification'
import { JOB_VERIFICATION_APPROVAL_LIFETIME_MS } from '@foreman-code/contracts/job-verification-policy'
import { createVerificationProfile } from '../../src/modules/jobs/verificationProfiles.js'
import { jobDigest } from '../../src/modules/jobs/service.js'
import { buildComputerFixture } from './buildComputerFixture.js'
import { verificationFixture } from './jobVerificationFixture.js'

/** Structured admission data only; this fixture makes no physical qualification claim. */
export function verificationCapacityFixture(host: 'main' | 'device', maxConcurrentJobs = 4) {
  const facts = verificationFixture()
  const base = buildComputerFixture('11111111-1111-4111-8111-111111111111', 'workspace')
  const rawRoot = base.candidate.profile.root
  const hostRef = host === 'main' ? { kind: 'main' as const, mainId: rawRoot.binding.mainId } : rawRoot.selection.hostRef
  const root = SourceRootRecordSchema.parse({ ...rawRoot, selection: { ...rawRoot.selection, hostRef },
    registration: host === 'main' ? null : rawRoot.registration,
    binding: { ...rawRoot.binding, deviceId: host === 'main' ? null : rawRoot.binding.deviceId,
      workerInstallationId: host === 'main' ? null : rawRoot.binding.workerInstallationId } })
  const now = new Date().toISOString()
  const profile = createVerificationProfile({ id: 'profile', workspaceId: 'workspace', revision: 1,
    name: 'Verification capacity', root, sourceCommit: facts.build.source.commit, previous: null, now,
    spec: JobVerificationProfileInputSchema.parse({ rootId: root.binding.rootId, bindingRevision: 1,
      resources: facts.resources, suites: ['unit'], policy: jobPolicyRequirementsRecord(facts.spec.policy),
      approvalConfig: { approvalLifetimeMs: JOB_VERIFICATION_APPROVAL_LIFETIME_MS } }) })
  const digest = 'a'.repeat(64)
  const qualificationId = randomUUID()
  const approvalId = randomUUID()
  const expiresAt = new Date(Date.parse(now) + JOB_VERIFICATION_APPROVAL_LIFETIME_MS).toISOString()
  const fingerprint = { schemaVersion: 3, profileId: profile.id, profileRevision: profile.revision,
    specDigest: profile.specDigest, hostRef, registration: root.registration, mainInstallationId: root.binding.mainId,
    bootId: randomUUID(), root, runtimeExecutable: '/usr/bin/podman', runtimeBinarySha256: digest,
    ociExecutable: '/usr/bin/crun', ociBinarySha256: digest, configurationDigest: digest,
    imageDigest: profile.spec.policy.imageDigest, toolchainDigest: profile.spec.policy.toolchainDigest,
    limits: profile.spec.resources.limits, resources: profile.spec.resources, network: profile.spec.policy.network,
    workspaceLayout: JOB_RUNTIME_WORKSPACE_LAYOUT, approvalConfig: profile.approvalConfig,
    tools: [], seedReceiptSha256: digest, sourceCommit: profile.sourceCommit,
    resourcePolicyRevision: 1, resourcePolicyDigest: digest, runtimeApprovalId: approvalId, runtimeApprovalRevision: 1,
    provisioningSuite: JOB_RUNTIME_PROVISIONING_SUITE,
    deviceLimits: { cpuLimit: 16, memoryBytes: (host === 'main' ? 30 : 14) * 2 ** 30,
      pidsLimit: 4096, diskBytes: 64 * 2 ** 30 },
    quotaPool: { queryExecutable: '/usr/lib/foreman-code/job-quota-query', queryBinarySha256: digest,
      blockDevice: '/dev/loop0', volumeCapacityInodes: 1000 + facts.resources.mutableInodes * 7,
      slots: Array.from({ length: 7 }, (_, index) => ({ namespace: randomUUID(), projectId: 2 + index,
        hardLimitBytes: facts.resources.limits.diskBytes, hardInodes: facts.resources.mutableInodes,
        filesystem: { ...root.binding.filesystem, inode: String(100 + index) } })) },
    quota: { volumeId: randomUUID(), mountIdentityDigest: digest, volumeCapacityBytes: 64 * 2 ** 30,
      growthMode: 'filesystem-project-quota', reservedHostBytes: 2 ** 30, controlProjectId: 1, workloadProjectId: 2,
      controlHardLimitBytes: 2 ** 30, controlUsageBytes: 0, workloadHardLimitBytes: facts.resources.limits.diskBytes,
      workloadUsageBytes: 0, controlHardInodes: 1000, controlUsedInodes: 0, workloadHardInodes: facts.resources.mutableInodes,
      workloadUsedInodes: 0, quotaRevision: 1, quotaDigest: digest, accountingEnabled: true,
      enforcementEnabled: true, inheritanceVerified: true, rootlessAccountingVerified: true },
    aggregateCgroupIdentityDigest: digest, imageManifestDigest: profile.spec.policy.imageDigest,
    imageConfigDigest: profile.spec.policy.imageDigest }
  const identity = { profileId: profile.id, profileRevision: profile.revision, qualificationId,
    approvalId, fingerprintDigest: jobDigest(fingerprint), rootId: root.binding.rootId, bindingRevision: 1,
    imageDigest: fingerprint.imageDigest, toolchainDigest: fingerprint.toolchainDigest, network: fingerprint.network,
    approvalExpiresAt: expiresAt, qualificationExpiresAt: expiresAt }
  return JobVerificationProfileSchema.parse({ ...profile, status: 'qualified', measurement: {
    schemaVersion: 2, identity, fingerprint, origin: 'real-runtime', approvedAt: now, checkedAt: now, expiresAt,
    checks: [...JOB_VERIFICATION_BASE_CHECKS, 'network-none'].map(id => ({ id, passed: true, evidenceDigest: digest })),
    suites: [{ suite: 'unit', resources: profile.spec.resources, coldCachePeakBytes: 2 ** 30,
      coldCachePeakInodes: 1000, maxConcurrentHeavyJobs: maxConcurrentJobs, maxUnitWorkers: 12,
      maxIntegrationShards: 12, evidenceDigest: digest }],
  } })
}
