import { z } from 'zod'
import { FileScopeSchema, MAX_FILE_READ_BYTES} from './files.js'

const Id = z.string().min(1).max(500)
const Hash = z.string().regex(/^[a-f0-9]{64}$/)
export const ArtifactAttemptSchema = z.object({
  workspaceId: Id, workflowId: Id, runId: Id, nodeId: Id, executionId: Id, attemptId: Id,
  placementHash: Hash,
}).strict()
const ArtifactGrantReferenceSchema = z.object({
  principalId: Id, grantId: Id, grantRevision: z.string().regex(/^[1-9][0-9]*$/),
}).strict()
/** Issued by main admission, never accepted from a worker as delegation authority. */
export const ArtifactEdgeBindingSchema = z.object({
  version: z.literal(1), edgeId: Id, commandId: Id,
  producer: ArtifactAttemptSchema, consumer: ArtifactAttemptSchema, outputKey: Id,
  publication: z.object({ ownerPrincipalId: Id, requestId: Id, binding: Hash }).strict(),
  pins: z.object({ fileId: z.uuid(), revisionId: z.uuid(), sha256: Hash,
    byteSize: z.number().int().nonnegative().max(64 * 1024 * 1024) }).strict(),
  scope: FileScopeSchema, sender: ArtifactGrantReferenceSchema, receiver: ArtifactGrantReferenceSchema,
  access: z.literal('read-only'), acceptedAt: z.string().datetime(),
}).strict().superRefine((v, c) => {
  if (v.producer.workspaceId !== v.consumer.workspaceId || v.producer.workflowId !== v.consumer.workflowId) {
    c.addIssue({ code: 'custom', message: 'Artifact edges cannot cross workspace or workflow authority.' })
  }
})
export type ArtifactAttempt = z.infer<typeof ArtifactAttemptSchema>
export type ArtifactGrantReference = z.infer<typeof ArtifactGrantReferenceSchema>
export type ArtifactEdgeBinding = z.infer<typeof ArtifactEdgeBindingSchema>
export const ArtifactEdgeReadSchema = z.object({ edgeId: Id, offset: z.number().int().nonnegative(),
  length: z.number().int().positive().max(MAX_FILE_READ_BYTES) }).strict()
