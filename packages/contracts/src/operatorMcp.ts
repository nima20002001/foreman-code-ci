export { mcpInputSchema } from './mcpInput.js'
import { RunWorktreeSchema } from './runWorktrees.js'
import { z } from 'zod'
import {
  ManagedWorkspaceSchema, ManagementPageInfoSchema, OperatorCapabilitiesSchema,
  ManagementActionSchema, ExpectedRevisionSchema,
  WorkspaceListInputSchema, WorkflowListInputSchema,
  AgentListInputSchema, RunListInputSchema, RunGetInputSchema,
} from './management/index.js'
import { SavedManagedWorkflowSchema, SavedRunDetailsSchema, WorkflowRunV3Schema } from './wave25/saved.js'
import { ExecutionResultSchema, HarnessExecutionSchema } from './index.js'
import { SourceListInputSchema, SourceListResultSchema, ApprovedSourceSchema } from './sourceAdmission.js'
import { SourceManifestSchema } from './sourceMaterialization.js'

const detail = z.enum(['compact', 'full']).default('compact')
const limit = z.number().int().min(1).max(100).default(10)

export const OperatorWorkspaceListInputSchema = WorkspaceListInputSchema.extend({ detail, limit })
export const OperatorWorkflowListInputSchema = WorkflowListInputSchema.extend({ detail, limit })
export const OperatorAgentListInputSchema = AgentListInputSchema.extend({ limit })
export const OperatorRunListInputSchema = RunListInputSchema.extend({ limit })

export const OperatorSourceListInputSchema = SourceListInputSchema.extend({ detail, limit })
export const SourceSummarySchema = ApprovedSourceSchema.extend({
  manifest: SourceManifestSchema.omit({ entries: true, deletions: true }),
  detailsOmitted: z.literal(true),
}).strict()
export const OperatorSourceListResultSchema = z.union([
  z.object({ detail: z.literal('compact'), items: z.array(SourceSummarySchema).max(100),
    nextSnapshotId: SourceListResultSchema.shape.nextSnapshotId }).strict(),
  SourceListResultSchema,
])

export const OperatorRunGetInputSchema = RunGetInputSchema.extend({ detail })
export const OperatorRunSummarySchema = z.object(WorkflowRunV3Schema.shape).omit({
  input: true, result: true, executionLocation: true, authorizationPrincipalId: true,
}).extend({ failure: ExecutionResultSchema.shape.error })
export const OperatorExecutionSummarySchema = z.object(HarnessExecutionSchema.shape).pick({
  id: true, runId: true, workflowNodeId: true, agentId: true, agentConfigurationVersionId: true,
  attempt: true, state: true, createdAt: true, startedAt: true, finishedAt: true,
  queueReason: true,
}).extend({ failure: ExecutionResultSchema.shape.error, continuedFromExecutionId: z.string().min(1).optional() })
const OperatorActivitySummarySchema = z.object({
  id: z.string(), kind: z.string(), title: z.string().max(256), status: z.string().optional(),
  order: z.string(),
}).strict()
export const OperatorRunCompactSchema = z.object({
  worktrees: z.array(RunWorktreeSchema).max(25).optional(),
  detail: z.literal('compact'), detailsOmitted: z.literal(true), run: OperatorRunSummarySchema,
  executions: z.array(OperatorExecutionSummarySchema).max(25),
  activities: z.array(OperatorActivitySummarySchema).max(25),
  executionsOmitted: z.number().int().nonnegative(), activitiesOmitted: z.number().int().nonnegative(),
  activitiesHasMore: z.boolean(),
  cleanupPending: z.boolean().optional(),
}).strict()
export const OperatorRunGetResultSchema = z.union([OperatorRunCompactSchema, SavedRunDetailsSchema])


const WorkspaceSummarySchema = z.object({
  workspace: ManagedWorkspaceSchema.shape.workspace.pick({ id: true, name: true }),
  revision: ManagedWorkspaceSchema.shape.revision,
  archivedAt: ManagedWorkspaceSchema.shape.archivedAt,
  locationRevision: ManagedWorkspaceSchema.shape.locationRevision,
  locationStatus: z.enum(['unconfigured', 'restricted', 'ready', 'unavailable']),
  detailsOmitted: z.literal(true),
}).strict()
export const WorkspaceSummaryPageSchema = z.object({
  detail: z.literal('compact'), items: z.array(WorkspaceSummarySchema), pageInfo: ManagementPageInfoSchema,
}).strict()

const WorkflowSummarySchema = SavedManagedWorkflowSchema.omit({ workflow: true }).extend({
  workflow: z.object({
    id: SavedManagedWorkflowSchema.shape.workflow.shape.id,
    workspaceId: SavedManagedWorkflowSchema.shape.workflow.shape.workspaceId,
    name: SavedManagedWorkflowSchema.shape.workflow.shape.name,
  }).strict(),
  detailsOmitted: z.literal(true),
}).strict()
export const WorkflowSummaryPageSchema = z.object({
  detail: z.literal('compact'), items: z.array(WorkflowSummarySchema), pageInfo: ManagementPageInfoSchema,
  orderRevision: ExpectedRevisionSchema.default(0),
}).strict()

export const OperatorCompactCapabilitiesSchema = OperatorCapabilitiesSchema.omit({ requirements: true }).extend({
  detail: z.literal('compact'),
  tools: z.array(z.string()),
  detailsTool: z.literal('operator_tool_schema_get'),
  fullDetailArguments: z.object({ detail: z.literal('full') }).strict(),
}).strict()

export const OperatorToolSchemaInputSchema = z.object({
  name: z.string().min(1).max(256),
  includeOutputSchema: z.boolean().default(false),
}).strict()
export const OperatorToolSchemaResultSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
  permissionRequirements: z.object({
    actions: z.array(ManagementActionSchema).optional(), detail: z.string(),
  }).strict(),
}).strict()

/** Operator uses JSON text for small payloads and structured data for large payloads. */
export function decodeMcpToolResult(result: {
  structuredContent?: unknown;
  content?: readonly { type: string; text?: string | undefined }[] | undefined;
}): Record<string, unknown> {
  if (result.structuredContent !== undefined) return result.structuredContent as Record<string, unknown>
  const text = result.content?.find((part) => part.type === 'text' && part.text !== undefined)?.text
  if (text === undefined) throw new Error('The MCP result has no JSON data.')
  return JSON.parse(text) as Record<string, unknown>
}
