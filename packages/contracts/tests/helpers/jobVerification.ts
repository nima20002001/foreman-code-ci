import { verificationJobLifecycle } from '../../src/jobVerificationPolicy.js'
import { JOB_RUNTIME_PROVISIONING_SUITE, JOB_RUNTIME_WORKSPACE_LAYOUT } from '../../src/jobRuntime.js'
import { JOB_VERIFICATION_BASE_CHECKS } from '../../src/jobVerificationRuntime.js'
import { ResolvedJobDefinitionSpecSchema, AcceptedJobSpecSchema } from '../../src/jobs.js'
import { JobQueueTicketSchema, JobResourceReservationSchema } from '../../src/jobAdmission.js'
import { ResolvedVerificationJobSpecSchema, JobVerificationReportSchema } from '../../src/jobVerification.js'
import { JobVerificationProfileIdentitySchema } from '../../src/jobVerificationPolicy.js'

export const verificationId = '11111111-1111-4111-8111-111111111111'
export const verificationDigest = 'a'.repeat(64)
export const verificationTime = '2026-10-04T12:00:00.000Z'
const expiry = '2026-10-04T13:00:00.000Z'

export function verificationFixture() {
  const id = verificationId
  const digest = verificationDigest
  const build = ResolvedJobDefinitionSpecSchema.parse({
    source: { approvedSourceId: id, snapshotId: id, commit: 'b'.repeat(40), manifestDigest: digest },
    target: {
      schemaVersion: 1, mainId: id, mainInstallationId: id, hostRef: { kind: 'main', mainId: id }, registration: null,
      destination: {
        canonicalProjectRoot: '/approved/source', canonicalCwd: '/approved/source', managedRuntimeRoot: '/approved/runtime',
        directoryIdentityHash: digest, rootPolicyId: 'root', rootPolicyRevision: '1', locationRevision: '1',
        attestationId: 'attestation', attestationHash: digest,
      },
    },
    argv: ['corepack', 'pnpm', 'test'], inputs: [], outputs: [],
    policy: {
      isolationPolicyId: 'profile', isolationPolicyRevision: 1, imageDigest: `sha256:${digest}`, toolchainDigest: digest,
      environmentScopeRefs: [], network: 'none', queueTimeoutMs: 60_000, preparationTimeoutMs: 30_000,
      executionTimeoutMs: 60_000, cancellationGraceMs: 10_000, maxLogChunkBytes: 1024,
      maxLogBytes: 4096, maxWorkerSpoolBytes: 4096, logOverflow: 'stop', maxOutputBytes: 4096, retentionSeconds: 3600,
    },
  })
  const resources = {
    schemaVersion: 1 as const,
    limits: { cpuLimit: 1, memoryBytes: 2 ** 30, pidsLimit: 128, diskBytes: 8 * 2 ** 30 },
    mutableInodes: 100_000, controlTempBytes: 2 ** 20, scratchBytes: 2 ** 30, scratchExecutable: true,
    shmBytes: 64 * 2 ** 20, spoolBytes: 2 ** 20, reportBytes: 2 ** 20,
  }
  const spec = ResolvedVerificationJobSpecSchema.parse({
    ...build,
    policy: { ...build.policy, schemaVersion: 2, network: { schemaVersion: 2, mode: 'none' },
      serviceStartupTimeoutMs: 10_000, publicationTimeoutMs: 10_000, cleanupTimeoutMs: 10_000 },
    outputs: [{ path: 'reports/summary.json', required: true, mediaType: 'application/json',
      kind: 'suite-summary', maxBytes: 4096 }],
    verification: { suite: 'unit', parameters: { unitWorkers: 1, integrationShards: 1 }, resources, credentialRefs: [] },
  })
  const profile = JobVerificationProfileIdentitySchema.parse({
    profileId: 'profile', profileRevision: 1, qualificationId: id, rootId: id, bindingRevision: 1, fingerprintDigest: digest,
    imageDigest: build.policy.imageDigest, toolchainDigest: digest, network: spec.policy.network,
    approvalId: id, approvalExpiresAt: expiry, qualificationExpiresAt: expiry,
  })
  const definition = {
    schemaVersion: 1 as const, id: 'definition', workspaceId: 'workspace', name: 'Build', revision: 1,
    versionId: 'definition-version', spec: build, createdAt: verificationTime, updatedAt: verificationTime,
  }
  const ticket = JobQueueTicketSchema.parse({
    schemaVersion: 1, id, workspaceId: 'workspace', revision: 1, commandId: 'start-command', commandDigest: digest,
    principalId: 'operator', definition, executionId: 'execution', attemptId: 'attempt', operationId: 'operation',
    workflow: null, gateId: null, placement: { kind: 'explicit', target: build.target }, placementOverride: null,
    resources, enqueueSequence: '1', enqueuedAt: verificationTime, deadlineAt: '2026-10-04T12:01:00.000Z',
    state: 'waiting', waitingReasons: ['busy'], compatibleTargetCount: 1, queuePosition: 1, estimatedStartAt: null,
    reservationId: null, cancelRequestedAt: null, terminalReason: null, finishedAt: null,
  })
  const reservation = JobResourceReservationSchema.parse({
    schemaVersion: 1, id, ticketId: id, workspaceId: 'workspace', executionId: 'execution', attemptId: 'attempt',
    operationId: 'operation', target: build.target, rootId: id, bindingRevision: 1, profileId: 'profile',
    profileRevision: 1, qualificationId: id, resources, computerSelection: { mode: 'auto', buildPriority: 50, settingsRevision: 1 },
    slot: 1, owner: { grantId: 'owner-grant', epoch: '1' }, state: 'preparing', claimedAt: verificationTime,
    deliveryAttemptedAt: null, closure: null, computeReleasedAt: null, cleanupCompletedAt: null, storageReleasedAt: null,
  })
  const acceptedBuild = AcceptedJobSpecSchema.parse({
    ...build, source: { ...build.source, materializationId: id, materializationDigest: digest },
    workflowInput: null, definitionId: definition.id, definitionRevision: 1, definitionVersionId: definition.versionId,
    scriptDigest: digest, outputSpecDigest: digest, specDigest: digest, bindingHash: digest,
  })
  const report = JobVerificationReportSchema.parse({
    schemaVersion: 1, commit: build.source.commit, manifestDigest: digest, definitionVersionId: definition.versionId,
    suite: 'unit', executionId: 'execution', attemptId: 'attempt', target: build.target, profile, resources,
    parameters: spec.verification.parameters, startedAt: verificationTime, finishedAt: '2026-10-04T12:00:30.000Z',
    totals: { total: 4, passed: 4, failed: 0, skipped: 0 }, firstPassFailed: 0,
    expectedPortions: 1, completedPortions: 1, disallowedSkipped: 0, completeness: 'complete', outcome: 'passed',
  })
  const pass = {
    report,
    expected: { commit: report.commit, manifestDigest: digest, definitionVersionId: definition.versionId,
      suite: report.suite, executionId: report.executionId, attemptId: report.attemptId,
      target: report.target, profile: report.profile, resources: report.resources, parameters: report.parameters },
    process: { phase: 'terminal', outcome: 'succeeded', exitCode: 0, signal: null, processStopped: true },
    publication: 'complete', requiredOutputsVerified: true,
  }
  return { lifecycle: verificationJobLifecycle('2026-10-04T12:00:00.000Z', spec.policy), build, spec, profile, resources, definition, ticket, reservation, acceptedBuild, report, pass }
}

