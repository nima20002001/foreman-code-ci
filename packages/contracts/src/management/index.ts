import { GRAPHQL_OPERATOR_TOOLS } from '../graphqlMcpTools.js'
import { AgentProductRoleSchema } from '../agentIdentity.js'
import { OperationalFailureSchema } from '../operationalFailures.js'
import { NativeInteractionSupportSchema } from '../nativeInteractionSupport.js'
import { ClaudeFullAccessConfigurationSchema, ClaudeHarnessConfigurationSchema } from '../claude.js';
import { RunStartV3InputSchema } from '../wave25/startRequest.js'
import { InteractionActivityProjectionSchema } from '../interaction-activity.js'
import { z } from "zod";
import { WorkflowDefinitionV3Schema} from "../wave25/workflowSchemas.js";
import { AgentActiveTimeoutMsSchema, CurrentWorkflowNodeSchema, CurrentWorkflowRelationshipSchema } from "../wave25/workflowShape.js";

export * from "./extensions.js";
export * from "./harnessSettings.js";
export * from './workerExecution.js'
export * from './remoteExecution.js'
export * from "./codexPlugins.js";
export * from "./claudePlugins.js";
export * from "./settingsExperience.js";
export * from './generalSettings.js';
export * from './circleCreditAllowance.js';
export * from './circleAccounts.js';
export * from './bugReports.js';
export * from './promptSettings.js';
export * from '../providerAccounts.js'

import {
  AgentSchema,
  AgentHarnessSchema,
  AgentDefaultsSchema,
  CodexHarnessConfigurationSchema,
  HarnessQualificationSchema,
  HarnessConfigurationSchema,
  SupportedHarnessConfigurationSchema,
  ExecutionLocationSchema,
  RunActivitySchema,
  ReviewStatusSchema,
  IdSchema,
  TimestampSchema,
  WorkflowApprovalConfigurationSchema,
  ExecutionConditionSchema,
  WorkspaceSchema,
  WorkspaceRepositorySchema,
  WorkspaceCiMirrorSchema,
  DurableInteractionSchema,
  InteractionStatusSchema,
  ApprovalHandlerSchema,
  WorkflowDefaultsSchema,
} from "../index.js";

export * from './principals.js'
import { ManagementActionSchema, ManagementGrantSchema } from './principals.js'

/** The implicit local human's product permissions; contains no credentials. */
export const LocalHumanAccessSchema = z.object({
  principal: z.object({
    id: IdSchema, name: z.string().min(1), expiresAt: TimestampSchema,
    grants: z.array(ManagementGrantSchema),
  }).strict(),
}).strict();

const ManagementHarnessConfigurationSchema = z.discriminatedUnion("harness", [
  CodexHarnessConfigurationSchema,
  ClaudeHarnessConfigurationSchema,
]);
export const ManagementHarnessDefaultsSchema = z.object({
  codex: CodexHarnessConfigurationSchema,
  claude: ClaudeHarnessConfigurationSchema.optional(),
}).strict();

import { optionalCommandId, CommandIdSchema, ExpectedRevisionSchema } from './commands.js';
export { CommandIdSchema, ExpectedRevisionSchema } from './commands.js';
const ManagementPageInputSchema = z
  .object({
    cursor: z.string().trim().min(1).optional(),
    limit: z.number().int().min(1).max(100).default(50),
    includeArchived: z.boolean().default(false),
  })
  .strict();
export const ManagementPageInfoSchema = z
  .object({ nextCursor: z.string().nullable() })
  .strict();


export const ManagedWorkspaceSchema = z
  .object({
    workspace: WorkspaceSchema,
    revision: ExpectedRevisionSchema,
    archivedAt: TimestampSchema.nullable(),
    executionLocation: ExecutionLocationSchema.nullable(),
    locationRevision: ExpectedRevisionSchema,
    locationValidation: z.discriminatedUnion("status", [
      z.object({ status: z.literal("unconfigured") }).strict(),
      z.object({ status: z.literal("restricted") }).strict(),
      z.object({ status: z.literal("ready"), checkedAt: TimestampSchema }).strict(),
      z.object({
        status: z.literal("unavailable"), checkedAt: TimestampSchema,
        error: z.object({ code: z.string().trim().min(1), message: z.string().trim().min(1) }).strict(),
      }).strict(),
    ]),
  })
  .strict();
export type ManagedWorkspace = z.infer<typeof ManagedWorkspaceSchema>;
export const ManagedWorkspacePageSchema = z.object({
  items: z.array(ManagedWorkspaceSchema), pageInfo: ManagementPageInfoSchema,
}).strict();
export const ManagedWorkspaceCommandResultSchema = z.object({ value: ManagedWorkspaceSchema, replayed: z.boolean() }).strict();

