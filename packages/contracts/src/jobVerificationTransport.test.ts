import { describe, expect, it } from 'vitest'
import { AcceptedVerificationJobSpecSchema, PreparedJobSpecRecordSchema,
  VerificationJobExecutionSchema, jobPolicyRequirementsRecord } from './jobVerification.js'
import { acceptedJobSpecDigests, jobSpecDigests } from './jobsNode.js'
import { JobRuntimeApprovalRecordSchema, JobRuntimeQualificationRpcRequestRecordSchema,
  JobRuntimeQualificationRpcResponseRecordSchema, JobVerificationRuntimeNativeAdmissionSchema,
  JobVerificationRuntimeMeasurementSchema, JobVerificationOfflineSeedReceiptSchema, JobVerificationProfileSchema } from './jobVerificationRuntime.js'
import { RemoteJobExecutionRpcRequestRecordSchema, RemoteVerificationJobDispatchRequestSchema } from './remoteJobExecution.js'
import { JobExecutionSchema } from './jobs.js'
import { verificationFixture, verificationMeasurementFixture, verificationId as id,
  verificationDigest as digest, verificationTime as requestedAt } from '../tests/helpers/jobVerification.js'

function admission() {
  const measured = JobVerificationRuntimeMeasurementSchema.parse(verificationMeasurementFixture())
  const fingerprint = measured.fingerprint
  return JobVerificationRuntimeNativeAdmissionSchema.parse({
    schemaVersion: 3, kind: 'job-runtime-qualification', approvalId: id, qualificationId: id,
    operationId: id, workspaceId: fingerprint.root.binding.workspaceId,
    profileId: fingerprint.profileId, profileRevision: fingerprint.profileRevision,
    fingerprintDigest: digest, leaseId: id, runCommandId: 'qualify', runPrincipalId: 'runner',
    approvedByPrincipalId: 'owner', hostRef: fingerprint.hostRef, registration: fingerprint.registration,
    mainInstallationId: fingerprint.mainInstallationId, bootId: id, connection: null,
    admittedAt: requestedAt, expiresAt: measured.expiresAt,
    resourcePolicyRevision: 1, resourcePolicyDigest: digest, runtimeApprovalId: id, runtimeApprovalRevision: 1,
  })
}

function execution() {
  const f = verificationFixture()
  const spec = AcceptedVerificationJobSpecSchema.parse({
    ...f.acceptedBuild, ...f.spec, source: f.acceptedBuild.source, schemaVersion: 2,
    profile: f.profile, reservationId: id, lifecycle: f.lifecycle,
    resourcePolicyRevision: 1, resourcePolicyDigest: digest, runtimeApprovalId: id, runtimeApprovalRevision: 1,
  })
  const acceptedSpec = { ...spec, ...acceptedJobSpecDigests(spec) }
  return VerificationJobExecutionSchema.parse({
    schemaVersion: 2, id: 'execution', workspaceId: 'workspace', acceptedSpec,
    operationId: 'operation', attemptId: 'attempt', owner: { grantId: 'grant', epoch: '1' }, workflow: null,
    process: { phase: 'queued', outcome: null, exitCode: null, signal: null, processStopped: false },
    transport: 'unknown', publication: 'pending', startedAt: null, finishedAt: null, lastSeenAt: null,
    resultIssue: null, cancelRequestedAt: null, createdAt: requestedAt, updatedAt: requestedAt,
  })
}

