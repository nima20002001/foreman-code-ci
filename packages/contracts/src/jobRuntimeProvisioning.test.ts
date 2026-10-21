import { describe, expect, it } from 'vitest'
import { DEVICE_GIB, DeviceExecutionAdmissionSchema } from './deviceResources.js'
import { JOB_RUNTIME_PROVISIONING_SUITE, JOB_RUNTIME_PROVISIONED_QUALIFICATION_EXTENSION,
  JobRuntimeProjectQuotaSchema, QualifiedJobRuntimeSchema, JobRuntimeFingerprintSchema, JobRuntimeMeasurementSchema,
  ProvisionedQualifiedJobRuntimeSchema, ProvisionedJobRuntimeFingerprintSchema, ProvisionedJobRuntimeMeasurementSchema,
  ProvisionedJobQualificationCandidateSchema, ProvisionedJobRuntimeQualificationRpcRequestSchema, CurrentJobRuntimeNativeAdmissionSchema } from './jobRuntime.js'
import { CurrentAcceptedNodePlacementSchema, AcceptedNodePlacementSchema, CurrentDispatchIntentSchema } from './nodePlacement.js'
import { CurrentAcceptedJobSpecSchema, AcceptedJobSpecSchema } from './jobs.js'
import { CurrentRemoteJobDispatchRequestSchema, CurrentRemoteJobDispatchIntentSchema } from './remoteJobExecution.js'
import { CurrentRemoteExecutionRpcRequestSchema } from './remoteExecutionRpc.js'
import { deviceResourceLimitsFixture } from './deviceProvisioningFixtures.js'
import { JobRuntimeMeasurementRecordSchema, JobRuntimeProfileRecordSchema,
  JobVerificationRuntimeMeasurementSchema } from './jobVerificationRuntime.js'

const id = '11111111-1111-4111-8111-111111111111', digest = 'a'.repeat(64)
const now = '2026-10-02T18:00:00.000Z', expiry = '2026-10-02T19:00:00.000Z'
const admission = { resourcePolicyRevision: 2, resourcePolicyDigest: digest, runtimeApprovalId: id, runtimeApprovalRevision: 1 }
const limits = { cpuLimit: 1, memoryBytes: DEVICE_GIB, diskBytes: 8 * DEVICE_GIB, pidsLimit: 128 }
const root = { version: 1, source: { approvedSourceId: id, snapshotId: id, manifestDigest: digest },
  selection: { hostRef: { kind: 'main', mainId: id }, rootPolicyId: id, rootPolicyRevision: '1', locationRevision: '1' },
  binding: { version: 1, mainId: id, deviceId: null, workerInstallationId: null, workspaceId: id, rootId: id, bindingRevision: 1,
    locationRevision: 1, canonicalPath: '/approved/source', filesystem: { device: '12', inode: '34', mountId: '56' },
    accessMode: 'exclusive-write', snapshotId: id, manifestDigest: digest }, ownerPrincipalId: id, authorizedByPrincipalId: id,
  registration: null, attestationId: id, attestationDigest: digest, boundAt: now }
const quota = { volumeId: id, mountIdentityDigest: digest, volumeCapacityBytes: 256 * DEVICE_GIB,
  growthMode: 'extendable-volume', reservedHostBytes: 64 * DEVICE_GIB, controlProjectId: 100, workloadProjectId: 101,
  controlHardLimitBytes: DEVICE_GIB, controlUsageBytes: 512 * 2 ** 20,
  workloadHardLimitBytes: 63 * DEVICE_GIB, workloadUsageBytes: 4 * DEVICE_GIB,
  controlHardInodes: 1000, controlUsedInodes: 100, workloadHardInodes: 10000, workloadUsedInodes: 500, quotaRevision: 2, quotaDigest: digest,
  accountingEnabled: true, enforcementEnabled: true, inheritanceVerified: true, rootlessAccountingVerified: true }
