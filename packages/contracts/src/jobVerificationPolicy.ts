import { z } from 'zod'
import { DeviceDigestSchema, DeviceSafeIntegerSchema } from './deviceResources.js'
import { JobPolicySchema, JobRuntimeLimitsSchema } from './jobs.js'
import { IdSchema, TimestampSchema } from './schemaPrimitives.js'

const PositiveInteger = DeviceSafeIntegerSchema.positive()
const JOB_VERIFICATION_POLICY_VERSION = 2 as const
export const JOB_VERIFICATION_APPROVAL_LIFETIME_MS = 24 * 60 * 60 * 1000
export const JOB_VERIFICATION_OWNER_CONFIGURATION = Object.freeze({
  schemaVersion: 1, revision: 1, id: 'offline-verification', reviewedOn: '2026-10-05',
  network: 'none', approvalLifetimeMs: JOB_VERIFICATION_APPROVAL_LIFETIME_MS,
  mainConcurrentJobs: 4, laptopConcurrentJobs: 2, unitWorkers: 12, integrationShards: 12,
  laptopMinimumAvailableBytes: 4 * 2 ** 30, laptopPerRunningJobBytes: 2 * 2 ** 30,
  credentialDelivery: 'local-only',
})
/** Unit test workers for a qualification: the owner's maximum, but never more than the profile's whole CPUs,
 * so a small build allowance does not oversubscribe its container and time tests out. */
export function qualificationUnitWorkers(limits: { cpuLimit: number }): number {
  return Math.max(1, Math.min(JOB_VERIFICATION_OWNER_CONFIGURATION.unitWorkers, Math.floor(limits.cpuLimit)))
}
/** Each integration slot runs an API process and disposable database within the saved Job reservation.
 * Measured gates run 11 slots on 14 GiB computers, so a slot budgets 1 GiB of memory after the shared database. */
export function qualificationIntegrationShards(resources: {
  limits: { cpuLimit: number; memoryBytes: number }; scratchBytes: number
}): number {
  const gib = 2 ** 30
  const cpuSlots = Math.floor(resources.limits.cpuLimit)
  const memorySlots = Math.floor((resources.limits.memoryBytes - gib) / gib)
  const scratchSlots = Math.floor(resources.scratchBytes / (2 * gib))
  return Math.max(1, Math.min(JOB_VERIFICATION_OWNER_CONFIGURATION.integrationShards,
    cpuSlots, memorySlots, scratchSlots))
}

export const JOB_VERIFICATION_INITIAL_CONCURRENCY = Object.freeze({
  heavyJobs: 1,
  integrationShards: 1,
  unitWorkers: 1,
})

/** These are policy identities; only measured worker enforcement makes a mode available. */
export const JobNetworkPolicySchema = z.discriminatedUnion('mode', [
  z.object({ schemaVersion: z.literal(2), mode: z.literal('none') }).strict(),
  z.object({
    schemaVersion: z.literal(2),
    mode: z.enum(['registry-only', 'public-egress']),
    enforcement: z.object({
      implementation: IdSchema,
      version: IdSchema,
      destinationPolicyDigest: DeviceDigestSchema,
    }).strict(),
  }).strict(),
])
export type JobNetworkPolicy = z.infer<typeof JobNetworkPolicySchema>

/** Includes service, install and cleanup peaks. Temp/shm/spool/reports are sub-budgets, not extra capacity. */
export const JobResourceRequestSchema = z.object({
  schemaVersion: z.literal(1),
  limits: JobRuntimeLimitsSchema.extend({
    memoryBytes: PositiveInteger, pidsLimit: PositiveInteger, diskBytes: PositiveInteger,
  }),
  mutableInodes: PositiveInteger,
  controlTempBytes: PositiveInteger,
  scratchBytes: PositiveInteger,
  scratchExecutable: z.boolean(),
  shmBytes: PositiveInteger,
  spoolBytes: PositiveInteger,
  reportBytes: PositiveInteger,
}).strict().superRefine((value, context) => {
  const diskBytes = value.controlTempBytes + value.scratchBytes + value.spoolBytes + value.reportBytes
  if (!Number.isSafeInteger(diskBytes) || diskBytes > value.limits.diskBytes) {
    context.addIssue({ code: 'custom', message: 'Private storage sub-budgets exceed the Job disk reservation.' })
  }
  if (value.shmBytes > value.limits.memoryBytes) {
    context.addIssue({ code: 'custom', path: ['shmBytes'], message: 'Private shm is charged to Job memory.' })
  }
})
export type JobResourceRequest = z.infer<typeof JobResourceRequestSchema>

export const JobVerificationPolicySchema = JobPolicySchema.omit({ network: true }).extend({
  schemaVersion: z.literal(JOB_VERIFICATION_POLICY_VERSION),
  environmentScopeRefs: z.array(IdSchema).max(0),
  network: JobNetworkPolicySchema,
  serviceStartupTimeoutMs: PositiveInteger,
  publicationTimeoutMs: PositiveInteger,
  cleanupTimeoutMs: PositiveInteger,
}).strict()
export const JobVerificationPolicyRequirementsSchema = JobVerificationPolicySchema.omit({
  isolationPolicyId: true,
  isolationPolicyRevision: true,
})
type JobVerificationPolicy = z.infer<typeof JobVerificationPolicySchema>

