import { ChatDeliveryIntentSchema, ChatDeliveryReceiptSchema } from './chatDelivery.js';
import { BoardDigestSchema } from './memoryBoards.js';
import { AgentProductRoleSchema as WorkflowAgentProductRoleSchema, type WorkflowAgentProductRole } from './agentIdentity.js';
import { ResultProtocolSchema } from './coordinationResult.js';
import { MessageSchema } from './messages.js';
export * from './messages.js';
import { RecordedAgentHarnessSchema } from './harnessIdentity.js';
export * from './harnessIdentity.js';
import { OptionalTimestampFields } from './schemaPrimitives.js';
import { optionalCommandId } from './management/commands.js'
import { refineChatMessageSize } from './chatInput.js'
export * from './chatInput.js'
import { FailureClassSchema } from './failure.js'
import { SourceCapacityErrorDetailsSchema } from './sourceCapacity.js'
export { SourceCapacityErrorDetailsSchema, type SourceCapacityErrorDetails } from './sourceCapacity.js'
import { ExecutionQueueReasonSchema } from './executionQueue.js';
import { NativeToolsSchema } from './nativeTools.js';
export * from './nativeTools.js';
import { PromptSettingSnapshotSchema } from './prompts.js';
import { AcceptedProviderAccountBindingSchema } from './providerAccounts.js';
export * from './providerAccounts.js';
export * from './prompts.js';
import { HarnessProfileSelectionSchema } from './harnessProfileSelection.js';
import { NativeInteractionSupportSchema } from './nativeInteractionSupport.js';
import { NativeInteractionInputSchema } from './interactionInput.js';
export * from './interactionInput.js';
export * from './nativeInteractionSupport.js';
import { ActivitySnapshotV1Schema } from './activity.js';
import { CLAUDE_FULL_ACCESS_REQUIRED, ClaudeEffortSchema, ClaudeFullAccessConfigurationSchema, ClaudeHarnessConfigurationSchema, NativeMessageSubmissionSchema } from './claude.js';
import { changeCodexSandbox } from './harnessEditing.js';
export * from './claude.js';
export * from './claudeQualification.js';
import { RunStartV3InputSchema } from "./wave25/startRequest.js";
import { InteractionActivityProjectionSchema, NativeInteractionResponseAvailabilitySchema } from "./interaction-activity.js";
import { z } from "zod";
import { McpCredentialArrangementSchema } from './mcpDetection.js';
export { McpCredentialArrangementSchema } from './mcpDetection.js';
export type { McpCredentialArrangement } from './mcpDetection.js';
export { PairedMcpEndpointSchema, type PairedMcpEndpoint } from './mcpDetection.js';
import { MessageAttachmentFields } from "./files.js";
import { IdSchema, TimestampSchema, GraphIdSchema, RunInputSchema } from "./schemaPrimitives.js";
export { IdSchema, TimestampSchema } from "./schemaPrimitives.js";
export type { Id, Timestamp } from "./schemaPrimitives.js";
import {
  ApprovalHandlerSchema, AcceptedWorkflowApprovalConfigurationSchema,
  ExecutionConditionSchema,
  WorkflowDefinitionV3Schema, ExecutionSemanticsVersionSchema,
} from "./wave25/workflowShape.js";
export {
  ApprovalHandlerSchema, AcceptedWorkflowApprovalConfigurationSchema, WorkflowApprovalConfigurationSchema, ExecutionConditionSchema, WorkflowExecutionPolicySchema,
  ChoiceOutcomeSchema, ChoiceTargetSchema, WorkflowChoiceSchema, WorkflowRelationshipSchema,
} from "./wave25/workflowShape.js";
export type {
  ApprovalHandler, WorkflowApprovalConfiguration, WorkflowExecutionPolicy, WorkflowChoice, WorkflowRelationship,
} from "./wave25/workflowShape.js";
import type { ApprovalHandler } from "./wave25/workflowShape.js";
import type { RunLiveActivity } from "./runLiveActivity.js";
import { RunStopCauseSchema } from "./runStopCause.js";
import { GraphqlToolDefaultsSchema, graphqlToolsOutsideRole } from "./graphqlMcpTools.js";
export * from "./runStopCause.js";
export * from "./runState.js";
export * from "./runLiveActivity.js";

export * from "./harnessEditing.js";
export * from "./harnessCompatibility.js";
export * from "./harnessQualification.js";
export * from "./approvalTopology.js";
export * from "./graphqlMcpTools.js";

import { ExecutionLocationSchema } from "./executionLocation.js";
export { ExecutionLocationSchema } from "./executionLocation.js";
export type { ExecutionLocation } from "./executionLocation.js";

/** Immutable location accepted together with a new Run. */
export const RunExecutionLocationSchema = ExecutionLocationSchema.extend({
  locationRevision: z.number().int().nonnegative(),
  /** Opaque runner-side identity used to detect replacement of the accepted directory. */
  identityHash: z.string().startsWith("sha256:"),
}).strict();
export type RunExecutionLocation = z.infer<typeof RunExecutionLocationSchema>;



import { WorkspaceCiMirrorSchema, WorkspaceRepositorySchema } from './workspaceRepository.js';
export { WorkspaceCiMirrorSchema, WorkspaceRepositorySchema, type WorkspaceCiMirror, type WorkspaceRepository } from './workspaceRepository.js';

/** A workspace is the top-level scope for agents, workflows, conversations and resources. */
export const WorkspaceSchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1),
    description: z.string().optional(),
    repository: WorkspaceRepositorySchema.optional(),
    ciMirror: WorkspaceCiMirrorSchema.optional(),
    agentIds: z.array(IdSchema).optional(),
    workflowIds: z.array(IdSchema).optional(),
    ...OptionalTimestampFields,
  })
  .strict();
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const AgentStatusSchema = z.enum([
  "available",
  "working",
  "waiting_browser",
  "auth_required",
  "interrupted",
  "disconnected",
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
const AgentExecutionStateSchema = AgentStatusSchema;
export type AgentExecutionState = z.infer<typeof AgentExecutionStateSchema>;

const AgentRoleSchema = z.string().trim().min(1);

/** Product authority role. Free-form Agent.role remains display metadata only. */
const ConfiguredAgentProductRoleSchema = z.enum(["master", "orchestrator", "coder", "operator"]);
export type AgentProductRole = z.infer<typeof ConfiguredAgentProductRoleSchema>;

const HarnessStatusSchema = z.enum(["ready", "running", "disconnected", "unavailable"]);
export type HarnessStatus = z.infer<typeof HarnessStatusSchema>;

/** A small runner/harness projection suitable for an Agent context panel. */
export const HarnessSummarySchema = z
  .object({
    status: HarnessStatusSchema,
    label: z.string().trim().min(1).optional(),
    detail: z.string().optional(),
    runnerId: IdSchema.optional(),
  })
  .strict();

export const AgentHarnessSchema = z.enum(["codex", "claude"]);

export const RETIRED_OPENCODE_MESSAGE = "OpenCode is retired and cannot execute. Select Codex or Claude for new work.";
export type AgentHarness = z.infer<typeof AgentHarnessSchema>;
export const AgentEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
export type AgentEffort = z.infer<typeof AgentEffortSchema>;

/** A Skill Hub reference pinned when an agent configuration version is created. */
export const AssignedSkillSchema = z
  .object({
    skillId: IdSchema,
    version: z.string().trim().min(1),
  })
  .strict();
export type AssignedSkill = z.infer<typeof AssignedSkillSchema>;
/** The application-level Operator is not workspace-owned, so its skill references name their workspace. */
const WorkspaceSkillReferenceSchema = AssignedSkillSchema.extend({ workspaceId: IdSchema }).strict();
export type WorkspaceSkillReference = z.infer<typeof WorkspaceSkillReferenceSchema>;

/** Per-skill instruction body limit, in UTF-16 code units (JavaScript string length). */
export const MAX_SKILL_INSTRUCTIONS_CHARS = 100_000;
/** Aggregate persistent Agent instructions plus pinned skill bodies, in UTF-8 bytes.
 * A bounded context size, never a token or cost quota; exceeding it is rejected, never truncated. */
export const MAX_AGENT_INSTRUCTIONS_BYTES = 512 * 1024;
/** Server-resolved immutable snapshot. Callers cannot supply one. */
const ResolvedSkillSchema = AssignedSkillSchema.extend({
  // Operator snapshots include scope; optional for previously accepted snapshots.
  workspaceId: IdSchema.optional(),
  name: z.string().min(1).max(200).optional(),
  instructions: z.string().min(1).max(MAX_SKILL_INSTRUCTIONS_CHARS),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();
export type ResolvedSkill = z.infer<typeof ResolvedSkillSchema>;

const AgentPromptSchema = z
  .object({
    system: z.string().trim().min(1).optional(),
  })
  .strict();

const WritableRootSchema = z.string().min(1)
  .refine((value) => !value.includes("\0"), "path cannot contain NUL")
  .refine((value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value), "path must be absolute");
const CodexMcpToolApprovalModeSchema = z.enum(["auto", "prompt", "writes", "approve"]);
const CodexMcpToolPolicySchema = z.object({
  enabled: z.boolean().optional(),
  approvalMode: CodexMcpToolApprovalModeSchema.optional(),
}).strict();
export type CodexMcpToolPolicy = z.infer<typeof CodexMcpToolPolicySchema>;
const CodexMcpServerSettingsSchema = z.object({
  enabled: z.boolean(),
  required: z.boolean(),
  enabledTools: z.array(z.string().trim().min(1)).optional(),
  disabledTools: z.array(z.string().trim().min(1)).optional(),
  defaultToolsApprovalMode: CodexMcpToolApprovalModeSchema.optional(),
  tools: z.record(z.string().trim().min(1), CodexMcpToolPolicySchema).optional(),
}).strict().superRefine((value, context) => {
  if (value.required && !value.enabled) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["required"], message: "a required MCP server must be enabled" });
  }
  const disabled = new Set(value.disabledTools ?? []);
  for (const [index, tool] of (value.enabledTools ?? []).entries()) {
    if (disabled.has(tool)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["enabledTools", index], message: "enabled and disabled MCP tools must be disjoint" });
  }
});
const CodexAdvancedConfigurationSchema = z.object({
  approvalPolicy: z.enum(["on-request", "never"]).describe("Defaults to never for workflow Agents; sandbox restrictions still apply."),
  approvalsReviewer: z.enum(["user", "auto_review"]),
  additionalWritableDirectories: z.array(WritableRootSchema),
  workspaceWrite: z.object({
    networkAccess: z.boolean(), excludeTmpdirEnvVar: z.boolean(), excludeSlashTmp: z.boolean(),
  }).strict().optional(),
  sessionPersistence: z.enum(["persistent", "ephemeral"]),
  shellEnvironment: z.object({
    inherit: z.enum(["all", "core", "none"]),
    ignoreDefaultExcludes: z.boolean(),
    filters: z.record(z.string().trim().min(1), z.enum(["include", "exclude"])),
    set: z.record(z.string().trim().min(1), z.string()),
  }).strict(),
  webSearch: z.enum(["disabled", "cached", "live"]),
  mcpServers: z.record(z.string().trim().min(1), CodexMcpServerSettingsSchema),
}).strict();
export type CodexAdvancedConfiguration = z.infer<typeof CodexAdvancedConfigurationSchema>;
export const DEFAULT_CODEX_ADVANCED_CONFIGURATION: CodexAdvancedConfiguration = {
  approvalPolicy: "never",
  approvalsReviewer: "user",
  additionalWritableDirectories: [],
  sessionPersistence: "persistent",
  shellEnvironment: { inherit: "all", ignoreDefaultExcludes: false, filters: {}, set: {} },
  webSearch: "cached",
  mcpServers: {},
};

