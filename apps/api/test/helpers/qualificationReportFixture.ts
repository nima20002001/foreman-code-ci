import { qualificationUnitWorkers } from '@foreman-code/contracts/job-verification-policy'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { JobQualificationReportSchema, JobVerificationQualificationCandidateSchema,
  JobVerificationRepositoryContextSchema, type JobQualificationCandidateRecord, type JobQualificationReport } from '@foreman-code/contracts/job-verification-runtime'
import { jobPolicyRequirementsRecord } from '@foreman-code/contracts/job-verification'
import { verificationRuntimeFixture } from './verificationRuntimeFixture.js'
import { createVerificationProfile } from '../../src/modules/jobs/verificationProfiles.js'
import { createQualificationReportReceiver } from '../../src/modules/jobs/qualificationReportReceiver.js'
import { sourceBindingHash } from '../../src/modules/sources/bindingHash.js'
import { jobDigest } from '../../src/modules/jobs/digest.js'

export function qualificationReportFixture() {
  const f = verificationRuntimeFixture()
  const now = new Date().toISOString()
  const qualificationId = randomUUID()
  const approvalId = randomUUID()
  const resources = { ...f.measurement.fingerprint.resources, reportBytes: 8 * 1024 * 1024 }
  const policy = { ...jobPolicyRequirementsRecord(f.spec.policy), maxOutputBytes: resources.reportBytes, maxWorkerSpoolBytes: 131072 }
  const profile = createVerificationProfile({ id: randomUUID(), workspaceId: f.measurement.fingerprint.root.binding.workspaceId, revision: 1,
    name: 'Packet fixture', root: f.measurement.fingerprint.root, sourceCommit: f.spec.source.commit,
    spec: { rootId: f.measurement.fingerprint.root.binding.rootId, bindingRevision: 1, resources, policy,
      suites: ['unit'], approvalConfig: { approvalLifetimeMs: 86400000 } }, previous: null, now })
  const fingerprint = { ...f.measurement.fingerprint, profileId: profile.id, resources, specDigest: profile.specDigest,
    approvalConfig: profile.approvalConfig }
  const candidate = JobVerificationQualificationCandidateSchema.parse({ qualificationId, operationId: qualificationId,
    approvalId, profile, fingerprint, approvedAt: now, sourceParent: profile.root.binding.canonicalPath,
    runtimeRoot: '/approved/runtime', controllerEnvironment: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/1000', LANG: 'C.UTF-8' },
    findmntBinary: '/usr/bin/findmnt', findmntBinarySha256: 'a'.repeat(64), backingFile: null, backingBytes: null,
    volumeCapacityBytes: fingerprint.quota.volumeCapacityBytes, spoolBytes: profile.spec.policy.maxWorkerSpoolBytes,
    ttlSeconds: 3600 })
  const expiresAt = new Date(Date.now() + 86400000).toISOString()
  const admission = { schemaVersion: 3, kind: 'job-runtime-qualification', qualificationId, operationId: qualificationId,
    approvalId, profileId: profile.id, profileRevision: 1, workspaceId: profile.workspaceId,
    fingerprintDigest: jobDigest(fingerprint), leaseId: randomUUID(), runCommandId: 'command', runPrincipalId: 'operator',
    approvedByPrincipalId: 'human', hostRef: fingerprint.hostRef, registration: fingerprint.registration,
    mainInstallationId: fingerprint.mainInstallationId, bootId: fingerprint.bootId, connection: null,
    resourcePolicyRevision: fingerprint.resourcePolicyRevision, resourcePolicyDigest: fingerprint.resourcePolicyDigest,
    runtimeApprovalId: fingerprint.runtimeApprovalId, runtimeApprovalRevision: fingerprint.runtimeApprovalRevision,
    admittedAt: now, expiresAt }
  const root = join(candidate.sourceParent, fingerprint.quotaPool!.slots[0]!.namespace, qualificationId, 'tree')
  const filesystem = { ...profile.root.binding.filesystem, inode: '999' }
  const context = JobVerificationRepositoryContextSchema.parse({ identity: {
    commit: f.spec.source.commit, manifestDigest: f.spec.source.manifestDigest,
    profile: { ...f.spec.profile, profileId: profile.id, fingerprintDigest: jobDigest(fingerprint), approvalId, qualificationId,
      approvalExpiresAt: expiresAt, qualificationExpiresAt: expiresAt },
    suite: 'unit', executionId: `${qualificationId}:unit`, attemptId: `${qualificationId}:unit`,
    definitionVersionId: `${profile.id}:1:${qualificationId}:unit`,
    target: { ...f.spec.target, destination: { ...f.spec.target.destination,
      canonicalProjectRoot: root, canonicalCwd: root, rootPolicyId: profile.root.selection.rootPolicyId,
      rootPolicyRevision: profile.root.selection.rootPolicyRevision, directoryIdentityHash: jobDigest(filesystem) } }, resources,
    parameters: { unitWorkers: qualificationUnitWorkers(resources.limits), integrationShards: 1 } },
    privateGit: { sourceCommit: f.spec.source.commit, generatedCommit: 'b'.repeat(40),
      repositoryReceiptDigest: 'a'.repeat(64), configDigest: 'a'.repeat(64), indexDigest: 'a'.repeat(64) },
    requiredPortions: [{ key: 'root:install', kind: 'bootstrap' }], executionTimeoutMs: policy.executionTimeoutMs,
    cancellationTimeoutMs: policy.cancellationGraceMs, qualifiedUnitWorkers: qualificationUnitWorkers(resources.limits),
    mutableDirectory: '/job-scratch', storeDirectory: '/job-scratch/pnpm-store',
    limits: { summaryBytes: 2097152, junitBytes: 2097152, vitestBytes: 2097152, logsArchiveBytes: 2097152, logBytes: 1024 },
    preseedReceipt: { lockfileSha256: 'a'.repeat(64), pnpmVersion: '11.27.0', platform: 'linux', architecture: 'x64',
      provenanceDigest: 'a'.repeat(64), minimumReleaseAgeMinutes: 2880, releaseAgeVerified: true } })
  const bytes = Buffer.from(JSON.stringify({ log: 'x'.repeat(1048700) }))
  const process = { pid: 1, startTicks: '1', bootId: fingerprint.bootId }
  const placementHash = sourceBindingHash(profile.root, { executionId: context.identity.executionId,
    attemptId: context.identity.attemptId, keyRevision: null, authorizationRevision: null }, context.identity.executionId)
  const report = JobQualificationReportSchema.parse({ context, startedAt: now,
    materialization: { receipt: { version: 1, materializationId: qualificationId, binding: profile.root.binding,
      quota: fingerprint.quotaPool!.slots[0], placementHash,
      executionId: context.identity.executionId, attemptId: context.identity.attemptId,
      keyRevision: null, authorizationRevision: null, verifiedManifestDigest: context.identity.manifestDigest,
      verifiedEntries: 0, verifiedBytes: 0, verifiedAt: now,
      localTreeIdentity: filesystem },
      rootPolicyId: profile.root.selection.rootPolicyId, rootPolicyRevision: profile.root.selection.rootPolicyRevision,
      operationId: context.identity.executionId, reservationId: qualificationId,
      sourceBindingHash: placementHash, finalDispatchBindingHash: null, state: 'prepared' },
    terminal: { outcome: 'succeeded', exitCode: 0, signal: null, finishedAt: now },
    closure: { scope: { subject: { kind: 'qualification', qualificationId, operationId: qualificationId,
      profileId: profile.id, profileRevision: 1, fingerprint: jobDigest(fingerprint) }, admission, bootId: fingerprint.bootId },
      containerId: 'c'.repeat(64), process, boundary: { kind: 'cgroup-v2', path: '/sys/fs/cgroup/fixture',
        device: '1', inode: '1' }, helpers: [], lifecycle: 'closed' },
    path: '.logs/verification/vitest.json', sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length })
  const artifact = { executionId: context.identity.executionId, publicationId: 'publication', path: report.path,
    fileId: 'file', revisionId: 'revision', sha256: report.sha256, byteSize: bytes.length,
    mediaType: 'application/json', expiresAt, state: 'available' as const }
  const publish = vi.fn(async (_candidate: JobQualificationCandidateRecord, _report: JobQualificationReport, received: Uint8Array) => {
    expect(Buffer.from(received)).toEqual(bytes)
    return artifact
  })
  return { candidate, report, bytes, artifact, publish, receive: createQualificationReportReceiver(publish) }
}
