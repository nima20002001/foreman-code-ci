import { z } from 'zod'
import { JobExecutionSchema, JobOutputSpecSchema } from './jobs.js'
import { JobArtifactMediaTypeSchema } from './jobArtifacts.js'
import { FileSha256Schema, MAX_FILE_BYTES } from './files.js'
import { TransferIntentSchema } from './byteTransfer.js'
import { DeviceConnectionIdentitySchema } from './deviceIdentity.js'
import { DeviceSessionBindingSchema } from './deviceConnection.js'

/** Worker arguments assert output metadata only; main issues transfer identity and authority. */
export const JobOutputPublicationInputSchema = z.object({
  workspaceId: JobExecutionSchema.shape.workspaceId, executionId: JobExecutionSchema.shape.id,
  attemptId: JobExecutionSchema.shape.attemptId, owner: JobExecutionSchema.shape.owner,
  commandId: z.string().min(8).max(200), path: JobOutputSpecSchema.shape.path,
  mediaType: JobArtifactMediaTypeSchema, sha256: FileSha256Schema,
  byteSize: z.number().int().nonnegative().max(MAX_FILE_BYTES),
}).strict()
export type JobOutputPublicationInput = z.infer<typeof JobOutputPublicationInputSchema>
export const JobOutputAdmissionSchema = z.object({
  version: z.literal(1), input: JobOutputPublicationInputSchema, principalId: z.string().min(1),
  inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/), specDigest: FileSha256Schema,
  materializationId: z.uuid(), materializationDigest: FileSha256Schema,
  fileId: z.string().min(1), revisionId: z.string().min(1), allocationExpiresAt: z.string().datetime(),
  originalConnection: z.union([DeviceSessionBindingSchema, DeviceConnectionIdentitySchema]), nativeIdentityDigest: FileSha256Schema,
  closureEvidenceDigest: FileSha256Schema, receiptSequence: z.number().int().positive(),
  intent: TransferIntentSchema, admittedAt: z.string().datetime(),
}).strict()
export type JobOutputAdmission = z.infer<typeof JobOutputAdmissionSchema>
export const JobOutputDeviceRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('job-output-admit'), input: JobOutputPublicationInputSchema }).strict(),
  z.object({ method: z.literal('job-output-publish'), input: JobOutputPublicationInputSchema }).strict(),
  z.object({ method: z.enum(['start','status','finish','cancel']), transferId: z.uuid() }).strict(),
  z.object({ method: z.literal('append'), transferId: z.uuid(), offset: z.number().int().nonnegative(),
    sha256: FileSha256Schema, byteLength: z.number().int().positive().max(8192) }).strict(),
])
/** Existing byte-transfer Job channel, after original admission and sealed-byte
 * registration. Replies reuse VerifiedTransferReceipt and canonical JobArtifact. */
export const JobOutputStageRequestSchema = z.object({ method: z.literal('job-output-stage'), transferId: z.uuid() }).strict()
export const JobOutputStatusRequestSchema = z.object({ method: z.literal('job-output-status'), transferId: z.uuid() }).strict()
