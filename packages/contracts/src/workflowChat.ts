import { z } from 'zod';
import { IdSchema, GraphIdSchema, TimestampSchema } from './schemaPrimitives.js';
import { AgentIdentitySchema, ExecutionRefSchema, CoordinatorConsultationBindingSchema, AgentSubjectSchema, sameExecution, sameAgentNode } from './agentIdentity.js';
import { DeliveryTargetSchema, ChatDeliveryIntentSchema, ChatDeliveryReceiptSchema } from './chatDelivery.js';
import { NativeSourceMessageSchema } from './messages.js';
import { canonicalJson } from './canonicalJson.js';

export const WorkflowMentionSchema = z.object({
  workflowNodeId: GraphIdSchema,
  start: z.number().int().nonnegative(), end: z.number().int().positive(),
}).strict().refine((mention) => mention.start < mention.end, { message: 'Mention span must have positive length.' });
export const WorkflowChatPostSchema = z.object({
  id: IdSchema, channelId: IdSchema, sequence: z.number().int().positive(),
  workspaceId: IdSchema, workflowId: IdSchema,
  author: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('user'), principalId: IdSchema,
      displayName: z.string() }).strict(),
    z.object({ kind: z.literal('operator'), principalId: IdSchema,
      displayName: z.string() }).strict(),
    z.object({ kind: z.literal('agent'), agent: AgentIdentitySchema }).strict(),
    z.object({ kind: z.literal('system') }).strict(),
  ]),
  kind: z.enum(['message','started','blocked','finished','review_return','report']),
  body: z.string().min(1), mentions: z.array(WorkflowMentionSchema),
  replyToPostId: IdSchema.optional(), cardIds: z.array(IdSchema),
  execution: ExecutionRefSchema.optional(),
  sourceEventKey: z.string().optional(), createdAt: TimestampSchema,
}).strict().superRefine((post, context) => {
  refineMentions(post, context);
  if (post.author.kind === 'agent' && (post.author.agent.workspaceId !== post.workspaceId
    || post.author.agent.workflowId !== post.workflowId)) context.addIssue({ code: 'custom', path: ['author'], message: 'Author must belong to the same workflow.' });
  if ((post.author.kind === 'agent' || post.author.kind === 'system' || post.kind !== 'message') && post.mentions.length) {
    context.addIssue({ code: 'custom', path: ['mentions'], message: 'Only explicit user or Operator messages resolve mentions.' });
  }
  if (post.kind !== 'message' && post.body.length > 600) context.addIssue({ code: 'custom', path: ['body'], message: 'Lifecycle summaries are limited to 600 characters.' });
});
export const WorkflowChatPostRequestSchema = z.object({
  commandId: IdSchema.optional(), workspaceId: IdSchema, workflowId: IdSchema,
  body: z.string().min(1), mentions: z.array(WorkflowMentionSchema),
  deliveries: z.array(z.object({ workflowNodeId: GraphIdSchema,
    target: DeliveryTargetSchema, intent: ChatDeliveryIntentSchema,
    expectedNativeTurnId: IdSchema.optional() }).strict()).max(32),
  replyToPostId: IdSchema.optional(), cardIds: z.array(IdSchema).max(32),
}).strict().superRefine((request, context) => {
  refineMentions(request, context);
  if (new TextEncoder().encode(request.body).byteLength > 16 * 1024) {
    context.addIssue({ code: 'custom', path: ['body'], message: 'Post text must fit within 16 KiB UTF-8.' });
  }
  const mentioned = new Set(request.mentions.map((mention) => mention.workflowNodeId));
  const delivered = new Set<string>();
  for (const [index, delivery] of request.deliveries.entries()) {
    const target = delivery.target;
    if (delivered.has(delivery.workflowNodeId) || !mentioned.has(delivery.workflowNodeId)) {
      context.addIssue({ code: 'custom', path: ['deliveries', index], message: 'Each mentioned node requires exactly one delivery.' });
    }
    delivered.add(delivery.workflowNodeId);
    if (target.kind === 'operator_conversation' || target.agent.workflowNodeId !== delivery.workflowNodeId
      || target.agent.workspaceId !== request.workspaceId || target.agent.workflowId !== request.workflowId) {
      context.addIssue({ code: 'custom', path: ['deliveries', index, 'target'], message: 'Mention target must be the selected node in this workflow.' });
    }
  }
  if ([...mentioned].some((nodeId) => !delivered.has(nodeId))) context.addIssue({ code: 'custom', path: ['deliveries'], message: 'Supply an explicit target and intent for every mentioned node.' });
});
export const WorkflowChatPostResponseSchema = z.object({
  post: WorkflowChatPostSchema, receipts: z.array(ChatDeliveryReceiptSchema),
  replayed: z.boolean(),
}).strict().superRefine(({ post, receipts }, context) => {
  const mentioned = new Set(post.mentions.map((mention) => mention.workflowNodeId));
  const delivered = new Set<string>();
  for (const receipt of receipts) {
    const target = receipt.target;
    if (receipt.postId !== post.id || target.kind === 'operator_conversation'
      || target.agent.workspaceId !== post.workspaceId || target.agent.workflowId !== post.workflowId
      || !mentioned.has(target.agent.workflowNodeId) || delivered.has(target.agent.workflowNodeId)) {
      context.addIssue({ code: 'custom', path: ['receipts'], message: 'Receipts must identify this post and each exact recipient once.' });
    }
    if (target.kind !== 'operator_conversation') delivered.add(target.agent.workflowNodeId);
  }
  if (delivered.size !== mentioned.size) context.addIssue({ code: 'custom', path: ['receipts'], message: 'Every mentioned node needs a receipt.' });
});
export const EngineChatMessageSchema =
  NativeSourceMessageSchema.extend({
    provenance: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('execution'), execution: ExecutionRefSchema }).strict(),
      z.object({ kind: z.literal('consultation'),
        binding: CoordinatorConsultationBindingSchema }).strict(),
    ]),
  }).strict().superRefine((message, context) => {
    if (message.provenance.kind === 'consultation' && message.activityNative
      && message.activityNative.sessionId !== message.provenance.binding.nativeSessionId) {
      context.addIssue({ code: 'custom', path: ['provenance'], message: 'Consultation provenance must retain the native session.' });
    }
  });