export const ManagedWorkflowRecordFields = {
  revision: ExpectedRevisionSchema, currentVersionId: IdSchema.nullable(), archivedAt: TimestampSchema.nullable(),
};
export const ManagedWorkflowSchema = z.object({ ...ManagedWorkflowRecordFields, workflow: WorkflowDefinitionV3Schema }).strict();
export type ManagedWorkflow = z.infer<typeof ManagedWorkflowSchema>;
export const ManagedWorkflowPageSchema = z.object({
  items: z.array(ManagedWorkflowSchema), pageInfo: ManagementPageInfoSchema,
  orderRevision: ExpectedRevisionSchema.default(0),
}).strict();
export const ManagedWorkflowCommandResultSchema = z.object({ value: ManagedWorkflowSchema, replayed: z.boolean() }).strict();

const WorkspaceScopeSchema = z.object({ workspaceId: IdSchema }).strict();
const WorkflowScopeSchema = z.object({ workspaceId: IdSchema, workflowId: IdSchema }).strict();
const DraftScopeSchema = z.object({ workspaceId: IdSchema, workflowId: IdSchema, draftId: IdSchema }).strict();
const MutationFields = { commandId: optionalCommandId(CommandIdSchema) } as const;
const RevisionMutationFields = { ...MutationFields, expectedRevision: ExpectedRevisionSchema } as const;

export const WorkspaceListInputSchema = ManagementPageInputSchema;
export const WorkspaceGetInputSchema = WorkspaceScopeSchema;
export const WorkspaceCreateInputSchema = z.object({
  parentPath: z.string().min(1).max(4096).refine((value) => !value.includes("\0"), "Invalid folder path").optional().describe("Existing absolute parent folder on Local Runner; path whitespace is preserved. Pass workspace_defaults_get.value.parentPath to use the configured default; creates a new child named after the workspace. Omit only to leave execution location unconfigured."),
  ...MutationFields,
  name: z.string().trim().min(1).max(200).optional().describe("Omit to use the configured suggested name, adding (1), (2), etc. when a workspace name or project folder is already taken. An explicit name is used exactly and existing folders are rejected."),
  description: z.string().max(10_000).optional(),
}).strict();
export const WorkspaceUpdateInputSchema = z.object({
  ...WorkspaceScopeSchema.shape,
  ...RevisionMutationFields,
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(10_000).nullable().optional(),
  /** null removes the repository; agents then work in copied folders without branches. */
  repository: WorkspaceRepositorySchema.nullable().optional(),
  /** A public GitHub repository for free GitHub Actions CI; null stops using it. See WorkspaceCiMirrorSchema. */
  ciMirror: WorkspaceCiMirrorSchema.nullable().optional(),
}).strict().refine((value) => value.name !== undefined || value.description !== undefined || value.repository !== undefined
  || value.ciMirror !== undefined, "name, description, repository or ciMirror is required");
export const WorkspaceArchiveInputSchema = z.object({
  ...WorkspaceScopeSchema.shape,
  ...RevisionMutationFields,
}).strict();
export const WorkspaceBatchArchiveInputSchema = z.object({
  ...MutationFields,
  workspaces: z.array(z.object({ workspaceId: IdSchema, expectedRevision: ExpectedRevisionSchema }).strict())
    .min(1).max(100).refine((items) => new Set(items.map((item) => item.workspaceId)).size === items.length,
      "Each workspace must appear only once"),
}).strict();
export type WorkspaceBatchArchiveInput = z.infer<typeof WorkspaceBatchArchiveInputSchema>;
export const WorkspaceBatchArchiveResultSchema = z.object({
  value: z.object({ workspaceIds: z.array(IdSchema) }).strict(), replayed: z.boolean(),
}).strict();
const WorkspaceLocationAccessModeSchema = z.enum(["read-only", "read-write"]);
export type WorkspaceLocationAccessMode = z.infer<typeof WorkspaceLocationAccessModeSchema>;
export const WorkspaceLocationValidateInputSchema = z.object({
  ...WorkspaceScopeSchema.shape,
  runnerId: IdSchema,
  rootPath: z.string().min(1).refine((value) => !value.includes("\0"), "rootPath cannot contain NUL"),
  accessMode: WorkspaceLocationAccessModeSchema.default("read-only"),
}).strict();
export const WorkspaceLocationSetInputSchema = z.object({
  ...WorkspaceScopeSchema.shape,
  ...MutationFields,
  expectedLocationRevision: ExpectedRevisionSchema,
  runnerId: IdSchema,
  rootPath: z.string().min(1).refine((value) => !value.includes("\0"), "rootPath cannot contain NUL"),
}).strict();
export const WorkspaceLocationValidationSchema = z.object({
  workspaceId: IdSchema,
  location: ExecutionLocationSchema,
  accessMode: WorkspaceLocationAccessModeSchema,
  checkedAt: TimestampSchema,
}).strict();
export const WorkspaceLocationSetResultSchema = z.object({
  value: z.object({
    workspaceId: IdSchema,
    executionLocation: ExecutionLocationSchema,
    locationRevision: ExpectedRevisionSchema,
    validation: WorkspaceLocationValidationSchema,
  }).strict(),
  replayed: z.boolean(),
}).strict();
export type WorkspaceLocationValidateInput = z.infer<typeof WorkspaceLocationValidateInputSchema>;
export type WorkspaceLocationSetInput = z.infer<typeof WorkspaceLocationSetInputSchema>;
export type WorkspaceCreateInput = z.infer<typeof WorkspaceCreateInputSchema>;
export type WorkspaceUpdateInput = z.infer<typeof WorkspaceUpdateInputSchema>;
export type WorkspaceArchiveInput = z.infer<typeof WorkspaceArchiveInputSchema>;

