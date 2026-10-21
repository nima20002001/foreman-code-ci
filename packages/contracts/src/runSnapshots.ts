import { z } from "zod";
import { GraphIdSchema, IdSchema, TimestampSchema } from "./schemaPrimitives.js";
import { CurrentWorkflowRelationshipSchema } from "./wave25/workflowShape.js";
import type { RunExecutionState, RunOutcome, WorkflowRunSummary } from "./index.js";
import { ExecutionQueueEntrySchema } from './executionQueue.js';
import { AcceptedProviderAccountBindingSchema } from './providerAccounts.js';
import { ActivitySnapshotV1Schema } from './activity.js';

const Workflow = { workspaceId: IdSchema, workflowId: IdSchema };
const Run = { ...Workflow, runId: IdSchema };
const Page = {
  cursor: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(50),
};

/** Dropdown-only projection; do not shadow the root RunSummarySchema or replace stored Run facts. */
export const RunDropdownStatusSchema = z.enum([
  "queued", "running", "waiting", "interrupted", "succeeded", "failed", "canceled",
]);
export type RunDropdownStatus = z.infer<typeof RunDropdownStatusSchema>;
export const RunDropdownTriggerSchema = z.enum(["manual", "schedule"]);
export type RunDropdownTrigger = z.infer<typeof RunDropdownTriggerSchema>;
export const RunDropdownSummarySchema = z.object({
  runId: IdSchema,
  /** Display only, never a lookup or chat identity; collisions are allowed. */
  shortId: z.string().trim().min(1).max(32),
  /** Required null when the admitted Run has not started; never substitute a current timestamp. */
  startedAt: TimestampSchema.nullable(),
  status: RunDropdownStatusSchema,
  trigger: RunDropdownTriggerSchema,
}).strict();
export type RunDropdownSummary = z.infer<typeof RunDropdownSummarySchema>;
export const RunDropdownListInputSchema = z.object({ ...Workflow, ...Page }).strict();
/** Newest admission first; opaque cursor includes the stable Run-id tie-breaker. */
export const RunDropdownPageSchema = z.object({
  items: z.array(RunDropdownSummarySchema).max(100),
  pageInfo: z.object({ nextCursor: z.string().trim().min(1).nullable() }).strict(),
}).strict();
export type RunDropdownListInput = z.infer<typeof RunDropdownListInputSchema>;
export type RunDropdownPage = z.infer<typeof RunDropdownPageSchema>;

export function runDropdownStatus(run: { executionState: RunExecutionState; outcome: RunOutcome }): RunDropdownStatus {
  // In particular, interrupted never implies a successful or failed task outcome.
  if (run.executionState !== "completed") return run.executionState;
  if (run.outcome === "pending") throw new RangeError("A completed Run must have a terminal outcome");
  return run.outcome;
}

/** Terminal Run facts cannot regress when independently refreshed projections arrive out of order. */
export function preferRunSummary<T extends Pick<WorkflowRunSummary, 'id' | 'executionState' | 'outcome' | 'startedAt' | 'finishedAt'>>(
  workspace: WorkflowRunSummary | undefined, listed: T, workspaceReadAt: number, listReadAt: number,
): WorkflowRunSummary | T {
  if (!workspace) return listed
  if (workspace.executionState === 'completed' && listed.executionState !== 'completed') return workspace
  if (listed.executionState === 'completed' && workspace.executionState !== 'completed') return listed
  if (workspace.startedAt && !listed.startedAt) return workspace
  if (listed.startedAt && !workspace.startedAt) return listed
  return workspaceReadAt > listReadAt ? workspace : listed
}

/** Reconcile by identity before counting or choosing an automatically displayed Run. */
export function activeRunCandidates(workspace: readonly WorkflowRunSummary[], listed: readonly RunDropdownSummary[]) {
  const active = new Set(['queued', 'running', 'waiting', 'interrupted'])
  const summaries = new Map(workspace.map(run => [run.id, run]))
  const candidates = new Map<string, Pick<WorkflowRunSummary, 'id' | 'startedAt'>>()
  for (const run of summaries.values()) {
    if (active.has(run.executionState) || run.cleanupPending) candidates.set(run.id, run)
  }
  for (const run of listed) {
    const summary = summaries.get(run.runId)
    if (!active.has(run.status)) {
      if (!(summary?.executionState === 'completed' && summary.cleanupPending)) candidates.delete(run.runId)
    } else if (summary?.executionState !== 'completed') {
      candidates.set(run.runId, { id: run.runId, ...(run.startedAt ? { startedAt: run.startedAt } : {}) })
    }
  }
  return [...candidates.values()]
}

