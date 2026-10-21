import { z } from "zod";
import { GraphIdSchema, IdSchema } from "./schemaPrimitives.js";
import { SelectedRunChatKeySchema } from "./runSnapshots.js";
import {
  AgentChatHistoryPageSchema, AgentChatReadbackQuerySchema, AgentChatStateSchema,
  AgentChatTurnPageSchema, InterruptAgentChatRequestSchema, ReadAgentChatRequestSchema, ReadAgentChatResponseSchema,
  AgentChatMessageCommandSchema,
} from "./agentChat.js";

/** SCH-06 is an additive envelope; the frozen Run snapshot and FEAT-15 shapes are unchanged. */
export const SelectedRunChatTargetSchema = z.object({
  workspaceId: IdSchema, workflowId: IdSchema, runId: IdSchema, workflowNodeId: GraphIdSchema,
}).strict();
export const SelectedRunChatSelectionSchema = SelectedRunChatTargetSchema.extend({ executionId: IdSchema.optional() });
const SelectedRunChatExecutionSchema = SelectedRunChatTargetSchema.extend({ executionId: IdSchema });
export type SelectedRunChatTarget = z.infer<typeof SelectedRunChatTargetSchema>;
export type SelectedRunChatSelection = z.infer<typeof SelectedRunChatSelectionSchema>;
export type SelectedRunChatExecution = z.infer<typeof SelectedRunChatExecutionSchema>;

export const ReadSelectedRunChatRequestSchema = z.object({
  selection: SelectedRunChatSelectionSchema,
  history: AgentChatReadbackQuerySchema.optional(),
  receipts: AgentChatReadbackQuerySchema.optional(),
}).strict();

const Selected = z.object({
  kind: z.literal("selected"), selection: SelectedRunChatExecutionSchema,
  /** Null until a conversation exists. Never fabricate a conversation id on a read. */
  key: SelectedRunChatKeySchema.nullable(), state: AgentChatStateSchema,
  history: AgentChatHistoryPageSchema.optional(), receipts: AgentChatTurnPageSchema.optional(),
}).strict().superRefine((value, context) => {
  const { selection, state, key } = value;
  if (state.sourceTranscript && state.sourceTranscript.executionId !== selection.executionId) {
    context.addIssue({ code: 'custom', path: ['state', 'sourceTranscript', 'executionId'], message: 'Mixed execution transcript identity' });
  }
  for (const field of ["workspaceId", "workflowId", "runId", "workflowNodeId"] as const) {
    if (state.context[field] !== selection[field]) context.addIssue({ code: "custom", path: ["state", "context", field], message: "Mixed Run chat identity" });
  }
  const conversation = state.conversation;
  if (!conversation) {
    if (key !== null || value.history || value.receipts) context.addIssue({ code: "custom", message: "No conversation means no resolved key or pages" });
    return;
  }
  if (!key) { context.addIssue({ code: "custom", path: ["key"], message: "A conversation requires its complete key" }); return; }
  for (const field of ["workspaceId", "workflowId", "runId", "workflowNodeId", "executionId"] as const) {
    if (key[field] !== selection[field]) context.addIssue({ code: "custom", path: ["key", field], message: "Mixed Run chat identity" });
  }
  for (const field of ["workspaceId", "workflowId", "workflowNodeId", "agentId"] as const) {
    if (conversation[field] !== key[field] || state.context[field] !== key[field]) context.addIssue({ code: "custom", message: "Mixed conversation identity" });
  }
  if (conversation.id !== key.conversationId || conversation.origin.kind !== "run_execution"
    || conversation.origin.runId !== key.runId || conversation.origin.executionId !== key.executionId
    || value.history && value.history.conversationId !== key.conversationId
    || value.receipts && value.receipts.conversationId !== key.conversationId) {
    context.addIssue({ code: "custom", message: "Mixed conversation origin or page" });
  }
});
const ExecutionChoice = z.object({
  kind: z.literal("execution_selection_required"), target: SelectedRunChatTargetSchema,
  /** A bounded hint, not an automatic choice. Existing Run execution paging can enumerate the rest. */
  executions: z.array(z.object({ executionId: IdSchema, attempt: z.number().int().positive() }).strict()).min(2).max(100),
  hasMoreExecutions: z.boolean(),
}).strict();
const Unavailable = z.object({ kind: z.literal("unavailable"), target: SelectedRunChatTargetSchema,
  reason: z.enum(["legacy_run", "execution_missing", "job_node"]) }).strict();
