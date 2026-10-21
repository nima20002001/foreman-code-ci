import { z } from 'zod'
import { IdSchema, GraphIdSchema } from './schemaPrimitives.js'
import { NodePlacementReadbackSchema, SavedNodePlacementSchema } from './nodePlacement.js'

export const RunPlacementGetInputSchema = z.object({ workspaceId: IdSchema, workflowId: IdSchema,
  runId: IdSchema, nodeId: GraphIdSchema }).strict()
export const RunPlacementGetResultSchema = z.object({ ...RunPlacementGetInputSchema.shape,
  readback: NodePlacementReadbackSchema }).strict()
export type RunPlacementGetResult = z.infer<typeof RunPlacementGetResultSchema>
export type RunPlacementGetInput = z.infer<typeof RunPlacementGetInputSchema>

export const NodePlacementChoicesInputSchema = z.object({ workspaceId: IdSchema, workflowId: IdSchema,
  nodeId: GraphIdSchema, agentConfigurationVersionId: IdSchema }).strict()
const NodePlacementChoiceSchema = z.object({
  id: IdSchema, label: z.string().min(1),
  placement: SavedNodePlacementSchema,
  /** Readiness is authoritative discovery, never a native launch grant. */
  availability: z.enum(['ready', 'offline', 'unavailable', 'revoked']),
  reason: z.string().min(1).nullable(),
}).strict()
export const NodePlacementChoicesResultSchema = z.object({ ...NodePlacementChoicesInputSchema.shape,
  choices: z.array(NodePlacementChoiceSchema).max(1000),
  /** A matching harness profile is still being checked on some computer, which may be missing from `choices`
   * until its check finishes; read the choices again until this is false. */
  pending: z.boolean(),
}).strict()
export type NodePlacementChoicesInput = z.infer<typeof NodePlacementChoicesInputSchema>
export type NodePlacementChoice = z.infer<typeof NodePlacementChoiceSchema>
export type NodePlacementChoicesResult = z.infer<typeof NodePlacementChoicesResultSchema>
