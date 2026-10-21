import { RunWorktreeSchema } from '../runWorktrees.js'
export { RunWorktreeSchema, type RunWorktree } from '../runWorktrees.js'
import { z } from 'zod'
import { ActivitySnapshotV1Schema } from '../activity.js'
import {
  HarnessExecutionSchema, RunActivitySchema, RunLiveActivitySchema, WorkspaceSchema, AgentSchema, WorkflowRunSummarySchema,
  ResourceSummarySchema, BrowserProfileSummarySchema, RunnerSummarySchema, TimestampSchema,
} from '../index.js'
import { ExpectedRevisionSchema, ManagementPageInfoSchema } from '../management/index.js'
import { WorkflowDefinitionV3Schema, WorkflowVersionV3Schema, WorkflowRunV3Schema } from './workflowSchemas.js'
import { GraphIdSchema } from './graphPrimitives.js'
import { sameWorkflowValue } from './meaningfulEdit.js'

/** Current persisted V3 records only. Unsupported/missing execution tags fail;
 * historical version IDs remain immutable, not converted or reinterpreted. */
export { WorkflowDefinitionV3Schema, WorkflowVersionV3Schema, WorkflowRunV3Schema } from './workflowSchemas.js'
export type { WorkflowDefinitionV3, WorkflowVersionV3, WorkflowRunV3 } from './workflowSchemas.js'

export const SavedWorkflowDefinitionSchema = WorkflowDefinitionV3Schema
export const SavedWorkflowVersionSchema = WorkflowVersionV3Schema
export const SavedWorkflowRunSchema = WorkflowRunV3Schema
export type SavedWorkflowDefinition = z.infer<typeof SavedWorkflowDefinitionSchema>
export type SavedWorkflowVersion = z.infer<typeof SavedWorkflowVersionSchema>
type SavedWorkflowRun = z.infer<typeof SavedWorkflowRunSchema>

/** Public detail retains existing result authorization/redaction obligations.
 * This is NOT the content-free graph/occurrence metadata contract. A redacted
 * Run may omit location and principal; internal admission uses a stronger schema. */
export const RunDetailsV3Schema = z.object({ run: WorkflowRunV3Schema,
  worktrees: z.array(RunWorktreeSchema).optional(),
  activitySnapshot: ActivitySnapshotV1Schema.optional(),
  executions: z.array(HarnessExecutionSchema), activity: z.array(RunActivitySchema), cleanupPending: z.boolean().optional(),
  liveActivity: RunLiveActivitySchema.optional(),
  activityPageInfo: z.object({ hasEarlier: z.boolean() }).strict().optional(),
}).strict()
  .superRefine(({ run, executions, activity }, context) => {
    const ids = new Set<string>()
    for (const execution of executions) {
      if (ids.has(execution.id) || execution.runId !== run.id
        || execution.agentConfigurationVersionId !== run.agentConfigurationVersionIds[execution.agentId]) {
        context.addIssue({ code: 'custom', message: 'RUN_EXECUTION_PIN_MISMATCH' })
      }
      ids.add(execution.id)
    }
    if (activity.some((event) => event.runId !== run.id)) {
      context.addIssue({ code: 'custom', message: 'RUN_ACTIVITY_PIN_MISMATCH' })
    }
  })
export const SavedRunDetailsSchema = RunDetailsV3Schema
export type SavedRunDetails = z.infer<typeof SavedRunDetailsSchema>

export const SavedManagedWorkflowSchema = z.object({ workflow: SavedWorkflowDefinitionSchema,
  revision: ExpectedRevisionSchema, currentVersionId: GraphIdSchema.nullable(), archivedAt: TimestampSchema.nullable(),
}).strict()
export type SavedManagedWorkflow = z.infer<typeof SavedManagedWorkflowSchema>
export const SavedManagedWorkflowPageSchema = z.object({
  items: z.array(SavedManagedWorkflowSchema), pageInfo: ManagementPageInfoSchema,
  orderRevision: ExpectedRevisionSchema.default(0),
}).strict()
export const SavedManagedWorkflowCommandResultSchema = z.object({
  value: SavedManagedWorkflowSchema, replayed: z.boolean(),
}).strict()
export const SavedWorkspaceDetailsSchema = z.object({
  workspace: WorkspaceSchema, agents: z.array(AgentSchema), workflows: z.array(SavedWorkflowDefinitionSchema),
  runs: z.array(WorkflowRunSummarySchema)
    .describe('Newest 2000 eligible Runs; use paged Run reads for older Runs.'),
  resources: z.array(ResourceSummarySchema),
  browserProfiles: z.array(BrowserProfileSummarySchema).optional(), runners: z.array(RunnerSummarySchema).optional(),
}).strict()
export const SavedWorkflowVersionPageSchema = z.object({
  items: z.array(SavedWorkflowVersionSchema), pageInfo: ManagementPageInfoSchema,
}).strict()
export const SavedWorkflowVersionDetailSchema = z.object({ version: SavedWorkflowVersionSchema }).strict()
export const SavedRunPageSchema = z.object({ items: z.array(SavedWorkflowRunSchema), pageInfo: ManagementPageInfoSchema }).strict()

/** Loaded immutable snapshots only. No lookup of a moving workflow/Agent head.
 * The DB reader must additionally prove physical row identity and content hash. */
type SavedRunVersionSnapshot = { run: SavedWorkflowRun; version: SavedWorkflowVersion }
function validateSavedRunVersionSnapshot({ run, version }: SavedRunVersionSnapshot, context: z.RefinementCtx): void {
  if (run.executionSemanticsVersion !== version.executionSemanticsVersion || run.workflowVersionId !== version.id
    || run.workspaceId !== version.workspaceId || run.workflowId !== version.workflowId
    || !sameWorkflowValue(run.agentConfigurationVersionIds, version.agentConfigurationVersionIds)
    || !sameWorkflowValue(run.approval, version.approval)
    || !sameWorkflowValue(run.executionCondition, version.definition.executionCondition)) {
    context.addIssue({ code: 'custom', message: 'RUN_VERSION_SNAPSHOT_PIN_MISMATCH' })
  }
}
export const SavedRunVersionSnapshotSchema = z.object({
  run: SavedWorkflowRunSchema, version: SavedWorkflowVersionSchema,
}).strict().superRefine(validateSavedRunVersionSnapshot)

const savedRunVersionPinsSchema = z.custom<SavedRunVersionSnapshot>().superRefine(validateSavedRunVersionSnapshot)

/** Checks the relationship after both records have been parsed at their input boundaries. */
export function assertSavedRunVersionSnapshot(snapshot: SavedRunVersionSnapshot): void {
  savedRunVersionPinsSchema.parse(snapshot)
}

export type SavedWorkspaceDetails = z.infer<typeof SavedWorkspaceDetailsSchema>

export const SavedWorkflowResponseSchema = z.object({ workflow: SavedWorkflowDefinitionSchema }).strict()