export const ReadSelectedRunChatResponseSchema = z.discriminatedUnion("kind", [Selected, ExecutionChoice, Unavailable]);
export type ReadSelectedRunChatResponse = z.infer<typeof ReadSelectedRunChatResponseSchema>;

/** Context/Agent ids are derived from the snapshot, not accepted again in the message body. */
export const SendSelectedRunChatRequestSchema = z.object({
  selection: SelectedRunChatExecutionSchema,
  // Derive fields before refining: preserve content and attachment-steering checks.
  message: z.object(AgentChatMessageCommandSchema.shape).omit({ context: true }).strict()
    .refine((value) => value.content.length > 0 || value.attachments.length > 0, {
      path: ["content"], message: "Message requires text or an attachment.",
    }).refine((value) => value.intent !== "steer" || value.attachments.length === 0, {
      path: ["attachments"], message: "Attachment steering is not supported. Send attachments in a new turn.",
    }),
}).strict();
export const InterruptSelectedRunChatRequestSchema = z.object({
  key: SelectedRunChatKeySchema, request: InterruptAgentChatRequestSchema,
}).strict();

/** Keep the existing tool name, grants and top-level paging fields. Exactly one selector is required. */
export const AgentChatReadToolInputSchema = ReadAgentChatRequestSchema.extend({
  query: ReadAgentChatRequestSchema.shape.query.optional(),
  selection: SelectedRunChatSelectionSchema.omit({ workspaceId: true }).optional(),
}).superRefine((value, context) => {
  if (Boolean(value.query) === Boolean(value.selection)) context.addIssue({ code: "custom", message: "Supply exactly one of query or selection" });
  if (value.conversationId && !value.query) context.addIssue({ code: 'custom', message: 'Historical conversationId requires query' });
});

export const AgentChatSendToolInputSchema = z.object({
  workspaceId: IdSchema, request: AgentChatMessageCommandSchema.optional(),
  selection: SelectedRunChatExecutionSchema.omit({ workspaceId: true }).optional(),
  message: SendSelectedRunChatRequestSchema.shape.message.optional(),
}).strict().superRefine((value, context) => {
  if (value.request ? value.selection || value.message : !value.selection || !value.message) {
    context.addIssue({ code: "custom", message: "Supply request, or selection and message" });
  }
});
export const AgentChatInterruptToolInputSchema = InterruptAgentChatRequestSchema.extend({
  workspaceId: IdSchema, conversationId: IdSchema,
  selection: SelectedRunChatKeySchema.unwrap().omit({ workspaceId: true, conversationId: true }).optional(),
});

/** MCP requires an object-shaped output schema. Validate against the exact shared result union,
 * while exposing both old readback fields and the historical envelope in tools/list. */
const ReadToolResult = z.union([ReadAgentChatResponseSchema, ReadSelectedRunChatResponseSchema]);
export const AgentChatReadToolOutputSchema = ReadAgentChatResponseSchema.partial().extend({
  kind: z.enum(["selected", "execution_selection_required", "unavailable"]).optional(),
  selection: SelectedRunChatExecutionSchema.optional(), key: SelectedRunChatKeySchema.nullable().optional(),
  state: AgentChatStateSchema.optional(), target: SelectedRunChatTargetSchema.optional(),
  executions: ExecutionChoice.shape.executions.optional(),
  hasMoreExecutions: z.boolean().optional(),
  reason: Unavailable.shape.reason.optional(),
}).superRefine((value, context) => {
  const parsed = ReadToolResult.safeParse(value);
  if (!parsed.success) for (const issue of parsed.error.issues) {
    context.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }
});
