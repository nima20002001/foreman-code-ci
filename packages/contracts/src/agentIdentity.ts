import { z } from 'zod';
import { IdSchema, GraphIdSchema } from './schemaPrimitives.js';

export const AgentProductRoleSchema = z.enum(['master', 'orchestrator', 'coder']);
export type WorkflowAgentProductRole = z.infer<typeof AgentProductRoleSchema>;
export const AGENT_PRODUCT_ROLE_LABELS = {
  master: 'Master', orchestrator: 'Orchestrator', coder: 'Worker', operator: 'Operator',
} as const;
export function agentProductRoleLabel(role: WorkflowAgentProductRole | 'operator'): string {
  return AGENT_PRODUCT_ROLE_LABELS[role];
}
// UI: master → Master; orchestrator → Orchestrator; coder → Worker.
export const AgentNodeRefSchema = z.object({
  workspaceId: IdSchema, workflowId: IdSchema,
  workflowNodeId: GraphIdSchema, agentId: IdSchema,
}).strict();
export const AgentIdentitySchema = AgentNodeRefSchema.extend({
  productRole: AgentProductRoleSchema,
  displayName: z.string().min(1),
  configurationVersionId: IdSchema,
}).strict();
export const ExecutionRefSchema = z.object({
  runId: IdSchema, workflowVersionId: IdSchema,
  executionId: IdSchema, activationId: IdSchema.optional(),
  attempt: z.number().int().positive(),
}).strict();
export const LogicalWorkRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('activation'), runId: IdSchema,
    workflowVersionId: IdSchema, activationId: IdSchema }).strict(),
  z.object({ kind: z.literal('slot'), runId: IdSchema,
    workflowVersionId: IdSchema, slotId: IdSchema }).strict(),
]); // Server-resolved business work; every technical attempt retains this key.
export const CoordinatorConsultationBindingSchema = z.object({
  runId: IdSchema, workflowVersionId: IdSchema,
  waitingActivationId: IdSchema, delegationGroupId: IdSchema,
  consultationId: IdSchema, nativeSessionId: IdSchema,
  purpose: z.literal('consultation'),
}).strict();
export const AgentSubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('execution'), agent: AgentIdentitySchema,
    execution: ExecutionRefSchema }).strict(),
  z.object({ kind: z.literal('conversation'), agent: AgentIdentitySchema,
    conversationId: IdSchema }).strict(),
  z.object({ kind: z.literal('coordinator_consultation'), agent: AgentIdentitySchema,
    binding: CoordinatorConsultationBindingSchema }).strict(),
]).superRefine((subject, context) => {
  if (subject.kind === 'coordinator_consultation' && subject.agent.productRole === 'coder') {
    context.addIssue({ code: 'custom', path: ['agent', 'productRole'], message: 'Consultations require a coordinator.' });
  }
});
export const CommandOptionsSchema = z.object({
  commandId: IdSchema.optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
}).strict();

export type AgentNodeRef = z.infer<typeof AgentNodeRefSchema>;
export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;
export type ExecutionRef = z.infer<typeof ExecutionRefSchema>;
export type LogicalWorkRef = z.infer<typeof LogicalWorkRefSchema>;
export type CoordinatorConsultationBinding = z.infer<typeof CoordinatorConsultationBindingSchema>;
export type AgentSubject = z.infer<typeof AgentSubjectSchema>;
export type CommandOptions = z.infer<typeof CommandOptionsSchema>;

export function sameAgentNode(left: AgentNodeRef, right: AgentNodeRef): boolean {
  return left.workspaceId === right.workspaceId && left.workflowId === right.workflowId
    && left.workflowNodeId === right.workflowNodeId && left.agentId === right.agentId;
}

export function sameExecution(left: ExecutionRef, right: ExecutionRef): boolean {
  return left.runId === right.runId && left.workflowVersionId === right.workflowVersionId
    && left.executionId === right.executionId && left.activationId === right.activationId
    && left.attempt === right.attempt;
}

export function sameLogicalWork(left: LogicalWorkRef, right: LogicalWorkRef): boolean {
  return left.runId === right.runId && left.workflowVersionId === right.workflowVersionId
    && (left.kind === 'activation' && right.kind === 'activation' ? left.activationId === right.activationId
      : left.kind === 'slot' && right.kind === 'slot' && left.slotId === right.slotId);
}

/** Node/slot membership is resolved by the owner; these are the shared wire facts. */
export function executionMatchesWork(execution: ExecutionRef, work: LogicalWorkRef): boolean {
  return execution.runId === work.runId && execution.workflowVersionId === work.workflowVersionId
    && (work.kind !== 'activation' || execution.activationId === work.activationId);
}
