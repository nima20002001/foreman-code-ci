import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemaPrimitives.js';
import { AgentSubjectSchema, ExecutionRefSchema, LogicalWorkRefSchema } from './agentIdentity.js';
import { MemoryBoardSchema, MemoryCardSchema, MemoryNoteSchema, MemoryCardWorkBindingSchema,
  MemoryCardWorkClaimSchema, MemoryBoardMutationReceiptSchema } from './memoryBoards.js';

const revision = z.number().int().nonnegative();
const page = <T extends z.ZodType>(item: T) => z.object({
  items: z.array(item), nextCursor: z.string().nullable(), hasMore: z.boolean(), revision,
}).strict();

export const MemoryBoardChangeSchema = z.object({
  id: IdSchema, boardId: IdSchema, sequence: revision, boardRevision: revision,
  entity: z.enum(['card', 'note']), entityId: IdSchema, entityRevision: revision,
  commandId: IdSchema.optional(), sourceEventKey: z.string().optional(),
  actor: z.object({ kind: z.enum(['operator', 'agent', 'engine']), id: IdSchema, displayName: z.string() }).strict(),
  occurredAt: TimestampSchema,
  provenance: z.object({ principalId: IdSchema.optional(), subject: AgentSubjectSchema.optional(),
    work: LogicalWorkRefSchema.optional(), execution: ExecutionRefSchema.optional() }).strict().optional(),
  changes: z.record(z.string(), z.object({ before: z.unknown(), after: z.unknown() }).strict()).optional(),
}).strict();
export const MemoryBoardViewSchema = z.object({
  board: MemoryBoardSchema,
  openColumns: z.array(page(MemoryCardSchema).extend({ status: z.enum(['todo', 'doing', 'waiting_for_user', 'blocked']) })),
  notes: page(MemoryNoteSchema), sequence: revision,
  counts: z.object({ todo: revision, doing: revision, waiting_for_user: revision, blocked: revision, done: revision,
    completed: revision, dropped: revision, notes: revision }).strict(),
}).strict();
export const MemoryWorkPageInfoSchema = z.object({ nextCursor: z.string().nullable(), hasMore: z.boolean(), revision }).strict();
export const MemoryWorkSummarySchema = z.object({ activeBindings: revision, unresolvedFailures: revision, armedClaims: revision }).strict();
export const MemoryBindingsPageSchema = page(MemoryCardWorkBindingSchema);
export const MemoryClaimsPageSchema = page(MemoryCardWorkClaimSchema);
export const MemoryCardDetailSchema = z.object({ card: MemoryCardSchema,
  bindings: z.array(MemoryCardWorkBindingSchema).max(100), claims: z.array(MemoryCardWorkClaimSchema).max(100),
  bindingPage: MemoryWorkPageInfoSchema, claimPage: MemoryWorkPageInfoSchema, workSummary: MemoryWorkSummarySchema,
  history: page(MemoryBoardChangeSchema),
}).strict();
export const MemoryBoardCommandReadSchema = z.discriminatedUnion('state', [
  z.object({ commandId: IdSchema, state: z.literal('known'), receipt: MemoryBoardMutationReceiptSchema }).strict(),
  z.object({ commandId: IdSchema, state: z.literal('rejected'), error: z.object({ code: z.string(),
    message: z.string(), status: z.number().int(), details: z.record(z.string(), z.unknown()).optional() }).strict() }).strict(),
  z.object({ commandId: IdSchema, state: z.literal('unknown') }).strict(),
]);
export const MemoryBoardWireSchemas = {
  bindings: MemoryBindingsPageSchema, claims: MemoryClaimsPageSchema,
  board: MemoryBoardViewSchema, cards: page(MemoryCardSchema), card: MemoryCardDetailSchema,
  notes: page(MemoryNoteSchema), command: MemoryBoardCommandReadSchema,
  receipt: MemoryBoardMutationReceiptSchema,
  changes: page(MemoryBoardChangeSchema).extend({ watermark: revision, resetRequired: z.boolean() }),
  change: MemoryBoardChangeSchema,
};

export const MemoryBoardSearchSchema = z.object({
  memoryCard: IdSchema.optional(), memoryQuery: z.string().max(240).optional(),
  memoryStatus: z.enum(['todo', 'doing', 'waiting_for_user', 'blocked', 'done']).optional(),
  memoryDone: z.boolean().optional(), memoryCompletion: z.enum(['completed', 'dropped']).optional(),
}).strict();

export type MemoryWorkPageInfo = z.infer<typeof MemoryWorkPageInfoSchema>;
export type MemoryWorkSummary = z.infer<typeof MemoryWorkSummarySchema>;
