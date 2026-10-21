import type { JobDefinition, ResolvedJobDefinitionSpec, JobExecution, JobLogPage } from '@foreman-code/contracts/jobs'
import { JobDefinitionSchema, jobPolicyRequirements } from '@foreman-code/contracts/jobs'
import { JobQueueTicketSchema } from '@foreman-code/contracts/job-admission'
import { VerificationJobDefinitionSchema, VerificationJobExecutionSchema,
  jobPolicyRequirementsRecord, jobVerificationTemplate, type JobVerificationReport } from '@foreman-code/contracts/job-verification'
import { verificationJobLifecycle } from '@foreman-code/contracts/job-verification-policy'
const digest = 'a'.repeat(64)
const uuid = '11111111-1111-4111-8111-111111111111'
export const definition: JobDefinition & { spec: ResolvedJobDefinitionSpec } = {
  schemaVersion: 1, id: 'job-a', workspaceId: 'workspace-a', name: 'Web build', revision: 1, versionId: 'version-a', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  spec: { argv: ['corepack', 'pnpm', 'build'], inputs: [], outputs: [{ path: 'apps/web/dist/index.html', required: true, mediaType: 'text/html' }],
    source: { approvedSourceId: uuid, snapshotId: uuid, commit: 'b'.repeat(40), manifestDigest: digest },
    target: { schemaVersion: 1, mainId: uuid, mainInstallationId: 'main-installation', hostRef: { kind: 'main', mainId: uuid }, registration: null, labelAtAcceptance: 'Qualified PC',
      destination: { canonicalProjectRoot: '/synthetic/root', canonicalCwd: '/synthetic/root', managedRuntimeRoot: '/synthetic/runtime', directoryIdentityHash: digest, rootPolicyId: 'root-a', rootPolicyRevision: '1', locationRevision: '1', attestationId: 'attestation-a', attestationHash: digest } },
    policy: { isolationPolicyId: 'rootless-oci', isolationPolicyRevision: 1, imageDigest: `sha256:${digest}`, toolchainDigest: digest, environmentScopeRefs: [], network: 'none', queueTimeoutMs: 10000, preparationTimeoutMs: 10000, executionTimeoutMs: 60000, cancellationGraceMs: 1000, maxLogChunkBytes: 65536, maxLogBytes: 1048576, maxWorkerSpoolBytes: 1048576, logOverflow: 'explicit-truncation', maxOutputBytes: 1048576, retentionSeconds: 3600 },
  },
}
export const execution: JobExecution = {
  schemaVersion: 1, id: 'execution-a', workspaceId: 'workspace-a', acceptedSpec: { ...definition.spec, workflowInput:null,source:{...definition.spec.source,materializationId:uuid,materializationDigest:digest}, definitionId: definition.id, definitionRevision: 1, definitionVersionId: definition.versionId, scriptDigest: digest, outputSpecDigest: digest, specDigest: digest, bindingHash: digest },
  operationId: 'operation-a', attemptId: 'attempt-a', owner: { grantId: 'grant-a', epoch: '1' }, workflow: null,
  process: { phase: 'terminal', outcome: 'build_failed', exitCode: 7, signal: null, processStopped: true }, transport: 'connected', publication: 'complete', cancelRequestedAt: null,
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:03Z', startedAt: '2026-10-01T00:00:01Z', finishedAt: '2026-10-01T00:00:03Z', lastSeenAt: '2026-10-01T00:00:03Z', resultIssue: 'missing_output',
}
export const logPage: JobLogPage = { chunks: [{ executionId: execution.id, attemptId: execution.attemptId, sequence: 1, stream: 'stderr', text: 'build failed <script>bad()</script>\nλ🙂', byteSize: 45, createdAt: execution.updatedAt }], nextCursor: 1, truncated: false, gap: null }
export const queueTicket = JobQueueTicketSchema.parse({
  schemaVersion: 1, id: uuid, workspaceId: definition.workspaceId, revision: 1,
  commandId: 'start-a', commandDigest: digest, principalId: 'principal-a', definition,
  executionId: execution.id, attemptId: execution.attemptId, operationId: execution.operationId,
  workflow: null, gateId: null, placement: { kind: 'explicit', target: definition.spec.target }, placementOverride: null,
  resources: { schemaVersion: 1, limits: { cpuLimit: 1, memoryBytes: 67108864, pidsLimit: 32, diskBytes: 8388608 },
    mutableInodes: 1000, controlTempBytes: 1048576, scratchBytes: 1048576, scratchExecutable: false,
    shmBytes: 1048576, spoolBytes: 1048576, reportBytes: 1048576 },
  enqueueSequence: '1', enqueuedAt: '2026-10-01T00:00:00Z', deadlineAt: '2026-10-01T00:00:10Z',
  state: 'waiting', waitingReasons: ['offline'], compatibleTargetCount: 1, queuePosition: 1,
  estimatedStartAt: null, reservationId: null, cancelRequestedAt: null, terminalReason: null, finishedAt: null,
})
export const autoDefinition = JobDefinitionSchema.parse({ ...definition,
  spec: { ...definition.spec, target: { kind: 'auto' }, limits: queueTicket.resources.limits,
    policy: jobPolicyRequirements(definition.spec.policy) } })