const RetiredOpenCodePermissionRuleSchema = z.object({
  permission: z.string().trim().min(1),
  pattern: z.string().min(1),
  effect: z.enum(["allow", "ask", "deny"]),
}).strict();
const RetiredOpenCodeAdvancedConfigurationSchema = z.object({
  apiVersion: z.literal("v1"),
  permissionRules: z.array(RetiredOpenCodePermissionRuleSchema),
  permissionHandling: z.enum(["graphql_routed", "native_auto"]),
  subagentDepth: z.number().int().nonnegative().optional(),
  plugins: z.object({ mode: z.enum(["inherit", "pure"]) }).strict(),
  compaction: z.object({
    auto: z.boolean(), prune: z.boolean(), reservedTokens: z.number().int().nonnegative().optional(),
    tailTurns: z.number().int().nonnegative().optional(), preserveRecentTokens: z.number().int().nonnegative().optional(),
  }).strict(),
  configLoading: z.object({ mode: z.literal("native") }).strict(),
  mcp: z.object({ serverEnabled: z.record(z.string().trim().min(1), z.boolean()) }).strict(),
}).strict();
export const CodexHarnessConfigurationSchema = z
  .object({
    harness: z.literal("codex"),
    accountId: z.uuid().optional(),
    model: z.string().trim().min(1),
    reasoningEffort: AgentEffortSchema,
    sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]),
    serviceTier: z.enum(["standard", "priority"]),
    advanced: CodexAdvancedConfigurationSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sandbox !== "workspace-write" && value.advanced
      && (value.advanced.additionalWritableDirectories.length > 0 || value.advanced.workspaceWrite !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["advanced", "workspaceWrite"], message: "writable directories and workspace controls require workspace-write sandbox" });
    }
  });
export type CodexHarnessConfiguration = z.infer<typeof CodexHarnessConfigurationSchema>;

export const RetiredOpenCodeConfigurationSchema = z
  .object({
    harness: z.literal("opencode"),
    model: z.string().trim().min(1),
    /** Empty string delegates to the native default; named variants require provider evidence. */
    variant: z.string().trim(),
    nativeAgent: z.string().trim().min(1),
    thinking: z.boolean(),
    autoApprove: z.boolean(),
    advanced: RetiredOpenCodeAdvancedConfigurationSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.advanced && value.autoApprove !== (value.advanced.permissionHandling === "native_auto")) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["autoApprove"], message: "legacy autoApprove must match Advanced permission handling" });
    }
  });
export type RetiredOpenCodeConfiguration = z.infer<typeof RetiredOpenCodeConfigurationSchema>;

/** Readback preserves retired provider settings without authorizing execution. */
export const HarnessConfigurationSchema = z.discriminatedUnion("harness", [
  CodexHarnessConfigurationSchema,
  RetiredOpenCodeConfigurationSchema,
  ClaudeHarnessConfigurationSchema,
]);
export type HarnessConfiguration = z.infer<typeof HarnessConfigurationSchema>;
export const SupportedHarnessConfigurationSchema = z.discriminatedUnion("harness", [
  CodexHarnessConfigurationSchema,
  ClaudeFullAccessConfigurationSchema,
]);

/** Preserve native variants in harnessConfiguration; this is only a legacy display projection. */
export function projectHarnessEffort(configuration: HarnessConfiguration): AgentEffort | undefined {
  const value = configuration.harness === "codex" ? configuration.reasoningEffort : configuration.harness === "opencode" ? configuration.variant : undefined;
  const effort = AgentEffortSchema.safeParse(value);
  return effort.success ? effort.data : undefined;
}

export const HarnessWorkflowCompatibilitySchema = z.object({
  configuration: SupportedHarnessConfigurationSchema,
  workflowApprovalHandler: ApprovalHandlerSchema.optional(),
  designatedOrchestrator: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (value.configuration.harness === 'claude' && value.configuration.sandbox !== 'danger-full-access') {
    context.addIssue({ code: 'custom', path: ['configuration', 'sandbox'], message: CLAUDE_FULL_ACCESS_REQUIRED });
  }
  if (!value.workflowApprovalHandler) return;
  if (value.workflowApprovalHandler === "native") {
    const configuration = value.configuration;
    const advanced = configuration.harness === "codex"
      ? configuration.advanced ?? DEFAULT_CODEX_ADVANCED_CONFIGURATION : undefined;
    const native = advanced?.approvalPolicy === "never" || advanced?.approvalsReviewer === "auto_review";
    if (!native) context.addIssue({ code: z.ZodIssueCode.custom, path: ["configuration"],
      message: "native workflow handling requires an Agent that does not ask for user approval" });
    return;
  }
  if (value.configuration.harness === "codex" && value.configuration.advanced?.approvalsReviewer === "auto_review"
    && value.workflowApprovalHandler !== "orchestrator") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["configuration", "advanced", "approvalsReviewer"], message: "native auto review conflicts with this workflow approval handler" });
  }
  if (value.configuration.harness === "codex" && value.designatedOrchestrator
    && value.configuration.advanced?.approvalsReviewer === "auto_review"
    && value.configuration.advanced.approvalPolicy !== "on-request") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["configuration", "advanced", "approvalPolicy"], message: "Codex automatic review requires on-request approval" });
  }
});
export function validateHarnessWorkflowCompatibility(
  configuration: HarnessConfiguration,
  workflowApprovalHandler?: ApprovalHandler,
  designatedOrchestrator = false,
): HarnessConfiguration {
  return HarnessWorkflowCompatibilitySchema.parse({ configuration, workflowApprovalHandler, designatedOrchestrator }).configuration;
}

const AgentTemplateSchema = z.object({
  nativeTools: NativeToolsSchema.optional(),
  graphqlTools: GraphqlToolDefaultsSchema.optional(),
  harnessProfileSelection: z.lazy(() => HarnessProfileSelectionSchema).optional(),
  role: ConfiguredAgentProductRoleSchema,
  boardAddable: z.boolean(),
  harness: HarnessConfigurationSchema,
}).strict().superRefine((value, context) => {
  if (value.role === "operator" && value.boardAddable) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["boardAddable"], message: "Operator is application-level and cannot be added to a workflow board" });
  }
  if (value.graphqlTools && (value.role === 'operator' || graphqlToolsOutsideRole(value.role, value.graphqlTools).length)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['graphqlTools'], message: 'Workflow tool defaults must be allowed for the selected Agent role.' });
  }
});

export const AgentDefaultsSchema = z.object({
  master: AgentTemplateSchema.safeExtend({ role: z.literal("master"), boardAddable: z.literal(true) }).optional(),
  orchestrator: AgentTemplateSchema.safeExtend({ role: z.literal("orchestrator"), boardAddable: z.literal(true) }),
  coder: AgentTemplateSchema.safeExtend({ role: z.literal("coder"), boardAddable: z.literal(true) }),
  operator: AgentTemplateSchema.safeExtend({
    role: z.literal("operator"), boardAddable: z.literal(false), uiEnabled: z.boolean(), showThinking: z.boolean().optional(),
    /** Ordered exact skill versions for the Operator; pinned into its configuration when saved. */
    assignedSkills: z.array(WorkspaceSkillReferenceSchema).max(100).optional(),
  }),
}).strict();
export type AgentDefaults = z.infer<typeof AgentDefaultsSchema>;

/** Old saved defaults stay untouched; a new Master deliberately starts from coordinator settings. */
export function agentTemplateForRole(defaults: AgentDefaults, role: WorkflowAgentProductRole) {
  return role === 'master' ? defaults.master ?? { ...defaults.orchestrator, role: 'master' as const } : defaults[role];
}