export const WorkflowListInputSchema = z.object({
  workspaceId: IdSchema,
  ...ManagementPageInputSchema.shape,
}).strict();
export const WorkflowGetInputSchema = WorkflowScopeSchema;
export const WorkflowCreateInputSchema = z.object({
  ...WorkspaceScopeSchema.shape,
  ...MutationFields,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).optional(),
}).strict();
export const WorkflowUpdateInputSchema = z.object({
  ...WorkflowScopeSchema.shape,
  ...RevisionMutationFields,
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(10_000).nullable().optional(),
}).strict().refine((value) => value.name !== undefined || value.description !== undefined, "name or description is required");
export const WorkflowArchiveInputSchema = z.object({
  ...WorkflowScopeSchema.shape,
  ...RevisionMutationFields,
}).strict();
export const WorkflowBatchArchiveInputSchema = z.object({
  ...WorkspaceScopeSchema.shape,
  ...MutationFields,
  workflows: z.array(z.object({ workflowId: IdSchema, expectedRevision: ExpectedRevisionSchema }).strict())
    .min(1).max(100).refine((items) => new Set(items.map((item) => item.workflowId)).size === items.length,
      "Each workflow must appear only once"),
}).strict();
export type WorkflowBatchArchiveInput = z.infer<typeof WorkflowBatchArchiveInputSchema>;
export const WorkflowReorderInputSchema = z.object({
  ...WorkspaceScopeSchema.shape,
  ...RevisionMutationFields,
  workflowIds: z.array(IdSchema).min(2)
    .refine((ids) => new Set(ids).size === ids.length, "Each workflow must appear only once"),
}).strict();
export type WorkflowReorderInput = z.infer<typeof WorkflowReorderInputSchema>;
export const WorkflowOrderSchema = z.object({
  workspaceId: IdSchema,
  workflowIds: z.array(IdSchema),
  orderRevision: ExpectedRevisionSchema,
}).strict();
export const WorkflowReorderResultSchema = z.object({
  value: WorkflowOrderSchema, replayed: z.boolean(),
}).strict();
export const WorkflowBatchArchiveResultSchema = z.object({
  value: z.object({ workflowIds: z.array(IdSchema) }).strict(), replayed: z.boolean(),
}).strict();
export type WorkflowUpdateInput = z.infer<typeof WorkflowUpdateInputSchema>;
export type WorkflowArchiveInput = z.infer<typeof WorkflowArchiveInputSchema>;

export const AgentListInputSchema = z.object({
  workspaceId: IdSchema,
  workflowId: IdSchema.optional(),
  includeArchived: z.boolean().default(false),
  ...ManagementPageInputSchema.omit({ includeArchived: true }).shape,
}).strict();
export const AgentGetInputSchema = z.object({ workspaceId: IdSchema, agentId: IdSchema }).strict();
export const ManagedAgentSchema = z.object({ agent: AgentSchema, metadataRevision: ExpectedRevisionSchema, archivedAt: TimestampSchema.nullable().optional() }).strict();
export const ManagedAgentPageSchema = z.object({ items: z.array(ManagedAgentSchema), pageInfo: ManagementPageInfoSchema }).strict();
export const ManagedAgentDetailSchema = ManagedAgentSchema.extend({ workflowIds: z.array(IdSchema) }).strict();

const AgentAddOperationSchema = z.object({
  type: z.literal("agent.add"),
  agentId: IdSchema,
  nodeId: IdSchema,
  name: z.string().trim().min(1).max(200),
  nodeName: z.string().trim().min(1).max(200).optional(),
  productRole: AgentProductRoleSchema.optional(),
  /** Omit to copy the role template. A different harness requires an explicit configuration. */
  harness: z.enum(["codex", "claude"]).optional(),
  configuration: ManagementHarnessConfigurationSchema.optional(),
  prompt: AgentSchema.shape.prompt,
  assignedSkills: AgentSchema.shape.assignedSkills,
  graphqlTools: AgentSchema.shape.graphqlTools,
  nativeTools: AgentSchema.shape.nativeTools,
  description: z.string().max(10_000).optional(),
  role: z.string().trim().min(1).max(200).optional(),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional(),
}).strict();
/** Select a product template; callers cannot fabricate a privileged Agent role. */
const AgentAddFromTemplateOperationSchema = AgentAddOperationSchema.omit({ harness: true }).extend({
  type: z.literal("agent.add_from_template"), template: AgentProductRoleSchema,
}).strict().refine((value) => value.productRole === undefined || value.productRole === value.template,
  "productRole must match the selected template");
