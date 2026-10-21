import { WorkflowWorktreeSettingsSchema } from '../worktreeSettings.js'
import { z } from 'zod'
import { CurrentCommonGraphOperationSchema } from '../management/index.js'
import { WorkflowRelationshipSchema, WorkflowChoiceSchema } from './workflow.js'
import { CurrentWorkflowNodeSchema } from './currentWorkflowFoundation.js'
import { RepeatPlanV1Schema } from './repeat.js'
import {
  CurrentEditIntentSchema, CurrentEditReadResultSchema, CurrentEditStageInputSchema, CurrentEditReadInputSchema,
  CurrentEditAdvanceInputSchema, CurrentEditDiscardInputSchema,
} from './currentEditIntent.js'

/** Board-local authoring vocabulary. The Board diffs its local V3 graph into these
 * operations; Agent operations call the Agent service and the complete graph is
 * saved through the shared current definition writer. There is no server draft. */
const WorkflowNodeV3Schema = CurrentWorkflowNodeSchema
export type WorkflowNodeV3 = z.infer<typeof WorkflowNodeV3Schema>
export const GraphDraftOperationV3Schema = z.union([
  z.object({ type: z.literal('workflow.set_worktree'), worktree: WorkflowWorktreeSettingsSchema.nullable() }).strict(),
  z.object({ type: z.literal('workflow.set_entry'), entryNodeId: z.string().nullable() }).strict(),
  z.object({ type: z.literal('node.set_choice'), nodeId: z.string(), choice: WorkflowChoiceSchema.nullable() }).strict(),
  z.object({ type: z.literal('relationship.put'), relationship: WorkflowRelationshipSchema }).strict(),
  z.object({ type: z.literal('node.replace_v3'), node: WorkflowNodeV3Schema }).strict(),
  z.object({ type: z.literal('workflow.restore_version_v3'), versionId: z.string() }).strict(),
  // null is an explicit removal command, never a saved repeat value.
  z.object({ type: z.literal('workflow.set_repeat'), repeat: RepeatPlanV1Schema.nullable() }).strict(),
  CurrentCommonGraphOperationSchema,
])
export type GraphDraftOperationV3 = z.infer<typeof GraphDraftOperationV3Schema>

/** Board names for the shared current edit-intent journal contracts. */
export const GraphEditIntentV3Schema = CurrentEditIntentSchema
export type GraphEditIntentV3 = z.infer<typeof CurrentEditIntentSchema>
export const GraphEditReadResultV3Schema = CurrentEditReadResultSchema
export type GraphEditReadResultV3 = z.infer<typeof CurrentEditReadResultSchema>
export const GraphEditStageInputV3Schema = CurrentEditStageInputSchema
export type GraphEditStageInputV3 = z.infer<typeof CurrentEditStageInputSchema>
export const GraphEditReadInputV3Schema = CurrentEditReadInputSchema
export type GraphEditReadInputV3 = z.infer<typeof CurrentEditReadInputSchema>
export const GraphEditAdvanceInputV3Schema = CurrentEditAdvanceInputSchema
export type GraphEditAdvanceInputV3 = z.infer<typeof CurrentEditAdvanceInputSchema>
export const GraphEditDiscardInputV3Schema = CurrentEditDiscardInputSchema
export type GraphEditDiscardInputV3 = z.infer<typeof CurrentEditDiscardInputSchema>
