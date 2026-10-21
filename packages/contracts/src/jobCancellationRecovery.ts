import { optionalCommandId } from './management/commands.js'
import { z } from 'zod'
import { JobExecutionRecordSchema } from './jobVerification.js'
import { DeviceRegistrationSchema } from './deviceIdentity.js'
import { SourceMaterializationRecordSchema, SourceRootRecordSchema } from './sourceAdmission.js'
import { RemoteJobDispatchIntentSchema, RemoteJobOperationReceiptRecordSchema } from './remoteJobExecution.js'
import { canonicalGraphJson } from './wave25/index.js'

export const JOB_CANCELLATION_GRANT_TTL_MS = 300_000
const BackingJobCancellationFilesystemSchema = z.object({
  kind: z.literal('restored-original-volume'), bootId: z.uuid(), filesystemUuid: z.uuid(),
  filesystem: SourceRootRecordSchema.shape.binding.shape.filesystem,
  backingFile: z.object({ path: z.string().startsWith('/'), device: z.string().regex(/^\d+$/),
    inode: z.string().regex(/^\d+$/), bytes: z.string().regex(/^[1-9]\d*$/) }).strict(),
}).strict()
const ProjectJobCancellationFilesystemSchema = z.object({
  kind: z.literal('restored-original-project-quota'), blockDevice: z.string().startsWith('/dev/').max(2048), bootId: z.uuid(), filesystemUuid: z.uuid(), volumeId: z.uuid(),
  filesystem: SourceRootRecordSchema.shape.binding.shape.filesystem,
}).strict()
const JobCancellationFilesystemSchema = z.union([
  BackingJobCancellationFilesystemSchema, ProjectJobCancellationFilesystemSchema,
])
export const JobCancellationProposalInputSchema = z.object({
  workspaceId: z.string().min(1), executionId: z.string().min(1), commandId: optionalCommandId(z.string().min(8).max(200)),
  journalSha256: z.string().regex(/^[a-f0-9]{64}$/),
  filesystemRecovery: JobCancellationFilesystemSchema.optional(),
}).strict()
export const JobCancellationGrantSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('job-cancel-before-entry'), id: z.uuid(),
  principalId: z.string().min(1), approvedByPrincipalId: z.string().min(1),
  approvedAt: z.string().datetime(), expiresAt: z.string().datetime(), cancelCommandId: z.string().min(1),
  journalSha256: z.string().regex(/^[a-f0-9]{64}$/),
  filesystemRecovery: JobCancellationFilesystemSchema.optional(),
  intent: RemoteJobDispatchIntentSchema, execution: JobExecutionRecordSchema,
  registration: DeviceRegistrationSchema.extend({ status: z.literal('revoked') }), root: SourceRootRecordSchema,
  materialization: SourceMaterializationRecordSchema,
}).strict()
export const SignedJobCancellationGrantSchema = z.object({
  grant: JobCancellationGrantSchema, mainPublicKey: z.string().max(1024),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict()
const JobCancellationClosureSchema = z.object({
  schemaVersion: z.literal(1), grantId: z.uuid(), receipt: RemoteJobOperationReceiptRecordSchema,
  sourceClaim: z.object({ materializationId: z.uuid(), reservationId: z.uuid(),
    released: z.literal(true), quotaReclaimed: z.literal(true).optional(), archiveSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
}).strict()
export const SignedJobCancellationClosureSchema = z.object({
  closure: JobCancellationClosureSchema, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict()
export const JobCancellationRecoveryReadSchema = z.object({
  id: z.uuid(), workspaceId: z.string(), executionId: z.string(), principalId: z.string(),
  state: z.enum(['pending', 'approved', 'expired', 'consumed']), requestedAt: z.string().datetime(),
  journalSha256: z.string().regex(/^[a-f0-9]{64}$/),
  filesystemRecovery: JobCancellationFilesystemSchema.optional(),
  execution: JobExecutionRecordSchema, registration: DeviceRegistrationSchema,
  root: SourceRootRecordSchema, materialization: SourceMaterializationRecordSchema,
  grant: SignedJobCancellationGrantSchema.nullable(), closure: SignedJobCancellationClosureSchema.nullable(),
}).strict()
export const JobCancellationRecoveryGetSchema = z.object({
  workspaceId: z.string().min(1), executionId: z.string().min(1), recoveryId: z.uuid(),
}).strict()
export const JobCancellationRecoveryApproveSchema = JobCancellationRecoveryGetSchema.extend({
  commandId: JobCancellationProposalInputSchema.shape.commandId,
}).strict()
export const JobCancellationRecoveryApplySchema = z.object({
  recoveryId: z.uuid(), closure: SignedJobCancellationClosureSchema,
}).strict()
export const JobCancelInputSchema = z.object({
  commandId: optionalCommandId(z.string().min(1)), recovery: JobCancellationRecoveryApplySchema.optional(),
}).strict()
type JobCancellationGrant = z.infer<typeof JobCancellationGrantSchema>
type JobCancellationClosure = z.infer<typeof JobCancellationClosureSchema>
export type SignedJobCancellationClosure = z.infer<typeof SignedJobCancellationClosureSchema>
export type JobCancellationRecoveryRead = z.infer<typeof JobCancellationRecoveryReadSchema>
export type JobCancellationRecoveryApply = z.infer<typeof JobCancellationRecoveryApplySchema>
export function jobCancellationGrantMessage(grant: JobCancellationGrant): string {
  return canonicalGraphJson(['graphql-job-cancellation-grant-v1', JobCancellationGrantSchema.parse(grant)])
}
export function jobCancellationClosureMessage(closure: JobCancellationClosure): string {
  return canonicalGraphJson(['graphql-job-cancellation-closure-v1', JobCancellationClosureSchema.parse(closure)])
}