const provisioned = { ...admission, provisioningSuite: JOB_RUNTIME_PROVISIONING_SUITE, deviceLimits: deviceResourceLimitsFixture,
  quota, aggregateCgroupIdentityDigest: digest, imageManifestDigest: `sha256:${'b'.repeat(64)}`, imageConfigDigest: `sha256:${digest}` }
const historicalRuntime = { ...limits, workspaceLayout: 'source-inputs-private-git-scheduler-v1', policyId: id, policyRevision: 1,
  imageDigest: `sha256:${digest}`, toolchainDigest: digest, runtimeVersion: 'fixture-podman', ociRuntimeVersion: 'fixture-crun',
  kernelVersion: 'fixture-kernel', qualificationId: id, rootless: true, cgroupV2: true, filesystemBounded: true,
  descendantContainment: true, network: 'none' }
const historicalFingerprint = { schemaVersion: 1, profileId: id, profileRevision: 1, specDigest: digest,
  hostRef: { kind: 'main', mainId: id }, registration: null, mainInstallationId: id, bootId: id, root,
  runtimeExecutable: '/usr/bin/podman', runtimeBinarySha256: digest, ociExecutable: '/usr/bin/crun', ociBinarySha256: digest,
  configurationDigest: digest, imageDigest: `sha256:${digest}`, toolchainDigest: digest, limits, workspaceLayout: historicalRuntime.workspaceLayout }
const historicalMeasurement = { schemaVersion: 1, qualificationId: id, profileId: id, profileRevision: 1, specDigest: digest,
  hostRef: historicalFingerprint.hostRef, registration: null, root, runtime: historicalRuntime, runtimeBinarySha256: digest,
  ociBinarySha256: digest, runtimeExecutable: '/usr/bin/podman', environment: { PATH: '/usr/bin', XDG_RUNTIME_DIR: '/run/user/1000', LANG: 'C.UTF-8' },
  fingerprint: historicalFingerprint, fingerprintDigest: digest, approvalId: id, origin: 'real-runtime', checkedAt: now, expiresAt: expiry,
  checks: ['rootless', 'cgroup-v2', 'filesystem-quota', 'descendant-containment', 'network-none', 'image-toolchain', 'credential-isolation']
    .map(id => ({ id, passed: true, evidenceDigest: digest })) }
const runtime = { ...historicalRuntime, ...provisioned }
const fingerprint = { ...historicalFingerprint, ...provisioned, schemaVersion: 2 }
const measurement = { ...historicalMeasurement, runtime, fingerprint }
const candidate = { qualificationId: id, operationId: id, approvalId: id, fingerprint,
  findmntBinary: '/usr/bin/findmnt', findmntBinarySha256: digest, backingFile: '/approved/volume.img', backingBytes: quota.volumeCapacityBytes,
  volumeCapacityBytes: quota.volumeCapacityBytes, controllerEnvironment: { PATH: '/usr/bin', XDG_RUNTIME_DIR: '/run/user/1000', LANG: 'C.UTF-8' },
  sourceParent: '/approved/source', runtimeRoot: '/approved/runtime', spoolBytes: 131072, ttlSeconds: 3600 }
const native = { ...admission, schemaVersion: 2, kind: 'job-runtime-qualification', approvalId: id, qualificationId: id, operationId: id,
  workspaceId: id, profileId: id, profileRevision: 1, fingerprintDigest: digest, leaseId: id, runCommandId: 'run-command',
  runPrincipalId: 'operator', approvedByPrincipalId: 'human', hostRef: historicalFingerprint.hostRef, registration: null,
  mainInstallationId: id, bootId: id, connection: null, admittedAt: now, expiresAt: expiry }

