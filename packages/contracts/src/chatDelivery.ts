import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemaPrimitives.js';
import { AgentNodeRefSchema, ExecutionRefSchema, LogicalWorkRefSchema } from './agentIdentity.js';
import { executionMatchesWork, type ExecutionRef } from './agentIdentity.js';
import { MessageAttachmentFields } from './files.js';
import { canonicalJson } from './canonicalJson.js';

export const ChatDeliveryIntentSchema = z.enum([
  'auto', 'steer', 'next_turn', 'interrupt_and_send',
]);
export const DeliveryTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workflow_execution'), agent: AgentNodeRefSchema,
    execution: ExecutionRefSchema }).strict(),
  z.object({ kind: z.literal('workflow_coordinator'), agent: AgentNodeRefSchema,
    runId: IdSchema, waitingActivationId: IdSchema }).strict(),
  z.object({ kind: z.literal('agent_conversation'), agent: AgentNodeRefSchema,
    conversationId: IdSchema }).strict(),
  z.object({ kind: z.literal('operator_conversation'),
    conversationId: IdSchema }).strict(),
]);
export const ChatDeliveryReceiptSchema = z.object({
  id: IdSchema, commandId: IdSchema, postId: IdSchema.optional(),
  target: DeliveryTargetSchema,
  requestedIntent: ChatDeliveryIntentSchema,
  appliedIntent: z.enum(['steer','next_turn','interrupt_and_send']),
  state: z.enum(['queued','submitting','accepted','completed','failed','canceled','unknown']),
  nativeTurnId: IdSchema.optional(),
  continuationId: IdSchema.optional(), continuationExecution: ExecutionRefSchema.optional(),
  consultationId: IdSchema.optional(),
  replyPostId: IdSchema.optional(), errorCode: z.string().optional(),
  createdAt: TimestampSchema, updatedAt: TimestampSchema,
}).strict().superRefine((receipt, context) => {
  refineReceiptLineage(receipt, context);
  if (receipt.requestedIntent !== 'auto' && receipt.requestedIntent !== receipt.appliedIntent) {
    context.addIssue({ code: 'custom', path: ['appliedIntent'], message: 'Explicit delivery intent cannot silently change.' });
  }
  if (receipt.requestedIntent === 'auto' && receipt.appliedIntent === 'interrupt_and_send') {
    context.addIssue({ code: 'custom', path: ['appliedIntent'], message: 'Automatic delivery cannot interrupt work.' });
  }
});
export const ChatSendRequestSchema = z.object({
  commandId: IdSchema.optional(), target: DeliveryTargetSchema,
  intent: ChatDeliveryIntentSchema,
  content: z.string(), ...MessageAttachmentFields,
  sessionMode: z.enum(['regular','plan']).optional(),
  expectedNativeTurnId: IdSchema.optional(), sourcePostId: IdSchema.optional(),
}).strict().superRefine((request, context) => {
  if (!request.content.trim() && request.attachments.length === 0) {
    context.addIssue({ code: 'custom', path: ['content'], message: 'Provide text or at least one attachment.' });
  }
  if (request.intent === 'steer' && request.attachments.length) {
    context.addIssue({ code: 'custom', path: ['attachments'], message: 'Steering accepts text only; queue attachments in a new turn.' });
  }
  if (new TextEncoder().encode(canonicalJson(request)).byteLength > CHAT_SEND_MAX_BYTES) {
    context.addIssue({ code: 'custom', message: 'Chat input exceeds the 960 KiB serialized request limit.' });
  }
});
export const ChatStopRequestSchema = z.object({
  commandId: IdSchema.optional(), target: DeliveryTargetSchema,
  scope: z.enum(['active_turn','active_and_queued']),
  expectedNativeTurnId: IdSchema.optional(),
}).strict();
export const ChatQueueCancelRequestSchema = z.object({
  commandId: IdSchema.optional(), target: DeliveryTargetSchema,
  selection: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('one'), receiptId: IdSchema }).strict(),
    z.object({ kind: z.literal('all') }).strict(),
  ]),
}).strict();
export const WorkflowControlContinuationSchema = z.object({
  id: IdSchema, controlCommandId: IdSchema, deliveryReceiptId: IdSchema,
  work: LogicalWorkRefSchema, previousExecution: ExecutionRefSchema,
  nativeTarget: z.object({ nativeSessionId: IdSchema, ownerRequestId: IdSchema,
    nativeTurnId: IdSchema.optional(), inputMessageId: IdSchema.optional() }).strict(),
  cause: z.enum(['interrupt_and_send','stop_with_queued']),
  state: z.enum(['reserved','waiting_settlement','admitted','failed','canceled','unknown']),
  successorExecution: ExecutionRefSchema.nullable(),
  errorCode: z.string().nullable(), createdAt: TimestampSchema, updatedAt: TimestampSchema,
}).strict().superRefine((continuation, context) => {
  const fail = (message: string) => context.addIssue({ code: 'custom', message });
  if (!executionMatchesWork(continuation.previousExecution, continuation.work)) fail('Original execution must identify the same logical work.');
  if ((continuation.state === 'admitted') !== (continuation.successorExecution !== null)) fail('Only admitted continuations require a successor execution.');
  if (continuation.successorExecution && (!executionMatchesWork(continuation.successorExecution, continuation.work)
    || continuation.successorExecution.executionId === continuation.previousExecution.executionId)) fail('Successor must be a distinct execution of the same logical work.');
  if (continuation.state === 'failed' && !continuation.errorCode?.trim()) fail('Failed continuation requires a cause.');
});

