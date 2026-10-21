import { optionalCommandId } from '../management/commands.js'
import { WorkflowWorktreeSettingsSchema } from '../worktreeSettings.js'
import { z } from 'zod'
import { ApprovalHandlerSchema,
  DEFAULT_AGENT_ACTIVE_TIMEOUT_MS, MAX_AGENT_ACTIVE_TIMEOUT_MS,
  AGENT_INTERVAL_MIN_SECONDS, AGENT_INTERVAL_MAX_SECONDS,
  AGENT_INTERVAL_PROMPT_MAX_LENGTH } from './workflowShape.js'
import { OUTPUT_REFERENCE_KEYWORD, OUTPUT_REFERENCE_KINDS, OUTPUT_SCHEMA_MAX_BYTES } from './outputContract.js'
const OUTPUT_DEFAULT_RULE = 'plain final answer not blank; handoff or repeat-exit latestDeliverable not null; choice or artifactOutputs data checked only against a declared schema' as const
const OUTPUT_NATIVE_STRUCTURED = 'Codex turn outputSchema for plain-answer nodes whose schema is strict (object root, additionalProperties false and every property required); otherwise validation and repair only' as const
import { CommandIdSchema, ExpectedRevisionSchema, WorkflowCreateInputSchema, ManagedAgentSchema } from '../management/index.js'
import { GraphIdSchema } from './graphPrimitives.js'
import { WorkflowDefinitionV3Schema, WorkflowVersionV3Schema } from './saved.js'
import { sameExecutableWorkflow } from './meaningfulEdit.js'

// Creation supplies identity, metadata and the workflow default worktree.
const InitialWorkflowGraphSchema = z.object(WorkflowDefinitionV3Schema.shape).omit({
  id: true, workspaceId: true, name: true, description: true, defaultWorktree: true,
  version: true, createdAt: true, updatedAt: true,
}).strict()

/** An initial save shares the creation transaction; invalid graphs leave no workflow. */
export const CurrentWorkflowCreateInputSchema = WorkflowCreateInputSchema.extend({
  executionSemanticsVersion: z.literal(3).optional(),
  defaultWorktree: WorkflowWorktreeSettingsSchema.nullable().optional(),
  initialSave: z.object({
    graph: InitialWorkflowGraphSchema,
    expectedAgentConfigurationVersionIds: z.record(GraphIdSchema, GraphIdSchema),
  }).strict().optional(),
}).strict()
export type CurrentWorkflowCreateInput = z.infer<typeof CurrentWorkflowCreateInputSchema>

/** One complete authored definition, not a complexity-selected mode, patch,
 * admission permit or caller-supplied WorkflowVersion. Shared by HTTP/MCP/Board.
 * Configurations are references to immutable Agent rows; saving
 * this graph never edits a shared Agent or changes an accepted Run. */