export const WorkflowDefaultsSchema = z.object({ approvalHandler: ApprovalHandlerSchema }).strict();
export type WorkflowDefaults = z.infer<typeof WorkflowDefaultsSchema>;

/** Global templates copied into new board Agents. Prompts and skills never belong here. */
export const HarnessDefaultsSchema = z
  .object({
    codex: CodexHarnessConfigurationSchema,
    /** Absent until an owner selects an actual host-local Claude profile. */
    claude: ClaudeHarnessConfigurationSchema.optional(),
  })
  .strict();
export type HarnessDefaults = z.infer<typeof HarnessDefaultsSchema>;
export const DEFAULT_HARNESS_DEFAULTS: HarnessDefaults = HarnessDefaultsSchema.parse({
  codex: {
    harness: "codex",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    sandbox: "read-only",
    serviceTier: "standard",
    advanced: DEFAULT_CODEX_ADVANCED_CONFIGURATION,
  },
});

export const DEFAULT_AGENT_DEFAULTS: AgentDefaults = AgentDefaultsSchema.parse({
  orchestrator: {
    role: "orchestrator", boardAddable: true,
    nativeTools: { mcpServers: [], apps: false },
    harness: { ...DEFAULT_HARNESS_DEFAULTS.codex },
  },
  coder: {
    role: "coder", boardAddable: true,
    nativeTools: { mcpServers: [], apps: false },
    harness: { ...DEFAULT_HARNESS_DEFAULTS.codex },
  },
  operator: {
    role: "operator", boardAddable: false, uiEnabled: true, showThinking: true,
    harness: { ...DEFAULT_HARNESS_DEFAULTS.codex, sandbox: "danger-full-access" },
  },
});

/** New Operator provider selections use full access, without changing board presets or approval routing. */
export function operatorHarnessDefaults(base: HarnessConfiguration): HarnessConfiguration {
  if (base.harness === "codex") return changeCodexSandbox(base, "danger-full-access");
  if (base.harness === "claude") return { ...base, sandbox: "danger-full-access" };
  return structuredClone(base);
}

/** A designated Orchestrator is selected when a workflow is created. */
export const DEFAULT_WORKFLOW_APPROVAL_HANDLER: ApprovalHandler = "native";

export const HarnessQualificationSchema = z
  .object({
    harness: RecordedAgentHarnessSchema,
    version: z.string().trim().min(1),
    authenticated: z.boolean(),
    ready: z.boolean(),
    structuredEvents: z.boolean(),
    modelCatalogSource: z.enum(['native', 'cached']).optional(),
    supportsResume: z.boolean(),
    supportsCancellation: z.boolean(),
    supportsWorkingDirectory: z.boolean(),
    supportsStartupPrompt: z.boolean(),
    supportedNativeTools: z.array(z.string().trim().min(1)),
    supportedSettings: z.array(z.string().trim().min(1)),
    unsupportedCapabilities: z.array(z.string().trim().min(1)),
  })
  .strict();
export type HarnessQualification = z.infer<typeof HarnessQualificationSchema>;

const McpDetectionStateSchema = z.enum([
  "not_detected", "misconfigured", "status_unavailable", "connected", "disabled",
  "authentication_required", "broken", "check_failed",
]);
export const McpDetectionSchema = z.object({
  harness: AgentHarnessSchema,
  serverName: z.string().trim().min(1),
  state: McpDetectionStateSchema,
  endpointMatches: z.boolean().nullable(),
  credentialEnvironmentVariable: z.string().trim().min(1).nullable(),
  credentialArrangement: McpCredentialArrangementSchema.optional(),
  checkedAt: TimestampSchema,
  detail: z.string().optional(),
}).strict();
export type McpDetection = z.infer<typeof McpDetectionSchema>;

export const ScopedMcpDetectionSchema = z.object({
  detection: McpDetectionSchema,
  runnerId: IdSchema,
  workingDirectory: z.string().min(1).refine((value) => !value.includes("\0"), "workingDirectory cannot contain NUL"),
  providerVersion: z.string().trim().min(1),
  nativeFilters: z.object({
    enabledTools: z.array(z.string()).optional(),
    disabledTools: z.array(z.string()).optional(),
    diagnostics: z.array(z.string()).optional(),
  }).strict(),
}).strict();
export type ScopedMcpDetection = z.infer<typeof ScopedMcpDetectionSchema>;

export const NativeHarnessCapabilitiesSchema = z.object({
  provider: AgentHarnessSchema,
  providerVersion: z.string().trim().min(1),
  persistentSessions: z.boolean(),
  reconnect: z.boolean(),
  sameRequestResponses: z.boolean(),
  cancellation: z.boolean(),
  history: z.boolean(),
  configurationInspection: z.boolean(),
  mcpDetection: z.boolean(),
  supportedInteractionKinds: z.array(z.string().trim().min(1)),
  interactionSupport: z.array(NativeInteractionSupportSchema).optional(),
}).strict();
export type NativeHarnessCapabilities = z.infer<typeof NativeHarnessCapabilitiesSchema>;

export const ApprovalResponseSemanticSchema = z.enum([
  "approve_once", "allow_turn", "allow_session", "reject", "cancel",
  "provider_scoped_allow", "persistent_policy_change",
]);
const ApprovalPersistenceSchema = z.enum([
  "request", "turn", "session", "provider_instance", "project", "persistent_config",
]);
export const ApprovalResponseOptionSchema = z.object({
  optionId: IdSchema,
  semantic: ApprovalResponseSemanticSchema,
  label: z.string().trim().min(1),
  persistence: ApprovalPersistenceSchema,
  scopeSummary: z.string().trim().min(1).optional(),
  affectsOtherPendingRequests: z.boolean(),
  interruptsCurrentTurn: z.boolean(),
  mutatesPersistentPolicy: z.boolean(),
  input: NativeInteractionInputSchema.optional(),
  response: z.json().optional(),
}).strict();
export type ApprovalResponseOption = z.infer<typeof ApprovalResponseOptionSchema>;

export const CodexSessionCompatibilitySchema = z.object({
  configuration: CodexHarnessConfigurationSchema,
  responseOptions: z.array(ApprovalResponseOptionSchema).default([]),
  requiresResume: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (value.configuration.advanced?.sessionPersistence !== "ephemeral") return;
  if (value.requiresResume) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["requiresResume"], message: "ephemeral Codex sessions cannot support resume-dependent features" });
  }
  value.responseOptions.forEach((option, index) => {
    if (option.semantic === "allow_session") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["responseOptions", index], message: "ephemeral Codex sessions cannot offer session allowance" });
    }
  });
});

export const InteractionStatusSchema = z.enum(["pending", "decided", "delivery_pending", "delivered", "delivery_failed", "canceled"]);
export const NativeDeliveryStateSchema = z.enum(["not_started", "pending", "submitted", "uncertain", "delivered", "failed"]);
export const DurableInteractionSchema = z.object({
  kind: z.enum(["native", "work_direction"]).optional(),
  continuationRunId: IdSchema.optional(),
  id: IdSchema,
  revision: z.number().int().nonnegative(),
  workspaceId: IdSchema,
  workflowId: IdSchema,
  runId: IdSchema,
  executionId: IdSchema,
  requestingAgentId: IdSchema,
  harness: RecordedAgentHarnessSchema,
  providerVersion: z.string().trim().min(1),
  nativeSessionId: IdSchema,
  nativeRequestId: IdSchema,
  nativeRequestType: z.string().trim().min(1),
  graphThreadId: IdSchema,
  graphInterruptId: IdSchema.optional(),
  request: z.json(),
  reviewContext: z.object({ target: z.string().min(1), changeSummary: z.string().min(1) }).strict().optional(),
  approval: AcceptedWorkflowApprovalConfigurationSchema,
  responseOptions: z.array(ApprovalResponseOptionSchema).min(1),
  status: InteractionStatusSchema,
  selectedOptionId: IdSchema.optional(),
  selectedSemantic: ApprovalResponseSemanticSchema.optional(),
  nativeResponse: z.json().optional(),
  deliveryState: NativeDeliveryStateSchema,
  auditReference: IdSchema.optional(),
  createdAt: TimestampSchema,
  decidedAt: TimestampSchema.optional(),
  deliveredAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema,
}).strict().superRefine((value, context) => {
  const decisionFields = ["selectedOptionId", "selectedSemantic", "nativeResponse", "decidedAt"] as const;
  if (value.kind === 'work_direction'
    && (value.nativeRequestType !== 'workflow/work_direction' || value.approval.handler !== 'user')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['kind'], message: 'Workflow direction is an owner-handled Run decision.' });
  }
  if (value.continuationRunId && (value.kind !== 'work_direction'
    || value.selectedOptionId !== 'continue' || value.status !== 'delivered')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['continuationRunId'], message: 'A continuation Run requires a completed direction choice.' });
  }
  const hasDecision = decisionFields.every((field) => value[field] !== undefined);
  const hasAnyDecision = decisionFields.some((field) => value[field] !== undefined);
  if (hasAnyDecision && !hasDecision) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["selectedOptionId"], message: "a decision requires an option, semantic, native response and decision time" });
  }
  if (value.status === "pending" && hasAnyDecision) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "pending interactions cannot contain a decision" });
  }
  if (value.status !== "pending" && value.status !== "canceled" && !hasDecision) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "decided and delivery states require a complete decision" });
  }
  if (hasDecision) {
    const option = value.responseOptions.find((item) => item.optionId === value.selectedOptionId);
    if (!option || option.semantic !== value.selectedSemantic) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["selectedOptionId"], message: "the selected option and semantic must match an offered response" });
    }
  }
  const allowedDeliveryStates: Record<typeof value.status, readonly typeof value.deliveryState[]> = {
    pending: ["not_started"], decided: ["not_started"],
    delivery_pending: ["pending", "submitted", "uncertain"],
    delivered: ["delivered"], delivery_failed: ["failed"], canceled: ["not_started", "delivered", "failed", "uncertain"],
  };
  if (!allowedDeliveryStates[value.status].includes(value.deliveryState)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["deliveryState"], message: "delivery state contradicts the interaction lifecycle" });
  }
  if ((value.deliveryState === "delivered") !== (value.deliveredAt !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["deliveredAt"], message: "confirmed native delivery requires a delivery time" });
  }
});
export type DurableInteraction = z.infer<typeof DurableInteractionSchema>;
export { WorkDirectionRequestSchema, WorkDirectionResponseSchema } from './workDirection.js';