describe('verification records at qualification and Job transport boundaries', () => {
  it('keeps the protected offline seed receipt bounded and covers the strict release-age boundary', () => {
    const receipt = {
      schemaVersion: 1, packageManager: 'pnpm@11.27.0', platform: { os: 'linux', arch: 'x64', libc: 'glibc' },
      minimumReleaseAge: 2880, minimumReleaseAgeStrict: true, minimumReleaseAgeIgnoreMissingTime: false,
      capturedAt: requestedAt, provenanceDigest: digest,
      review: { reviewedByPrincipalId: 'owner', reviewedAt: requestedAt, decisionDigest: digest },
      maxBytes: 1024, maxInodes: 10,
      dependencyInputs: ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].map(path => ({ path, sha256: digest })),
      files: ['corepack-cache/pnpm.json', 'pnpm-store/index.db', 'registry-cache/fixture.json', 'metadata/fixture.json']
        .map(path => ({ path, bytes: 1, sha256: digest })),
      packages: [{ name: 'fixture', version: '1.0.0', integrity: 'sha512-fixture',
        publishedAt: '2026-10-02T12:00:00.000Z', metadataPath: 'metadata/fixture.json' }],
    }
    expect(JobVerificationOfflineSeedReceiptSchema.parse(receipt)).toEqual(receipt)
    expect(JobVerificationOfflineSeedReceiptSchema.safeParse({ ...receipt,
      packages: [{ ...receipt.packages[0], publishedAt: '2026-10-02T12:00:01.000Z' }] }).success).toBe(false)
    expect(JobVerificationOfflineSeedReceiptSchema.safeParse({ ...receipt,
      files: [...receipt.files, receipt.files[0]] }).success).toBe(false)
    expect(JobVerificationOfflineSeedReceiptSchema.safeParse({ ...receipt, maxBytes: 3 }).success).toBe(false)
    expect(JobVerificationOfflineSeedReceiptSchema.safeParse({ ...receipt,
      dependencyInputs: receipt.dependencyInputs.slice(1) }).success).toBe(false)
  })

  it('retains prepared suite, credential and resource fields in the versioned digest', () => {
    const f = verificationFixture()
    const prepared = PreparedJobSpecRecordSchema.parse({ ...f.spec, source: f.acceptedBuild.source })
    expect(prepared).toMatchObject({ verification: f.spec.verification, policy: f.spec.policy })
    const changed = PreparedJobSpecRecordSchema.parse({ ...prepared,
      verification: { ...f.spec.verification, parameters: { unitWorkers: 2, integrationShards: 1 } } })
    expect(jobSpecDigests(changed, null).specDigest).not.toBe(jobSpecDigests(prepared, null).specDigest)
    const accepted = execution().acceptedSpec
    const otherReservation = { ...accepted, reservationId: '22222222-2222-4222-8222-222222222222' }
    expect(acceptedJobSpecDigests(otherReservation).specDigest).not.toBe(accepted.specDigest)
    expect(acceptedJobSpecDigests(otherReservation).bindingHash).not.toBe(accepted.bindingHash)
    expect(acceptedJobSpecDigests(f.acceptedBuild)).toEqual(jobSpecDigests(f.acceptedBuild, null))
  })

  it('retains a reviewed approval and denies a changed lifetime or missing review', () => {
    const measured = JobVerificationRuntimeMeasurementSchema.parse(verificationMeasurementFixture())
    const approval = { schemaVersion: 2, id, qualificationId: id, workspaceId: 'workspace',
      profileId: measured.fingerprint.profileId, profileRevision: 1, fingerprint: measured.fingerprint,
      fingerprintDigest: digest, requestedByPrincipalId: 'runner', status: 'awaiting-approval',
      approvedByPrincipalId: null, approvedAt: null, requestedAt, expiresAt: measured.expiresAt }
    expect(JobRuntimeApprovalRecordSchema.parse(approval)).toEqual(approval)
    expect(JobRuntimeApprovalRecordSchema.safeParse({ ...approval,
      expiresAt: '2026-10-04T14:00:00.000Z' }).success).toBe(false)
    expect(JobRuntimeApprovalRecordSchema.safeParse({ ...approval, fingerprint: { ...approval.fingerprint,
      approvalConfig: { ...approval.fingerprint.approvalConfig, review: null } } }).success).toBe(false)
  })

  it('carries the full verification candidate and measured result without promoting a build result', () => {
    const measured = JobVerificationRuntimeMeasurementSchema.parse(verificationMeasurementFixture())
    const fingerprint = measured.fingerprint
    const profile = JobVerificationProfileSchema.parse({ schemaVersion: 2, id: fingerprint.profileId,
      workspaceId: fingerprint.root.binding.workspaceId, revision: fingerprint.profileRevision,
      name: 'Ordinary verification', root: fingerprint.root, sourceCommit: fingerprint.sourceCommit,
      specDigest: fingerprint.specDigest, status: 'unqualified', measurement: null,
      approvalConfig: fingerprint.approvalConfig, createdAt: requestedAt, updatedAt: requestedAt,
      spec: { rootId: fingerprint.root.binding.rootId, bindingRevision: fingerprint.root.binding.bindingRevision,
        resources: fingerprint.resources, policy: jobPolicyRequirementsRecord(verificationFixture().spec.policy),
        suites: measured.suites.map(suite => suite.suite),
        approvalConfig: { approvalLifetimeMs: fingerprint.approvalConfig.approvalLifetimeMs } } })
    expect(profile.approvalConfig).toEqual(fingerprint.approvalConfig)
    expect(JobVerificationProfileSchema.safeParse({ ...profile, spec: { ...profile.spec,
      approvalConfig: fingerprint.approvalConfig } }).success).toBe(false)
    const candidate = { qualificationId: id, operationId: id, approvalId: id, fingerprint, profile,
      approvedAt: measured.approvedAt,
      findmntBinary: '/usr/bin/findmnt', findmntBinarySha256: digest, backingFile: null, backingBytes: null,
      volumeCapacityBytes: measured.fingerprint.quota.volumeCapacityBytes,
      controllerEnvironment: { PATH: '/usr/bin', XDG_RUNTIME_DIR: '/runtime', LANG: 'C.UTF-8' },
      sourceParent: measured.fingerprint.root.binding.canonicalPath, runtimeRoot: '/runtime',
      spoolBytes: 131072, ttlSeconds: 3600 }
    const request = { version: 3, operation: 'run', admission: admission(), candidate }
    expect(JobRuntimeQualificationRpcRequestRecordSchema.parse(request)).toEqual(request)
    for (const operation of ['start', 'status']) {
      expect(JobRuntimeQualificationRpcRequestRecordSchema.parse({ ...request, operation, intent: 'execute' })).toEqual({ ...request, operation, intent: 'execute' })
      const status = { ...request, operation, phase: 'running', result: null }
      expect(JobRuntimeQualificationRpcResponseRecordSchema.parse(status)).toEqual(status)
      expect(JobRuntimeQualificationRpcResponseRecordSchema.safeParse({ ...status, phase: 'complete' }).success).toBe(false)
      expect(JobRuntimeQualificationRpcRequestRecordSchema.safeParse({ ...request, operation,
        candidate: { ...candidate, operationId: '22222222-2222-4222-8222-222222222222' } }).success).toBe(false)
    }

    expect(JobRuntimeQualificationRpcRequestRecordSchema.safeParse({ ...request,
      admission: { ...request.admission, runtimeApprovalRevision: 2 } }).success).toBe(false)
    expect(JobRuntimeQualificationRpcRequestRecordSchema.safeParse({ ...request,
      candidate: { ...candidate, operationId: '22222222-2222-4222-8222-222222222222' } }).success).toBe(false)
    const runtime = {
      ...fingerprint.limits, policyId: fingerprint.profileId, policyRevision: fingerprint.profileRevision,
      qualificationId: measured.identity.qualificationId, imageDigest: fingerprint.imageDigest,
      toolchainDigest: fingerprint.toolchainDigest, runtimeVersion: 'podman-fixture',
      ociRuntimeVersion: 'crun-fixture', kernelVersion: 'linux-fixture',
      rootless: true, cgroupV2: true, filesystemBounded: true, descendantContainment: true,
      network: fingerprint.network, workspaceLayout: fingerprint.workspaceLayout,
      resourcePolicyRevision: fingerprint.resourcePolicyRevision,
      resourcePolicyDigest: fingerprint.resourcePolicyDigest, runtimeApprovalId: fingerprint.runtimeApprovalId,
      runtimeApprovalRevision: fingerprint.runtimeApprovalRevision, provisioningSuite: fingerprint.provisioningSuite,
      deviceLimits: fingerprint.deviceLimits, quota: fingerprint.quota,
      aggregateCgroupIdentityDigest: fingerprint.aggregateCgroupIdentityDigest,
      imageManifestDigest: fingerprint.imageManifestDigest, imageConfigDigest: fingerprint.imageConfigDigest,
    }
    const response = { ...request, result: { outcome: 'qualified', measurement: measured, runtime } }
    expect(JobRuntimeQualificationRpcResponseRecordSchema.parse(response)).toEqual(response)
    expect(JobRuntimeQualificationRpcResponseRecordSchema.safeParse({ ...response,
      result: { ...response.result, runtime: { ...runtime, memoryBytes: runtime.memoryBytes + 1 } } }).success).toBe(false)
    expect(JobRuntimeQualificationRpcResponseRecordSchema.safeParse({ ...response, version: 1 }).success).toBe(false)
    expect(JobRuntimeQualificationRpcResponseRecordSchema.safeParse({ ...response,
      admission: { ...response.admission, fingerprintDigest: 'b'.repeat(64) } }).success).toBe(false)
  })

  it('keeps native admissions on their original authenticated installation', () => {
    const saved = admission()
    expect(JobVerificationRuntimeNativeAdmissionSchema.safeParse({ ...saved,
      mainInstallationId: '22222222-2222-4222-8222-222222222222' }).success).toBe(false)
    expect(JobVerificationRuntimeNativeAdmissionSchema.safeParse({ ...saved, expiresAt: saved.admittedAt }).success).toBe(false)
    expect(JobVerificationRuntimeNativeAdmissionSchema.safeParse({ ...saved,
      hostRef: { kind: 'device', mainId: saved.mainInstallationId, deviceId: id } }).success).toBe(false)
  })

  it('retains accepted verification records and rejects a different dispatch subject, owner or authority', () => {
    const job = execution()
    const spec = job.acceptedSpec
    const intent = { schemaVersion: 1, protocolVersion: 1, mainId: spec.target.mainId,
      subject: { kind: 'manual-job', workspaceId: job.workspaceId, jobExecutionId: job.id,
        definitionId: spec.definitionId }, executionId: job.id, attemptId: job.attemptId,
      operationId: job.operationId, bindingHash: spec.bindingHash, inputDigest: `sha256:${spec.specDigest}`,
      owner: job.owner, resourcePolicyRevision: 1, resourcePolicyDigest: digest,
      runtimeApprovalId: id, runtimeApprovalRevision: 1 }
    const request = { method: 'job-dispatch', intent, execution: job }
    expect(RemoteJobExecutionRpcRequestRecordSchema.parse(request)).toEqual(request)
    expect(RemoteVerificationJobDispatchRequestSchema.parse(request)).toEqual(request)
    for (const changed of [{ owner: { grantId: 'other', epoch: '1' } },
      { runtimeApprovalRevision: 2 }, { inputDigest: `sha256:${'b'.repeat(64)}` },
      { subject: { ...intent.subject, jobExecutionId: 'other' } }]) {
      expect(RemoteVerificationJobDispatchRequestSchema.safeParse({ ...request,
        intent: { ...intent, ...changed } }).success).toBe(false)
    }
    expect(JobExecutionSchema.safeParse(job).success).toBe(false)
  })
})
