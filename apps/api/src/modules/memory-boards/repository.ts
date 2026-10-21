import { randomUUID } from 'node:crypto'
import {
  MemoryBoardSchema, MemoryCardSchema, MemoryNoteSchema,
  MemoryCardWorkBindingSchema, MemoryCardWorkClaimSchema,
  type MemoryBoardScope, type MemoryCard, type MemoryNote,
  type MemoryCardWorkBinding, type MemoryCardWorkClaim,
} from '@foreman-code/contracts'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { Actor, BoardChange, BoardRow, Counts, MutationReceipt, CommandRead } from './types.js'
import { missing, nodeKey, normalizeTitle, scopeKey, workKey } from './identity.js'
import { saveDigestTargets } from './digestCards.js'

interface StoredBoard { id: string; scope: unknown; revision: string; sequence: string; counts: Counts; next_note_rank: string }
function boardRow(row: StoredBoard): BoardRow {
  return { board: MemoryBoardSchema.parse({ id: row.id, scope: row.scope, revision: Number(row.revision) }),
    sequence: Number(row.sequence), counts: row.counts, nextNoteRank: Number(row.next_note_rank) }
}
export async function loadBoard(tx: GraphTransactionSql, id: string): Promise<BoardRow> {
  const result = await tx.query<StoredBoard>('select * from memory_boards where id=$1 for update', [id])
  return boardRow(result.rows[0] ?? missing('Memory board'))
}
export async function readBoard(tx: GraphTransactionSql, id: string): Promise<BoardRow> {
  const result = await tx.query<StoredBoard>('select * from memory_boards where id=$1', [id])
  return boardRow(result.rows[0] ?? missing('Memory board'))
}
export async function ensureBoard(tx: GraphTransactionSql, scope: MemoryBoardScope): Promise<BoardRow> {
  await tx.query('insert into memory_boards(id,scope_key,scope) values($1,$2,$3) on conflict(scope_key) do nothing',
    [randomUUID(), scopeKey(scope), scope])
  const result = await tx.query<StoredBoard>('select * from memory_boards where scope_key=$1 for update', [scopeKey(scope)])
  return boardRow(result.rows[0] ?? missing('Memory board'))
}
export async function peekBoardScope(tx: GraphTransactionSql, id: string): Promise<MemoryBoardScope> {
  const result = await tx.query<{ scope: MemoryBoardScope }>('select scope from memory_boards where id=$1', [id])
  return result.rows[0]?.scope ?? missing('Memory board')
}
export async function findScopeBoard(tx: GraphTransactionSql, scope: MemoryBoardScope): Promise<BoardRow | undefined> {
  const result = await tx.query<StoredBoard>('select * from memory_boards where scope_key=$1', [scopeKey(scope)])
  return result.rows[0] ? boardRow(result.rows[0]) : undefined
}
export async function cardById(tx: GraphTransactionSql, boardId: string, id: string): Promise<MemoryCard> {
  const result = await tx.query<{ record: unknown }>('select record from memory_cards where board_id=$1 and id=$2', [boardId,id])
  return MemoryCardSchema.parse(result.rows[0]?.record ?? missing('Task'))
}
export async function cardByTitle(tx: GraphTransactionSql, boardId: string, title: string): Promise<MemoryCard | undefined> {
  const result = await tx.query<{ record: unknown }>('select record from memory_cards where board_id=$1 and normalized_title=$2',
    [boardId,normalizeTitle(title)])
  return result.rows[0] ? MemoryCardSchema.parse(result.rows[0].record) : undefined
}
export async function cardBlockerSource(tx: GraphTransactionSql, id: string): Promise<'manual' | 'engine' | null> {
  const result = await tx.query<{blocker_source:'manual'|'engine'|null}>('select blocker_source from memory_cards where id=$1',[id])
  return result.rows[0]?.blocker_source ?? null
}
export async function noteById(tx: GraphTransactionSql, boardId: string, id: string): Promise<MemoryNote> {
  const result = await tx.query<{ record: unknown }>('select record from memory_notes where board_id=$1 and id=$2', [boardId,id])
  return MemoryNoteSchema.parse(result.rows[0]?.record ?? missing('Note'))
}
export async function bindingsFor(tx: GraphTransactionSql, cardId: string): Promise<MemoryCardWorkBinding[]> {
  const result = await tx.query<{ record: unknown }>('select record from memory_card_bindings where card_id=$1 order by id', [cardId])
  return result.rows.map(row => MemoryCardWorkBindingSchema.parse(row.record))
}
export async function claimsFor(tx: GraphTransactionSql, cardId: string): Promise<MemoryCardWorkClaim[]> {
  const result = await tx.query<{ record: unknown }>('select record from memory_card_claims where card_id=$1 order by id', [cardId])
  return result.rows.map(row => MemoryCardWorkClaimSchema.parse(row.record))
}
export async function saveBinding(tx: GraphTransactionSql, boardId: string, binding: MemoryCardWorkBinding): Promise<void> {
  const record = MemoryCardWorkBindingSchema.parse(binding)
  await tx.query(`insert into memory_card_bindings(id,board_id,card_id,work_key,node_key,record) values($1,$2,$3,$4,$5,$6)
    on conflict(id) do update set work_key=excluded.work_key,node_key=excluded.node_key,record=excluded.record`,
  [record.id,boardId,record.cardId,workKey(record.work),nodeKey(record.node),record])
}
export async function saveClaim(tx: GraphTransactionSql, boardId: string, claim: MemoryCardWorkClaim): Promise<void> {
  const record = MemoryCardWorkClaimSchema.parse(claim)
  await tx.query(`insert into memory_card_claims(id,board_id,card_id,node_key,state,record) values($1,$2,$3,$4,$5,$6)
    on conflict(id) do update set state=excluded.state,record=excluded.record`,
  [record.id,boardId,record.cardId,nodeKey(record.node),record.state,record])
}
export interface ChangeSource {
  actor: Actor; commandId?: string; sourceEventKey?: string; now: string
  provenance?: BoardChange['provenance']; changes?: BoardChange['changes']
  preserveBlocker?: boolean
}
async function publishChange(tx: GraphTransactionSql, row: BoardRow,
  entity: 'card' | 'note', entityId: string, entityRevision: number, source: ChangeSource): Promise<void> {
  row.board = { ...row.board, revision: row.board.revision + 1 }
  row.sequence += 1
  await tx.query('update memory_boards set revision=$2,sequence=$3,counts=$4,next_note_rank=$5 where id=$1',
    [row.board.id,row.board.revision,row.sequence,row.counts,row.nextNoteRank])
  const change: BoardChange = { id: randomUUID(), boardId: row.board.id, sequence: row.sequence,
    boardRevision: row.board.revision, entity, entityId, entityRevision, actor: source.actor,
    occurredAt: source.now,
    ...(source.commandId ? { commandId: source.commandId } : {}),
    ...(source.sourceEventKey ? { sourceEventKey: source.sourceEventKey } : {}),
    ...(source.provenance ? { provenance: source.provenance } : {}),
    ...(source.changes ? { changes: source.changes } : {}) }
  await tx.query('insert into memory_board_changes(board_id,sequence,entity_id,record) values($1,$2,$3,$4)',
    [row.board.id,row.sequence,entityId,change])
  // PostgreSQL defers NOTIFY until COMMIT. A rolled-back engine fact emits nothing.
  await tx.query("select pg_notify('memory_board_changes',$1)", [row.board.id])
}
function countCard(counts: Counts, card: MemoryCard | undefined, delta: number): void {
  if (!card) return
  counts[card.status] += delta
  if (card.status === 'done' && card.completionKind) counts[card.completionKind] += delta
}
export async function saveCard(tx: GraphTransactionSql, row: BoardRow, before: MemoryCard | undefined,
  next: MemoryCard, source: ChangeSource): Promise<MemoryCard> {
  const card = MemoryCardSchema.parse({ ...next, revision: before ? before.revision + 1 : 1, updatedAt: source.now })
  const blockerSource = card.status !== 'blocked' ? null : source.preserveBlocker && before
    ? await cardBlockerSource(tx,card.id) : source.actor.kind === 'engine' ? 'engine' : 'manual'
  await tx.query(`insert into memory_cards(id,board_id,normalized_title,status,completion_kind,updated_at,record,blocker_source)
    values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(id) do update set normalized_title=excluded.normalized_title,
    status=excluded.status,completion_kind=excluded.completion_kind,updated_at=excluded.updated_at,record=excluded.record,blocker_source=excluded.blocker_source`,
  [card.id,card.boardId,normalizeTitle(card.title),card.status,card.completionKind,card.updatedAt,card,blockerSource])
  await saveDigestTargets(tx,card)
  countCard(row.counts,before,-1); countCard(row.counts,card,1)
  const changes: NonNullable<BoardChange['changes']> = {}
  for (const key of ['title','body','status','completionKind','reason'] as const) {
    if (before?.[key] !== card[key]) changes[key] = { before: before?.[key] ?? null, after: card[key] }
  }
  await publishChange(tx,row,'card',card.id,card.revision,{ ...source, changes })
  return card
}
export async function saveNote(tx: GraphTransactionSql, row: BoardRow, before: MemoryNote | undefined,
  next: MemoryNote, source: ChangeSource): Promise<MemoryNote> {
  const note = MemoryNoteSchema.parse({ ...next, revision: before ? before.revision + 1 : 1, updatedAt: source.now })
  await tx.query(`insert into memory_notes(id,board_id,archived,rank,record) values($1,$2,$3,$4,$5)
    on conflict(id) do update set archived=excluded.archived,rank=excluded.rank,record=excluded.record`,
  [note.id,note.boardId,note.archived,note.rank,note])
  if (before && !before.archived) row.counts.notes -= 1
  if (!note.archived) row.counts.notes += 1
  row.nextNoteRank = Math.max(row.nextNoteRank, note.rank + 1)
  const changes: NonNullable<BoardChange['changes']> = {}
  for (const key of ['text','rank','archived'] as const) {
    if (before?.[key] !== note[key]) changes[key] = { before: before?.[key] ?? null, after: note[key] }
  }
  await publishChange(tx,row,'note',note.id,note.revision,{ ...source, changes })
  return note
}
export async function lockIdentity(tx: GraphTransactionSql, key: string): Promise<void> {
  await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`memory:${key}`])
}
export type StoredCommand = { input_hash: string; board_id: string; receipt: MutationReceipt | null;
  rejection: Extract<CommandRead, { state: 'rejected' }>['error'] | null }
export async function commandReceipt(tx: GraphTransactionSql, principalId: string, commandId: string): Promise<StoredCommand | undefined> {
  const result = await tx.query<StoredCommand>(
    'select input_hash,board_id,receipt,rejection from memory_board_commands where principal_id=$1 and command_id=$2', [principalId,commandId])
  return result.rows[0]
}
export async function saveReceipt(tx: GraphTransactionSql, principalId: string, boardId: string,
  hash: string, receipt: MutationReceipt): Promise<void> {
  await tx.query('insert into memory_board_commands(principal_id,command_id,board_id,input_hash,receipt) values($1,$2,$3,$4,$5)',
    [principalId,receipt.commandId,boardId,hash,receipt])
}
