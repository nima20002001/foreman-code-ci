import { verificationJobLifecycle } from '@foreman-code/contracts/job-verification-policy'
import { AcceptedJobSpecSchema, ResolvedJobDefinitionSpecSchema } from '@foreman-code/contracts/jobs'
import { ResolvedVerificationJobSpecSchema } from '@foreman-code/contracts/job-verification'
import { JobVerificationProfileIdentitySchema } from '@foreman-code/contracts/job-verification-policy'

/** Serialized runtime test facts; this fixture does not qualify an installed device. */
export function verificationFixture() {
  const id = '11111111-1111-4111-8111-111111111111'
  const digest = 'a'.repeat(64)
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
  const expiry = '2026-10-04T13:00:00.000Z'
  const profile = JobVerificationProfileIdentitySchema.parse({
    profileId: 'profile', profileRevision: 1, qualificationId: id, rootId: id, bindingRevision: 1,
    fingerprintDigest: digest, imageDigest: build.policy.imageDigest, toolchainDigest: digest, network: spec.policy.network,
    approvalId: id, approvalExpiresAt: expiry, qualificationExpiresAt: expiry,
  })
  const acceptedBuild = AcceptedJobSpecSchema.parse({
    ...build, source: { ...build.source, materializationId: id, materializationDigest: digest },
    workflowInput: null, definitionId: 'definition', definitionRevision: 1, definitionVersionId: 'definition-version',
    scriptDigest: digest, outputSpecDigest: digest, specDigest: digest, bindingHash: digest,
  })
  return { lifecycle: verificationJobLifecycle('2026-10-04T12:00:00.000Z', spec.policy), build, spec, profile, resources, acceptedBuild }
}