/** Scoped restart recovery: send only unsent work; reconcile all ambiguous attempts. */
export const InteractionRecoveryQuerySchema = z.object({
  workspaceId: IdSchema, workflowId: IdSchema.optional(), runId: IdSchema.optional(),
  afterId: IdSchema.optional(), limit: z.number().int().min(1).max(100),
  mode: z.enum(["send", "reconcile"]),
}).strict();
export type InteractionRecoveryQuery = z.infer<typeof InteractionRecoveryQuerySchema>;


export const NativeSessionReferenceSchema = z.object({
  harness: RecordedAgentHarnessSchema,
  providerVersion: z.string().trim().min(1),
  nativeSessionId: IdSchema,
}).strict();
export type NativeSessionReference = z.infer<typeof NativeSessionReferenceSchema>;
export const WorkflowSessionContinuationSchema = z.object({
  previousExecutionId: IdSchema,
  session: NativeSessionReferenceSchema,
  previousOperationId: IdSchema.optional(),
}).strict();
export type WorkflowSessionContinuation = z.infer<typeof WorkflowSessionContinuationSchema>;
const NativeInteractionIdentitySchema = z.object({
  nativeTurnId: IdSchema.optional(),
  nativeMessageId: IdSchema.optional(),
  nativeRequestId: IdSchema.optional(),
}).strict();
export const NativeHarnessEventSchema = z.object({
  connectionId: IdSchema.optional(),
  sequence: z.number().int().nonnegative(),
  type: z.string().trim().min(1),
  occurredAt: TimestampSchema,
  payload: z.record(z.string(), z.unknown()),
}).strict();
export type NativeHarnessEvent = z.infer<typeof NativeHarnessEventSchema>;
export const PendingNativeInteractionSchema = z.object({
  session: NativeSessionReferenceSchema,
  turn: NativeInteractionIdentitySchema,
  nativeRequestType: z.string().trim().min(1),
  request: z.json(),
  responseOptions: z.array(ApprovalResponseOptionSchema).min(1),
}).strict().superRefine((value, context) => {
  if (value.session.harness === 'codex' && value.nativeRequestType === 'mcpServer/elicitation/request'
    && value.turn.nativeRequestId && !value.turn.nativeTurnId && !value.turn.nativeMessageId) return;
  if ((value.turn.nativeTurnId !== undefined) === (value.turn.nativeMessageId !== undefined)) {
    context.addIssue({ code: 'custom', path: ['turn'], message: 'An observed turn or message identity is required.' });
  }
  if (value.session.harness !== "claude" && !value.turn.nativeTurnId) context.addIssue({ code: "custom", path: ["turn", "nativeTurnId"], message: "This native provider requires its observed turn identity." });
});
export type PendingNativeInteraction = z.infer<typeof PendingNativeInteractionSchema>;
export function isSessionNativeInteraction(value: PendingNativeInteraction): boolean {
  return value.session.harness === 'codex' && value.nativeRequestType === 'mcpServer/elicitation/request'
    && !value.turn.nativeTurnId && !value.turn.nativeMessageId && Boolean(value.turn.nativeRequestId);
}


export const NativeSessionLaneSchema = z.object({
  id: IdSchema,
  harness: RecordedAgentHarnessSchema,
  nativeSessionId: IdSchema,
  ownerAgentId: IdSchema,
  leaseOwner: IdSchema.optional(),
  leaseToken: IdSchema.optional(),
  leaseExpiresAt: TimestampSchema.optional(),
  correlationId: IdSchema.optional(),
  observedStatus: z.enum(["idle", "busy", "disconnected", "uncertain"]),
  currentTurnOrMessageId: IdSchema.optional(),
  connectionGeneration: z.number().int().nonnegative(),
  observedAt: TimestampSchema,
  revision: z.number().int().nonnegative(),
}).strict();
export type NativeSessionLane = z.infer<typeof NativeSessionLaneSchema>;

/** Failure is a business outcome; native/credential cleanup has its own durable lifecycle. */
export const ReviewCleanupSchema = z.object({
  nativeState: z.enum(["pending", "not_started", "terminal", "closed"]),
  credentialState: z.enum(["pending", "revoked", "not_required"]),
  /** Opaque principal identity only. Never persist a process token or its environment. */
  credentialPrincipalId: IdSchema.optional(),
  interruptState: z.enum(["not_sent", "submitted", "acknowledged"]),
  completedAt: TimestampSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.completedAt && (value.nativeState === "pending" || value.credentialState === "pending")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["completedAt"], message: "cleanup requires confirmed native settlement and credential revocation" });
  }
});
export type ReviewCleanup = z.infer<typeof ReviewCleanupSchema>;

export const ReviewJobSchema = z.object({
  id: IdSchema,
  interactionId: IdSchema,
  reviewerAgentId: IdSchema,
  attempt: z.number().int().nonnegative(),
  state: z.enum(["pending", "leased", "submitted", "acknowledged", "completed", "blocked_busy", "blocked_disconnected", "uncertain", "failed"]),
  provider: RecordedAgentHarnessSchema,
  nativeSessionId: IdSchema,
  providerTurnOrMessageId: IdSchema.optional(),
  leaseOwner: IdSchema.optional(),
  leaseToken: IdSchema.optional(),
  leaseExpiresAt: TimestampSchema.optional(),
  correlationId: IdSchema,
  retryAfter: TimestampSchema.optional(),
  cleanup: ReviewCleanupSchema.optional(),
  error: z.object({ code: z.string().trim().min(1), message: z.string().trim().min(1) }).strict().optional(),
  createdAt: TimestampSchema,
  submittedAt: TimestampSchema.optional(),
  acknowledgedAt: TimestampSchema.optional(),
  completedAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema,
}).strict();
export type ReviewJob = z.infer<typeof ReviewJobSchema>;
export const ReviewStatusSchema = ReviewJobSchema.pick({
  state: true, attempt: true, error: true, retryAfter: true, updatedAt: true,
}).extend({ cleanupPending: z.boolean().optional(), reviewJobId: IdSchema.optional() });
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

/** An Agent is a separately addressable worker; workflow nodes reference it by agentId. */
export const AgentSchema = z
  .object({
    nativeTools: NativeToolsSchema.optional(),
    id: IdSchema,
    name: z.string().trim().min(1),
    description: z.string().optional(),
    role: AgentRoleSchema.optional(),
    /** Server-owned product role; never derived from role or model output. */
    productRole: WorkflowAgentProductRoleSchema.optional(),
    status: AgentStatusSchema.optional(),
    executionState: AgentExecutionStateSchema.optional(),
    /** Links this logical Agent projection to its current run summary, if any. */
    activeRunId: IdSchema.optional(),
    harnessSummary: HarnessSummarySchema.optional(),
    harness: RecordedAgentHarnessSchema.optional(),
    model: z.string().trim().min(1).optional(),
    effort: AgentEffortSchema.optional(),
    fastMode: z.boolean().optional(),
    harnessConfiguration: HarnessConfigurationSchema.optional(),
    harnessProfileSelection: z.lazy(() => HarnessProfileSelectionSchema).optional(),
    configurationVersionId: IdSchema.optional(),
    prompt: AgentPromptSchema.optional(),
    assignedSkills: z.array(AssignedSkillSchema).optional(),
    /** Default Foreman Code MCP tools; absence retains the pre-collaboration role tools. */
    graphqlTools: GraphqlToolDefaultsSchema.optional(),
    ...OptionalTimestampFields,
  })
  .strict();
export type Agent = z.infer<typeof AgentSchema>;

export type WorkflowDefinition = import('./wave25/workflowShape.js').WorkflowDefinitionV3;
export type WorkflowVersion = import('./wave25/workflowSchemas.js').WorkflowVersionV3;

/** Immutable prompt, skill, model and harness settings used to start a native session. */
export const AgentConfigurationVersionSchema = z
  .object({
    nativeTools: NativeToolsSchema.optional(),
    harnessProfileSelection: z.lazy(() => HarnessProfileSelectionSchema).optional(),
    id: IdSchema,
    workspaceId: IdSchema,
    agentId: IdSchema,
    productRole: WorkflowAgentProductRoleSchema.optional(),
    version: z.number().int().positive(),
    prompt: AgentPromptSchema,
    assignedSkills: z.array(AssignedSkillSchema),
    resolvedSkills: z.array(ResolvedSkillSchema).max(100).optional(),
    graphqlTools: GraphqlToolDefaultsSchema.optional(),
    /** Present on configurations accepted after Skills v1: the persistent prompt and pinned
     * skills are delivered as native app instructions, separate from task text. Absent on
     * earlier accepted configurations, which keep their original in-task delivery. */
    instructionDelivery: z.literal("native-v1").optional(),
    harness: HarnessConfigurationSchema,
    contentHash: z.string().trim().min(1),
    createdAt: TimestampSchema,
  })
  .strict();