export function verificationMeasurementFixture() {
  const { build, resources, profile } = verificationFixture()
  const id = verificationId
  const digest = verificationDigest
  const gib = 2 ** 30
  const root = {
    version: 1, source: { approvedSourceId: id, snapshotId: id, manifestDigest: digest },
    selection: { hostRef: build.target.hostRef, rootPolicyId: id, rootPolicyRevision: '1', locationRevision: '1' },
    binding: { version: 1, mainId: id, deviceId: null, workerInstallationId: null, workspaceId: 'workspace', rootId: id,
      bindingRevision: 1, locationRevision: 1, canonicalPath: '/approved/source',
      filesystem: { device: '1', inode: '2', mountId: '3' }, accessMode: 'exclusive-write', snapshotId: id, manifestDigest: digest },
    ownerPrincipalId: 'owner', authorizedByPrincipalId: 'owner', registration: null,
    attestationId: 'attestation', attestationDigest: digest, boundAt: verificationTime,
  }
  const fingerprint = {
    schemaVersion: 3, profileId: profile.profileId, profileRevision: 1, specDigest: digest,
    hostRef: build.target.hostRef, registration: null, mainInstallationId: id, bootId: id, root,
    runtimeExecutable: '/usr/bin/podman', runtimeBinarySha256: digest, ociExecutable: '/usr/bin/crun', ociBinarySha256: digest,
    configurationDigest: digest, imageDigest: build.policy.imageDigest, toolchainDigest: digest,
    limits: resources.limits, workspaceLayout: JOB_RUNTIME_WORKSPACE_LAYOUT,
    resourcePolicyRevision: 1, resourcePolicyDigest: digest, runtimeApprovalId: id, runtimeApprovalRevision: 1,
    provisioningSuite: JOB_RUNTIME_PROVISIONING_SUITE,
    deviceLimits: { cpuLimit: 4, memoryBytes: 8 * gib, pidsLimit: 1024, diskBytes: 64 * gib },
    quota: {
      volumeId: id, mountIdentityDigest: digest, volumeCapacityBytes: 64 * gib,
      growthMode: 'filesystem-project-quota', reservedHostBytes: gib, controlProjectId: 1, workloadProjectId: 2,
      controlHardLimitBytes: gib, controlUsageBytes: 0, workloadHardLimitBytes: 63 * gib, workloadUsageBytes: 0,
      controlHardInodes: 1000, controlUsedInodes: 0, workloadHardInodes: 1_000_000, workloadUsedInodes: 0,
      quotaRevision: 1, quotaDigest: digest, accountingEnabled: true, enforcementEnabled: true,
      inheritanceVerified: true, rootlessAccountingVerified: true,
    },
    aggregateCgroupIdentityDigest: digest, imageManifestDigest: `sha256:${digest}`, imageConfigDigest: `sha256:${digest}`,
    network: profile.network, resources,
    approvalConfig: { schemaVersion: 1, revision: 1, approvalLifetimeMs: 3_600_000,
      review: { reviewedByPrincipalId: 'owner', reviewedAt: verificationTime, decisionDigest: digest } },
    tools: [], seedReceiptSha256: digest, sourceCommit: build.source.commit,
  }
  const checkIds = [...JOB_VERIFICATION_BASE_CHECKS, 'network-none']
  return {
    schemaVersion: 2, identity: profile, fingerprint, origin: 'real-runtime', approvedAt: verificationTime,
    checkedAt: verificationTime, expiresAt: profile.qualificationExpiresAt,
    checks: checkIds.map(id => ({ id, passed: true, evidenceDigest: digest })),
    suites: [{ suite: 'unit', resources, coldCachePeakBytes: gib, coldCachePeakInodes: 1000,
      maxConcurrentHeavyJobs: 1, maxUnitWorkers: 1, maxIntegrationShards: 1, evidenceDigest: digest }],
  }
}