export const JobVerificationLifecycleSchema = z.object({
  dispatchAt: TimestampSchema,
  executionDeadlineAt: TimestampSchema,
  publicationDeadlineAt: TimestampSchema,
  cleanupDeadlineAt: TimestampSchema,
}).strict()
export function verificationJobLifecycle(dispatchAt: string, policy: JobVerificationPolicy) {
  const execution = Date.parse(dispatchAt) + policy.preparationTimeoutMs
    + policy.serviceStartupTimeoutMs + policy.executionTimeoutMs
  const publication = execution + policy.cancellationGraceMs + policy.publicationTimeoutMs
  return JobVerificationLifecycleSchema.parse({ dispatchAt,
    executionDeadlineAt: new Date(execution).toISOString(),
    publicationDeadlineAt: new Date(publication).toISOString(),
    cleanupDeadlineAt: new Date(publication + policy.cleanupTimeoutMs).toISOString() })
}

/** Save input cannot declare review, approval or measured readiness. */
export const JobVerificationApprovalConfigInputSchema = z.object({
  approvalLifetimeMs: PositiveInteger.default(JOB_VERIFICATION_APPROVAL_LIFETIME_MS),
}).strict()
export const JobVerificationApprovalConfigSchema = z.object({
  schemaVersion: z.literal(1),
  revision: PositiveInteger,
  approvalLifetimeMs: PositiveInteger,
  review: z.union([z.object({
    reviewedByPrincipalId: IdSchema,
    reviewedAt: TimestampSchema,
    decisionDigest: DeviceDigestSchema,
  }).strict(), z.object({
    authority: z.literal('repository-owner'), decisionId: IdSchema,
    reviewedOn: z.iso.date(), decisionDigest: DeviceDigestSchema,
  }).strict()]).nullable(),
}).strict().superRefine((value, context) => {
  if (value.review === null && value.approvalLifetimeMs !== 3_600_000
    && value.approvalLifetimeMs !== JOB_VERIFICATION_APPROVAL_LIFETIME_MS) {
    context.addIssue({ code: 'custom', message: 'Changing approval lifetime requires an owner-reviewed configuration.' })
  }
})

export const JobVerificationProfileIdentitySchema = z.object({
  profileId: IdSchema,
  profileRevision: PositiveInteger,
  qualificationId: z.uuid(),
  rootId: z.uuid(),
  bindingRevision: PositiveInteger,
  fingerprintDigest: DeviceDigestSchema,
  imageDigest: JobPolicySchema.shape.imageDigest,
  toolchainDigest: DeviceDigestSchema,
  network: JobNetworkPolicySchema,
  approvalId: z.uuid(),
  approvalExpiresAt: TimestampSchema,
  qualificationExpiresAt: TimestampSchema,
}).strict().superRefine((value, context) => {
  if (Date.parse(value.qualificationExpiresAt) > Date.parse(value.approvalExpiresAt)) {
    context.addIssue({ code: 'custom', message: 'Qualification cannot outlive its human approval.' })
  }
})

/** Dispatch reserves enough remaining validity for preparation, execution and closure/publication. */
export const JobVerificationDispatchValiditySchema = z.object({
  identity: JobVerificationProfileIdentitySchema,
  approvalConfig: JobVerificationApprovalConfigSchema,
  approvedAt: TimestampSchema,
  dispatchAt: TimestampSchema,
  policy: JobVerificationPolicySchema,
}).strict().superRefine((value, context) => {
  const { policy, identity } = value
  const requiredMs = policy.preparationTimeoutMs + policy.serviceStartupTimeoutMs + policy.executionTimeoutMs
    + policy.cancellationGraceMs + policy.publicationTimeoutMs + policy.cleanupTimeoutMs
  const approvedAt = Date.parse(value.approvedAt)
  const dispatchAt = Date.parse(value.dispatchAt)
  const expiresAt = Math.min(Date.parse(identity.approvalExpiresAt), Date.parse(identity.qualificationExpiresAt))
  if (!value.approvalConfig.review || dispatchAt < approvedAt
    || Date.parse(identity.approvalExpiresAt) - approvedAt > value.approvalConfig.approvalLifetimeMs
    || expiresAt - dispatchAt < requiredMs) {
    context.addIssue({ code: 'custom', message: 'Reviewed approval must cover the original dispatch and closure deadlines.' })
  }
  if (policy.isolationPolicyId !== identity.profileId || policy.isolationPolicyRevision !== identity.profileRevision
    || policy.imageDigest !== identity.imageDigest || policy.toolchainDigest !== identity.toolchainDigest
    || JSON.stringify(policy.network) !== JSON.stringify(identity.network)) {
    context.addIssue({ code: 'custom', message: 'Dispatch policy differs from the qualified profile identity.' })
  }
})