export type AgentConfigurationVersion = z.infer<typeof AgentConfigurationVersionSchema>;

export const OperatorConfigurationVersionSchema = z.object({
  nativeTools: NativeToolsSchema.optional(),
  harnessProfileSelection: z.lazy(() => HarnessProfileSelectionSchema).optional(),
  id: IdSchema,
  operatorId: IdSchema,
  version: z.number().int().positive(),
  harness: HarnessConfigurationSchema,
  showThinking: z.boolean().optional(),
  assignedSkills: z.array(WorkspaceSkillReferenceSchema).max(100).optional(),
  resolvedSkills: z.array(ResolvedSkillSchema).max(100).optional(),
  instructionDelivery: z.literal("native-v1").optional(),
  contentHash: z.string().startsWith("sha256:"),
  createdAt: TimestampSchema,
}).strict();
export type OperatorConfigurationVersion = z.infer<typeof OperatorConfigurationVersionSchema>;

export const OperatorAgentSchema = z.object({
  id: IdSchema,
  role: z.literal("operator"),
  name: z.string().trim().min(1),
  currentConfigurationVersionId: IdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();
export type OperatorAgent = z.infer<typeof OperatorAgentSchema>;

const ConversationStatusSchema = z.enum(["open", "archived"]);

export const ConversationSchema = z
  .object({
    id: IdSchema,
    /** Omitted for application-global Operator conversations. */
    workspaceId: IdSchema.optional(),
    agentId: IdSchema,
    scope: z.enum(["workspace", "application"]).optional(),
    operatorConfigurationVersionId: IdSchema.optional(),
    initialPrompt: PromptSettingSnapshotSchema.optional(),
    title: z.string().optional(),
    status: ConversationStatusSchema.optional(),
    ...OptionalTimestampFields,
  })
  .strict()
  .superRefine((value, context) => {
    const scope = value.scope ?? "workspace";
    if (scope === "workspace" && !value.workspaceId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["workspaceId"], message: "workspace conversations require workspaceId" });
    }
    if (scope === "application" && value.workspaceId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["workspaceId"], message: "application conversations cannot use a fake workspace" });
    }
    if (scope === "application" && !value.operatorConfigurationVersionId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["operatorConfigurationVersionId"], message: "Operator conversations pin a configuration version" });
    }
  });
export type Conversation = z.infer<typeof ConversationSchema>;



export const RunExecutionStateSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "interrupted",
  "completed",
]);
export type RunExecutionState = z.infer<typeof RunExecutionStateSchema>;

/** A terminal task result. An interrupted run has no successful/failed outcome by implication. */
export const RunOutcomeSchema = z.enum(["pending", "succeeded", "failed", "canceled"]);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

export { RunInputSchema } from "./schemaPrimitives.js";
export type RunInput = z.infer<typeof RunInputSchema>;

export const ExecutionResultSchema = z
  .object({
    outcome: z.enum(["succeeded", "failed", "canceled"]),
    output: z.json().optional(),
    error: z
      .object({
        code: z.string().trim().min(1),
        message: z.string().trim().min(1),
        retryable: z.boolean(),
        details: SourceCapacityErrorDetailsSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.outcome === "failed" && !result.error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "a failed result requires an error",
      });
    }
    if (result.outcome !== "failed" && result.error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "only a failed result may include an error",
      });
    }
  });
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

export { ExecutionQueueReasonSchema, ExecutionQueueEntrySchema, executionQueueReasonLabel } from './executionQueue.js';
export type { ExecutionQueueReason, ExecutionQueueEntry } from './executionQueue.js';

export const HarnessExecutionStateSchema = z.enum([
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
]);
export type HarnessExecutionState = z.infer<typeof HarnessExecutionStateSchema>;

/** One native harness attempt for a workflow node. Attempts may share a parallelGroupId. */
export const HarnessExecutionSchema = z
  .object({
    resultProtocol: ResultProtocolSchema.optional(),
    memoryBoardDigest: BoardDigestSchema.optional(),
    id: IdSchema,
    runId: IdSchema,
    workflowNodeId: IdSchema,
    agentId: IdSchema,
    agentConfigurationVersionId: IdSchema,
    attempt: z.number().int().positive(),
    systemPrompt: PromptSettingSnapshotSchema.optional(),
    parallelGroupId: IdSchema.optional(),
    nativeSessionId: IdSchema.optional(),
    sessionContinuation: WorkflowSessionContinuationSchema.optional(),
    /** User project directory selected on the Run. Optional only for legacy history. */
    workingDirectory: z.string().min(1).optional(),
    /** Foreman Code-owned attempt storage, always separate from workingDirectory. */
    runtimeDirectory: z.string().min(1).optional(),
    input: z.json(),
    state: HarnessExecutionStateSchema,
    /** Live process-local capacity wait, added by authorized reads only. */
    queueReason: ExecutionQueueReasonSchema.optional(),
    result: ExecutionResultSchema.optional(),
    createdAt: TimestampSchema,
    startedAt: TimestampSchema.optional(),
    finishedAt: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((execution, context) => {
    if (execution.sessionContinuation && (execution.sessionContinuation.previousExecutionId === execution.id
      || execution.nativeSessionId !== undefined
        && execution.nativeSessionId !== execution.sessionContinuation.session.nativeSessionId)) {
      context.addIssue({ code: 'custom', path: ['sessionContinuation'], message: 'Invalid session continuation.' });
    }
    if (execution.state === "completed" && (!execution.result || !execution.finishedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["result"],
        message: "a completed harness execution requires a result and finishedAt",
      });
    }
    if (execution.state !== "completed") {
      for (const field of ["result", "finishedAt"] as const) {
        if (execution[field] !== undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `a non-completed harness execution cannot include ${field}`,
          });
        }
      }
    }
  });
export type HarnessExecution = z.infer<typeof HarnessExecutionSchema>;

/** Durable run identity; workflow/configuration pins never change after creation. */
export const WorkflowRunRecordSchema = z
  .object({
    id: GraphIdSchema,
    workspaceId: GraphIdSchema,
    workflowId: GraphIdSchema,
    workflowVersionId: GraphIdSchema,
    executionSemanticsVersion: ExecutionSemanticsVersionSchema,
    resultProtocol: ResultProtocolSchema.optional(),
    /** Accepted workspace location snapshot. Public redacted reads may omit this. */
    executionLocation: RunExecutionLocationSchema.optional(),
    /** Operator authority rechecked before queued and later node execution. */
    authorizationPrincipalId: GraphIdSchema.optional(),
    /** Automatic Stop cause; does not imply confirmed native closure. */
    stopCause: RunStopCauseSchema.optional(),
    agentConfigurationVersionIds: z.record(GraphIdSchema, GraphIdSchema),
    /** Immutable accepted approval assignment. */
    approval: AcceptedWorkflowApprovalConfigurationSchema,
    executionCondition: ExecutionConditionSchema,
    executionState: RunExecutionStateSchema,
    outcome: RunOutcomeSchema,
    input: RunInputSchema,
    result: ExecutionResultSchema.optional(),
    createdAt: TimestampSchema,
    startedAt: TimestampSchema.optional(),
    finishedAt: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((run, context) => {
    const terminal = run.executionState === "completed";
    if (terminal && (run.outcome === "pending" || !run.result || !run.finishedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["result"],
        message: "a completed run requires a terminal outcome, result, and finishedAt",
      });
    }
    if (!terminal && (run.outcome !== "pending" || run.result || run.finishedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome"],
        message: "a non-completed run must retain a pending outcome without a result or finishedAt",
      });
    }
    if (run.result && run.result.outcome !== run.outcome) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["result", "outcome"],
        message: "result.outcome must match outcome",
      });
    }
  });
// Generic Run DTOs enforce the same current family as execution admission.
export const WorkflowRunSchema = WorkflowRunRecordSchema;
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

export const ActivitySourceSchema = z.enum(["backend", "langgraph", "harness", "operator"]);
export type ActivitySource = z.infer<typeof ActivitySourceSchema>;

export const ActivityKindSchema = z.enum([
  "run_state_changed",
  "node_scheduled",
  "node_state_changed",
  "ci_state_changed",
  "harness_session_started",
  "harness_output",
  "native_events_skipped",
  "harness_session_finished",
  "result_recorded",
  "interaction_pending",
  "interaction_decided",
  "interaction_delivery_state",
  "interaction_resolved",
  "interaction_worker_ack",
  "review_job_state",
  "run_stop_requested",
  "run_cleanup_checked",
  "work_activation_queued",
  "work_result_accepted",
  "work_handoff_accepted",
  "work_handoff_returned",
  "work_handoff_denied",
  "work_requester_reactivated",
  "work_rerouted",
  "work_limit_notice_queued",
  "work_limit_notice_pending",
  "work_limit_notice_delivered",
  "work_limit_notice_unknown",
  "work_needs_direction",
  "work_direction_wait",
  "workflow_chat_receipt",
  "collaboration_lifecycle",
]);

/** Ordered native/backend activity. payload remains source-specific but JSON-safe. */
export const RunActivitySchema = z
  .object({
    id: IdSchema,
    runId: IdSchema,
    sequence: z.number().int().nonnegative(),
    source: ActivitySourceSchema,
    kind: ActivityKindSchema,
    harnessExecutionId: IdSchema.optional(),
    occurredAt: TimestampSchema,
    payload: z.record(z.string(), z.json()),
  })
  .strict();
export type RunActivity = z.infer<typeof RunActivitySchema>;

