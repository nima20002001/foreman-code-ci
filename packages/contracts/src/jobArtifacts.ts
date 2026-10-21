import { z } from 'zod'
import { IdSchema, TimestampSchema } from './schemaPrimitives.js'
import { FileNameSchema } from './filePrimitives.js'
/** CI bytes form an explicit class. Chat/document input schemas remain unchanged. */
const JOB_ARTIFACT_MEDIA_TYPES=['text/plain','application/json','application/xml','text/html','application/zip','application/gzip','application/octet-stream'] as const
export const JobArtifactMediaTypeSchema=z.enum(JOB_ARTIFACT_MEDIA_TYPES)
export const JobArtifactRetentionSchema=z.number().int().min(3600).max(365*24*3600)
export const JobExecutionFileScopeSchema=z.object({kind:z.literal('job_execution'),workspaceId:IdSchema,jobExecutionId:IdSchema}).strict()
export type JobExecutionFileScope=z.infer<typeof JobExecutionFileScopeSchema>
export const JobArtifactFileSchema=z.object({fileId:IdSchema,currentRevisionId:IdSchema,scope:JobExecutionFileScopeSchema,state:z.enum(['pending','ready','expired','removed']),
  createdAt:TimestampSchema,retentionDurationSeconds:JobArtifactRetentionSchema,expiresAt:TimestampSchema,
}).strict().refine(file=>Date.parse(file.expiresAt)-Date.parse(file.createdAt)===file.retentionDurationSeconds*1000,'Artifact expiry must equal its accepted retention snapshot.')
export const JobArtifactFileRevisionSchema=z.object({
  byteClass:z.literal('ci-output'),fileId:IdSchema,revisionId:IdSchema,filename:FileNameSchema,mediaType:JobArtifactMediaTypeSchema,
  byteSize:z.number().int().nonnegative().max(25*1024*1024),sha256:z.string().regex(/^[a-f0-9]{64}$/),origin:z.literal('job_output'),createdAt:TimestampSchema,
}).strict().readonly()
export const JobArtifactFileWithRevisionSchema=z.object({file:JobArtifactFileSchema,revision:JobArtifactFileRevisionSchema}).strict().refine(value=>value.file.fileId===value.revision.fileId&&Date.parse(value.revision.createdAt)>=Date.parse(value.file.createdAt),'Artifact revision scope/time mismatch.')
