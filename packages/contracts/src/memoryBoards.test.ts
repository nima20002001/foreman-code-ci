import { describe, expect, it } from 'vitest';
import { MemoryCardSchema, MemoryBoardMutationSchema, MemoryBoardMutationContextSchema,
  MemoryCardWorkBindingSchema, MemoryCardWorkClaimSchema, BoardResultSchema, BoardDigestSchema,
  BoardLifecycleFactSchema, BoardResultApplicationSchema, normalizeMemoryCardTitle } from './memoryBoards.js';
import { collaborationContractFixtures as fixture } from './collaborationFixtures.js';

describe('memory board public contracts', () => {
  it('validates complete card outcomes and reasons', () => {
    expect(MemoryCardSchema.parse(fixture.card)).toEqual(fixture.card);
    expect(MemoryCardSchema.safeParse({ ...fixture.card, status: 'done' }).success).toBe(false);
    expect(MemoryCardSchema.safeParse({ ...fixture.card, status: 'done', completionKind: 'dropped' }).success).toBe(false);
    expect(MemoryCardSchema.safeParse({ ...fixture.card, status: 'blocked', reason: ' ' }).success).toBe(false);
    expect(MemoryCardSchema.safeParse({ ...fixture.card, status: 'waiting_for_user', reason: null }).success).toBe(false);
    expect(MemoryCardSchema.safeParse({ ...fixture.card, status: 'waiting_for_user', reason: 'Pay on the checkout page' }).success).toBe(true);
    expect(MemoryCardSchema.safeParse({ ...fixture.card, status: 'done', completionKind: 'completed' }).success).toBe(true);
  });

  it('accepts optional command/revision and validates partial patches against current state', () => {
    const mutation = { kind: 'card_update', boardId: fixture.board.id, cardId: fixture.card.id, patch: { status: 'blocked' } };
    expect(MemoryBoardMutationSchema.safeParse(mutation).success).toBe(true);
    expect(MemoryBoardMutationContextSchema.safeParse({ board: fixture.board, mutation, currentCard: fixture.card }).success).toBe(false);
    expect(MemoryBoardMutationContextSchema.safeParse({ board: fixture.board,
      mutation: { ...mutation, patch: { status: 'blocked', reason: 'Waiting for input' }, commandId: 'command', expectedRevision: 1 }, currentCard: fixture.card }).success).toBe(true);
    expect(MemoryBoardMutationSchema.safeParse({ ...mutation, patch: {} }).success).toBe(false);
    expect(MemoryBoardMutationSchema.safeParse({ ...mutation, actor: fixture.agent }).success).toBe(false);
    expect(MemoryBoardMutationContextSchema.safeParse({ board: fixture.board,
      mutation: { ...mutation, patch: { status: 'doing', completionKind: null } },
      currentCard: { ...fixture.card, status: 'done', completionKind: 'completed' } }).success).toBe(false);
  });

  it('rejects cross-scope links, duplicate work selections and forged note source posts', () => {
    const mutation = { kind: 'card_update', boardId: 'board', cardId: 'card', patch: {},
      workSelections: [{ kind: 'next_activation', node: fixture.node }] };
    expect(MemoryBoardMutationContextSchema.safeParse({ board: fixture.board, mutation, currentCard: fixture.card }).success).toBe(true);
    expect(MemoryBoardMutationSchema.safeParse({ ...mutation, workSelections: [...mutation.workSelections, ...mutation.workSelections] }).success).toBe(false);
    expect(MemoryBoardMutationContextSchema.safeParse({ board: fixture.board, currentCard: fixture.card,
      mutation: { ...mutation, workSelections: [{ kind: 'next_activation', node: { ...fixture.node, workflowId: 'other' } }] } }).success).toBe(false);
    const note = { kind: 'note_create', boardId: 'board', text: 'Keep this context', sourcePostId: 'post' };
    expect(MemoryBoardMutationContextSchema.safeParse({ board: fixture.board, mutation: note,
      sourcePost: { id: 'post', workspaceId: 'workspace', workflowId: 'other' } }).success).toBe(false);
    expect(MemoryBoardMutationContextSchema.safeParse({ board: fixture.board, mutation: note,
      sourcePost: { id: 'post', workspaceId: 'workspace', workflowId: 'workflow' } }).success).toBe(true);
    expect(MemoryBoardMutationSchema.safeParse({ kind: 'note_update', boardId: 'board', noteId: 'note', patch: {} }).success).toBe(false);
  });

  it('keeps claims and bindings tied to admitted logical work', () => {
    const claim = { id: 'claim', cardId: 'card', node: fixture.node, state: 'armed', consumedBy: null };
    expect(MemoryCardWorkClaimSchema.safeParse(claim).success).toBe(true);
    expect(MemoryCardWorkClaimSchema.safeParse({ ...claim, state: 'consumed' }).success).toBe(false);
    expect(MemoryCardWorkClaimSchema.safeParse({ ...claim, state: 'consumed', consumedBy: fixture.work }).success).toBe(true);
    const binding = { id: 'binding', cardId: 'card', node: fixture.node, work: fixture.work,
      currentExecutionId: 'execution', state: 'running', reason: null, revision: 0 };
    const resolution = { kind: 'dropped', commandId: 'command', reason: 'No longer needed', resolvedAt: fixture.createdAt };
    expect(MemoryCardWorkBindingSchema.safeParse({ ...binding, resolution }).success).toBe(false);
    expect(MemoryCardWorkBindingSchema.safeParse({ ...binding, state: 'failed', reason: 'Native failure', resolution }).success).toBe(true);
  });

  it('distinguishes authoritative return lineage from same-work control continuation', () => {
    const fact = { sourceEventKey: 'event', agent: fixture.agent, work: fixture.work, execution: fixture.execution,
      phase: 'accepted', outstandingRequestIds: [], reason: null };
    expect(BoardLifecycleFactSchema.safeParse(fact).success).toBe(true);
    expect(BoardLifecycleFactSchema.safeParse({ ...fact, outstandingRequestIds: ['request'] }).success).toBe(false);
    expect(BoardLifecycleFactSchema.safeParse({ ...fact, phase: 'failed' }).success).toBe(false);
    expect(BoardLifecycleFactSchema.safeParse({ ...fact, phase: 'launched', continuationOf: fixture.work,
      work: { ...fixture.work, activationId: 'return-activation' },
      execution: { ...fixture.execution, activationId: 'return-activation', executionId: 'return-execution' } }).success).toBe(true);
    expect(BoardLifecycleFactSchema.safeParse({ ...fact, phase: 'continuation_admitted', controlContinuationId: 'control',
      previousExecution: fixture.execution, execution: { ...fixture.execution, executionId: 'successor', attempt: 2 } }).success).toBe(true);
    expect(BoardLifecycleFactSchema.safeParse({ ...fact, phase: 'continuation_admitted', controlContinuationId: 'control',
      previousExecution: fixture.execution, execution: { ...fixture.execution, executionId: 'successor', activationId: 'other' } }).success).toBe(false);
  });

  it('validates digest bytes and never accepts consultation result effects', () => {
    expect(BoardDigestSchema.safeParse({ text: 'é', byteLength: 2, cardIds: [], omittedCount: 0 }).success).toBe(true);
    expect(BoardDigestSchema.safeParse({ text: 'é', byteLength: 1, cardIds: [], omittedCount: 0 }).success).toBe(false);
    const result = { kind: 'none', reason: 'no_access' };
    expect(BoardResultSchema.parse(result)).toEqual(result);
    expect(BoardResultApplicationSchema.safeParse({ sourceEventKey: 'event', execution: fixture.execution, work: fixture.work, result,
      subject: { kind: 'coordinator_consultation', agent: fixture.agent, binding: fixture.binding } }).success).toBe(false);
  });

  it('normalizes Unicode whitespace without deleting punctuation', () => {
    expect(normalizeMemoryCardTitle('  ＴＡＳＫ\u0085One\u00a0—  Done  ')).toBe('task one — done');
    expect(normalizeMemoryCardTitle('Task-one')).not.toBe(normalizeMemoryCardTitle('Task one'));
  });
});
