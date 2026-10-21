import { z } from "zod";

import { IdSchema, MessageSchema } from "./index.js";

/** PostgreSQL bigint keyset cursor. Never round a message sequence through a JS number. */
export const OperatorHistoryCursorSchema = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => value.length < 19 || value <= "9223372036854775807", "Invalid history cursor");

export const OperatorConversationHistoryQuerySchema = z.object({
  before: OperatorHistoryCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type OperatorConversationHistoryQuery = z.infer<typeof OperatorConversationHistoryQuerySchema>;

/**
 * Durable acceptance identity, not permission to resubmit.
 * Null outcome means no terminal result was stored at the page's revision.
 */
const OperatorMessageReceiptSchema = z.object({
  requestId: IdSchema,
  inputHash: z.union([z.literal("legacy"), z.string().regex(/^[a-f0-9]{64}$/)]),
  outcome: z.enum(["succeeded", "failed", "canceled"]).nullable(),
  retryable: z.boolean(),
}).strict();

export const OperatorConversationHistoryPageSchema = z.object({
  conversationId: IdSchema,
  revision: z.number().int().nonnegative(),
  activeRequestId: IdSchema.nullable(),
  entries: z.array(z.object({
    sequence: OperatorHistoryCursorSchema,
    message: MessageSchema,
    receipt: OperatorMessageReceiptSchema.nullable(),
  }).strict()).max(100),
  nextCursor: OperatorHistoryCursorSchema.nullable(),
}).strict();
export type OperatorConversationHistoryPage = z.infer<typeof OperatorConversationHistoryPageSchema>;

/** Read-only, text-only source history for a credential bound to a forked Operator chat. */
export const OperatorHandoffHistoryPageSchema = z.object({
  sourceConversationId: IdSchema,
  parentConversationId: IdSchema.optional(),
  messages: z.array(z.object({ sequence: OperatorHistoryCursorSchema,
    role: z.enum(['user', 'assistant']), content: z.string() }).strict()).max(50),
  nextCursor: OperatorHistoryCursorSchema.nullable(),
}).strict();