export const CurrentWorkflowValidateInputSchema = z.object({
  workspaceId: GraphIdSchema, workflowId: GraphIdSchema,
  executionSemanticsVersion: z.literal(3),
  expectedRevision: ExpectedRevisionSchema,
  expectedWorkflowVersionId: GraphIdSchema.nullable(),
  expectedAgentConfigurationVersionIds: z.record(GraphIdSchema, GraphIdSchema),
  graph: WorkflowDefinitionV3Schema,
}).strict()
export const CurrentWorkflowSaveInputSchema = CurrentWorkflowValidateInputSchema.extend({
  commandId: optionalCommandId(CommandIdSchema),
}).strict()
export type CurrentWorkflowSaveInput = z.infer<typeof CurrentWorkflowSaveInputSchema>
export type CurrentWorkflowValidateInput = z.infer<typeof CurrentWorkflowValidateInputSchema>
export const CurrentWorkflowSavedSchema = z.object({
  workspaceId: GraphIdSchema, workflowId: GraphIdSchema, revision: ExpectedRevisionSchema,
  currentVersionId: GraphIdSchema, version: WorkflowVersionV3Schema,
  presentation: WorkflowDefinitionV3Schema.optional(),
  agents: z.array(ManagedAgentSchema).optional(),
}).strict().superRefine((value, context) => {
  if (value.workspaceId !== value.version.workspaceId || value.workflowId !== value.version.workflowId
    || value.currentVersionId !== value.version.id) context.addIssue({ code: 'custom', message: 'WORKFLOW_SAVED_PIN_MISMATCH' })
  const presentation = value.presentation
  if (presentation && (presentation.id !== value.workflowId || presentation.workspaceId !== value.workspaceId
    || presentation.version !== value.version.version || presentation.createdAt !== value.version.definition.createdAt
    || !sameExecutableWorkflow({ ...presentation, name: value.version.definition.name,
      description: value.version.definition.description }, value.version.definition))) {
    context.addIssue({ code: 'custom', message: 'WORKFLOW_SAVED_PRESENTATION_MISMATCH' })
  }
})
export const CurrentWorkflowSaveResultSchema = z.object({ value: CurrentWorkflowSavedSchema, replayed: z.boolean() }).strict()
export const CurrentWorkflowReadInputSchema = z.object({
  workspaceId: GraphIdSchema, workflowId: GraphIdSchema,
  // Omit for the current saved version; supply for exact immutable history.
  workflowVersionId: GraphIdSchema.optional(),
}).strict()
export const CurrentWorkflowValidationSchema = z.object({
  valid: z.literal(true), executionSemanticsVersion: z.literal(3),
  expectedRevision: ExpectedRevisionSchema, expectedWorkflowVersionId: GraphIdSchema.nullable(),
  expectedAgentConfigurationVersionIds: z.record(GraphIdSchema, GraphIdSchema),
  // Validation is neither persistence nor native/Stop qualification.
  runtimeAdmission: z.boolean(), stopAvailable: z.boolean(),
}).strict()
export const CurrentWorkflowReadResultSchema = z.object({
  workspaceId: GraphIdSchema, workflowId: GraphIdSchema, revision: ExpectedRevisionSchema,
  currentVersionId: GraphIdSchema, version: WorkflowVersionV3Schema,
}).strict().superRefine((value, context) => {
  if (value.workspaceId !== value.version.workspaceId || value.workflowId !== value.version.workflowId) {
    context.addIssue({ code: 'custom', message: 'WORKFLOW_VERSION_PIN_MISMATCH' })
  }
})
export const CURRENT_WORKFLOW_ROUTES = Object.freeze({
  capabilities: '/api/management/workflows/capabilities/v3',
  saved: '/api/management/workspaces/:workspaceId/workflows/:workflowId/definition',
  validate: '/api/management/workspaces/:workspaceId/workflows/:workflowId/definition/validate',
  edits: '/api/management/workspaces/:workspaceId/workflows/:workflowId/definition/edits',
})
export const CURRENT_WORKFLOW_TOOLS = Object.freeze({
  capabilities: 'workflow_authoring_capabilities_v3',
  saved: 'workflow_saved_get_v3', validate: 'workflow_validate_v3', save: 'workflow_save_v3',
  edits: 'workflow_edit_v3', editRead: 'workflow_edits_get_v3',
})
export const CurrentWorkflowCapabilitiesSchema = z.object({
  executionSemanticsVersion: z.literal(3), repeatOptional: z.literal(true),
  agentActiveTimeBudget: z.object({
    defaultMs: z.number().int().positive(), maximumMs: z.literal(MAX_AGENT_ACTIVE_TIMEOUT_MS),
    perExecution: z.literal(true), approvalWaitExcluded: z.literal(true),
  }).strict(),
  agentInterval: z.object({ field: z.literal('node.interval.everySeconds'),
    promptField: z.literal('node.interval.prompt'), promptMaxLength: z.literal(AGENT_INTERVAL_PROMPT_MAX_LENGTH),
    minimumSeconds: z.literal(AGENT_INTERVAL_MIN_SECONDS), maximumSeconds: z.literal(AGENT_INTERVAL_MAX_SECONDS),
    maximumChecksPerRun: z.null(), defaultEnabled: z.literal(false), routesGraph: z.literal(false), runStatusTool: z.literal('run_status_get'),
    requires: z.literal('approval handler native, or a Codex Agent with approvalPolicy never; no artifactOutputs') }).strict(),
  agentOutputSchema: z.object({ field: z.literal('node.outputSchema'), dialect: z.literal('json-schema-2020-12'),
    maximumBytes: z.literal(OUTPUT_SCHEMA_MAX_BYTES), referenceKeyword: z.literal(OUTPUT_REFERENCE_KEYWORD),
    referenceKinds: z.array(z.enum(OUTPUT_REFERENCE_KINDS)), defaultRule: z.literal(OUTPUT_DEFAULT_RULE),
    repairTurns: z.literal(2), failureCodes: z.tuple([z.literal('OUTPUT_SCHEMA_MISMATCH'), z.literal('OUTPUT_REFERENCE_UNKNOWN')]),
    nativeStructuredOutput: z.literal(OUTPUT_NATIVE_STRUCTURED) }).strict(),
  agentSkills: z.object({ field: z.literal('node.skills'), add: z.literal('exact {skillId, version} workspace skill references'),
    remove: z.literal('skill IDs the Agent assigns') }).strict(),
  approvalHandlers: z.array(ApprovalHandlerSchema),
  forms: z.tuple([z.literal('sequential'), z.literal('parallel_all_required'), z.literal('conditional'),
    z.literal('approval'), z.literal('bounded_repeat')]),
  worktrees: z.object({ workflowDefault: z.literal(true), agentBranchOverride: z.literal(true),
    sharedPrefixComputer: z.literal('one'),
    rootOverride: z.literal('node.placement'), creationOptOut: z.literal(true),
    immutableSource: z.literal(true), uniqueExecutionBranch: z.literal(true),
    requiredSelectionReads: z.tuple([z.literal('sources:read'), z.literal('source_roots:read'),
      z.literal('workspace_locations:read')]) }).strict(),
  savedAuthoring: z.literal(true), persistedReadback: z.literal(true),
  nodeGeometry: z.object({ manualPositionField: z.literal('node.position.manual'),
    automaticLayout: z.literal('hierarchy'), operatorPositionsManual: z.literal(true) }).strict(),
  runtimeAdmission: z.boolean(), stopAvailable: z.boolean(), meaningfulEdit: z.boolean(),
  editIntents: z.object({ stage: z.literal(true), read: z.literal(true), discard: z.literal(true),
    publishWhenSettled: z.literal(true), stopUnsettled: z.boolean(), stagedAgents: z.literal(true),
    presentationOnly: z.literal(true) }).strict(),
  reasons: z.array(z.enum(['NATIVE_START_NOT_READY', 'NATIVE_STOP_CLEANUP_NOT_READY'])).max(2),
  repeatLimits: z.object({ nesting: z.literal(false), arbitraryCycles: z.literal(false),
    minimumOccurrences: z.literal(1), maximumOccurrences: z.literal(2147483647),
    explicitLimitExit: z.literal(true), executionBudgetAlsoApplies: z.literal(true) }).strict(),
  tools: z.object({ capabilities: z.literal(CURRENT_WORKFLOW_TOOLS.capabilities),
    saved: z.literal(CURRENT_WORKFLOW_TOOLS.saved), validate: z.literal(CURRENT_WORKFLOW_TOOLS.validate),
    save: z.literal(CURRENT_WORKFLOW_TOOLS.save), edits: z.literal(CURRENT_WORKFLOW_TOOLS.edits),
    editRead: z.literal(CURRENT_WORKFLOW_TOOLS.editRead) }).strict(),
}).strict().superRefine((value, context) => {
  if (value.meaningfulEdit !== value.stopAvailable || value.editIntents.stopUnsettled !== value.stopAvailable
    || new Set(value.reasons).size !== value.reasons.length
    || value.reasons.includes('NATIVE_START_NOT_READY') === value.runtimeAdmission
    || value.reasons.includes('NATIVE_STOP_CLEANUP_NOT_READY') === value.stopAvailable) {
    context.addIssue({ code: 'custom', message: 'CURRENT_WORKFLOW_CAPABILITY_CONFLICT' })
  }
})
export const CURRENT_WORKFLOW_CAPABILITIES = CurrentWorkflowCapabilitiesSchema.parse({
  executionSemanticsVersion: 3, repeatOptional: true,
  agentActiveTimeBudget: { defaultMs: DEFAULT_AGENT_ACTIVE_TIMEOUT_MS, maximumMs: MAX_AGENT_ACTIVE_TIMEOUT_MS,
    perExecution: true, approvalWaitExcluded: true },
  agentInterval: { field: 'node.interval.everySeconds', promptField: 'node.interval.prompt',
    promptMaxLength: AGENT_INTERVAL_PROMPT_MAX_LENGTH, minimumSeconds: AGENT_INTERVAL_MIN_SECONDS,
    maximumSeconds: AGENT_INTERVAL_MAX_SECONDS, maximumChecksPerRun: null, defaultEnabled: false, routesGraph: false, runStatusTool: 'run_status_get',
    requires: 'approval handler native, or a Codex Agent with approvalPolicy never; no artifactOutputs' },
  agentOutputSchema: { field: 'node.outputSchema', dialect: 'json-schema-2020-12', maximumBytes: OUTPUT_SCHEMA_MAX_BYTES,
    referenceKeyword: OUTPUT_REFERENCE_KEYWORD, referenceKinds: [...OUTPUT_REFERENCE_KINDS], defaultRule: OUTPUT_DEFAULT_RULE,
    repairTurns: 2, failureCodes: ['OUTPUT_SCHEMA_MISMATCH', 'OUTPUT_REFERENCE_UNKNOWN'], nativeStructuredOutput: OUTPUT_NATIVE_STRUCTURED },
  agentSkills: { field: 'node.skills', add: 'exact {skillId, version} workspace skill references', remove: 'skill IDs the Agent assigns' },
  approvalHandlers: ApprovalHandlerSchema.options,
  forms: ['sequential', 'parallel_all_required', 'conditional', 'approval', 'bounded_repeat'],
  worktrees: { workflowDefault: true, agentBranchOverride: true, rootOverride: 'node.placement',
    sharedPrefixComputer: 'one',
    creationOptOut: true, immutableSource: true, uniqueExecutionBranch: true,
    requiredSelectionReads: ['sources:read', 'source_roots:read', 'workspace_locations:read'] },
  savedAuthoring: true, persistedReadback: true, runtimeAdmission: false, stopAvailable: false, meaningfulEdit: false,
  nodeGeometry: { manualPositionField: 'node.position.manual', automaticLayout: 'hierarchy', operatorPositionsManual: true },
  editIntents: { stage: true, read: true, discard: true, publishWhenSettled: true, stopUnsettled: false,
    stagedAgents: true, presentationOnly: true },
  reasons: ['NATIVE_START_NOT_READY', 'NATIVE_STOP_CLEANUP_NOT_READY'],
  repeatLimits: { nesting: false, arbitraryCycles: false, minimumOccurrences: 1,
    maximumOccurrences: 2147483647, explicitLimitExit: true, executionBudgetAlsoApplies: true },
  tools: CURRENT_WORKFLOW_TOOLS,
})
