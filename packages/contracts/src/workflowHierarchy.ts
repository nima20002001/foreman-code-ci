import { z } from 'zod';
import { IdSchema, GraphIdSchema, TimestampSchema } from './schemaPrimitives.js';
import { AgentIdentitySchema, ExecutionRefSchema, CommandOptionsSchema } from './agentIdentity.js';

export const WorkflowHierarchySchema = z.object({
  version: z.literal(1), masterNodeId: GraphIdSchema,
  parents: z.array(z.object({
    workflowNodeId: GraphIdSchema, parentNodeId: GraphIdSchema,
  }).strict()),
}).strict().superRefine((hierarchy, context) => {
  const parents = new Map<string, string>();
  for (const [index, entry] of hierarchy.parents.entries()) {
    if (parents.has(entry.workflowNodeId) || entry.workflowNodeId === hierarchy.masterNodeId
      || entry.workflowNodeId === entry.parentNodeId) {
      context.addIssue({ code: 'custom', path: ['parents', index], message: 'Each non-Master member has one distinct parent.' });
    }
    parents.set(entry.workflowNodeId, entry.parentNodeId);
  }
  for (const nodeId of parents.keys()) {
    const visited = new Set<string>();
    let current: string | undefined = nodeId;
    while (current !== undefined) {
      if (visited.has(current)) {
        context.addIssue({ code: 'custom', path: ['parents'], message: 'Hierarchy cannot contain a cycle.' });
        break;
      }
      visited.add(current);
      current = parents.get(current);
    }
  }
});
export const DelegateRoutingSchema = z.object({
  kind: z.literal('delegate'),
  requests: z.array(z.object({
    outcome: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
    data: z.json(),
  }).strict()).min(1),
}).strict().refine((routing) => new Set(routing.requests.map((request) => request.outcome)).size === routing.requests.length, {
  path: ['requests'], message: 'Delegation outcomes must be unique.',
});
export const HierarchyReportSchema = z.object({
  id: IdSchema, agent: AgentIdentitySchema, execution: ExecutionRefSchema,
  parentNodeId: GraphIdSchema, parentRequestId: IdSchema,
  state: z.enum(['started','working','blocked','returned','failed','canceled']),
  summary: z.string().max(600), cardIds: z.array(IdSchema),
  sourceEventKey: z.string(), updatedAt: TimestampSchema,
}).strict();

export type WorkflowHierarchy = z.infer<typeof WorkflowHierarchySchema>;
export type DelegateRouting = z.infer<typeof DelegateRoutingSchema>;
export type HierarchyReport = z.infer<typeof HierarchyReportSchema>;

/** Reporting is saved metadata; only the matching directed execution route carries its label. */
export function isHierarchyReportingRoute(hierarchy: WorkflowHierarchy | undefined,
  relationship: { kind: 'execution' | 'approval'; source: string; target: string }): boolean {
  return relationship.kind === 'execution' && !!hierarchy?.parents.some(member =>
    member.parentNodeId === relationship.source && member.workflowNodeId === relationship.target);
}

/** These unchanged routing/data leaves are also consumed by the historical handoff parser. */
export const WorkHandoffRoutingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('request'), outcome: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/) }).strict(),
  z.object({ kind: z.literal('return'),
    requestId: GraphIdSchema.optional().describe('May be omitted for a single open received request; required when several are open. A supplied ID must match an open received request.'),
    outcome: z.enum(['accepted', 'needs_changes']) }).strict(),
  z.object({ kind: z.literal('finish'), outcome: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/).optional() }).strict(),
]);
export const WorkHandoffDataSchema = z.object({ latestDeliverable: z.json(), remainingFindings: z.array(z.json()).max(1000) }).strict();

/** Caller supplies the exact saved graph-node identities; native subagents are not graph nodes. */
export const WorkflowHierarchyContextSchema = z.object({
  hierarchy: WorkflowHierarchySchema, workspaceId: IdSchema, workflowId: IdSchema,
  entryNodeId: GraphIdSchema, nodes: z.array(AgentIdentitySchema).min(1),
}).strict().superRefine(({ hierarchy, workspaceId, workflowId, entryNodeId, nodes }, context) => {
  const fail = (message: string) => context.addIssue({ code: 'custom', message });
  const members = new Map(nodes.map((node) => [node.workflowNodeId, node]));
  const parents = new Map(hierarchy.parents.map((entry) => [entry.workflowNodeId, entry.parentNodeId]));
  if (members.size !== nodes.length) fail('Hierarchy graph members must be unique.');
  if (nodes.some((node) => node.workspaceId !== workspaceId || node.workflowId !== workflowId)) fail('Hierarchy members must share the saved workflow scope.');
  if (entryNodeId !== hierarchy.masterNodeId || members.get(hierarchy.masterNodeId)?.productRole !== 'master'
    || nodes.filter((node) => node.productRole === 'master').length !== 1) fail('Hierarchy needs exactly one Master at its entry.');
  if (parents.size !== nodes.length - 1) fail('Every non-Master graph member needs one parent.');
  for (const [nodeId, parentId] of parents) {
    const node = members.get(nodeId), parent = members.get(parentId);
    if (!node || !parent) fail('Hierarchy parents must reference saved graph members.');
    else if (node.productRole === 'orchestrator' ? parentId !== hierarchy.masterNodeId
      : node.productRole !== 'coder' || parent.productRole !== 'orchestrator') fail('Orchestrators report to Master; Workers report to an Orchestrator.');
  }
});
export type WorkflowHierarchyContext = z.infer<typeof WorkflowHierarchyContextSchema>;