const WorkflowApprovalOperationSchema = z.object({
  type: z.literal("workflow.set_approval"), approval: WorkflowApprovalConfigurationSchema,
}).strict();
const AgentRenameOperationSchema = z.object({
  type: z.literal("agent.rename"), agentId: IdSchema,
  expectedAgentRevision: ExpectedRevisionSchema, name: z.string().trim().min(1).max(200),
}).strict();
const AgentConfigureOperationSchema = z.object({
  type: z.literal("agent.configure"), agentId: IdSchema,
  productRole: AgentProductRoleSchema.optional(),
  expectedAgentRevision: ExpectedRevisionSchema, configuration: ManagementHarnessConfigurationSchema,
  harnessProfileSelection: AgentSchema.shape.harnessProfileSelection,
  prompt: AgentSchema.shape.prompt,
  assignedSkills: AgentSchema.shape.assignedSkills,
  graphqlTools: AgentSchema.shape.graphqlTools,
  nativeTools: AgentSchema.shape.nativeTools,
  description: z.string().max(10_000).nullable().optional(),
  role: z.string().trim().min(1).max(200).nullable().optional(),
}).strict();
const AgentCloneOperationSchema = z.object({
  type: z.literal("agent.clone"), sourceAgentId: IdSchema, agentId: IdSchema,
  expectedSourceConfigurationVersionId: IdSchema.nullable().optional(),
  expectedSourceAgentRevision: ExpectedRevisionSchema.nullable().optional(),
  nodeId: IdSchema, name: z.string().trim().min(1).max(200),
}).strict();
const NodeRenameOperationSchema = z.object({
  type: z.literal("node.rename"), nodeId: IdSchema, name: z.string().trim().min(1).max(200),
}).strict();
const NodePromptOperationSchema = z.object({
  type: z.literal("node.set_initial_prompt"), nodeId: IdSchema,
  initialPrompt: z.string().trim().min(1).max(100_000).nullable(),
}).strict();
const NodeMoveOperationSchema = z.object({
  type: z.literal("node.move"), nodeId: IdSchema,
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
}).strict();
const NodeRemoveOperationSchema = z.object({ type: z.literal("node.remove"), nodeId: IdSchema }).strict();
const EdgeConnectOperationSchema = z.object({
  type: z.literal("edge.connect"), kind: z.enum(["execution", "approval"]), edgeId: IdSchema, sourceNodeId: IdSchema, targetNodeId: IdSchema,
}).strict();
const EdgeDisconnectOperationSchema = z.object({ type: z.literal("edge.disconnect"), edgeId: IdSchema }).strict();
const ExecutionLimitsOperationSchema = z.object({
  type: z.literal("workflow.set_execution_limits"),
  maxParallelism: z.number().int().positive().max(100),
  maxNodeExecutions: z.number().int().positive().max(10_000),
  agentActiveTimeoutMs: AgentActiveTimeoutMsSchema.optional(),
}).strict();
const RequiredAgentCountOperationSchema = z.object({
  type: z.literal("workflow.set_required_agent_count"),
  requiredAgentCount: z.number().int().nonnegative().max(10_000),
}).strict();

const NodeReplaceOperationSchema = z.object({
  type: z.literal("node.replace"), node: CurrentWorkflowNodeSchema,
}).strict();
const NodeOrderOperationSchema = z.object({
  type: z.literal("nodes.reorder"), nodeIds: z.array(IdSchema).max(10_000),
}).strict();
const EdgeOrderOperationSchema = z.object({
  type: z.literal("edges.reorder"), edgeIds: z.array(IdSchema).max(50_000),
}).strict();
const EdgePutOperationSchema = z.object({
  type: z.literal("edge.put"), edge: CurrentWorkflowRelationshipSchema,
}).strict();
const ResetExecutionLimitsOperationSchema = z.object({ type: z.literal("workflow.reset_execution_limits") }).strict();
const ResetRequiredAgentCountOperationSchema = z.object({ type: z.literal("workflow.reset_required_agent_count") }).strict();

export const CurrentCommonGraphOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent.attach"), agentId: IdSchema, nodeId: IdSchema,
    expectedAgentRevision: ExpectedRevisionSchema, expectedConfigurationVersionId: IdSchema,
    name: z.string().trim().min(1).max(200).optional(),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional(),
  }).strict(),
  z.object({ type: z.literal("workflow.set_execution_condition"),
    executionCondition: ExecutionConditionSchema,
  }).strict(),
  WorkflowApprovalOperationSchema,
  NodeOrderOperationSchema,
  EdgeOrderOperationSchema,
  ResetExecutionLimitsOperationSchema,
  RequiredAgentCountOperationSchema,
  ResetRequiredAgentCountOperationSchema,
  AgentAddOperationSchema,
  AgentAddFromTemplateOperationSchema,
  AgentRenameOperationSchema,
  AgentConfigureOperationSchema,
  AgentCloneOperationSchema,
  NodeRenameOperationSchema,
  NodePromptOperationSchema,
  NodeMoveOperationSchema,
  NodeRemoveOperationSchema,
  EdgeDisconnectOperationSchema,
  ExecutionLimitsOperationSchema,
]);

