import { isDeepStrictEqual } from 'node:util'
import type { JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { z } from 'zod'
import { RemoteJobDispatchIntentSchema, RemoteJobConnectionIdentitySchema } from '@foreman-code/contracts/remote-job-execution'
import { JobVerificationRepositoryContextSchema } from '@foreman-code/contracts/job-verification-runtime'
import { SourcePreparationClosureSchema } from '@foreman-code/contracts/source-admission'

const process = z.object({ pid: z.number().int().positive(), startTicks: z.string().regex(/^\d+$/), bootId: z.uuid() }).strict()
const boundary = z.object({ kind: z.literal('cgroup-v2'), path: z.string().startsWith('/sys/fs/cgroup/'), device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/) }).strict()
export const JobOCICertificateSchema = z.object({
  scope: z.object({ subject: z.object({ kind: z.literal('job'), executionId: z.string().min(1), attemptId: z.string().min(1), operationId: z.string().min(1), bindingHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    leaseId: z.string().min(1), owner: RemoteJobDispatchIntentSchema.shape.owner, observedDeviceId: z.string().min(1).nullable(), observedInstallationId: z.string().min(1), bootId: z.uuid() }).strict(),
  containerId: z.string().regex(/^[a-f0-9]{64}$/), process, boundary,
  helpers: z.array(z.object({ kind: z.enum(['conmon', 'launcher']), process, boundary: boundary.nullable() }).strict()).max(512),
  lifecycle: z.enum(['active', 'closed', 'closure-unconfirmed']),
}).strict()
/** Internal evidence in the existing fsynced worker journal, never a second owner ledger. */
export const JobNativeOwnerSchema = z.object({
  operationId: z.string().min(1), qualificationOperationId: z.string().min(1).nullable().default(null), timedOut: z.boolean().default(false), connection: RemoteJobConnectionIdentitySchema,
  nonEntryConfirmed: z.boolean().default(false),
  sourceReclamation: SourcePreparationClosureSchema.optional(),
  launches: z.array(z.object({ launchId: z.uuid(), processOwner: z.string().min(1).optional(), binary: z.string().startsWith('/'), argv: z.array(z.string()).max(256),
    exit: z.object({ exitCode: z.number().int().nullable(), signal: z.string().nullable() }).strict().nullable(), closed: z.boolean() }).strict()).max(512),
  container: z.object({ identity: z.string().min(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), containerId: z.string().regex(/^[a-f0-9]{64}$/).nullable(), deadlineAt: z.string().datetime().nullable().default(null), certificate: JobOCICertificateSchema.nullable(), unreleasedClosureConfirmed: z.boolean().optional() }).strict().nullable(),
  verification: z.object({ context: JobVerificationRepositoryContextSchema,
    contextPin: z.object({ relativePath: z.literal('verification.json'), sha256: z.string().regex(/^[a-f0-9]{64}$/),
      byteSize: z.number().int().positive().max(1024*1024) }).strict(),
    reserve: z.object({ parent: z.string().startsWith('/'), name: z.string().min(1), device: z.number().int(),
      inode: z.number().int(), bytes: z.number().int().positive() }).strict(),
    finalizedAt: z.string().datetime().nullable() }).strict().optional(),
}).strict()
export type JobNativeOwner = z.infer<typeof JobNativeOwnerSchema>

export function jobContainerNonEntryObserved(owner: JobNativeOwner): boolean {
  const container = owner.container
  if (!container || container.certificate || !owner.launches.length) return false
  if (container.containerId) {
    return container.unreleasedClosureConfirmed === true && owner.launches.every(launch => launch.closed)
      && !owner.launches.some(launch => (launch.argv[0] === '--remote=false' ? launch.argv[1] : launch.argv[0]) === 'exec')
  }
  const exact = (argv: string[], operation: string) => isDeepStrictEqual(argv,
    ['--remote=false', 'container', operation, container.identity])
  return owner.launches.every(launch => launch.closed && (exact(launch.argv, 'inspect') || exact(launch.argv, 'exists')))
    && owner.launches.some(launch => exact(launch.argv, 'exists') && launch.exit?.exitCode === 1 && launch.exit.signal === null)
}

export function isPreparatoryVerificationOwner(owner: JobNativeOwner, execution: JobExecutionRecord): boolean {
  if (execution.schemaVersion !== 2 || owner.operationId !== execution.operationId
    || owner.launches.length || owner.container || !owner.verification) return false
  const identity = owner.verification.context.identity
  const spec = execution.acceptedSpec
  return identity.executionId === execution.id && identity.attemptId === execution.attemptId
    && identity.commit === spec.source.commit && identity.definitionVersionId === spec.definitionVersionId
    && isDeepStrictEqual(identity.profile, spec.profile)
    && isDeepStrictEqual(identity.resources, spec.verification.resources)
    && identity.suite === spec.verification.suite
}