export const ChatControlReceiptSchema = z.object({
  commandId: IdSchema, target: DeliveryTargetSchema,
  operation: z.enum(['stop_active','stop_active_and_queued','cancel_one','cancel_all_queued']),
  state: z.enum(['recorded','settling','completed','failed','unknown']),
  affectedReceiptIds: z.array(IdSchema), replayed: z.boolean(),
  continuationId: IdSchema.optional(), continuationExecution: ExecutionRefSchema.optional(),
  consultationId: IdSchema.optional(),
  errorCode: z.string().optional(),
}).strict().superRefine(refineReceiptLineage);


export type ChatDeliveryIntent = z.infer<typeof ChatDeliveryIntentSchema>;
export type DeliveryTarget = z.infer<typeof DeliveryTargetSchema>;
export type ChatDeliveryReceipt = z.infer<typeof ChatDeliveryReceiptSchema>;
export type ChatSendRequest = z.infer<typeof ChatSendRequestSchema>;
export type ChatStopRequest = z.infer<typeof ChatStopRequestSchema>;
export type ChatQueueCancelRequest = z.infer<typeof ChatQueueCancelRequestSchema>;
export type WorkflowControlContinuation = z.infer<typeof WorkflowControlContinuationSchema>;
export type ChatControlReceipt = z.infer<typeof ChatControlReceiptSchema>;

/** Leave room for the device owner/session envelope beneath its 1 MiB transport cap.
 * The final native adapter still validates the actual serialized request. */
export const CHAT_SEND_MAX_BYTES = 960 * 1024;

function refineReceiptLineage(receipt: {
  target: DeliveryTarget; continuationId?: string; continuationExecution?: ExecutionRef; consultationId?: string;
}, context: z.RefinementCtx): void {
  const fail = (message: string) => context.addIssue({ code: 'custom', message });
  if (receipt.continuationId || receipt.continuationExecution) {
    if (receipt.target.kind !== 'workflow_execution') fail('Execution continuation lineage is only valid for workflow execution targets.');
    else if (receipt.continuationExecution) {
      const original = receipt.target.execution, successor = receipt.continuationExecution;
      if (!receipt.continuationId || original.runId !== successor.runId || original.workflowVersionId !== successor.workflowVersionId
        || original.activationId !== successor.activationId || original.executionId === successor.executionId) fail('Receipt successor must retain the original logical-work identity.');
    }
  }
  if (receipt.consultationId && receipt.target.kind !== 'workflow_coordinator') fail('Consultation identity requires a waiting-coordinator target.');
}

/** A supplied mode can preserve the active mode, but steering cannot change it. */
export const ChatSendModeContextSchema = z.object({
  request: ChatSendRequestSchema, activeSessionMode: z.enum(['regular', 'plan']),
}).strict().refine(({ request, activeSessionMode }) => request.intent !== 'steer'
  || request.sessionMode === undefined || request.sessionMode === activeSessionMode, {
  path: ['request', 'sessionMode'], message: 'Use a new turn to change session mode.',
});

/** Legacy omissions are frozen. New clients choose auto/active_turn explicitly. */
export function legacyAgentChatIntent(intent?: ChatDeliveryIntent): ChatDeliveryIntent {
  return intent ?? 'next_turn';
}
export function legacyAgentChatStopScope(scope?: ChatStopRequest['scope']): ChatStopRequest['scope'] {
  return scope ?? 'active_and_queued';
}
export function operatorChatDeliveryMode(intent?: ChatDeliveryIntent): 'legacy' | 'explicit' {
  return intent === undefined ? 'legacy' : 'explicit';
}
