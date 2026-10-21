import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemaPrimitives.js';
import { AgentNodeRefSchema, AgentIdentitySchema, CommandOptionsSchema, LogicalWorkRefSchema, ExecutionRefSchema } from './agentIdentity.js';
import { AgentSubjectSchema, executionMatchesWork, sameExecution, sameLogicalWork, type AgentNodeRef } from './agentIdentity.js';
import { canonicalJson } from './canonicalJson.js';

function refineCardState(card: { status: string; completionKind: string | null; reason: string | null }, context: z.RefinementCtx): void {
  if ((card.status === 'done') !== (card.completionKind !== null)) {
    context.addIssue({ code: 'custom', path: ['completionKind'], message: 'Only Done cards require a completion kind.' });
  }
  if ((card.status === 'blocked' || card.status === 'waiting_for_user' || card.completionKind === 'dropped') && !card.reason?.trim()) {
    context.addIssue({ code: 'custom', path: ['reason'], message: 'Blocked, waiting-for-user or dropped cards require a reason.' });
  }
}

export const MemoryBoardScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace'), workspaceId: IdSchema }).strict(),
  z.object({ kind: z.literal('workflow'), workspaceId: IdSchema,
    workflowId: IdSchema }).strict(),
]);
/** waiting_for_user: an Agent needs the owner to act (pay, sign in, solve a CAPTCHA); reason says what to do. */
export const MemoryCardStatusSchema = z.enum(['todo', 'doing', 'waiting_for_user', 'blocked', 'done']);
export const MemoryCardSchema = z.object({
  id: IdSchema, boardId: IdSchema,
  title: z.string().trim().min(1).max(240), body: z.string().max(8000),
  status: MemoryCardStatusSchema,
  completionKind: z.enum(['completed', 'dropped']).nullable(),
  reason: z.string().trim().max(1000).nullable(),
  assignee: AgentNodeRefSchema.nullable(),
  linkedNodes: z.array(AgentNodeRefSchema),
  sourcePostId: IdSchema.optional(),
  revision: z.number().int().nonnegative(),
  createdAt: TimestampSchema, updatedAt: TimestampSchema,
}).strict().superRefine(refineCardState);
export const MemoryNoteSchema = z.object({
  id: IdSchema, boardId: IdSchema, text: z.string().trim().min(1).max(4000),
  rank: z.number().int().nonnegative(), archived: z.boolean(),
  sourcePostId: IdSchema.optional(),
  revision: z.number().int().nonnegative(), updatedAt: TimestampSchema,
}).strict();
export const MemoryBoardSchema = z.object({
  id: IdSchema, scope: MemoryBoardScopeSchema,
  revision: z.number().int().nonnegative(),
}).strict();
export const MemoryCardWorkSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('current'), work: LogicalWorkRefSchema }).strict(),
  z.object({ kind: z.literal('next_activation'), node: AgentNodeRefSchema }).strict(),
]);
export const MemoryCardWorkBindingSchema = z.object({
  id: IdSchema, cardId: IdSchema, node: AgentNodeRefSchema,
  work: LogicalWorkRefSchema, currentExecutionId: IdSchema.nullable(),
  parentRequestId: IdSchema.optional(),
  state: z.enum(['queued','running','awaiting_acceptance','waiting_children',
    'accepted','blocked','failed','canceled']),
  reason: z.string().nullable(), revision: z.number().int().nonnegative(),
  resolution: z.object({ kind: z.enum(['reopened','dropped']), commandId: IdSchema,
    reason: z.string().trim().min(1), resolvedAt: TimestampSchema }).strict().optional(),
}).strict().superRefine((binding, context) => {
  if (['blocked', 'failed', 'canceled'].includes(binding.state) && !binding.reason?.trim()) {
    context.addIssue({ code: 'custom', path: ['reason'], message: 'Unsuccessful work requires a cause.' });
  }
  if (binding.resolution && binding.state !== 'failed' && binding.state !== 'canceled') {
    context.addIssue({ code: 'custom', path: ['resolution'], message: 'Only terminal failed or canceled work can be resolved.' });
  }
});
export const MemoryCardWorkClaimSchema = z.object({
  id: IdSchema, cardId: IdSchema, node: AgentNodeRefSchema,
  state: z.enum(['armed','consumed','canceled']),
  consumedBy: LogicalWorkRefSchema.nullable(),
}).strict().refine((claim) => (claim.state === 'consumed') === (claim.consumedBy !== null), {
  path: ['consumedBy'], message: 'Only a consumed claim identifies its admitted work.',
});
const MemoryCardEditableFields = {
  title: z.string().trim().min(1).max(240), body: z.string().max(8000),
  status: MemoryCardStatusSchema,
  completionKind: z.enum(['completed','dropped']).nullable(),
  reason: z.string().trim().max(1000).nullable(),
  assignee: AgentNodeRefSchema.nullable(), linkedNodes: z.array(AgentNodeRefSchema),
};
export const MemoryBoardMutationSchema = z.discriminatedUnion('kind', [
  CommandOptionsSchema.extend({ kind: z.literal('card_create'), boardId: IdSchema,
    card: z.object(MemoryCardEditableFields).strict().superRefine(refineCardState), sourcePostId: IdSchema.optional(),
    workSelections: z.array(MemoryCardWorkSelectionSchema).max(32).optional() }).strict(),
  CommandOptionsSchema.extend({ kind: z.literal('card_update'), boardId: IdSchema,
    cardId: IdSchema, patch: z.object(MemoryCardEditableFields).partial().strict(),
    workSelections: z.array(MemoryCardWorkSelectionSchema).max(32).optional() }).strict(),
  CommandOptionsSchema.extend({ kind: z.literal('note_create'), boardId: IdSchema,
    text: z.string().trim().min(1).max(4000), rank: z.number().int().nonnegative().optional(),
    sourcePostId: IdSchema.optional() }).strict(),
  CommandOptionsSchema.extend({ kind: z.literal('note_update'), boardId: IdSchema,
    noteId: IdSchema, patch: z.object({ text: z.string().trim().min(1).max(4000).optional(),
      rank: z.number().int().nonnegative().optional() }).strict() }).strict(),
  CommandOptionsSchema.extend({ kind: z.literal('note_archive'), boardId: IdSchema,
    noteId: IdSchema, archived: z.boolean() }).strict(),
]).superRefine((mutation, context) => {
  if (mutation.kind === 'card_update' && !Object.values(mutation.patch).some((field) => field !== undefined)
    && !mutation.workSelections?.length) {
    context.addIssue({ code: 'custom', path: ['patch'], message: 'Supply a card change or work selection.' });
  }
  if (mutation.kind === 'note_update' && !Object.values(mutation.patch).some((field) => field !== undefined)) {
    context.addIssue({ code: 'custom', path: ['patch'], message: 'Supply note text or rank.' });
  }
  if ('workSelections' in mutation && mutation.workSelections) {
    const keys = mutation.workSelections.map((selection) => canonicalJson(selection));
    if (new Set(keys).size !== keys.length) context.addIssue({ code: 'custom', path: ['workSelections'], message: 'Duplicate work selections are not allowed.' });
  }
});