describe('quota-v3 immutable history and current measured admission', () => {
  it('preserves historical v2 facts verbatim and rejects them at new provisioned entry', () => {
    expect(QualifiedJobRuntimeSchema.parse(historicalRuntime)).toEqual(historicalRuntime)
    expect(JobRuntimeFingerprintSchema.parse(historicalFingerprint)).toEqual(historicalFingerprint)
    expect(JobRuntimeMeasurementSchema.parse(historicalMeasurement)).toEqual(historicalMeasurement)
    expect(ProvisionedQualifiedJobRuntimeSchema.safeParse(historicalRuntime).success).toBe(false)
    expect(ProvisionedJobRuntimeFingerprintSchema.safeParse(historicalFingerprint).success).toBe(false)
    expect(ProvisionedJobRuntimeMeasurementSchema.safeParse(historicalMeasurement).success).toBe(false)
    expect(JobRuntimeMeasurementRecordSchema.parse(historicalMeasurement)).toEqual(historicalMeasurement)
    expect(JobRuntimeMeasurementRecordSchema.parse(measurement)).toEqual(measurement)
    expect(JobVerificationRuntimeMeasurementSchema.safeParse(historicalMeasurement).success).toBe(false)
    const profile = { schemaVersion: 1, id, workspaceId: id, revision: 1, name: 'Historical build', root,
      policy: { isolationPolicyId: id, isolationPolicyRevision: 1, imageDigest: historicalRuntime.imageDigest,
        toolchainDigest: digest, environmentScopeRefs: [], network: 'none', queueTimeoutMs: 1000,
        preparationTimeoutMs: 1000, executionTimeoutMs: 1000, cancellationGraceMs: 100,
        maxLogChunkBytes: 1024, maxLogBytes: 4096, maxWorkerSpoolBytes: 4096, logOverflow: 'stop',
        maxOutputBytes: 4096, retentionSeconds: 3600 }, limits, specDigest: digest, status: 'qualified',
      measurement: historicalMeasurement, createdAt: now, updatedAt: now }
    expect(JobRuntimeProfileRecordSchema.parse(profile)).toEqual(profile)
  })
  it('retains current quota/policy/device approval and independent image manifest/config identities', () => {
    expect(ProvisionedJobRuntimeMeasurementSchema.parse(measurement)).toEqual(measurement)
    expect(JobRuntimeMeasurementSchema.parse(measurement)).toEqual(measurement)
    expect(fingerprint.imageManifestDigest).not.toBe(fingerprint.imageConfigDigest)
    expect(JOB_RUNTIME_PROVISIONED_QUALIFICATION_EXTENSION.namespace).toBe('job-runtime-qualification-v2')
  })
  it('measures volume geometry independently of disk allowance, including project quota on an existing filesystem', () => {
    expect(ProvisionedJobQualificationCandidateSchema.parse(candidate)).toEqual(candidate)
    expect(candidate.backingBytes).not.toBe(candidate.fingerprint.limits.diskBytes)
    expect(ProvisionedJobQualificationCandidateSchema.safeParse({ ...candidate, backingBytes: limits.diskBytes }).success).toBe(false)
    const existingFilesystem = { ...candidate, backingFile: null, backingBytes: null,
      fingerprint: { ...fingerprint, quota: { ...quota, growthMode: 'filesystem-project-quota' } } }
    expect(ProvisionedJobQualificationCandidateSchema.parse(existingFilesystem)).toEqual(existingFilesystem)
    expect(ProvisionedJobQualificationCandidateSchema.safeParse({ ...candidate, backingFile: null, backingBytes: null }).success).toBe(false)
  })
  it.each([
    { workloadProjectId: 100 }, { enforcementEnabled: false }, { rootlessAccountingVerified: false },
    { workloadUsageBytes: 64 * DEVICE_GIB }, { volumeCapacityBytes: 32 * DEVICE_GIB }, { quotaRevision: 0 },
    { controlProjectId: 4294967296 }, { workloadUsedInodes: 10001 }, { helperCommand: 'sudo any-command' },
  ])('rejects forged or impossible quota readback %j', change => {
    expect(JobRuntimeProjectQuotaSchema.safeParse({ ...quota, ...change }).success).toBe(false)
  })
  it.each([
    { cpuLimit: 8 }, { memoryBytes: 16 * DEVICE_GIB }, { pidsLimit: 1024 }, { diskBytes: 64 * DEVICE_GIB },
    { imageConfigDigest: `sha256:${'b'.repeat(64)}` }, { resourcePolicyDigest: undefined }, { runtimeApprovalId: undefined },
  ])('rejects over-reservation or missing current authority %j', change => {
    expect(ProvisionedQualifiedJobRuntimeSchema.safeParse({ ...runtime, ...change }).success).toBe(false)
  })
  it('rejects partial provisioned history and mixed fingerprint/runtime authority without rewriting it', () => {
    expect(JobRuntimeFingerprintSchema.safeParse({ ...historicalFingerprint, schemaVersion: 2 }).success).toBe(false)
    expect(JobRuntimeFingerprintSchema.safeParse({ ...fingerprint, schemaVersion: 1 }).success).toBe(false)
    expect(JobRuntimeMeasurementSchema.safeParse({ ...historicalMeasurement, runtime: { ...historicalRuntime, resourcePolicyRevision: 2 } }).success).toBe(false)
    expect(ProvisionedJobRuntimeMeasurementSchema.safeParse({ ...measurement, runtime: { ...runtime, resourcePolicyRevision: 3 } }).success).toBe(false)
  })
  it('retains separate diagnostic identity and matches the exact policy/approval on the versioned wire', () => {
    const wire = { version: 2, operation: 'run', admission: native, candidate }
    expect(CurrentJobRuntimeNativeAdmissionSchema.parse(native)).toEqual(native)
    expect(ProvisionedJobRuntimeQualificationRpcRequestSchema.parse(wire)).toEqual(wire)
    expect(ProvisionedJobRuntimeQualificationRpcRequestSchema.safeParse({ ...wire, version: 1 }).success).toBe(false)
    expect(ProvisionedJobRuntimeQualificationRpcRequestSchema.safeParse({ ...wire, admission: { ...native, resourcePolicyRevision: 3 } }).success).toBe(false)
    expect(ProvisionedJobRuntimeQualificationRpcRequestSchema.safeParse({ ...wire, admission: { ...native, runtimeApprovalRevision: 2 } }).success).toBe(false)
  })
})
const destination = { canonicalProjectRoot: '/approved/source', canonicalCwd: '/approved/source', managedRuntimeRoot: '/approved/runtime',
  directoryIdentityHash: digest, rootPolicyId: id, rootPolicyRevision: '1', locationRevision: '1', attestationId: id, attestationHash: digest }
