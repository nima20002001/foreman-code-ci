import { optionalCommandId } from './commands.js'
import { AgentProductRoleSchema } from '../agentIdentity.js';
import { z } from "zod";
import { DeviceProvisioningHostReferenceSchema } from "../deviceResources.js";
import { WorkflowVersionV3Schema } from "../wave25/workflowSchemas.js";
import {
  AgentSchema, AgentConfigurationVersionSchema,
  HarnessConfigurationSchema, SupportedHarnessConfigurationSchema, HarnessQualificationSchema, ScopedMcpDetectionSchema,
  IdSchema, TimestampSchema, ApprovalHandlerSchema, MAX_SKILL_INSTRUCTIONS_CHARS,
} from "../index.js";

// Kept separate from index.ts to avoid a management-module initialization cycle.
const Revision = z.number().int().nonnegative();
const Command = z.string().trim().min(8).max(200);
const Page = { cursor: z.string().trim().min(1).optional(), limit: z.number().int().min(1).max(100).default(50) };
const Workspace = { workspaceId: IdSchema };
const Workflow = { ...Workspace, workflowId: IdSchema };
const Mutation = { commandId: optionalCommandId(Command), expectedRevision: Revision };
const Configuration = SupportedHarnessConfigurationSchema;

export const AgentCreateInputSchema = z.object({
  ...Workspace, commandId: optionalCommandId(Command), agentId: IdSchema,
  name: z.string().trim().min(1).max(200),
  productRole: AgentProductRoleSchema.default("coder"),
  description: z.string().max(10_000).optional(),
  role: z.string().trim().min(1).max(200).optional(),
  configuration: Configuration.optional(),
  harnessProfileSelection: AgentSchema.shape.harnessProfileSelection,
  prompt: AgentSchema.shape.prompt, assignedSkills: AgentSchema.shape.assignedSkills,
  graphqlTools: AgentSchema.shape.graphqlTools,
  nativeTools: AgentSchema.shape.nativeTools,
}).strict();
export const AgentUpdateInputSchema = z.object({
  ...Workspace, agentId: IdSchema, ...Mutation,
  expectedConfigurationVersionId: IdSchema,
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(10_000).nullable().optional(),
  role: z.string().trim().min(1).max(200).nullable().optional(),
  configuration: Configuration.optional(),
  harnessProfileSelection: AgentSchema.shape.harnessProfileSelection,
  prompt: AgentSchema.shape.prompt, assignedSkills: AgentSchema.shape.assignedSkills,
  graphqlTools: AgentSchema.shape.graphqlTools,
  nativeTools: AgentSchema.shape.nativeTools,
}).strict().refine((value) => [value.name, value.description, value.role, value.configuration,
  value.prompt, value.assignedSkills, value.graphqlTools, value.nativeTools, value.harnessProfileSelection].some((item) => item !== undefined), "At least one editable field is required");
export const AgentCloneInputSchema = z.object({
  ...Workspace, commandId: optionalCommandId(Command), agentId: IdSchema, sourceAgentId: IdSchema,
  expectedSourceRevision: Revision, expectedSourceConfigurationVersionId: IdSchema,
  name: z.string().trim().min(1).max(200),
}).strict();
export const AgentMutationResultSchema = z.object({
  value: z.object({ agent: AgentSchema, metadataRevision: Revision,
    affectedWorkflowIds: z.array(IdSchema).optional()
      .describe("Returned by agent_update: referencing workflows to re-save before using the changed configuration."),
  }).strict(), replayed: z.boolean(),
}).strict();
export type AgentCreateInput = z.infer<typeof AgentCreateInputSchema>;
export type AgentUpdateInput = z.infer<typeof AgentUpdateInputSchema>;
export type AgentCloneInput = z.infer<typeof AgentCloneInputSchema>;

export { HarnessOptionsInputSchema, HarnessOptionsRefreshInputSchema, type HarnessOptionsInput } from "../harnessOptionsDiscovery.js";
export { HarnessModelOptionSchema, HarnessOptionsResultSchema } from "../harnessOptions.js";
import { HarnessOptionsResultSchema } from "../harnessOptions.js";
export type HarnessOptions = z.infer<typeof HarnessOptionsResultSchema>;
export const HarnessMcpDetectionInputSchema = z.object({ ...Workspace, harness: z.enum(["codex", "claude"]), hostRef: DeviceProvisioningHostReferenceSchema.optional() }).strict();
export const HarnessMcpDetectionResultSchema = ScopedMcpDetectionSchema;
export const NativeConfigurationCheckInputSchema = z.object({ configuration: Configuration }).strict();
export const NativeConfigurationCheckResultSchema = z.object({
  configuration: HarnessConfigurationSchema, qualification: HarnessQualificationSchema, checkedAt: TimestampSchema,
}).strict();

