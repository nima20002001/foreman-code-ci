import { optionalCommandId } from '../management/commands.js'
import { z } from 'zod'
import { GraphIdSchema, RunInputSchema } from '../schemaPrimitives.js'
import { ExecutionSemanticsVersionSchema } from './workflowShape.js'

const CommandIdSchema = z.string().trim().min(8).max(200)
const ExpectedRevisionSchema = z.number().int().nonnegative()

/** The manual HTTP/MCP V3 request for all graph shapes, not native admission permission.
 * A new command must carry the exact displayed workflow revision/configuration
 * map as well as the existing immutable version, location and optional draft. */
export const RunStartV3InputSchema = z.object({
  workspaceId: GraphIdSchema, workflowId: GraphIdSchema, workflowVersionId: GraphIdSchema,
  commandId: optionalCommandId(CommandIdSchema), executionSemanticsVersion: ExecutionSemanticsVersionSchema,
  expectedWorkflowRevision: ExpectedRevisionSchema,
  expectedAgentConfigurationVersionIds: z.record(GraphIdSchema, GraphIdSchema),
  expectedLocationRevision: ExpectedRevisionSchema,
  draftId: GraphIdSchema.optional(), expectedDraftRevision: ExpectedRevisionSchema.optional(),
  input: RunInputSchema,
}).strict().refine((value) => (value.draftId === undefined) === (value.expectedDraftRevision === undefined),
  'draftId and expectedDraftRevision must be supplied together')
export type RunStartV3Input = z.infer<typeof RunStartV3InputSchema>
