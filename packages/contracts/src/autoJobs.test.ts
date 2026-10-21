import { expect, it } from 'vitest'
import { AutoJobDefinitionSpecSchema, JobDefinitionSpecSchema, PreparedJobSpecSchema,
  ResolvedJobDefinitionSpecSchema, jobPolicyRequirements } from './jobs.js'

const uuid = '11111111-1111-4111-8111-111111111111'
const digest = '1'.repeat(64)
const fixed = ResolvedJobDefinitionSpecSchema.parse({ source: { approvedSourceId: uuid, snapshotId: uuid,
  commit: '2'.repeat(40), manifestDigest: digest },
target: { schemaVersion: 1, mainId: uuid, mainInstallationId: uuid, hostRef: { kind: 'main', mainId: uuid }, registration: null,
  destination: { canonicalProjectRoot: '/approved', canonicalCwd: '/approved', managedRuntimeRoot: '/runtime',
    directoryIdentityHash: digest, rootPolicyId: 'root', rootPolicyRevision: '1', locationRevision: '1',
    attestationId: 'attestation', attestationHash: digest } },
argv: ['node', 'build.mjs'], inputs: [], outputs: [], policy: { isolationPolicyId: 'profile', isolationPolicyRevision: 1,
  imageDigest: `sha256:${digest}`, toolchainDigest: digest, environmentScopeRefs: [], network: 'none',
  queueTimeoutMs: 1000, preparationTimeoutMs: 1000, executionTimeoutMs: 1000, cancellationGraceMs: 100,
  maxLogChunkBytes: 1024, maxLogBytes: 4096, maxWorkerSpoolBytes: 4096, logOverflow: 'stop',
  maxOutputBytes: 4096, retentionSeconds: 3600 } })
const auto = { ...fixed, target: { kind: 'auto' as const }, policy: jobPolicyRequirements(fixed.policy),
  limits: { cpuLimit: 1, memoryBytes: 67108864, diskBytes: 8388608, pidsLimit: 32 } }

it('saves host-independent Auto while concrete preparation and historical fixed specs remain distinct', () => {
  expect(JobDefinitionSpecSchema.parse(auto)).toEqual(auto)
  expect(JobDefinitionSpecSchema.parse(fixed)).toEqual(fixed)
  expect(PreparedJobSpecSchema.safeParse({ ...auto, source: { ...auto.source,
    materializationId: uuid, materializationDigest: digest } }).success).toBe(false)
  expect(AutoJobDefinitionSpecSchema.safeParse({ ...auto, policy: fixed.policy }).success).toBe(false)
  expect(AutoJobDefinitionSpecSchema.safeParse({ ...auto, limits: undefined }).success).toBe(false)
})
it('preserves path validation and exact input/output revisions in Auto authoring', () => {
  const output = { path: 'dist/report.txt', required: true, mediaType: 'text/plain' }
  expect(JobDefinitionSpecSchema.safeParse({ ...auto, outputs: [output, output] }).success).toBe(false)
  expect(JobDefinitionSpecSchema.safeParse({ ...auto, relativeCwd: '../outside' }).success).toBe(false)
  const input = { path: 'input.txt', fileId: 'file', revisionId: 'revision', sha256: digest, byteSize: 12 }
  expect(JobDefinitionSpecSchema.parse({ ...auto, inputs: [input] }).inputs).toEqual([input])
  expect(JobDefinitionSpecSchema.safeParse({ ...auto, inputs: [input, input] }).success).toBe(false)
})
