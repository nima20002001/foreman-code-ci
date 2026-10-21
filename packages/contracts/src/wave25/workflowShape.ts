import { NodeBrowserSettingsSchema } from '../browserProfiles.js'
import { WorkflowHierarchySchema } from '../workflowHierarchy.js'
import { WorkflowWorktreeSettingsSchema, AgentWorktreeSettingsSchema } from '../worktreeSettings.js'
import { z } from 'zod'
import { IdSchema, GraphIdSchema, TimestampSchema } from '../schemaPrimitives.js'
import { JobWorkflowNodeSchema } from '../jobWorkflow.js'
import { SavedNodePlacementSchema } from '../nodePlacement.js'
import { WorkflowArtifactInputsV1Schema, WorkflowArtifactOutputsV1Schema } from '../workflowArtifactDeclarations.js'
import { GraphqlToolOverrideSchema } from '../graphqlMcpTools.js'
import { ChoiceOutcomeSchema, ChoiceTargetSchema, WorkflowChoiceSchema } from './choice.js'
import { NodeSkillOverrideSchema, OutputSchemaSchema } from './outputContract.js'
export { ChoiceOutcomeSchema, ChoiceTargetSchema, WorkflowChoiceSchema } from './choice.js'
export type { WorkflowChoice } from './choice.js'

/** Leaf schemas: do not import the root, management or saved DTO entrypoints.
 * Both public management DTOs and the execution validators use these same
 * objects. There is no legacy parser, retagging, fallback or execution mode. */
export const EXECUTION_SEMANTICS_VERSION = 3 as const
export const ExecutionSemanticsVersionSchema = z.literal(EXECUTION_SEMANTICS_VERSION)
const CurrentExecutionSemanticsSchema = ExecutionSemanticsVersionSchema

export const ApprovalHandlerSchema = z.enum(["user", "orchestrator", "native"]);
export type ApprovalHandler = z.infer<typeof ApprovalHandlerSchema>;

/** Editable selection. Orchestrator designation may remain incomplete until executable save. */
export const WorkflowApprovalConfigurationSchema = z
  .object({
    handler: ApprovalHandlerSchema,
    designatedOrchestratorAgentId: IdSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.handler !== "orchestrator" && value.designatedOrchestratorAgentId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["designatedOrchestratorAgentId"], message: "only orchestrator handling may designate an Orchestrator" });
    }
  });
export type WorkflowApprovalConfiguration = z.infer<typeof WorkflowApprovalConfigurationSchema>;

/** Complete immutable assignment accepted into workflow and Run snapshots. */
export const AcceptedWorkflowApprovalConfigurationSchema = z
  .object({
    handler: ApprovalHandlerSchema,
    designatedOrchestratorAgentId: IdSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.handler === "orchestrator" && !value.designatedOrchestratorAgentId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["designatedOrchestratorAgentId"], message: "Choose a reviewing orchestrator.", params: { issueCode: "ORCHESTRATOR_REQUIRED" } });
    }
    if (value.handler !== "orchestrator" && value.designatedOrchestratorAgentId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["designatedOrchestratorAgentId"], message: "only orchestrator handling may designate an Orchestrator" });
    }
  });

const ExecutionConditionKindSchema = z.enum([
  "manual",
  "on_message",
  "on_event",
  "schedule",
]);

/** The condition that makes a workflow eligible to start. It is not a run outcome. */
export const ExecutionConditionSchema = z
  .object({
    kind: ExecutionConditionKindSchema,
    description: z.string().trim().min(1).optional(),
  })
  .strict();

export const DEFAULT_AGENT_ACTIVE_TIMEOUT_MS = 6 * 60 * 60 * 1000
export const MAX_AGENT_ACTIVE_TIMEOUT_MS = 2_147_483_647
export const AgentActiveTimeoutMsSchema = z.number().int().positive().max(MAX_AGENT_ACTIVE_TIMEOUT_MS)

export const WorkflowExecutionPolicySchema = z
  .object({
    maxParallelism: z.number().int().positive(),
    /** Global safety bound across first attempts and repeats. */
    maxNodeExecutions: z.number().int().positive(),
    /** Active time per Agent execution, excluding approval waits. Omit to use the server default. */
    agentActiveTimeoutMs: AgentActiveTimeoutMsSchema.optional(),
  })
  .strict();
export type WorkflowExecutionPolicy = z.infer<typeof WorkflowExecutionPolicySchema>;

/** A loop: re-activates an Agent node every everySeconds while its Run is active, after its first
 * finished execution, with prompt or the default Run check. Absent means off. Loops never route the
 * graph and stop with the Run; workflow schedules, which start Runs, are separate. */