export const EngineChatReadbackSchema = z.object({
  target: DeliveryTargetSchema,
  state: z.enum(['queued','starting','active','waiting_children','settling','idle']),
  capabilities: z.object({ steer: z.enum(['native_expected_turn','unavailable']),
    queue: z.boolean(), interruptAndSend: z.boolean() }).strict(),
  /** Current native owner observation, independent of retained transcript messages. */
  nativeTurnId: z.string().min(1).optional(),
  messages: z.array(EngineChatMessageSchema).max(100), receipts: z.array(ChatDeliveryReceiptSchema),
  nextCursor: z.string().nullable(), hasMore: z.boolean(),
  revision: z.number().int().nonnegative(),
}).strict().superRefine((readback, context) => {
  const target = readback.target;
  if (target.kind !== 'workflow_execution' && target.kind !== 'workflow_coordinator') {
    context.addIssue({ code: 'custom', path: ['target'], message: 'Engine readback requires Run-owned work.' });
    return;
  }
  for (const [index, message] of readback.messages.entries()) {
    const source = message.provenance;
    const matches = target.kind === 'workflow_execution'
      ? source.kind === 'execution' && sameExecution(source.execution, target.execution)
      : source.kind === 'consultation' && source.binding.runId === target.runId
        && source.binding.waitingActivationId === target.waitingActivationId;
    if (!matches) context.addIssue({ code: 'custom', path: ['messages', index, 'provenance'], message: 'Message provenance must match the exact selected target.' });
  }
  if (readback.receipts.some((receipt) => canonicalJson(receipt.target) !== canonicalJson(target))) {
    context.addIssue({ code: 'custom', path: ['receipts'], message: 'Receipt targets must match the selected owner.' });
  }
}); // Existing native activity uses its current bounded activity endpoint.


export type WorkflowMention = z.infer<typeof WorkflowMentionSchema>;
export type WorkflowChatPost = z.infer<typeof WorkflowChatPostSchema>;
export type WorkflowChatPostRequest = z.infer<typeof WorkflowChatPostRequestSchema>;
export type WorkflowChatPostResponse = z.infer<typeof WorkflowChatPostResponseSchema>;
export type EngineChatMessage = z.infer<typeof EngineChatMessageSchema>;
export type EngineChatReadback = z.infer<typeof EngineChatReadbackSchema>;