export const BoardResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none'),
    reason: z.enum(['no_changes', 'no_access', 'already_recorded']),
    appliedCommandIds: z.array(IdSchema).max(32).optional() }).strict(),
  z.object({ kind: z.literal('changes'),
    operations: z.array(MemoryBoardMutationSchema).min(1).max(32) }).strict(),
]).superRefine((result, context) => {
  if (new TextEncoder().encode(canonicalJson(result)).byteLength > 64 * 1024) {
    context.addIssue({ code: 'custom', message: 'Board effects must fit within 64 KiB.' });
  }
  if (result.kind === 'none' && result.appliedCommandIds?.length && result.reason !== 'already_recorded') {
    context.addIssue({ code: 'custom', path: ['appliedCommandIds'], message: 'Applied commands require already_recorded.' });
  }
});
// MemoryBoardMutationSchema is the complete leaf union above.

export const BoardApplicationReceiptSchema = z.object({
  applicationId: IdSchema, sourceEventKey: z.string().min(1),
  commandIds: z.array(IdSchema), changedCardIds: z.array(IdSchema),
  boardRevisions: z.array(z.object({ boardId: IdSchema,
    revision: z.number().int().nonnegative() }).strict()),
  replayed: z.boolean(),
}).strict();
export const BoardDigestSchema = z.object({
  text: z.string(), cardIds: z.array(IdSchema).max(20),
  byteLength: z.number().int().nonnegative().max(12288), omittedCount: z.number().int().nonnegative(),
}).strict().refine((digest) => digest.byteLength === new TextEncoder().encode(digest.text).byteLength, {
  path: ['byteLength'], message: 'Digest byte length must match its UTF-8 text.',
});
export const BoardLifecycleFactSchema = z.object({
  sourceEventKey: z.string().min(1), agent: AgentIdentitySchema,
  work: LogicalWorkRefSchema, execution: ExecutionRefSchema.optional(),
  phase: z.enum(['admitted','launched','awaiting_acceptance','waiting_children',
    'accepted','retry_admitted','continuation_admitted','blocked','failed','canceled']),
  continuationOf: LogicalWorkRefSchema.optional(),
  controlContinuationId: IdSchema.optional(), previousExecution: ExecutionRefSchema.optional(),
  requestGroupId: IdSchema.optional(), outstandingRequestIds: z.array(IdSchema),
  reason: z.string().nullable(),
}).strict().superRefine((fact, context) => {
  const fail = (message: string) => context.addIssue({ code: 'custom', message });
  if (fact.execution && !executionMatchesWork(fact.execution, fact.work)) fail('Execution must identify the same logical work.');
  if (fact.previousExecution && !executionMatchesWork(fact.previousExecution, fact.work)) fail('Previous execution must identify the same logical work.');
  if (fact.continuationOf && (fact.continuationOf.runId !== fact.work.runId || fact.continuationOf.workflowVersionId !== fact.work.workflowVersionId)) fail('Continuation must retain the same Run and version.');
  if (['blocked', 'failed', 'canceled'].includes(fact.phase) && !fact.reason?.trim()) fail('Negative lifecycle facts require a cause.');
  if (fact.phase === 'accepted' && fact.outstandingRequestIds.length) fail('Accepted work cannot retain outstanding requests.');
  if (fact.phase === 'continuation_admitted') {
    if (fact.continuationOf && !sameLogicalWork(fact.continuationOf, fact.work)) fail('A control continuation must retain the exact logical work.');
    if (!fact.controlContinuationId || !fact.previousExecution || !fact.execution) fail('Continuation admission requires exact previous and successor identities.');
    if (fact.previousExecution?.executionId === fact.execution?.executionId) fail('Continuation requires a distinct successor execution.');
  } else if (fact.controlContinuationId || fact.previousExecution) fail('Control lineage belongs only to continuation admission.');
});


