import { randomUUID } from 'node:crypto'
import { MemoryCardSchema, MemoryNoteSchema, type MemoryCard, type MemoryNote } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { BoardRow, MemoryBoardAuthority, MutationContext, MutationReceipt, Operation } from './types.js'
import { inputHash, invalid, same } from './identity.js'
import { aggregateCard, resolveTerminalWork, selectWork, validateCardState, validateLinks } from './work.js'
import { bindingsFor, cardById, cardByTitle, claimsFor, commandReceipt, noteById,
  saveBinding, saveCard, saveClaim, saveNote, saveReceipt } from './repository.js'

function expected(revision: number, operation: Operation, current: unknown): void {
  if (operation.expectedRevision !== undefined && operation.expectedRevision !== revision) {
    throw new DomainError('REVISION_CONFLICT','This item changed. Review the current version and keep or update your draft.',409,{ current })
  }
}
export function replayCommand(stored: Awaited<ReturnType<typeof commandReceipt>>, operation: Operation): MutationReceipt | undefined {
  if (!stored) return undefined
  if (stored.input_hash !== inputHash(operation) || stored.board_id !== operation.boardId) {
    throw new DomainError('COMMAND_INPUT_CONFLICT','This command ID already belongs to different input.',409)
  }
  if (stored.rejection) throw new DomainError(stored.rejection.code,stored.rejection.message,stored.rejection.status,stored.rejection.details)
  return stored.receipt ?? undefined
}
async function cardMutation(tx: GraphTransactionSql, authority: MemoryBoardAuthority, row: BoardRow,
  context: MutationContext, operation: Extract<Operation,{ kind: 'card_create' | 'card_update' }>, now: string): Promise<MutationReceipt> {
  const creating = operation.kind === 'card_create'
  const before = creating ? undefined : await cardById(tx,row.board.id,operation.cardId)
  if (creating) {
    const existing = await cardByTitle(tx,row.board.id,operation.card.title)
    if (existing) return { commandId: operation.commandId, outcome: 'existing', card: existing,
      bindings: await bindingsFor(tx,existing.id), claims: await claimsFor(tx,existing.id), boardRevision: row.board.revision }
  }
  expected(before?.revision ?? row.board.revision,operation,before ?? row.board)
  if (!creating && Object.keys(operation.patch).length === 0 && operation.workSelections === undefined) invalid('Provide a card field or work selection.')
  const next: MemoryCard = MemoryCardSchema.parse(creating ? {
    ...operation.card, id: randomUUID(), boardId: row.board.id, revision: 0, createdAt: now, updatedAt: now,
    ...(operation.sourcePostId ? { sourcePostId: operation.sourcePostId } : {}),
  } : { ...before, ...operation.patch })
  validateCardState(next,before)
  await validateLinks(tx,authority,row.board.scope,next)
  const duplicate = await cardByTitle(tx,row.board.id,next.title)
  if (duplicate && duplicate.id !== next.id) throw new DomainError('DUPLICATE_CARD_TITLE',
    'A task with that title already exists on this board.',409,{ cardId: duplicate.id, card: duplicate })
  if (creating && operation.sourcePostId) await authority.sourcePost(tx,operation.sourcePostId,row.board.scope,context.caller)
  const bindings = before ? await bindingsFor(tx,next.id) : []
  const claims = before ? await claimsFor(tx,next.id) : []
  const oldBindings = structuredClone(bindings), oldClaims = structuredClone(claims)
  await selectWork(tx,authority,row.board.scope,next,operation.workSelections,context,bindings,claims,creating)
  resolveTerminalWork(next,before,bindings,claims,operation,now)
  const hadNewWork = !same(bindings,oldBindings) || !same(claims,oldClaims)
  // Explicit Blocked or Waiting for user is an honest blocker; work cannot silently complete it.
  const projected = next.status === 'blocked' || next.status === 'waiting_for_user' || next.status === 'done'
    ? next : aggregateCard(next,bindings,claims,false)
  const changed = !before || !same(before,projected) || hadNewWork
  const provenance = { principalId: context.principalId, ...(context.subject ? { subject: context.subject } : {}) }
  const preserveBlocker = before?.status === projected.status && before?.reason === projected.reason
  const card = changed ? await saveCard(tx,row,before,projected,{ actor: context.actor, commandId: operation.commandId, now, provenance, preserveBlocker }) : before!
  if (changed) {
    for (const binding of bindings) if (!oldBindings.some(previous => same(previous,binding))) await saveBinding(tx,row.board.id,binding)
    for (const claim of claims) if (!oldClaims.some(previous => same(previous,claim))) await saveClaim(tx,row.board.id,claim)
  }
  return { commandId: operation.commandId, outcome: creating ? 'created' : changed ? 'updated' : 'unchanged',
    card, bindings, claims, boardRevision: row.board.revision }
}
async function noteMutation(tx: GraphTransactionSql, authority: MemoryBoardAuthority, row: BoardRow,
  context: MutationContext, operation: Extract<Operation,{ kind: 'note_create' | 'note_update' | 'note_archive' }>, now: string): Promise<MutationReceipt> {
  const before = operation.kind === 'note_create' ? undefined : await noteById(tx,row.board.id,operation.noteId)
  expected(before?.revision ?? row.board.revision,operation,before ?? row.board)
  let next: MemoryNote
  if (operation.kind === 'note_create') {
    if (operation.sourcePostId) await authority.sourcePost(tx,operation.sourcePostId,row.board.scope,context.caller)
    next = MemoryNoteSchema.parse({ id: randomUUID(), boardId: row.board.id, text: operation.text,
      rank: operation.rank ?? row.nextNoteRank, archived: false, revision: 0, updatedAt: now,
      ...(operation.sourcePostId ? { sourcePostId: operation.sourcePostId } : {}) })
  } else if (operation.kind === 'note_update') {
    if (Object.keys(operation.patch).length === 0) invalid('Provide note text or rank.')
    next = MemoryNoteSchema.parse({ ...before, ...operation.patch })
  } else next = MemoryNoteSchema.parse({ ...before, archived: operation.archived })
  const changed = !before || !same(before,next)
  const provenance = { principalId: context.principalId, ...(context.subject ? { subject: context.subject } : {}) }
  const note = changed ? await saveNote(tx,row,before,next,{ actor: context.actor, commandId: operation.commandId, now, provenance }) : before!
  return { commandId: operation.commandId, outcome: !before ? 'created' : changed ? 'updated' : 'unchanged',
    note, bindings: [], claims: [], boardRevision: row.board.revision }
}
export async function mutateLocked(tx: GraphTransactionSql, authority: MemoryBoardAuthority, row: BoardRow,
  context: MutationContext, operation: Operation, now: string): Promise<MutationReceipt> {
  const replay = replayCommand(await commandReceipt(tx,context.principalId,operation.commandId),operation)
  if (replay) return replay
  const receipt = operation.kind === 'card_create' || operation.kind === 'card_update'
    ? await cardMutation(tx,authority,row,context,operation,now)
    : await noteMutation(tx,authority,row,context,operation,now)
  await saveReceipt(tx,context.principalId,row.board.id,inputHash(operation),receipt)
  return receipt
}
export function checkCapacity(rows: Iterable<BoardRow>): void {
  for (const row of rows) if (row.counts.todo + row.counts.doing + row.counts.waiting_for_user + row.counts.blocked > 10_000 || row.counts.notes > 1_000) {
    throw new DomainError('MEMORY_BOARD_CAPACITY','This board has reached its open task or active note capacity. Finish tasks or archive notes, then retry.',409)
  }
}