function refineMentions(value: { body: string; mentions: WorkflowMention[] }, context: z.RefinementCtx): void {
  if (!value.body.trim()) {
    context.addIssue({ code: 'custom', path: ['body'], message: 'Post text must be nonempty.' });
  }
  const sorted = value.mentions.map((mention, index) => ({ ...mention, index })).sort((a, b) => a.start - b.start);
  let previousEnd = 0;
  const splitsPair = (offset: number) => offset > 0 && offset < value.body.length
    && /[\uD800-\uDBFF]/u.test(value.body[offset - 1]!) && /[\uDC00-\uDFFF]/u.test(value.body[offset]!);
  for (const mention of sorted) {
    if (mention.start < previousEnd || mention.end > value.body.length || splitsPair(mention.start) || splitsPair(mention.end)) {
      context.addIssue({ code: 'custom', path: ['mentions', mention.index], message: 'Mention spans must be nonoverlapping UTF-16 ranges in the original body.' });
    }
    previousEnd = mention.end;
  }
}

/** Actor comes from authentication, never the request payload. */
export function validateWorkflowChatPostForAuthor(input: unknown, author: 'user' | 'operator' | 'agent'): WorkflowChatPostRequest {
  const request = WorkflowChatPostRequestSchema.parse(input);
  if (author === 'agent' && (request.mentions.length || request.deliveries.length)) {
    throw new Error('Agent posts cannot resolve mentions or schedule recipients.');
  }
  return request;
}

/** Bind readback to the owner's immutable subject and recorded consultation history.
 * The owner supplies these records; a selected target alone is not provenance proof. */
export const EngineChatReadbackContextSchema = z.object({
  subject: AgentSubjectSchema, readback: EngineChatReadbackSchema,
  consultationBindings: z.array(CoordinatorConsultationBindingSchema).optional(),
}).strict().superRefine(({ subject, readback, consultationBindings }, context) => {
  const fail = (message: string) => context.addIssue({ code: 'custom', message });
  const target = readback.target;
  if (target.kind === 'workflow_execution') {
    if (subject.kind !== 'execution' || !sameAgentNode(subject.agent, target.agent)
      || !sameExecution(subject.execution, target.execution)) fail('Readback must match its exact execution owner.');
    return;
  }
  if (target.kind !== 'workflow_coordinator' || subject.kind !== 'coordinator_consultation') {
    fail('Coordinator readback requires its owner-issued consultation subject.');
    return;
  }
  if (!sameAgentNode(subject.agent, target.agent) || subject.binding.runId !== target.runId
    || subject.binding.waitingActivationId !== target.waitingActivationId) fail('Readback must match the waiting coordinator.');
  const recorded = consultationBindings ?? [subject.binding];
  for (const binding of recorded) {
    if (binding.runId !== subject.binding.runId || binding.workflowVersionId !== subject.binding.workflowVersionId
      || binding.waitingActivationId !== subject.binding.waitingActivationId || binding.delegationGroupId !== subject.binding.delegationGroupId
      || binding.nativeSessionId !== subject.binding.nativeSessionId) fail('Recorded consultations must retain the same immutable waiting owner.');
  }
  for (const message of readback.messages) {
    if (message.provenance.kind !== 'consultation'
      || !recorded.some((binding) => canonicalJson(binding) === canonicalJson(message.provenance.kind === 'consultation' ? message.provenance.binding : null))) {
      fail('Consultation message requires its exact recorded binding.');
    }
  }
  for (const receipt of readback.receipts) if (receipt.consultationId && !recorded.some((binding) => binding.consultationId === receipt.consultationId)) {
    fail('Consultation receipt requires its recorded binding.');
  }
});
export type EngineChatReadbackContext = z.infer<typeof EngineChatReadbackContextSchema>;

export function validateEngineChatReadback(input: EngineChatReadbackContext): EngineChatReadback {
  return EngineChatReadbackContextSchema.parse(input).readback;
}