/** One unmodified machine-readable event emitted by a native harness process. */
export const HarnessNativeEventSchema = z
  .object({
    executionId: IdSchema,
    connectionId: IdSchema.optional(),
    sequence: z.number().int().nonnegative(),
    type: z.string().trim().min(1),
    occurredAt: TimestampSchema,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type HarnessNativeEvent = z.infer<typeof HarnessNativeEventSchema>;

/** Caller references reconstructed from saved ancestry, separate from frozen task input. */
export const HarnessExecutionContextSchema = z.object({
  parentRequest: z.object({
    requestId: GraphIdSchema,
    requesterNodeId: GraphIdSchema,
  }).strict().nullable(),
  outstandingRequestIds: z.array(GraphIdSchema).max(1000).optional(),
}).strict();
export type HarnessExecutionContext = z.infer<typeof HarnessExecutionContextSchema>;

/** Command handed to a harness adapter when initializing a new native session. */
export const HarnessExecutionRequestSchema = z
  .object({
    executionId: IdSchema,
    resultProtocol: ResultProtocolSchema.optional(),
    runId: IdSchema,
    workspaceId: IdSchema,
    workflowNodeId: IdSchema,
    // Validated filesystem paths must cross this boundary without trimming.
    workingDirectory: ExecutionLocationSchema.shape.rootPath,
    runtimeDirectory: ExecutionLocationSchema.shape.rootPath,
    initialPrompt: z.string().trim().min(1).optional(),
    systemPrompt: PromptSettingSnapshotSchema.optional(),
    configuration: AgentConfigurationVersionSchema,
    input: z.json(),
    executionContext: HarnessExecutionContextSchema.optional(),
  })
  .strict();
export type HarnessExecutionRequest = z.infer<typeof HarnessExecutionRequestSchema>;

const BrowserWaitReasonSchema = z.enum([
  "auth_required",
  "browser_profile",
  "operator_input",
  "browser_unavailable",
  "rate_limited",
  "other",
]);

const ResourceHolderSchema = z.enum(["none", "operator", "runner", "agent"]);

/** Why a run is waiting for a browser and who currently holds that resource. */
export const BrowserWaitSchema = z
  .object({
    reason: BrowserWaitReasonSchema,
    resourceHolder: ResourceHolderSchema,
    resourceId: IdSchema.optional(),
    resourceName: z.string().trim().min(1).optional(),
    holderId: IdSchema.optional(),
    holderLabel: z.string().trim().min(1).optional(),
    executionId: IdSchema.optional(),
    executionLabel: z.string().trim().min(1).optional(),
  })
  .strict();

const RunnerHealthStatusSchema = z.enum([
  "healthy",
  "degraded",
  "offline",
  "disconnected",
  "unknown",
]);

const RunnerHealthSchema = z
  .object({
    status: RunnerHealthStatusSchema,
    message: z.string().optional(),
    checkedAt: TimestampSchema.optional(),
  })
  .strict();

/**
 * A compact run projection for cards and activity views. Execution state, outcome,
 * auth, browser waits and runner health are separate so one cannot stand in for another.
 */
export const WorkflowRunSummarySchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    workflowId: IdSchema,
    executionCondition: ExecutionConditionSchema,
    executionState: RunExecutionStateSchema,
    outcome: RunOutcomeSchema,
    authRequired: z.boolean(),
    browserWait: BrowserWaitSchema.nullable(),
    runnerHealth: RunnerHealthSchema,
    cleanupPending: z.boolean().optional(),
    stopCause: RunStopCauseSchema.optional(),
    startedAt: TimestampSchema.optional(),
    finishedAt: TimestampSchema.optional(),
  })
  .strict();
export type WorkflowRunSummary = z.infer<typeof WorkflowRunSummarySchema>;
export const RunSummarySchema = WorkflowRunSummarySchema;
export type RunSummary = WorkflowRunSummary;

const ResourceKindSchema = z.enum(["browser", "file", "document", "tool", "other"]);

const ResourceStatusSchema = z.enum([
  "available",
  "in_use",
  "waiting",
  "auth_required",
  "unavailable",
]);

export const ResourceSummarySchema = z
  .object({
    id: IdSchema,
    kind: ResourceKindSchema,
    name: z.string().trim().min(1),
    status: ResourceStatusSchema,
    resourceHolder: ResourceHolderSchema,
    authRequired: z.boolean(),
  })
  .strict();
export type ResourceSummary = z.infer<typeof ResourceSummarySchema>;

const BrowserProfileStatusSchema = z.enum([
  "available",
  "in_use",
  "waiting",
  "auth_required",
  "unavailable",
]);

/** A browser profile summary is a resource projection, not a browser implementation. */
export const BrowserProfileSummarySchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1),
    status: BrowserProfileStatusSchema,
    authRequired: z.boolean(),
    resourceHolder: ResourceHolderSchema,
    runnerId: IdSchema.optional(),
  })
  .strict();
export type BrowserProfileSummary = z.infer<typeof BrowserProfileSummarySchema>;

export const RunnerSummarySchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1),
    health: RunnerHealthSchema,
  })
  .strict();
export type RunnerSummary = z.infer<typeof RunnerSummarySchema>;

export const LOCAL_CLIENT_UNAVAILABLE = 'LOCAL_CLIENT_UNAVAILABLE'

export const ApiErrorSchema = z
  .object({
    code: z.string().trim().min(1),
    message: z.string().trim().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
    /** Present when the reply has no other explicit classification (`details.retryable`) and is not permanent. */
    class: FailureClassSchema.optional(),
    requestId: IdSchema.optional(),
  })
  .strict();
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ApiErrorResponseSchema = z
  .object({
    error: ApiErrorSchema,
  })
  .strict();
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

export const ServiceHealthSchema = z
  .object({
    status: z.enum(["ok", "unavailable"]),
    service: z.literal("graphql-api"),
    checks: z
      .object({
        database: z.enum(["ok", "unavailable"]).optional(),
        checkpoints: z.enum(["ok", "unavailable"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ServiceHealth = z.infer<typeof ServiceHealthSchema>;

/** The same explicit V3 request as HTTP/Operator MCP; no unpinned Start DTO. */
export const CreateRunRequestSchema = RunStartV3InputSchema;

export const GetRunRequestSchema = z
  .object({ workspaceId: IdSchema, runId: IdSchema })
  .strict();
export type GetRunRequest = z.infer<typeof GetRunRequestSchema>;
export type GetRunResponse = {
  run: WorkflowRun;
  executions: HarnessExecution[];
  activity: RunActivity[];
  liveActivity?: RunLiveActivity | undefined;
  cleanupPending?: boolean | undefined;
};

export const WorkspaceDetailsRecordFields = {
  workspace: WorkspaceSchema, agents: z.array(AgentSchema), runs: z.array(WorkflowRunSummarySchema),
  resources: z.array(ResourceSummarySchema), browserProfiles: z.array(BrowserProfileSummarySchema).optional(),
  runners: z.array(RunnerSummarySchema).optional(),
};
const WorkspaceDetailsSchema = z.object({ ...WorkspaceDetailsRecordFields,
  workflows: z.array(WorkflowDefinitionV3Schema) }).strict();
export type WorkspaceDetails = z.infer<typeof WorkspaceDetailsSchema>;

export const WorkspaceDetailsRequestSchema = z
  .object({ workspaceId: IdSchema })
  .strict();
export type WorkspaceDetailsRequest = z.infer<typeof WorkspaceDetailsRequestSchema>;
export const WorkspaceDetailsResponseSchema = WorkspaceDetailsSchema;
export type WorkspaceDetailsResponse = WorkspaceDetails;

export const ListAgentsRequestSchema = WorkspaceDetailsRequestSchema;
export type ListAgentsRequest = WorkspaceDetailsRequest;
export const ListAgentsResponseSchema = z
  .object({ agents: z.array(AgentSchema) })
  .strict();
export type ListAgentsResponse = z.infer<typeof ListAgentsResponseSchema>;

export const GetWorkflowRequestSchema = z
  .object({ workspaceId: IdSchema, workflowId: IdSchema })
  .strict();
export type GetWorkflowRequest = z.infer<typeof GetWorkflowRequestSchema>;
export const GetWorkflowResponseSchema = z
  .object({ workflow: WorkflowDefinitionV3Schema })
  .strict();

export const SaveWorkflowRequestSchema = z
  .object({
    workspaceId: IdSchema,
    workflow: WorkflowDefinitionV3Schema,
    agents: z.array(AgentSchema).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.workspaceId !== value.workflow.workspaceId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workflow", "workspaceId"],
        message: "workflow.workspaceId must match workspaceId",
      });
    }
  });
export const SaveWorkflowResponseSchema = z
  .object({
    workflow: WorkflowDefinitionV3Schema,
    agents: z.array(AgentSchema).optional(),
  })
  .strict();

export const GetHarnessDefaultsResponseSchema = z
  .object({ defaults: HarnessDefaultsSchema })
  .strict();
export type GetHarnessDefaultsResponse = z.infer<typeof GetHarnessDefaultsResponseSchema>;

export const CreateConversationRequestSchema = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("workspace"), workspaceId: IdSchema, agentId: IdSchema,
    title: z.string().trim().min(1).optional(),
  }).strict(),
  z.object({
    scope: z.literal("application"), agentId: IdSchema,
    operatorConfigurationVersionId: IdSchema,
    title: z.string().trim().min(1).optional(),
  }).strict(),
]);