export const autoQueueTicket = JobQueueTicketSchema.parse({ ...queueTicket,
  definition: autoDefinition, placement: { kind: 'auto' } })

export const verificationPolicy = { ...definition.spec.policy, schemaVersion: 2 as const,
  network: { schemaVersion: 2 as const, mode: 'none' as const }, serviceStartupTimeoutMs: 10000,
  publicationTimeoutMs: 10000, cleanupTimeoutMs: 10000 }
export const verificationTemplate = jobVerificationTemplate({
  profileId: verificationPolicy.isolationPolicyId, profileRevision: verificationPolicy.isolationPolicyRevision,
  suite: 'unit', ready: true, policy: jobPolicyRequirementsRecord(verificationPolicy),
  resources: queueTicket.resources, maxUnitWorkers: 12,
})
export const verificationDefinition = VerificationJobDefinitionSchema.parse({ ...definition, schemaVersion: 2,
  name: 'Repository unit', spec: { ...definition.spec, target: { kind: 'auto' },
    policy: verificationTemplate.policy, limits: verificationTemplate.resources.limits,
    argv: verificationTemplate.argv, outputs: verificationTemplate.outputs,
    verification: { suite: verificationTemplate.suite, parameters: verificationTemplate.parameters,
      resources: verificationTemplate.resources, credentialRefs: [] } } })
export const verificationExecution = VerificationJobExecutionSchema.parse({ ...execution, schemaVersion: 2,
  process: { ...execution.process, outcome: 'succeeded', exitCode: 0 }, resultIssue: null,
  acceptedSpec: { ...execution.acceptedSpec, argv: verificationTemplate.argv,
    outputs: verificationTemplate.outputs, verification: verificationDefinition.spec.verification,
    schemaVersion: 2, target: definition.spec.target, policy: verificationPolicy,
    source: execution.acceptedSpec.source, reservationId: uuid,
    profile: { profileId: verificationPolicy.isolationPolicyId,
      profileRevision: verificationPolicy.isolationPolicyRevision, qualificationId: uuid,
      rootId: uuid, bindingRevision: 1, fingerprintDigest: digest, imageDigest: verificationPolicy.imageDigest,
      toolchainDigest: digest, network: verificationPolicy.network, approvalId: uuid,
      approvalExpiresAt: '2026-10-02T00:00:00Z', qualificationExpiresAt: '2026-10-02T00:00:00Z' },
    lifecycle: verificationJobLifecycle(execution.createdAt, verificationPolicy),
    resourcePolicyRevision: 1, resourcePolicyDigest: digest, runtimeApprovalId: uuid, runtimeApprovalRevision: 1,
  } })
export const verificationReport: JobVerificationReport = {
  schemaVersion: 1, commit: verificationExecution.acceptedSpec.source.commit, manifestDigest: digest,
  definitionVersionId: definition.versionId, suite: 'unit', executionId: execution.id, attemptId: execution.attemptId,
  target: verificationExecution.acceptedSpec.target, profile: verificationExecution.acceptedSpec.profile,
  resources: verificationTemplate.resources, parameters: verificationTemplate.parameters,
  startedAt: execution.startedAt!, finishedAt: execution.finishedAt!,
  totals: { total: 8, passed: 8, failed: 0, skipped: 0 }, firstPassFailed: 0,
  expectedPortions: 2, completedPortions: 2, disallowedSkipped: 0, completeness: 'complete', outcome: 'passed',
}
export const verificationQueueTicket = JobQueueTicketSchema.parse({ ...autoQueueTicket,
  definition: verificationDefinition, resources: verificationTemplate.resources })