export const GraphDraftOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent.attach"), agentId: IdSchema, nodeId: IdSchema,
    expectedAgentRevision: ExpectedRevisionSchema, expectedConfigurationVersionId: IdSchema,
    name: z.string().trim().min(1).max(200).optional(),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional(),
  }).strict(),
  z.object({ type: z.literal("workflow.restore_version"), versionId: IdSchema }).strict(),
  z.object({ type: z.literal("workflow.set_execution_condition"),
    executionCondition: ExecutionConditionSchema,
  }).strict(),
  WorkflowApprovalOperationSchema,
  NodeReplaceOperationSchema,
  NodeOrderOperationSchema,
  EdgePutOperationSchema,
  EdgeOrderOperationSchema,
  ResetExecutionLimitsOperationSchema,
  RequiredAgentCountOperationSchema,
  ResetRequiredAgentCountOperationSchema,
  AgentAddOperationSchema,
  AgentAddFromTemplateOperationSchema,
  AgentRenameOperationSchema,
  AgentConfigureOperationSchema,
  AgentCloneOperationSchema,
  NodeRenameOperationSchema,
  NodePromptOperationSchema,
  NodeMoveOperationSchema,
  NodeRemoveOperationSchema,
  EdgeConnectOperationSchema,
  EdgeDisconnectOperationSchema,
  ExecutionLimitsOperationSchema,
]);

export const StagedAgentSchema = z.object({ agent: AgentSchema, baseRevision: ExpectedRevisionSchema.nullable() }).strict();
const GraphDraftRecordFields = {
  id: IdSchema,
  workspaceId: IdSchema,
  workflowId: IdSchema,
  revision: ExpectedRevisionSchema,
  layoutRevision: ExpectedRevisionSchema.optional(),
  baseWorkflowVersionId: IdSchema.nullable(),
  // Missing markers on older records are conservatively treated as unpublished.
  publishedRevision: ExpectedRevisionSchema.nullable().optional(),
  stagedAgents: z.array(StagedAgentSchema),
  sourceAgentPins: z.array(z.object({agentId: IdSchema, metadataRevision: ExpectedRevisionSchema, configurationVersionId: IdSchema}).strict()).optional(),
  updatedByPrincipalId: IdSchema,
  updatedAt: TimestampSchema,
};
export const GraphDraftSchema = z.object({ ...GraphDraftRecordFields, graph: WorkflowDefinitionV3Schema }).strict();

export const GraphDraftApplyInputSchema = z.object({
  ...DraftScopeSchema.shape,
  ...RevisionMutationFields,
  operations: z.array(GraphDraftOperationSchema).min(1).max(100),
}).strict();

export const HarnessDefaultsUpdateInputSchema = z.object({
  ...MutationFields,
  expectedRevision: ExpectedRevisionSchema.optional()
    .describe('Omit for last write wins; supply to reject a stale revision.'),
  defaults: ManagementHarnessDefaultsSchema.describe('Unchanged incomplete presets may be retained. New, edited or explicitly selected Claude presets require Full access and supported app MCP connections.'),
  /** Explicitly select a preset even when its template values did not change. */
  configure: AgentHarnessSchema.array().max(3).optional(),
}).strict().superRefine((input, context) => {
  if (!input.configure?.includes('claude') || !input.defaults.claude) return;
  const result = ClaudeFullAccessConfigurationSchema.safeParse(input.defaults.claude);
  if (!result.success) {
    for (const issue of result.error.issues) {
      context.addIssue({ ...issue, path: ['defaults', 'claude', ...issue.path] });
    }
  }
});
export const HarnessConfigurationCheckInputSchema = z.object({
  configuration: SupportedHarnessConfigurationSchema,
}).strict();
export const HarnessConfigurationCheckResultSchema = z.object({
  configuration: HarnessConfigurationSchema,
  qualification: HarnessQualificationSchema,
  checkedAt: TimestampSchema,
}).strict();

export const HarnessGetInputSchema = z.object({ harness: z.enum(["codex", "claude"]) }).strict();
export const UnavailableHarnessDefaultsSchema = HarnessGetInputSchema.shape.harness.array().max(3);
export const HarnessCatalogEntrySchema = z.object({
  harness: z.enum(["codex", "claude"]),
  defaults: ManagementHarnessConfigurationSchema,
  defaultsRevision: ExpectedRevisionSchema,
  capability: HarnessQualificationSchema.nullable(),
  discoveryError: z.object({ code: z.string(), message: z.string() }).strict().nullable(),
  observation: z.object({
    checkedAt: TimestampSchema.nullable(), stale: z.boolean(), refreshing: z.boolean(),
    refreshCount: z.number().int().nonnegative(), failureCount: z.number().int().nonnegative(),
    staleReadCount: z.number().int().nonnegative(), lastError: z.string().nullable(),
  }).strict().optional(),
  interactionSupport: z.array(NativeInteractionSupportSchema).optional(),
}).strict();
export const HarnessCatalogSchema = z.array(HarnessCatalogEntrySchema);
export const HarnessCatalogResultSchema = z.object({ items: HarnessCatalogSchema }).strict();
export const HarnessDefaultsUpdateResultSchema = z.object({
  value: z.object({ defaults: ManagementHarnessDefaultsSchema, revision: ExpectedRevisionSchema }).strict(),
  replayed: z.boolean(),
}).strict();