export const WorkflowVersionListInputSchema = z.object({ ...Workflow, ...Page }).strict();
export const WorkflowVersionGetInputSchema = z.object({ ...Workflow, versionId: IdSchema }).strict();
export const WorkflowVersionPageSchema = z.object({
  items: z.array(WorkflowVersionV3Schema), pageInfo: z.object({ nextCursor: z.string().nullable() }).strict(),
}).strict();
export const WorkflowVersionResultSchema = z.object({ version: WorkflowVersionV3Schema }).strict();
export const AgentVersionListInputSchema = z.object({ ...Workspace, agentId: IdSchema, ...Page }).strict();
export const AgentVersionGetInputSchema = z.object({ ...Workspace, agentId: IdSchema, versionId: IdSchema }).strict();
export const AgentVersionPageSchema = z.object({
  items: z.array(AgentConfigurationVersionSchema), pageInfo: z.object({ nextCursor: z.string().nullable() }).strict(),
}).strict();
export const AgentVersionResultSchema = z.object({ version: AgentConfigurationVersionSchema }).strict();
export const AgentVersionRestoreInputSchema = z.object({
  ...Workspace, agentId: IdSchema, versionId: IdSchema, ...Mutation, expectedConfigurationVersionId: IdSchema,
}).strict();

export const WorkspaceLifecycleInputSchema = z.object({ ...Workspace, ...Mutation }).strict();
export const WorkflowLifecycleInputSchema = z.object({ ...Workflow, ...Mutation }).strict();
export const AgentLifecycleInputSchema = z.object({ ...Workspace, agentId: IdSchema, ...Mutation }).strict();
export const LifecycleResultSchema = z.object({
  value: z.object({ id: IdSchema, revision: Revision, archived: z.boolean() }).strict(), replayed: z.boolean(),
}).strict();
export const LocationClearInputSchema = z.object({
  ...Workspace, commandId: optionalCommandId(Command), expectedLocationRevision: Revision,
}).strict();
export const LocationClearResultSchema = z.object({
  value: z.object({ workspaceId: IdSchema, executionLocation: z.null(), locationRevision: Revision }).strict(), replayed: z.boolean(),
}).strict();
export const RunnerListInputSchema = z.object({ ...Workspace }).strict();
export const RunnerListResultSchema = z.object({ items: z.array(z.object({
  id: IdSchema, kind: z.literal("local"), available: z.literal(true),
  supportsRemoteDispatch: z.literal(false), supportsProvisioning: z.boolean(),
}).strict()) }).strict();
export const LocationProvisionInputSchema = z.object({
  ...Workspace, commandId: optionalCommandId(Command), expectedLocationRevision: Revision,
}).strict();
export const LocationProvisionResultSchema = z.object({
  value: z.object({ workspaceId: IdSchema, executionLocation: z.object({runnerId: IdSchema, rootPath: z.string()}).strict(),
    locationRevision: Revision }).strict(), replayed: z.boolean(),
}).strict();

/** Skills are workspace-owned instruction text. Users edit a logical skill; the server
 * allocates immutable versions, and Agent configurations pin exact versions. */
const SkillId = { ...Workspace, skillId: IdSchema };
const SkillVersionLabel = z.string().trim().min(1).max(100);
const SkillContent = {
  name: z.string().trim().min(1, "Enter a skill name.").max(200),
  description: z.string().trim().max(1_000).optional(),
  // Stored literally: never trimmed, expanded, or interpreted.
  instructions: z.string().max(MAX_SKILL_INSTRUCTIONS_CHARS).refine((value) => value.trim().length > 0, "Enter skill instructions."),
};
export const SkillVersionSchema = z.object({
  ...SkillId, version: SkillVersionLabel, name: z.string().min(1), description: z.string().max(1_000).optional(),
  instructions: z.string().min(1).max(MAX_SKILL_INSTRUCTIONS_CHARS), contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  createdAt: TimestampSchema,
}).strict();
export type SkillVersion = z.infer<typeof SkillVersionSchema>;
export const SkillVersionSummarySchema = SkillVersionSchema.omit({ instructions: true });
/** One row per logical skill. Summaries never carry instruction bodies. */
const SkillSummarySchema = z.object({
  ...SkillId, name: z.string().min(1), description: z.string().optional(),
  version: SkillVersionLabel, contentHash: SkillVersionSchema.shape.contentHash,
  revision: z.number().int().positive(), versionCount: z.number().int().positive(),
  archived: z.boolean(), createdAt: TimestampSchema, updatedAt: TimestampSchema,
}).strict();
export type SkillSummary = z.infer<typeof SkillSummarySchema>;
export const SkillListInputSchema = z.object({
  /** Omitted: every workspace the caller may read. */
  workspaceId: IdSchema.optional(),
  query: z.string().trim().max(200).optional(),
  includeArchived: z.boolean().default(false),
  ...Page,
}).strict();
export const SkillPageSchema = z.object({
  items: z.array(SkillSummarySchema),
  pageInfo: z.object({ nextCursor: z.string().nullable() }).strict(),
}).strict();
export const SkillGetInputSchema = z.object({ ...SkillId, version: SkillVersionLabel.optional() }).strict();
/** The logical head plus one exact version: the head's unless a version was requested. */
export const SkillGetResultSchema = z.object({ skill: SkillSummarySchema, version: SkillVersionSchema }).strict();
export const SkillVersionListInputSchema = z.object({ ...SkillId, ...Page }).strict();
export const SkillVersionPageSchema = z.object({
  items: z.array(SkillVersionSummarySchema),
  pageInfo: z.object({ nextCursor: z.string().nullable() }).strict(),
}).strict();
export const SkillCreateInputSchema = z.object({ ...Workspace, commandId: optionalCommandId(Command), ...SkillContent }).strict();
export const SkillUpdateInputSchema = z.object({ ...SkillId, ...Mutation, ...SkillContent }).strict();
export const SkillArchiveInputSchema = z.object({ ...SkillId, ...Mutation, archived: z.boolean() }).strict();
export const SkillMutationResultSchema = z.object({
  value: z.object({ skill: SkillSummarySchema, version: SkillVersionSchema,
    /** False when the save matched the current version; no version was created. */
    changed: z.boolean() }).strict(),
  replayed: z.boolean(),
}).strict();
/** All Agents still assigned an older skill version and their affected saved workflows. */
export const SkillUsageInputSchema = z.object({ ...SkillId }).strict();
export const SkillUsageSchema = z.object({
  skillId: IdSchema, headVersion: SkillVersionLabel,
  agents: z.array(z.object({ agentId: IdSchema, name: z.string(), version: SkillVersionLabel }).strict()),
  workflows: z.array(z.object({ workflowId: IdSchema, name: z.string() }).strict()),
}).strict();
/** Retains the head and consumers before updating through normal Agent/workflow saves. The same command
 * resumes that plan or replays its result; use a new command for newer heads or consumers. */
