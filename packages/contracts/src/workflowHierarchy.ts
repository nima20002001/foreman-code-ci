import { z } from 'zod';
import { IdSchema, GraphIdSchema, TimestampSchema } from './schemaPrimitives.js';
import { AgentIdentitySchema, ExecutionRefSchema } from './agentIdentity.js';

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