export const ManagedAgentDefaultsSchema = z.object({
  value: AgentDefaultsSchema, revision: ExpectedRevisionSchema, versionId: IdSchema.nullable(),
}).strict();
export const ManagedWorkflowDefaultsSchema = z.object({
  value: WorkflowDefaultsSchema, revision: ExpectedRevisionSchema, versionId: IdSchema.nullable(),
}).strict();
export const AgentDefaultsUpdateInputSchema = z.object({
  ...MutationFields,
  expectedRevision: ExpectedRevisionSchema.optional()
    .describe('Omit for last write wins; supply to reject a stale revision.'),
  value: AgentDefaultsSchema.superRefine((value, context) => {
    for (const role of ['master', 'orchestrator', 'coder', 'operator'] as const) {
      const template = value[role];
      if (!template) continue;
      const result = SupportedHarnessConfigurationSchema.safeParse(template.harness);
      if (!result.success) for (const issue of result.error.issues) context.addIssue({
        ...issue, path: [role, 'harness', ...issue.path],
      });
    }
  }),
}).strict();
export const WorkflowDefaultsUpdateInputSchema = z.object({
  ...MutationFields,
  expectedRevision: ExpectedRevisionSchema.optional()
    .describe('Omit for last write wins; supply to reject a stale revision.'),
  value: WorkflowDefaultsSchema,
}).strict();
export const AgentDefaultsUpdateResultSchema = z.object({ value: ManagedAgentDefaultsSchema, replayed: z.boolean() }).strict();
export const WorkflowDefaultsUpdateResultSchema = z.object({ value: ManagedWorkflowDefaultsSchema, replayed: z.boolean() }).strict();

export const RunListInputSchema = z.object({
  workspaceId: IdSchema,
  workflowId: IdSchema.optional(),
  ...ManagementPageInputSchema.omit({ includeArchived: true }).shape,
}).strict();
export const RunGetInputSchema = z.object({ workspaceId: IdSchema, runId: IdSchema }).strict();
export const RunEventsListInputSchema = z.object({
  workspaceId: IdSchema,
  runId: IdSchema,
  afterSequence: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(500).default(100),
}).strict();
/** Generic management spelling, one canonical explicit V3 Start request. */
export const RunStartInputSchema = RunStartV3InputSchema;
export const RunStopInputSchema = z.object({
  workspaceId: IdSchema,
  runId: IdSchema,
  ...MutationFields,
}).strict();

export const InteractionListInputSchema = z.object({
  workspaceId: IdSchema.optional(), workflowId: IdSchema.optional(), runId: IdSchema.optional(),
  handler: ApprovalHandlerSchema.optional(),
  status: InteractionStatusSchema.optional(),
  ...ManagementPageInputSchema.omit({ includeArchived: true }).shape,
}).strict();
export const InteractionGetInputSchema = z.object({ interactionId: IdSchema }).strict();
export const ManagedInteractionPageSchema = z.object({
  items: z.array(DurableInteractionSchema), pageInfo: ManagementPageInfoSchema,
  pendingCount: z.number().int().nonnegative().optional(),
  pendingByWorkflow: z.record(z.string(), z.number().int().nonnegative()).optional(),
}).strict();
export const ManagedInteractionSchema = z.object({ interaction: DurableInteractionSchema,
  activity: InteractionActivityProjectionSchema.optional(), review: ReviewStatusSchema.optional(),
  canRespond: z.boolean().optional() }).strict();

/** Deployment capability, separate from the candidate-only A0 schema. False
 * stays literal until native admission AND durable repeat edit intents qualify.
 * No caller-controlled flag can enable either unfinished runtime boundary. */
export const RepeatCapabilitiesResultSchema = z.object({
  contractVersion: z.literal(1),
  executionSemanticsVersion: z.literal(3),
  supported: z.literal(false),
  authoring: z.object({
    flatScopesOnly: z.literal(true), nesting: z.literal(false), arbitraryCycles: z.literal(false),
    maxOccurrencesMin: z.literal(1), maxOccurrencesMax: z.literal(2147483647),
    explicitLimitExit: z.literal(true), earlyExitOutcome: z.literal(true),
  }).strict(),
  availability: z.object({
    savedAuthoring: z.literal(true),
    persistedReadback: z.boolean(),
    runtimeAdmission: z.literal(false),
    meaningfulEdit: z.literal(false),
    reasons: z.tuple([z.literal("NATIVE_START_NOT_READY"), z.literal("REPEAT_EDIT_INTENT_NOT_READY")]),
  }).strict(),
}).strict();

export const REPEAT_OPERATOR_TOOL_NAMES = [
  "repeat_capabilities_get", "repeat_get", "repeat_update", "repeat_run_get",
] as const;
export type RepeatOperatorToolName = typeof REPEAT_OPERATOR_TOOL_NAMES[number];