export const SkillUsersUpdateInputSchema = z.object({ ...SkillId, commandId: optionalCommandId(Command) }).strict();
export const SkillUsersUpdateResultSchema = z.object({
  headVersion: SkillVersionLabel,
  agents: z.array(z.object({ agentId: IdSchema, configurationVersionId: IdSchema }).strict()),
  workflows: z.array(z.object({ workflowId: IdSchema, workflowVersionId: IdSchema }).strict()),
  failed: z.array(z.object({ kind: z.enum(['agent', 'workflow']), id: IdSchema, code: z.string(), message: z.string() }).strict()),
}).strict();
export type SkillUsage = z.infer<typeof SkillUsageSchema>;
export type SkillUsersUpdateInput = z.infer<typeof SkillUsersUpdateInputSchema>;
export type SkillUsersUpdateResult = z.infer<typeof SkillUsersUpdateResultSchema>;
export type SkillListInput = z.infer<typeof SkillListInputSchema>;
export type SkillCreateInput = z.infer<typeof SkillCreateInputSchema>;
export type SkillUpdateInput = z.infer<typeof SkillUpdateInputSchema>;
export type SkillArchiveInput = z.infer<typeof SkillArchiveInputSchema>;
export type SkillMutationResult = z.infer<typeof SkillMutationResultSchema>;

export const WorkflowTriggerSchema = z.discriminatedUnion("kind", [
  z.object({kind: z.literal("manual")}).strict(),
  z.object({kind: z.literal("on_message")}).strict(),
  z.object({kind: z.literal("on_event"), eventType: z.string().trim().min(1).max(200)}).strict(),
  z.object({kind: z.literal("schedule"), startsAt: TimestampSchema,
    intervalSeconds: z.number().int().min(60).max(31_536_000),
    missed: z.enum(["skip", "latest"]).default("skip"), input: z.record(z.string(), z.json()).default({}),
  }).strict(),
]);
export type WorkflowTrigger = z.infer<typeof WorkflowTriggerSchema>;
export const WorkflowTriggerUpdateInputSchema = z.object({
  ...Workflow, ...Mutation, workflowVersionId: IdSchema, expectedLocationRevision: Revision,
  trigger: WorkflowTriggerSchema, enabled: z.boolean(),
}).strict();

export const RunRetryInputSchema = z.object({ ...Workspace, runId: IdSchema, commandId: optionalCommandId(Command),
  workflowVersionId: IdSchema, expectedLocationRevision: Revision,
}).strict();

export const InteractionSummaryInputSchema = z.object({
  workspaceId: IdSchema.optional(), workflowId: IdSchema.optional(), runId: IdSchema.optional(), handler: ApprovalHandlerSchema.optional(),
}).strict();
export const InteractionSummaryResultSchema = z.object({
  pendingCount: Revision, pendingByWorkflow: z.record(z.string(), Revision),
}).strict();
export const OperatorCapabilityInputSchema = z.object({
  detail: z.enum(['compact', 'full']).default('compact'),
  workspaceId: IdSchema.optional(), workflowId: IdSchema.optional(), runId: IdSchema.optional(),
}).strict();