export type MemoryBoardScope = z.infer<typeof MemoryBoardScopeSchema>;
export type MemoryCardStatus = z.infer<typeof MemoryCardStatusSchema>;
export type MemoryCard = z.infer<typeof MemoryCardSchema>;
export type MemoryNote = z.infer<typeof MemoryNoteSchema>;
export type MemoryBoard = z.infer<typeof MemoryBoardSchema>;
export type MemoryCardWorkSelection = z.infer<typeof MemoryCardWorkSelectionSchema>;
export type MemoryCardWorkBinding = z.infer<typeof MemoryCardWorkBindingSchema>;
export type MemoryCardWorkClaim = z.infer<typeof MemoryCardWorkClaimSchema>;
export type MemoryBoardMutation = z.infer<typeof MemoryBoardMutationSchema>;
export type BoardResult = z.infer<typeof BoardResultSchema>;
export type BoardApplicationReceipt = z.infer<typeof BoardApplicationReceiptSchema>;
export type BoardDigest = z.infer<typeof BoardDigestSchema>;
export type BoardLifecycleFact = z.infer<typeof BoardLifecycleFactSchema>;

/** Only an execution subject may propose structured result effects. Consultations use ordinary writes. */
export const BoardResultApplicationSchema = z.object({
  subject: AgentSubjectSchema, execution: ExecutionRefSchema, work: LogicalWorkRefSchema,
  sourceEventKey: z.string().min(1), result: BoardResultSchema,
}).strict().superRefine((application, context) => {
  if (application.subject.kind !== 'execution' || !sameExecution(application.subject.execution, application.execution)
    || !executionMatchesWork(application.execution, application.work)) {
    context.addIssue({ code: 'custom', message: 'Board result effects require the exact execution subject and logical work.' });
  }
});
export type BoardResultApplication = z.infer<typeof BoardResultApplicationSchema>;