export const OperatorToolNameSchema = z.enum([
  'browser_target_read', 'browser_profiles_list', 'browser_profile_get', 'browser_profile_create', 'browser_profile_update', 'browser_profile_remove', 'browser_profiles_sync', 'browser_profile_sync_get', 'browser_session_open', 'browser_sessions_list', 'browser_session_get', 'browser_session_close', 'browser_tabs_list', 'browser_tab_create', 'browser_tab_select', 'browser_tab_close', 'browser_state_read', 'browser_screenshot', 'browser_action', 'browser_view_open', 'browser_view_read', 'browser_view_close', 'browser_control_acquire', 'browser_control_release', 'browser_input',
  'memory_board_get', 'memory_board_changes_read', 'memory_card_create', 'memory_card_update',
  'memory_note_create', 'memory_note_update', 'memory_note_archive',
  'harness_instances_list', 'harness_instance_save', 'harness_instance_check', 'workspace_root_configuration_adopt',
  'reference_files_list', 'reference_file_read', 'reference_file_add', 'reference_file_remove',
  'file_retention_get', 'file_retention_preview', 'file_retention_save', 'run_summaries_list', 'run_board_snapshot_get',
  'bug_report', 'bug_reports_list', 'bug_report_get', 'bug_report_update', 'bug_reports_close',
  "ci_run", "ci_get", "ci_computers_list", "ci_cancel", "ci_logs_read", "ci_list",
  ...Object.keys(GRAPHQL_OPERATOR_TOOLS) as (keyof typeof GRAPHQL_OPERATOR_TOOLS)[],
  "source_list", "source_get", "source_approve", "source_root_bind", "source_root_get", "source_root_list", "source_preparation_get", "source_preparation_reconcile",
  "job_runtime_profile_list","job_runtime_profile_save","job_runtime_qualification_request","job_runtime_qualification_run","job_runtime_qualification_get","build_computer_prepare","build_computer_prepare_get",
  "ci_enrollment_get", "ci_enrollment_update",
  "job_choices_get","job_workflow_execution_get","job_definition_list","job_definition_get","job_definition_version_get","job_definition_save","job_validate","job_launch_validate","job_start","job_queue_get","job_queue_list","job_queue_cancel","job_get","job_list","job_workflow_list","job_cancel","job_cancellation_recovery_propose","job_cancellation_recovery_get","job_cancellation_recovery_approve","job_logs_read","job_artifacts_list","job_artifact_read",
  "build_computer_get", "build_computer_update", "build_computers_update", "computer_activity_list", "computer_rename", "computer_accounts_list", "computers_maintenance_status", "computers_maintenance_start", "computer_github_login_start", "computer_github_login_status", "computer_github_logout", "computer_github_setup_git", "computer_sync_status", "computer_sync_update",
  "device_main_identity_get", "devices_list", "device_pairing_grant_create", "device_revoke",
  "device_setup_code_create",
  "device_setup_options_get",
  "device_connection_host_discover", "device_connection_read", "device_connection_inspect", "device_connection_check", "device_connection_configure",
  "harness_registry_get", "workspace_root_choices_list", "workspace_root_location_get", "workspace_root_location_validate", "workspace_root_directories_list", "workspace_root_location_set",
  "resource_telemetry_read", "resource_telemetry_selector_get",
  ...REPEAT_OPERATOR_TOOL_NAMES,
  "operator_mcp_setup_get",
  "operator_chat_controls_get", "operator_chat_controls_update", "agent_chat_controls_get", "agent_chat_controls_update",
  "operator_chat_create", "operator_chat_list", "operator_chat_get", "operator_chat_history_get", "operator_chat_activity_get",
  "operator_chat_send", "operator_chat_cancel", "operator_chat_cancel_queued", "operator_chat_cancel_all_queued", "operator_chat_respond", "operator_handoff_history_get",
  "operator_chat_delete", "operator_chat_restore",
  "agent_chat_ensure_conversation", "conversation_file_upload", "conversation_file_finalize",
  "conversation_file_cancel", "conversation_files_list", "conversation_file_read",
  "agent_chat_read", "agent_chat_send", "agent_chat_interrupt", "agent_chat_cancel_queued", "agent_chat_cancel_all_queued",
  "workflow_chat_read", "workflow_chat_post", "workflow_chat_deliveries_read", "workflow_chat_delivery_cancel", "agent_chat_respond",
  "workspace_defaults_get",
  'general_settings_get', 'general_settings_update', 'circle_credit_allowance_get', 'circle_credit_allowance_update',
  'circle_accounts_list', 'circle_account_add', 'circle_account_remove',
  'provider_account_targets', 'provider_account_profiles', 'provider_account_eligibility', 'provider_account_auth_list',
  'provider_accounts_list', 'provider_account_create', 'provider_account_rename',
  'provider_account_default_set', 'provider_account_login', 'provider_account_logout', 'provider_account_refresh',
  'provider_accounts_page', 'provider_account_get', 'provider_account_register', 'provider_account_remove',
  'provider_account_auth_prepare', 'provider_account_auth_status', 'provider_account_auth_cancel', 'provider_account_models',
  'system_prompt_get', 'system_prompt_update', 'operator_initial_prompt_get', 'operator_initial_prompt_update',
  'worker_execution_settings_get', 'remote_execution_settings_get', 'remote_execution_settings_update',
  "workspace_defaults_update",
  "harness_mcp_servers_list", "harness_mcp_change_request", "harness_mcp_managed_request", "harness_mcp_change_get", "harness_mcp_change_reconcile", "codex_plugin_change", "codex_plugin_reconcile",
  "codex_plugins_list", "codex_plugin_get",
  "codex_plugin_operations_list", "harness_mcp_plans_list", "harness_mcp_change_decide",
  "claude_plugins_list", "claude_plugin_change", "claude_plugin_marketplace_add",
  "harness_configuration_check",
  "execution_readiness_get",
  "claude_setup_options_get",
  "harness_options_get",
  "harness_options_refresh",
  "harness_mcp_detection_get",
  "agent_create",
  "agent_update",
  "agent_clone",
  "workflow_versions_list",
  "workflow_version_get",
  "agent_configuration_versions_list",
  "agent_configuration_version_get",
  "agent_configuration_restore",
  "workspace_restore",
  "workflow_restore",
  "agent_archive",
  "agent_restore",
  "workspace_location_clear",
  "workspace_location_provision",
  "runner_list",
  "skill_list",
  "skill_get",
  "skill_versions_list",
  "skill_create",
  "skill_update",
  "skill_archive",
  "skill_usage_get",
  "skill_users_update",
  "workflow_trigger_get",
  "workflow_trigger_update",
  "workflow_trigger_disable",
  "workflow_trigger_fire",
  "workflow_trigger_jobs_list",
  "run_resume",
  "run_retry",
  "interaction_summary",
  "operator_get_capabilities", "harness_list", "harness_get", "harness_defaults_update", "harness_qualifications_list", "harness_qualification_run", "harness_compatibility_list", "harness_compatibility_retry",
  "agent_defaults_get", "agent_defaults_update", "workflow_defaults_get", "workflow_defaults_update",
  "workspace_folders_list", "workspace_folder_create", "workspace_folder_rename", "workspace_folder_undo", "workspace_folders_delete",
  "workspace_storage_folders_list", "workspace_storage_folder_delete",
  "workspace_list", "workspace_get", "workspace_create", "workspace_update", "workspace_archive", "workspace_batch_archive",
  "workspace_location_validate", "workspace_location_set",
  "workflow_list", "workflow_get", "workflow_create", "workflow_update", "workflow_reorder", "workflow_archive", "workflow_batch_archive", "workflow_kanban_layout_get", "workflow_kanban_layout_set",
  "agent_list", "agent_get", "graph_draft_open", "graph_draft_get", "graph_draft_apply",
  "graph_draft_layout", "graph_draft_revert_applied", "graph_validate", "graph_save", "graph_draft_discard", "run_list", "run_get", "run_current_get_v1", "run_history_get_v1",
  "run_events_list", "run_handoffs_get_v1", "run_activities_get_v1", "run_node_placement_get", "workflow_node_placement_choices", "run_start", "run_start_resolve", "run_stop",
  "run_subagents_list_v1", "run_subagent_get_v1", "run_subagent_messages_list_v1", "run_subagent_tools_list_v1",
  "run_subagent_input_v1", "run_subagent_interrupt_v1", "run_subagent_respond_v1",
  "interaction_list", "interaction_get", "interaction_respond",
]);
export type OperatorToolName = z.infer<typeof OperatorToolNameSchema>;