const placement = { schemaVersion: 1, mainId: id, runId: 'run', nodeId: 'node', hostRef: { kind: 'main', mainId: id }, registration: null,
  mainInstallationId: id, destination, source: { revisionId: id, manifestDigest: digest, materializationId: id, materializationDigest: digest },
  payload: { kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'config', driverId: 'driver', driverRevision: '1', instanceId: 'instance',
    instanceRevision: '1', harnessInstallationId: 'harness', installationFingerprint: 'installation', runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [] }, bindingHash: digest }
const intent = { schemaVersion: 1, protocolVersion: 1, mainId: id, runId: 'run', nodeId: 'node', executionId: 'execution', occurrenceId: null,
  occurrenceIndex: 0, technicalAttempt: 1, attemptId: 'attempt', operationId: 'operation', bindingHash: digest, inputDigest: `sha256:${digest}`,
  owner: { grantId: 'grant', epoch: '1' } }
const policy = { isolationPolicyId: id, isolationPolicyRevision: 1, imageDigest: runtime.imageDigest, toolchainDigest: digest,
  environmentScopeRefs: [], network: 'none', queueTimeoutMs: 1000, preparationTimeoutMs: 1000, executionTimeoutMs: 1000,
  cancellationGraceMs: 100, maxLogChunkBytes: 1024, maxLogBytes: 4096, maxWorkerSpoolBytes: 131072,
  logOverflow: 'stop', maxOutputBytes: 1024, retentionSeconds: 3600 }
const acceptedJob = { source: { approvedSourceId: id, snapshotId: id, commit: 'a'.repeat(40), manifestDigest: digest, materializationId: id, materializationDigest: digest },
  target: { schemaVersion: 1, mainId: id, hostRef: { kind: 'main', mainId: id }, registration: null, mainInstallationId: id, destination },
  argv: ['node', 'test.js'], inputs: [], outputs: [], policy, workflowInput: null, definitionId: 'definition', definitionRevision: 1,
  definitionVersionId: 'definition-version', scriptDigest: digest, outputSpecDigest: digest, specDigest: digest, bindingHash: digest }