export const MemoryBoardMutationReceiptSchema = z.object({
  commandId: IdSchema, outcome: z.enum(['created', 'existing', 'updated', 'unchanged']),
  card: MemoryCardSchema.optional(), note: MemoryNoteSchema.optional(),
  bindings: z.array(MemoryCardWorkBindingSchema), claims: z.array(MemoryCardWorkClaimSchema),
  boardRevision: z.number().int().nonnegative(),
}).strict();
export type MemoryBoardMutationReceipt = z.infer<typeof MemoryBoardMutationReceiptSchema>;

/** Public validation of a patch against the current scoped row, without any persistence. */
export const MemoryBoardMutationContextSchema = z.object({
  board: MemoryBoardSchema, mutation: MemoryBoardMutationSchema,
  currentCard: MemoryCardSchema.optional(), currentNote: MemoryNoteSchema.optional(),
  sourcePost: z.object({ id: IdSchema, workspaceId: IdSchema, workflowId: IdSchema }).strict().optional(),
  selectedWork: z.array(z.object({ work: LogicalWorkRefSchema, node: AgentNodeRefSchema }).strict()).optional(),
}).strict().superRefine((input, context) => {
  const { board, mutation } = input;
  const fail = (message: string) => context.addIssue({ code: 'custom', message });
  const scoped = (node: AgentNodeRef) => node.workspaceId === board.scope.workspaceId
    && (board.scope.kind !== 'workflow' || node.workflowId === board.scope.workflowId);
  if (board.id !== mutation.boardId) fail('Mutation board does not match the selected board.');
  if ('sourcePostId' in mutation && mutation.sourcePostId) {
    const post = input.sourcePost;
    if (!post || post.id !== mutation.sourcePostId || post.workspaceId !== board.scope.workspaceId
      || board.scope.kind === 'workflow' && post.workflowId !== board.scope.workflowId) fail('Source post must be visible in the same board scope.');
  }
  let card: z.infer<typeof MemoryCardSchema> | undefined;
  if (mutation.kind === 'card_create') {
    if (mutation.card.assignee && !scoped(mutation.card.assignee) || mutation.card.linkedNodes.some((node) => !scoped(node))) fail('Card links must share the board scope.');
  } else if (mutation.kind === 'card_update') {
    const current = input.currentCard;
    if (!current || current.id !== mutation.cardId || current.boardId !== board.id) fail('Card update requires the selected current card.');
    else {
      const definedPatch = Object.fromEntries(Object.entries(mutation.patch).filter(([, value]) => value !== undefined));
      const merged = MemoryCardSchema.safeParse({ ...current, ...definedPatch });
      if (!merged.success) merged.error.issues.forEach((issue) => context.addIssue({ code: 'custom', path: ['mutation', 'patch', ...issue.path], message: issue.message }));
      else card = merged.data;
      if (current.status === 'done' && card && card.status !== 'done' && !mutation.patch.reason?.trim()) fail('Reopening a card requires an explicit reason.');
    }
  } else if (mutation.kind !== 'note_create') {
    if (!input.currentNote || input.currentNote.id !== mutation.noteId || input.currentNote.boardId !== board.id) fail('Note update requires the selected current note.');
  }
  if (card && (card.assignee && !scoped(card.assignee) || card.linkedNodes.some((node) => !scoped(node)))) fail('Card links must share the board scope.');
  if ('workSelections' in mutation) for (const selection of mutation.workSelections ?? []) {
    if (selection.kind === 'next_activation') {
      if (!scoped(selection.node)) fail('Next-activation claims must share the board scope.');
    } else if (!input.selectedWork?.some((selected) => sameLogicalWork(selected.work, selection.work) && scoped(selected.node))) {
      fail('Current work selections require resolved work in the board scope.');
    }
  }
});
export type MemoryBoardMutationContext = z.infer<typeof MemoryBoardMutationContextSchema>;

export function validateMemoryBoardMutation(input: MemoryBoardMutationContext): MemoryBoardMutation {
  return MemoryBoardMutationContextSchema.parse(input).mutation;
}

export function normalizeMemoryCardTitle(title: string): string {
  return title.normalize('NFKC').replace(/\p{White_Space}+/gu, ' ').trim().toLowerCase();
}