export const WorkflowDelegationContextSchema = z.object({
  hierarchy: WorkflowHierarchySchema, parentNodeId: GraphIdSchema, routing: DelegateRoutingSchema,
  routes: z.array(z.object({ outcome: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/), childNodeId: GraphIdSchema }).strict()),
}).strict().superRefine(({ hierarchy, parentNodeId, routing, routes }, context) => {
  const children = new Set(hierarchy.parents.filter((entry) => entry.parentNodeId === parentNodeId).map((entry) => entry.workflowNodeId));
  const selected = new Set<string>();
  for (const request of routing.requests) {
    const matches = routes.filter((route) => route.outcome === request.outcome);
    const target = matches[0]?.childNodeId;
    if (matches.length !== 1 || !target || !children.has(target) || selected.has(target)) {
      context.addIssue({ code: 'custom', path: ['routing', 'requests'], message: 'Each delegation must resolve once to a distinct direct-child execution route.' });
    }
    if (target) selected.add(target);
  }
});
export type WorkflowDelegationContext = z.infer<typeof WorkflowDelegationContextSchema>;

export const WORKFLOW_HIERARCHY_TOOLS = {
  get: 'workflow_hierarchy_get', update: 'workflow_hierarchy_update', reports: 'workflow_reports_read',
} as const;
export const WORKFLOW_HIERARCHY_ROUTE = '/api/management/workspaces/:workspaceId/workflows/:workflowId/hierarchy';
export const WorkflowHierarchyReadInputSchema = z.object({
  workspaceId: IdSchema, workflowId: IdSchema, runId: IdSchema.optional(),
  workflowVersionId: IdSchema.optional(),
}).strict().refine(value => !(value.runId && value.workflowVersionId), {
  path: ['workflowVersionId'], message: 'Choose either an exact Run or a saved WorkflowVersion.',
});
export const WorkflowHierarchyUpdateInputSchema = z.object({
  workspaceId: IdSchema, workflowId: IdSchema, hierarchy: WorkflowHierarchySchema.nullable(),
  ...CommandOptionsSchema.shape,
}).strict();
/** Bounded root facts. Source results and the held continuation remain distinct immutable executions. */
export const WorkflowHierarchyCoordinationSchema = z.object({
  state: z.enum(['active', 'waiting_for_direction', 'succeeded', 'failed', 'canceled']),
  summary: z.string().max(600).optional(),
  sourceExecution: ExecutionRefSchema.optional(),
  latestDeliverable: z.object({ execution: ExecutionRefSchema, resultDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict().optional(),
  direction: z.object({ directionId: IdSchema, activationId: IdSchema, execution: ExecutionRefSchema }).strict().optional(),
}).strict().superRefine((value, context) => {
  if ((value.state === 'waiting_for_direction') !== !!value.direction
    || value.direction && value.direction.activationId !== value.direction.execution.activationId) {
    context.addIssue({ code: 'custom', path: ['direction'], message: 'Waiting for direction requires its exact held execution.' });
  }
});
export type WorkflowHierarchyCoordination = z.infer<typeof WorkflowHierarchyCoordinationSchema>;
export const WorkflowHierarchyReadResultSchema = z.object({
  workspaceId: IdSchema, workflowId: IdSchema, workflowVersionId: IdSchema.nullable(),
  revision: z.number().int().nonnegative(), hierarchy: WorkflowHierarchySchema.nullable(),
  agents: z.array(AgentIdentitySchema).max(1000),
  run: z.object({ runId: IdSchema, state: z.string().min(1),
    summary: z.string().max(600).optional(), coordination: WorkflowHierarchyCoordinationSchema.optional(), }).strict().optional(),
}).strict().superRefine((value, context) => {
  const coordination = value.run?.coordination;
  const references = [coordination?.sourceExecution, coordination?.latestDeliverable?.execution, coordination?.direction?.execution];
  if (references.some(reference => reference && (reference.runId !== value.run?.runId || reference.workflowVersionId !== value.workflowVersionId))) {
    context.addIssue({ code: 'custom', path: ['run', 'coordination'], message: 'Coordination facts must keep the selected Run and saved version.' });
  }
});
export const WorkflowReportsReadInputSchema = z.object({
  workspaceId: IdSchema, workflowId: IdSchema, runId: IdSchema,
  parentNodeId: GraphIdSchema.optional(), workflowNodeId: GraphIdSchema.optional(),
  cursor: z.string().min(1).max(2048).optional(), limit: z.number().int().min(1).max(100).default(50),
}).strict();
export const WorkflowReportsPageSchema = z.object({
  workspaceId: IdSchema, workflowId: IdSchema, runId: IdSchema, workflowVersionId: IdSchema,
  items: z.array(HierarchyReportSchema).max(100), nextCursor: z.string().nullable(),
  hasMore: z.boolean(), revision: z.number().int().nonnegative(),
}).strict();
/** Opaque committed-state cursor; report sequence alone cannot identify root transitions. */
export const WorkflowHierarchyChangeSchema = z.object({
  runId: IdSchema, workflowVersionId: IdSchema,
  revision: z.number().int().nonnegative(), cursor: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();
export type WorkflowHierarchyChange = z.infer<typeof WorkflowHierarchyChangeSchema>;
export type WorkflowHierarchyReadInput = z.infer<typeof WorkflowHierarchyReadInputSchema>;
export type WorkflowHierarchyReadResult = z.infer<typeof WorkflowHierarchyReadResultSchema>;
export type WorkflowHierarchyUpdateInput = z.infer<typeof WorkflowHierarchyUpdateInputSchema>;
export type WorkflowReportsReadInput = z.infer<typeof WorkflowReportsReadInputSchema>;
export type WorkflowReportsPage = z.infer<typeof WorkflowReportsPageSchema>;