/** Application-global Operator chat commands. Browser route context is only a prompt hint. */
const OperatorConversationContextSchema = z.object({
  route: z.string().trim().min(1).optional(),
  workspaceId: IdSchema.optional(),
  workflowId: IdSchema.optional(),
  runId: IdSchema.optional(),
}).strict();
/** Per-message model controls. Execution permissions remain server-owned. */
export const OperatorChatSettingsSchema = z.discriminatedUnion("harness", [
  z.object({ harness: z.literal("codex"), model: z.string().trim().min(1), reasoningEffort: AgentEffortSchema,
    accountId: z.uuid().optional(), serviceTier: z.enum(["standard", "priority"]), showThinking: z.boolean() }).strict(),
  z.object({ harness: z.literal("claude"), accountId: z.uuid().optional(), model: z.string().trim().min(1),
    effort: ClaudeEffortSchema.optional(), showThinking: z.boolean() }).strict(),
]);
/** Saved conversation controls remain readable after provider retirement. */
export const RecordedOperatorChatSettingsSchema = z.union([
  OperatorChatSettingsSchema,
  z.object({ harness: z.literal("opencode"), model: z.string().trim().min(1), variant: z.string(),
    showThinking: z.boolean() }).strict(),
]);
export type OperatorChatSettings = z.infer<typeof OperatorChatSettingsSchema>;
export function operatorChatSettings(harness: HarnessConfiguration, showThinking = false): OperatorChatSettings {
  if (harness.harness === "opencode") throw new Error(RETIRED_OPENCODE_MESSAGE);
  if (harness.harness === "claude") {
    return { harness: "claude", model: harness.model, ...(harness.accountId ? { accountId: harness.accountId } : {}),
      ...(harness.effort ? { effort: harness.effort } : {}), showThinking };
  }
  return { harness: "codex", model: harness.model, reasoningEffort: harness.reasoningEffort,
    ...(harness.accountId ? { accountId: harness.accountId } : {}),
    serviceTier: harness.serviceTier, showThinking };
}
/** Apply chat controls without replacing the accepted execution permissions. */
export function applyOperatorChatSettings(base: HarnessConfiguration, settings: OperatorChatSettings) {
  if (base.harness !== settings.harness) throw new Error("Select the matching harness defaults before applying chat settings.");
  if (settings.harness === "claude") {
    const configuration = ClaudeHarnessConfigurationSchema.parse({ ...base, accountId: settings.accountId, model: settings.model });
    if (!configuration.accountId) delete configuration.accountId;
    delete configuration.effort;
    if (settings.effort) configuration.effort = settings.effort;
    return configuration;
  }
  const configuration = SupportedHarnessConfigurationSchema.parse({
    ...base, accountId: settings.accountId, model: settings.model, reasoningEffort: settings.reasoningEffort,
    serviceTier: settings.serviceTier,
  });
  if (!configuration.accountId) delete configuration.accountId;
  return configuration;
}
export const OperatorChatSetupQuerySchema = z.object({
  conversationId: IdSchema.optional(),
  requestId: IdSchema.optional(),
  configurationVersionId: IdSchema.optional(),
  harness: AgentHarnessSchema.optional(),
  expectedDefaultsRevision: z.coerce.number().int().nonnegative().optional(),
}).strict().refine((value) => !value.requestId || Boolean(value.conversationId), "A request needs its conversation.");
export type OperatorChatSetupQuery = z.infer<typeof OperatorChatSetupQuerySchema>;
export const OperatorChatSetupSchema = z.object({
  routing: z.enum(["automatic", "fixed"]).optional(),
  harness: RecordedAgentHarnessSchema,
  status: z.enum(["configured", "setup_required"]),
  endpoint: z.string().url(),
  checkedAt: TimestampSchema,
  configurationVersionId: IdSchema.optional(),
  reason: z.string().optional(),
}).strict();
export type OperatorChatSetup = z.infer<typeof OperatorChatSetupSchema>;
export const OperatorActivityCursorSchema = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => value.length < 19 || value <= "9223372036854775807", "Invalid activity cursor");
export const OperatorActivitySchema = z.object({
  id: IdSchema,
  requestId: IdSchema,
  sequence: OperatorActivityCursorSchema,
  revision: z.number().int().nonnegative(),
  kind: z.enum(["thinking", "tool", "mcp", "web_search", "file_read", "file_write", "subagent"]),
  title: z.string().max(240),
  status: z.enum(["pending", "running", "completed", "failed", "canceled", "unknown"]),
  input: z.string().max(16000).optional(),
  output: z.string().max(24000).optional(),
  truncated: z.boolean().optional(),
}).strict();
export type OperatorActivity = z.infer<typeof OperatorActivitySchema>;
export const OperatorActivityPageSchema = z.object({
  activities: z.array(OperatorActivitySchema), nextCursor: OperatorActivityCursorSchema.nullable(),
}).strict();
export type OperatorActivityPage = z.infer<typeof OperatorActivityPageSchema>;
export const OperatorActivityQuerySchema = z.object({
  requestId: IdSchema.optional(),
  activityId: IdSchema.optional(),
  before: OperatorActivityCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type OperatorActivityQuery = z.infer<typeof OperatorActivityQuerySchema>;
export const OperatorConversationStateSchema = z.object({
  providerAccountBinding: AcceptedProviderAccountBindingSchema.optional(),
  activitySnapshot: ActivitySnapshotV1Schema.optional(),
  responseAvailability: NativeInteractionResponseAvailabilitySchema.optional(),
  qualificationKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),  conversation: ConversationSchema,
  settings: RecordedOperatorChatSettingsSchema.optional(),
  handoff: z.object({ parentConversationId: IdSchema, sourceHarness: z.enum(['codex', 'opencode', 'claude']),
    sourceMessageSequence: z.string().regex(/^[0-9]+$/), omittedMessages: z.number().int().nonnegative() }).strict().optional(),
  hasEarlierMessages: z.boolean().optional(),
  messages: z.array(MessageSchema),
  activities: z.array(OperatorActivitySchema).optional(),
  activityNextCursor: OperatorActivityCursorSchema.nullable().optional(),
  turnState: z.enum(["idle", "starting", "active", "canceling", "uncertain", "error"]),
  revision: z.number().int().nonnegative().default(0),
  activeRequestId: IdSchema.nullable().default(null),
  nativeSubmission: NativeMessageSubmissionSchema.optional(),
  pendingInteraction: PendingNativeInteractionSchema.optional(),
  responseDelivery: z.enum(["offered", "submitted", "uncertain"]).optional(),
  lastResult: ExecutionResultSchema.optional(),
  error: z.string().optional(),
}).strict();
export type OperatorConversationState = z.infer<typeof OperatorConversationStateSchema>;
/** Owner-scoped navigation state; never contains message or approval payloads. */
export const OperatorConversationSummarySchema = OperatorConversationStateSchema.pick({
  turnState: true, revision: true, activeRequestId: true,
}).extend({
  conversationId: IdSchema,
  title: z.string().optional(),
  needsAttention: z.boolean(),
  backgroundActivity: z.enum(['running', 'unknown']).nullable().optional(),
}).strict();
export type OperatorConversationSummary = z.infer<typeof OperatorConversationSummarySchema>;
export const OperatorConversationSummariesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(2147483646).optional(),
}).strict();
export const ListOperatorConversationSummariesResponseSchema = z.object({
  hasMore: z.boolean().optional(),
  attention: z.array(OperatorConversationSummarySchema).optional(),
  conversations: z.array(OperatorConversationSummarySchema),
}).strict();

export const CreateOperatorConversationRequestSchema = z.object({
  commandId: optionalCommandId(IdSchema),
  title: z.string().trim().min(1).optional(),
}).strict();
export const DeleteOperatorConversationResponseSchema = z.object({
  conversationId: IdSchema,
  // Historical command receipts retain their original response without a revision.
  revision: z.number().int().nonnegative().optional(),
}).strict();
export const OperatorConversationDeletionInputSchema = z.object({
  conversationId: IdSchema,
  commandId: optionalCommandId(IdSchema),
}).strict();
export const CreateOperatorConversationResponseSchema = z.object({ conversation: ConversationSchema }).strict();
export const ListOperatorConversationsResponseSchema = z.object({ conversations: z.array(ConversationSchema) }).strict();
export const GetOperatorConversationResponseSchema = OperatorConversationStateSchema;
export const SendOperatorMessageRequestSchema = z.object({
  requestId: IdSchema,
  intent: ChatDeliveryIntentSchema.optional(),
  expectedNativeTurnId: IdSchema.optional(),
  ...MessageAttachmentFields,
  content: z.string().trim().describe('Message text, up to 768 KiB as UTF-8 JSON including request metadata. Receipt-only recovery retains previously accepted input.'),
  sessionMode: z.enum(['regular', 'plan']).optional(),
  context: OperatorConversationContextSchema.optional(),
  settings: OperatorChatSettingsSchema.optional(),
  forkExpectedRevision: z.number().int().nonnegative().optional(),
  /** The pinned configuration observed before reserving this command. */
  configurationVersionId: IdSchema.optional(),
  /** Required for a new cross-harness admission; never consulted for a receipt replay. */
  defaultsRevision: z.number().int().nonnegative().optional(),
  /** Read an existing receipt without creating or relaunching native work. Not part of command identity. */
  recovery: z.literal("receipt").optional(),
}).strict().refine((value) => value.content.length > 0 || value.attachments.length > 0, {
  path: ["content"], message: "Message requires text or an attachment.",
}).superRefine((value, context) => {
  if (value.recovery !== 'receipt') refineChatMessageSize(value, context)
});
export const SendOperatorMessageResponseSchema = z.union([
  z.object({ state: OperatorConversationStateSchema, replayed: z.boolean() }).strict(),
  z.object({ state: OperatorConversationStateSchema.optional(), receipt: ChatDeliveryReceiptSchema, replayed: z.boolean() }).strict(),
]);
export const CancelOperatorTurnRequestSchema = z.object({ requestId: IdSchema, commandId: z.string().min(8).max(200).optional() }).strict();
export const RespondOperatorInteractionRequestSchema = z.object({
  commandId: z.string().min(8).max(200).optional(),
  requestId: IdSchema, nativeRequestId: IdSchema, optionId: IdSchema,
  response: z.json().optional(),
}).strict();
export type SendOperatorMessageRequest = Omit<z.infer<typeof SendOperatorMessageRequestSchema>, "attachments">
  & { attachments?: z.input<typeof MessageAttachmentFields.attachments> };