export const AGENT_INTERVAL_MIN_SECONDS = 10
export const AGENT_INTERVAL_MAX_SECONDS = 24 * 60 * 60
export const AGENT_INTERVAL_PROMPT_MAX_LENGTH = 4000
const AgentIntervalSchema = z.object({
  everySeconds: z.number().int().min(AGENT_INTERVAL_MIN_SECONDS).max(AGENT_INTERVAL_MAX_SECONDS),
  /** What the Agent does on each loop. Omit for the default check of its Run. */
  prompt: z.string().trim().min(1).max(AGENT_INTERVAL_PROMPT_MAX_LENGTH).optional(),
}).strict()

const Handle = z.enum(['top', 'right', 'bottom', 'left']).nullable().optional()
const CurrentAgentWorkflowNodeFields = {
  kind: z.literal('agent').optional(),
  placement: SavedNodePlacementSchema.optional(),
  worktree: AgentWorktreeSettingsSchema.optional(),
  id: GraphIdSchema, agentId: GraphIdSchema,
  name: z.string().trim().min(1).optional(), label: z.string().trim().min(1).optional(),
  description: z.string().optional(), initialPrompt: z.string().trim().min(1).optional(),
  position: z.object({ x: z.number().finite(), y: z.number().finite(),
    manual: z.boolean().optional().describe('True for user or Operator placement; unmarked positions use hierarchy layout.'),
  }).strict().optional(),
  width: z.number().finite().positive().optional(), height: z.number().finite().positive().optional(),
  join: z.object({ mode: z.literal('all') }).strict().optional(), choice: WorkflowChoiceSchema.optional(),
  /** Changes the Agent's default Foreman Code MCP tools for this node only. */
  graphqlTools: GraphqlToolOverrideSchema.optional(),
  browser: NodeBrowserSettingsSchema.optional(),
  artifactOutputs: WorkflowArtifactOutputsV1Schema.optional(),
  interval: AgentIntervalSchema.optional(),
  /** Enforced deliverable schema; absent applies the default non-empty deliverable rule. */
  outputSchema: OutputSchemaSchema.optional(),
  /** Adds or removes skills from this Agent's assigned skills for this node only. */
  skills: NodeSkillOverrideSchema.optional(),
}
export const CurrentAgentWorkflowNodeSchema = z.object(CurrentAgentWorkflowNodeFields).strict().superRefine((node, context) => {
  if (!node.name && !node.label) context.addIssue({ code: 'custom', path: ['name'], message: 'a workflow node requires name or label' })
})
export const CurrentWorkflowNodeSchema = z.union([CurrentAgentWorkflowNodeSchema, JobWorkflowNodeSchema])
export const CurrentWorkflowRelationshipSchema = z.object({
  id: GraphIdSchema, source: GraphIdSchema, target: GraphIdSchema,
  sourceHandle: Handle, targetHandle: Handle, label: z.string().optional(), kind: z.enum(['execution', 'approval']),
  /** New handoff-policy work connection only. Missing means no connection cap. */
  maxWorkHandoffsPerRun: z.number().int().min(1).max(2147483647).optional(),
  /** A correlated return is always permitted; this controls independent new work. */
  workRequestDirection: z.enum(['source_to_target', 'both']).optional(),
  artifactInputs: WorkflowArtifactInputsV1Schema.optional(),
}).strict()
/** Incomplete authoring is allowed here; immutable executable validation below
 * requires a real entry, complete approval and enough execution budget. */
export const CurrentWorkflowDefinitionBaseSchema = z.object({
  hierarchy: WorkflowHierarchySchema.optional(),
  id: GraphIdSchema, workspaceId: GraphIdSchema, name: z.string().trim().min(1), description: z.string().optional(),
  executionSemanticsVersion: CurrentExecutionSemanticsSchema, entryNodeId: GraphIdSchema.nullable(),
  executionCondition: ExecutionConditionSchema, approval: WorkflowApprovalConfigurationSchema.optional(),
  requiredAgentCount: z.number().int().nonnegative().max(10000).optional(),
  nodes: z.array(CurrentWorkflowNodeSchema).max(1000), edges: z.array(CurrentWorkflowRelationshipSchema).max(8000),
  defaultWorktree: WorkflowWorktreeSettingsSchema.optional(),
  version: z.number().int().positive().optional(), executionPolicy: WorkflowExecutionPolicySchema.optional(),
  createdAt: TimestampSchema.optional(), updatedAt: TimestampSchema.optional(),
}).strict()

export const WorkflowRelationshipSchema = CurrentWorkflowRelationshipSchema
export type WorkflowRelationship = z.infer<typeof WorkflowRelationshipSchema>

/** Current execution semantics for every workflow. Repeat is optional; these
 * constants and validators are not runtime admission permission. */
export const REPEAT_CONTRACT_VERSION = 1 as const
export const REPEAT_EXECUTION_SEMANTICS_VERSION = 3 as const
const HANDOFF_CONTRACT_VERSION = 1 as const
export const WorkHandoffPolicyV1Schema = z.object({ contractVersion: z.literal(HANDOFF_CONTRACT_VERSION) }).strict()
const Ordinal = z.number().int().min(1).max(2147483647)
const Header = { contractVersion: z.literal(REPEAT_CONTRACT_VERSION) }

