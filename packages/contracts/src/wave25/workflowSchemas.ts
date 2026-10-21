import { z } from 'zod'
import { RepeatWorkflowVersionV1Schema, RepeatWorkflowRunV1Schema } from './repeat.js'

/** Canonical V3 family, without management response DTO dependencies. */
export { WorkflowDefinitionV3Schema } from './workflowShape.js'
export type { WorkflowDefinitionV3 } from './workflowShape.js'
export const WorkflowVersionV3Schema = RepeatWorkflowVersionV1Schema
export const WorkflowRunV3Schema = RepeatWorkflowRunV1Schema
export type WorkflowVersionV3 = z.infer<typeof WorkflowVersionV3Schema>
export type WorkflowRunV3 = z.infer<typeof WorkflowRunV3Schema>