const AgentRunBoardNodeSnapshotSchema = z.object({
  kind:z.literal("agent").optional(),
  id: GraphIdSchema,
  name: z.string().min(1).refine((value) => value.trim().length > 0, "A snapshot node requires a name"),
  agentId: GraphIdSchema,
  agentConfigurationVersionId: IdSchema,
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().readonly(),
  size: z.object({ width: z.number().finite().positive(), height: z.number().finite().positive() }).strict().readonly(),
}).strict().readonly();
const JobRunBoardNodeSnapshotSchema=z.object({kind:z.literal('job'),id:GraphIdSchema,name:z.string().min(1),
  jobDefinitionId:GraphIdSchema,jobDefinitionRevision:z.number().int().positive(),jobDefinitionVersionId:IdSchema,
  position:AgentRunBoardNodeSnapshotSchema.unwrap().shape.position,size:AgentRunBoardNodeSnapshotSchema.unwrap().shape.size,
}).strict().readonly()
export const RunBoardNodeSnapshotSchema=z.union([AgentRunBoardNodeSnapshotSchema,JobRunBoardNodeSnapshotSchema])
export type RunBoardNodeSnapshot = z.infer<typeof RunBoardNodeSnapshotSchema>;
/** Reuse the current edge shape, including handles, labels and execution/approval semantics. */
const RunBoardEdgeSnapshotSchema = CurrentWorkflowRelationshipSchema.readonly();
export type RunBoardEdgeSnapshot = z.infer<typeof RunBoardEdgeSnapshotSchema>;

const AvailableSnapshot = z.object({
  providerAccountBindings: z.record(z.string(), AcceptedProviderAccountBindingSchema).optional(),
  ...Run, kind: z.literal("available"), workflowVersionId: IdSchema,
  /** The admission transaction's timestamp, not a later history-read timestamp. */
  capturedAt: TimestampSchema,
  nodes: z.array(RunBoardNodeSnapshotSchema).max(1_000).readonly(),
  edges: z.array(RunBoardEdgeSnapshotSchema).max(8_000).readonly(),
}).strict().superRefine((snapshot, context) => {
  const nodes = new Set<string>();
  for (const [index, node] of snapshot.nodes.entries()) {
    if (nodes.has(node.id)) context.addIssue({ code: "custom", path: ["nodes", index, "id"], message: "Duplicate node id" });
    nodes.add(node.id);
  }
  const edges = new Set<string>();
  for (const [index, edge] of snapshot.edges.entries()) {
    if (edges.has(edge.id)) context.addIssue({ code: "custom", path: ["edges", index, "id"], message: "Duplicate edge id" });
    edges.add(edge.id);
    for (const endpoint of ["source", "target"] as const) {
      if (!nodes.has(edge[endpoint])) context.addIssue({ code: "custom", path: ["edges", index, endpoint],
        message: "An edge must reference a node in this snapshot" });
    }
  }
});
/** No mutable Agent/configuration, prompts, environment, credential handles, or arbitrary metadata.
 * Parsing creates a deeply readonly/frozen projection. Persistence must capture it exactly once at
 * admission; a history reader must never reconstruct it from today's workflow or Agent records. */
export const RunBoardSnapshotSchema = z.discriminatedUnion("kind", [
  AvailableSnapshot,
  z.object({ ...Run, kind: z.literal("unavailable"), reason: z.literal("legacy_run") }).strict(),
]).readonly();
export type RunBoardSnapshot = z.infer<typeof RunBoardSnapshotSchema>;
export const RunBoardSnapshotGetInputSchema = z.object({ ...Run }).strict();
/** Live state of one Agent node's interval checks in this Run. nextCheckAt is null while a check or the
 * node's graph work is running, before its first finished execution, and once the Run is not running. */
const RunIntervalCheckSchema = z.object({
  nodeId: GraphIdSchema, everySeconds: z.number().int().positive(), checks: z.number().int().nonnegative(),
  running: z.boolean(), nextCheckAt: TimestampSchema.nullable(),
}).strict();
export type RunIntervalCheck = z.infer<typeof RunIntervalCheckSchema>;
export const RunBoardSnapshotGetResultSchema = z.object({ snapshot: RunBoardSnapshotSchema,
  activitySnapshot: ActivitySnapshotV1Schema.optional(),
  /** Live waits in the owning engine, separate from the saved Board facts. */
  executionQueue: z.array(ExecutionQueueEntrySchema).optional(),
  /** Present when the pinned version has Agent nodes with interval checks. */
  intervalChecks: z.array(RunIntervalCheckSchema).max(1_000).optional() }).strict().superRefine((result, context) => {
  const activity = result.activitySnapshot;
  if (!activity) return;
  const saved = result.snapshot;
  if (saved.kind !== 'available' || activity.scope.kind !== 'workflow_run'
    || activity.scope.workspaceId !== saved.workspaceId || activity.scope.workflowId !== saved.workflowId
    || activity.scope.runId !== saved.runId || activity.scope.workflowVersionId !== saved.workflowVersionId) {
    context.addIssue({ code: 'custom', path: ['activitySnapshot'], message: 'ACTIVITY_SNAPSHOT_SCOPE_CONFLICT' });
  }
});
export type RunBoardSnapshotGetInput = z.infer<typeof RunBoardSnapshotGetInputSchema>;
export type RunBoardSnapshotGetResult = z.infer<typeof RunBoardSnapshotGetResultSchema>;

/** Every component is required. A workflow/node or short Run id alone is not a chat identity.
 * Missing execution/conversation means no resolved chat key, not a fallback to a live conversation.
 * This is a scoped selection/cache identity, never an authorization grant. */
export const SelectedRunChatKeySchema = z.object({
  ...Run, workflowNodeId: GraphIdSchema, agentId: GraphIdSchema, executionId: IdSchema, conversationId: IdSchema,
}).strict().readonly();