export const RepeatBlockV1Schema = z.object({
  id: GraphIdSchema,
  nodeIds: z.array(GraphIdSchema).min(1).max(1000),
  entryNodeId: GraphIdSchema,
  exitNodeId: GraphIdSchema,
  /** Includes the first occurrence; 1 allows no business repeat. No default. */
  maxOccurrences: Ordinal,
  repeatOutcome: ChoiceOutcomeSchema,
  earlyExitOutcome: ChoiceOutcomeSchema,
  /** The exit choice's repeatOutcome target, taken ONLY on limit exhaustion. */
  limitExit: ChoiceTargetSchema,
}).strict().superRefine((block, context) => {
  const fail = (message: string) => context.addIssue({ code: 'custom', message })
  if (new Set(block.nodeIds).size !== block.nodeIds.length) fail('REPEAT_DUPLICATE_MEMBER')
  if (!block.nodeIds.includes(block.entryNodeId) || !block.nodeIds.includes(block.exitNodeId)) fail('REPEAT_BOUNDARY_NOT_IN_SCOPE')
  if (block.repeatOutcome === block.earlyExitOutcome) fail('REPEAT_OUTCOMES_MUST_DIFFER')
})
export type RepeatBlockV1 = z.infer<typeof RepeatBlockV1Schema>

/** Context-free configured-repeat shape. Absent repeat is handled by the V3 family; an empty plan is not a workflow mode. */
export const RepeatPlanV1Schema = z.object({
  ...Header, blocks: z.array(RepeatBlockV1Schema).min(1).max(1000),
}).strict().superRefine(({ blocks }, context) => {
  const ids = new Set<string>(), members = new Set<string>()
  for (const [index, block] of blocks.entries()) {
    const fail = (message: string) => context.addIssue({ code: 'custom', path: ['blocks', index], message })
    if (ids.has(block.id)) fail('REPEAT_DUPLICATE_BLOCK')
    ids.add(block.id)
    for (const nodeId of block.nodeIds) {
      if (members.has(nodeId)) fail('REPEAT_OVERLAP_OR_NESTING_UNSUPPORTED')
      members.add(nodeId)
    }
  }
})
export type RepeatPlanV1 = z.infer<typeof RepeatPlanV1Schema>

/** One authoring definition for all current workflows. A missing repeat means
 * ordinary execution; a missing executionSemanticsVersion is never repaired. */
export const WorkflowDefinitionV3Schema = CurrentWorkflowDefinitionBaseSchema.extend({
  repeat: RepeatPlanV1Schema.optional(),
  handoffs: WorkHandoffPolicyV1Schema.optional(),
}).strict().superRefine((definition, context) => {
  if (definition.handoffs && definition.repeat) context.addIssue({ code: 'custom', path: ['handoffs'], message: 'HANDOFF_REPEAT_POLICY_CONFLICT' })
  const repeatMembers = new Set(definition.repeat?.blocks.flatMap(block => block.nodeIds) ?? [])
  for (const [index, node] of definition.nodes.entries()) {
    if (node.kind !== 'job' && node.interval && repeatMembers.has(node.id)) {
      context.addIssue({ code: 'custom', path: ['nodes', index, 'interval'], message: 'AGENT_INTERVAL_IN_REPEAT_BLOCK' })
    }
    // A check replies in prose; it never publishes the node's declared artifact outputs.
    if (node.kind !== 'job' && node.interval && node.artifactOutputs) {
      context.addIssue({ code: 'custom', path: ['nodes', index, 'interval'], message: 'AGENT_INTERVAL_WITH_ARTIFACT_OUTPUTS' })
    }
  }
  const pairs = new Set<string>()
  for (const [index, edge] of definition.edges.entries()) {
    const configured = edge.maxWorkHandoffsPerRun !== undefined || edge.workRequestDirection !== undefined
    if (configured && (!definition.handoffs || edge.kind !== 'execution')) {
      context.addIssue({ code: 'custom', path: ['edges', index], message: 'HANDOFF_CONNECTION_POLICY_REQUIRED' })
    }
    if (!definition.handoffs || edge.kind !== 'execution') continue
    // Hierarchy routing is directional and explicit. Opposite retained forward
    // routes may coexist, but two connections must never authorize the same request.
    const pair = definition.hierarchy ? [edge.source, edge.target].join('\u0000')
      : [edge.source, edge.target].sort().join('\u0000')
    const permissions = definition.hierarchy && edge.workRequestDirection === 'both'
      ? [pair, [edge.target, edge.source].join('\u0000')] : [pair]
    if (permissions.some(permission => pairs.has(permission))) context.addIssue({ code: 'custom', path: ['edges', index], message: 'HANDOFF_DUPLICATE_CONNECTION' })
    for (const permission of permissions) pairs.add(permission)
  }
})
export type WorkflowDefinitionV3 = z.infer<typeof WorkflowDefinitionV3Schema>