export type RespondOperatorInteractionRequest = z.infer<typeof RespondOperatorInteractionRequestSchema>;
export const CancelOperatorTurnResponseSchema = z.object({ state: OperatorConversationStateSchema }).strict();
export const OperatorConversationStreamEventSchema = z.object({
  id: z.number().int().nonnegative(),
  conversationId: IdSchema,
  type: z.enum(["snapshot", "delta", "message", "state", "error", "activity"]),
  data: z.record(z.string(), z.unknown()),
}).strict();
export type OperatorConversationStreamEvent = z.infer<typeof OperatorConversationStreamEventSchema>;

export const GetInteractionResponseSchema = z.object({
  interaction: DurableInteractionSchema,
  activity: InteractionActivityProjectionSchema.optional(),
  review: ReviewStatusSchema.optional(),
  /** Monitoring permission, independent of the interaction's assigned handler. */
  canRespond: z.boolean().optional(),
}).strict();
export const ListInteractionsRequestSchema = z.object({
  workspaceId: IdSchema.optional(), workflowId: IdSchema.optional(), status: InteractionStatusSchema.optional(),
  cursor: IdSchema.optional(), limit: z.number().int().min(1).max(100).default(50),
}).strict();
export const ListInteractionsResponseSchema = z.object({
  items: z.array(DurableInteractionSchema), nextCursor: IdSchema.nullable(),
  /** Authorized scope counts, independent of the current history page/status filter. */
  pendingCount: z.number().int().nonnegative().optional(),
  pendingByWorkflow: z.record(IdSchema, z.number().int().nonnegative()).optional(),
}).strict();
export const RespondToInteractionRequestSchema = z.object({
  interactionId: IdSchema, optionId: IdSchema, expectedRevision: z.number().int().nonnegative(),
  response: z.json().optional(),
}).strict();
export const RespondToInteractionResponseSchema = z.object({ interaction: DurableInteractionSchema, replayed: z.boolean() }).strict();

/** MCP summaries keep decisions visible; interaction_get retrieves omitted JSON in chunks. */
export const McpInteractionSummarySchema = z.object(DurableInteractionSchema.shape).pick({
  kind: true,
  continuationRunId: true,
  id: true, revision: true, workspaceId: true, workflowId: true, runId: true,
  executionId: true, harness: true, status: true, deliveryState: true, approval: true,
  responseOptions: true, selectedOptionId: true, selectedSemantic: true, decidedAt: true, deliveredAt: true,
}).extend({
  contentOmitted: z.literal(true),
  responseOptions: z.array(ApprovalResponseOptionSchema),
  responseOptionsComplete: z.boolean(),
  retrieval: z.object({ tool: z.literal('interaction_get'), interactionId: IdSchema }).strict(),
}).strict();
const McpInteractionSchema = z.union([DurableInteractionSchema, McpInteractionSummarySchema]);
export const AppInteractionGetInputSchema = z.object({
  interactionId: IdSchema, contentCursor: z.string().min(1).max(1000).optional(),
}).strict();
export const AppInteractionGetOutputSchema = z.object({
  interaction: McpInteractionSchema,
  activity: InteractionActivityProjectionSchema.optional(),
  content: z.object({
    format: z.literal('json'), text: z.string(), totalCharacters: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), nextCursor: z.string().nullable(),
  }).strict().optional(),
}).strict();
export const AppInteractionListOutputSchema = z.object({
  items: z.array(McpInteractionSchema), nextCursor: IdSchema.nullable(),
}).strict();
export const AppInteractionRespondOutputSchema = z.object({
  interaction: McpInteractionSchema, replayed: z.boolean(),
}).strict();

/** Deterministic cross-provider fixtures for contract consumers; exact native payloads stay server-side. */
export const CODEX_APPROVAL_OPTIONS_FIXTURE = ApprovalResponseOptionSchema.array().parse([
  { optionId: "codex-approve-once", semantic: "approve_once", label: "Approve once", persistence: "request", affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false },
  { optionId: "codex-allow-session", semantic: "allow_session", label: "Allow for this session", persistence: "session", scopeSummary: "Exact command and environment", affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false },
  { optionId: "codex-reject", semantic: "reject", label: "Reject", persistence: "request", affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false },
  { optionId: "codex-cancel", semantic: "cancel", label: "Cancel turn", persistence: "request", affectsOtherPendingRequests: false, interruptsCurrentTurn: true, mutatesPersistentPolicy: false },
]);
const FIXTURE_TIME = "2026-09-16T00:00:00.000Z";
export const NATIVE_INTERACTION_FIXTURES = {
  codex: DurableInteractionSchema.parse({
    id: "interaction-codex", revision: 0, workspaceId: "workspace-fixture", workflowId: "workflow-fixture",
    runId: "run-fixture", executionId: "execution-codex", requestingAgentId: "agent-coder", harness: "codex",
    providerVersion: "0.154.0", nativeSessionId: "codex-thread-fixture", nativeRequestId: "codex-request-fixture",
    nativeRequestType: "item/commandExecution/requestApproval", graphThreadId: "graph-thread-fixture",
    request: { command: ["pnpm", "test"] }, approval: { handler: "orchestrator", designatedOrchestratorAgentId: "agent-orchestrator" },
    responseOptions: CODEX_APPROVAL_OPTIONS_FIXTURE, status: "pending", deliveryState: "not_started",
    createdAt: FIXTURE_TIME, updatedAt: FIXTURE_TIME,
  }),
} as const;

export const ListVisibleResourcesRequestSchema = WorkspaceDetailsRequestSchema;
export type ListVisibleResourcesRequest = WorkspaceDetailsRequest;
export const ListVisibleResourcesResponseSchema = z
  .object({
    resources: z.array(ResourceSummarySchema),
    browserProfiles: z.array(BrowserProfileSummarySchema).optional(),
    runners: z.array(RunnerSummarySchema).optional(),
  })
  .strict();
export type ListVisibleResourcesResponse = z.infer<typeof ListVisibleResourcesResponseSchema>;

/** Scenario IDs are URL-safe and intentionally open-ended for additive Phase 1 scenarios. */
export const ScenarioIdSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "scenario id must be URL-safe");
export type ScenarioId = z.infer<typeof ScenarioIdSchema>;

/** The subset of URL search state that selects a Phase 1 scenario/resource. */
export const UrlSearchSelectionSchema = z
  .object({
    scenarioId: ScenarioIdSchema.optional(),
    workspaceId: IdSchema.optional(),
    agentId: IdSchema.optional(),
    workflowId: IdSchema.optional(),
    conversationId: IdSchema.optional(),
    interactionId: IdSchema.optional(),
  })
  .strict();
export const ScenarioSelectionSchema = UrlSearchSelectionSchema;

/** Linkable Approval Inbox presentation; this does not change API authorization or request status. */
const ApprovalInboxViewSchema = z.enum(["pending", "delivery", "history"]);
export type ApprovalInboxView = z.infer<typeof ApprovalInboxViewSchema>;
export const ApprovalInboxSearchSchema = UrlSearchSelectionSchema.extend({
  approvalView: ApprovalInboxViewSchema.optional().catch(undefined),
});

export * from "./runtimeIdentity.js";

export * from "./deviceIdentity.js";
export * from "./activity.js";
export * from "./activityFixtures.js";
export * from "./activityChanges.js";
export * from "./nodePlacement.js";
export * from "./harnessRegistry.js";
export * from "./sourceMaterialization.js";
export * from "./jobs.js";
export * from "./deviceApplication.js";
export * from "./remoteJobExecution.js";
export * from "./jobArtifacts.js";
export * from "./jobWorkflow.js";
export * from "./sourceAdmission.js";
export * from "./workspaceRootPolicies.js";
export * from "./workspaceBoundLocation.js";
export * from "./jobOutputTransfer.js";
export * from "./workflowArtifactTransfer.js";
export * from "./jobRuntime.js";

export * from "./resourceTelemetry.js";
export * from "./trustedDeviceConnection.js";

export * from './workflowArtifactDeclarations.js'

export * from './workerNativeOutput.js'
export * from './byteTransfer.js'
export * from './jobInputs.js'

export * from './deviceResources.js'

export * from './subagents.js';

export * from './buildComputers.js'
export * from './jobAdmission.js'
export * from './jobVerificationPolicy.js'
export * from './ci.js'
export * from './circleCredits.js'
export * from './ciHost.js'
export * from './runStatus.js'
export * from './jobVerification.js'
export * from './jobVerificationRuntime.js'
export * from './jobVerificationGate.js'

export * from './sessionControls.js'

export * from './sessionCommands.js'

export * from './worktreeSettings.js';
export * from './workspaceGit.js';
export * from './readObservation.js'
export * from './operationalFailures.js'

export * from './agentIdentity.js';
export * from './memoryBoards.js';
export * from './memoryBoardViews.js';
export * from './chatDelivery.js';
export * from './workflowChat.js';
export * from './browserProfiles.js';
export * from './browserSessions.js';
export * from './workflowHierarchy.js';
export * from './coordinationResult.js';
export { collaborationContractFixtures } from './collaborationFixtures.js';
export * from './workflowExecutionChat.js';
export { canonicalJson } from './canonicalJson.js';

export * from './hierarchyExecutionResult.js';

export * from './browserOperations.js';
export * from './browserTransport.js';
export * from './browserTargets.js';
