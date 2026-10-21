import { z } from 'zod'
import { IdSchema,TimestampSchema } from './schemaPrimitives.js'
import { PlacementDigestSchema } from './nodePlacement.js'
/** Committed stop-only authority from the actual Run owner. It grants neither
 * another native entry nor artifact publication and is never public request input. */
export const JobRunCleanupSchema=z.object({schemaVersion:z.literal(1),id:z.uuid(),commandId:IdSchema,
  workspaceId:IdSchema,workflowId:IdSchema,workflowVersionId:IdSchema,runId:IdSchema,
  nodeId:IdSchema,nodeExecutionId:IdSchema,executionId:IdSchema,attemptId:IdSchema,operationId:IdSchema,bindingHash:PlacementDigestSchema,
  jobOwner:z.object({grantId:IdSchema,epoch:z.string().regex(/^[1-9][0-9]*$/)}).strict(),
  runOwner:z.object({ownerId:z.string().regex(/^[1-9][0-9]*$/),fence:z.string().regex(/^[1-9][0-9]*$/)}).strict(),
  reason:z.enum(['run-stop','run-failure','engine-restart','authority-revoked']),
  cleanupRequestedAt:TimestampSchema,requestedAt:TimestampSchema,
}).strict()
export type JobRunCleanup=z.infer<typeof JobRunCleanupSchema>