describe('required admission facts for new Jobs and native entries', () => {
  it('reads unchanged accepted history but requires complete admission for new executable records', () => {
    expect(AcceptedNodePlacementSchema.parse(placement)).toEqual(placement)
    expect(AcceptedJobSpecSchema.parse(acceptedJob)).toEqual(acceptedJob)
    expect(CurrentAcceptedNodePlacementSchema.safeParse(placement).success).toBe(false)
    expect(CurrentAcceptedJobSpecSchema.safeParse(acceptedJob).success).toBe(false)
    expect(CurrentAcceptedNodePlacementSchema.parse({ ...placement, ...admission })).toBeTruthy()
    expect(CurrentAcceptedJobSpecSchema.parse({ ...acceptedJob, ...admission })).toBeTruthy()
    expect(AcceptedJobSpecSchema.safeParse({ ...acceptedJob, resourcePolicyRevision: 2 }).success).toBe(false)
    expect(DeviceExecutionAdmissionSchema.safeParse({ ...admission, runtimeApprovalRevision: 0 }).success).toBe(false)
  })
  it('requires the original identical policy/approval for new native turns while preserving historical status', () => {
    expect(CurrentDispatchIntentSchema.safeParse(intent).success).toBe(false)
    const wire = { method: 'start-turn', intent: { ...intent, ...admission }, placement: { ...placement, ...admission }, prompt: 'test', correlationId: 'turn-1' }
    expect(CurrentRemoteExecutionRpcRequestSchema.parse(wire)).toEqual(wire)
    expect(CurrentRemoteExecutionRpcRequestSchema.safeParse({ ...wire, placement: { ...wire.placement, resourcePolicyDigest: 'b'.repeat(64) } }).success).toBe(false)
    expect(CurrentRemoteExecutionRpcRequestSchema.safeParse({ ...wire, intent }).success).toBe(false)
    expect(CurrentRemoteExecutionRpcRequestSchema.parse({ method: 'status', intent, placement })).toBeTruthy()
  })
})

it('requires original policy/approval on remote Job entry and refuses mixed accepted authority', () => {
  const jobIntent = { schemaVersion: 1, protocolVersion: 1, mainId: id,
    subject: { kind: 'manual-job', workspaceId: 'workspace', jobExecutionId: 'job', definitionId: 'definition' },
    executionId: 'job', attemptId: 'attempt', operationId: 'operation', bindingHash: digest, inputDigest: `sha256:${digest}`,
    owner: { grantId: 'grant', epoch: '1' } }
  const execution = { schemaVersion: 1, id: 'job', workspaceId: 'workspace', acceptedSpec: { ...acceptedJob, ...admission },
    operationId: 'operation', attemptId: 'attempt', owner: jobIntent.owner, workflow: null,
    process: { phase: 'queued', outcome: null, exitCode: null, signal: null, processStopped: false },
    transport: 'connected', publication: 'pending', startedAt: null, finishedAt: null, lastSeenAt: null,
    resultIssue: null, cancelRequestedAt: null, createdAt: now, updatedAt: now }
  const wire = { method: 'job-dispatch', intent: { ...jobIntent, ...admission }, execution }
  expect(CurrentRemoteJobDispatchRequestSchema.parse(wire)).toEqual(wire)
  expect(CurrentRemoteJobDispatchIntentSchema.safeParse(jobIntent).success).toBe(false)
  expect(CurrentRemoteJobDispatchRequestSchema.safeParse({ ...wire, intent: { ...wire.intent, runtimeApprovalRevision: 2 } }).success).toBe(false)
  expect(CurrentRemoteJobDispatchRequestSchema.safeParse({ ...wire, intent: { ...wire.intent, attemptId: 'other-attempt' } }).success).toBe(false)
})