export const GraphValidationResultSchema = z.object({
  valid: z.boolean(),
  issues: z.array(z.object({ code: z.string().trim().min(1), message: z.string().trim().min(1) }).strict()),
}).strict();
export const RunStopResultSchema = z.object({
  runId: IdSchema,
  status: z.enum(["accepted", "already_terminal", "not_owner"]),
  // false means native process exit was not observed; database-terminal is not proof.
  processStopped: z.boolean(),
  replayed: z.boolean(),
}).strict();
export const RunEventsPageSchema = z.object({ items: z.array(RunActivitySchema), pageInfo: ManagementPageInfoSchema }).strict();
export const OperatorCapabilitiesSchema = z.object({
  operationalFailures: z.array(OperationalFailureSchema).optional(),
  endpoint: z.literal("/mcp"), audience: z.literal("operator"), protocol: z.literal("2026-07-28"),
  tools: z.array(OperatorToolNameSchema),
  principal: z.object({id: IdSchema, name: z.string(), expiresAt: TimestampSchema.describe(
    'Credential expiry; 9999-12-31T23:59:59.999Z means no expiry.',
  )}).strict().optional(),
  grants: z.array(ManagementGrantSchema).optional(),
  requestedResource: z.object({workspaceId: IdSchema.optional(),workflowId: IdSchema.optional(),runId: IdSchema.optional()}).strict().optional(),
  requirements: z.array(z.object({name: OperatorToolNameSchema, actions: z.array(ManagementActionSchema), detail: z.string()}).strict()).optional(),
  runtimeLimits: z.array(z.object({feature: z.string(), state: z.enum(["unsupported", "protected", "limited"]), detail: z.string()}).strict()).optional(),
  workerToolsMcp: z.object({ implemented: z.boolean(), endpoint: z.literal("/mcp") }).strict(),
}).strict();

export * from './executionReadiness.js'
export * from './workspaceStorageFolders.js'

export * from '../workspaceGit.js';
export * from '../worktreeSettings.js';
