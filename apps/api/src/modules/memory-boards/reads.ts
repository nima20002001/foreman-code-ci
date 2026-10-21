import { decodeCursor, page } from './pagination.js'
import { readBindingsPage, readClaimsPage, readWorkSummary } from './workReads.js'
import { z } from 'zod'
import { MemoryBoardScopeSchema, MemoryCardSchema, MemoryNoteSchema,
  type MemoryCard, type MemoryNote } from '@foreman-code/contracts'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { BoardChange, BoardRow, ChangesPage, Page, ReadRequest, ReadResult } from './types.js'
import { inputHash, invalid, normalizeTitle } from './identity.js'
import { cardById, commandReceipt } from './repository.js'

export const MemoryReadInputSchema = z.object({
  scope: MemoryBoardScopeSchema.optional(), boardId: z.string().min(1).optional(),
  view: z.enum(['board','cards','card','notes','command','bindings','claims']).default('board'),
  status: z.enum(['todo','doing','waiting_for_user','blocked','done']).optional(), completionKind: z.enum(['completed','dropped']).optional(),
  query: z.string().max(240).optional(),
  cardId: z.string().min(1).optional(), commandId: z.string().min(1).optional(),
  archived: z.boolean().optional(), cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(100).optional(),
}).strict().superRefine((input, context) => {
  if (!!input.scope === !!input.boardId) context.addIssue({ code: 'custom', message: 'Select exactly one scope or board ID.' })
  if (input.view === 'cards' && !input.status) context.addIssue({ code: 'custom', message: 'Select one card column.' })
  if (['card','bindings','claims'].includes(input.view) && !input.cardId) context.addIssue({ code: 'custom', message: 'Provide a card ID.' })
  if (input.view === 'command' && !input.commandId) context.addIssue({ code: 'custom', message: 'Provide a command ID.' })
  if (input.completionKind && input.status !== 'done') context.addIssue({ code: 'custom', message: 'Completion outcome is a Done filter.' })
})
export const MemoryChangesInputSchema = z.object({ boardId: z.string().min(1),
  afterSequence: z.number().int().nonnegative().optional(), cursor: z.string().max(2048).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict()
export async function readCards(tx: GraphTransactionSql, row: BoardRow, request: ReadRequest): Promise<Page<MemoryCard>> {
  const limit = request.limit ?? 20, query = normalizeTitle(request.query ?? '')
  const key = inputHash({ boardId: row.board.id, status: request.status, completionKind: request.completionKind ?? null,
    query, order: query ? 'title' : 'recent' })
  const cursor = decodeCursor(request.cursor,key,row.board.revision)
  const args: unknown[] = [row.board.id,request.status]
  const clauses = ['board_id=$1','status=$2']
  if (request.completionKind) { args.push(request.completionKind); clauses.push(`completion_kind=$${args.length}`) }
  if (query) {
    args.push(`${query.replace(/[\\%_]/gu,'\\$&')}%`)
    clauses.push(`normalized_title like $${args.length} escape '\\'`)
  }
  if (cursor) {
    args.push(cursor.last[0],cursor.last[1])
    clauses.push(`(${query ? 'normalized_title collate "C"' : 'updated_at'},id) ${query ? '>' : '<'} ($${args.length-1},$${args.length})`)
  }
  args.push(limit+1)
  const result = await tx.query<{ record: unknown }>(`select record from memory_cards where ${clauses.join(' and ')}
    order by ${query ? 'normalized_title collate "C",id' : 'updated_at desc,id desc'} limit $${args.length}`,args)
  return page(result.rows.map(result => MemoryCardSchema.parse(result.record)),limit,row.board.revision,key,
    card => [query ? normalizeTitle(card.title) : card.updatedAt,card.id])
}
export async function readNotes(tx: GraphTransactionSql, row: BoardRow, request: ReadRequest): Promise<Page<MemoryNote>> {
  const limit = request.limit ?? 20, archived = request.archived ?? false
  const key = inputHash({ boardId: row.board.id, archived, kind: 'notes' })
  const cursor = decodeCursor(request.cursor,key,row.board.revision)
  const args: unknown[] = [row.board.id,archived]
  let after = ''
  if (cursor) { args.push(cursor.last[0],cursor.last[1]); after = 'and (rank,id)>($3,$4)' }
  args.push(limit+1)
  const result = await tx.query<{ record: unknown }>(`select record from memory_notes where board_id=$1 and archived=$2 ${after}
    order by rank,id limit $${args.length}`,args)
  return page(result.rows.map(result => MemoryNoteSchema.parse(result.record)),limit,row.board.revision,key,note => [note.rank,note.id])
}
async function history(tx: GraphTransactionSql, row: BoardRow, request: ReadRequest): Promise<Page<BoardChange>> {
  const key = inputHash({ boardId: row.board.id, cardId: request.cardId, kind: 'history' }), limit = request.limit ?? 20
  const cursor = decodeCursor(request.cursor,key,row.board.revision), args: unknown[] = [row.board.id,request.cardId]
  let after = ''
  if (cursor) { args.push(cursor.last[0]); after = 'and sequence<$3' }
  args.push(limit+1)
  const result = await tx.query<{ record: BoardChange }>(`select record from memory_board_changes where board_id=$1 and entity_id=$2 ${after}
    order by sequence desc limit $${args.length}`,args)
  return page(result.rows.map(result => result.record),limit,row.board.revision,key,change => [change.sequence,change.id])
}
export async function readProjection(tx: GraphTransactionSql, row: BoardRow, request: ReadRequest, principalId: string): Promise<ReadResult> {
  if (request.view === 'cards') return readCards(tx,row,request)
  if (request.view === 'notes') return readNotes(tx,row,request)
  if (request.view === 'bindings' || request.view === 'claims') {
    await cardById(tx, row.board.id, request.cardId!)
    return request.view === 'bindings' ? readBindingsPage(tx, row, request) : readClaimsPage(tx, row, request)
  }
  if (request.view === 'card') {
    const card = await cardById(tx, row.board.id, request.cardId!)
    const { items: bindings, ...bindingPage } = await readBindingsPage(tx, row, { ...request, cursor: undefined })
    const { items: claims, ...claimPage } = await readClaimsPage(tx, row, { ...request, cursor: undefined })
    return { card, bindings, claims, bindingPage, claimPage, workSummary: await readWorkSummary(tx, card.id),
      history: await history(tx, row, request) }
  }
  if (request.view === 'command') {
    const stored = await commandReceipt(tx,principalId,request.commandId!)
    if (!stored || stored.board_id !== row.board.id) return { commandId: request.commandId!, state: 'unknown' }
    if (stored.rejection) return { commandId: request.commandId!, state: 'rejected', error: stored.rejection }
    return { commandId: request.commandId!, state: 'known', receipt: stored.receipt! }
  }
  const openColumns = []
  for (const status of ['todo','doing','waiting_for_user','blocked'] as const) openColumns.push({ status, ...await readCards(tx,row,{ status,limit:20 }) })
  return { board: row.board, openColumns, notes: await readNotes(tx,row,{ limit:20 }), counts: row.counts, sequence: row.sequence }
}
export async function readChanges(tx: GraphTransactionSql, row: BoardRow, request: z.infer<typeof MemoryChangesInputSchema>): Promise<ChangesPage> {
  const limit = request.limit ?? 50
  let after = request.afterSequence ?? row.sequence
  if (request.cursor) {
    let saved: { boardId: string; after: number }
    try { saved = z.object({ boardId:z.string(),after:z.number().int().nonnegative() }).strict()
      .parse(JSON.parse(Buffer.from(request.cursor,'base64url').toString('utf8'))) }
    catch { invalid('This changes cursor is invalid.') }
    if (saved.boardId !== row.board.id) invalid('This changes cursor belongs to another board.')
    after = saved.after
  }
  const result = await tx.query<{ record: BoardChange }>(
    'select record from memory_board_changes where board_id=$1 and sequence>$2 order by sequence limit $3',[row.board.id,after,limit+1])
  const values = result.rows.map(item => item.record), hasMore = values.length > limit, items = values.slice(0,limit)
  const resetRequired = after > row.sequence || (after < row.sequence && (!items.length || items[0]!.sequence !== after+1))
  return { items: resetRequired ? [] : items, hasMore: !resetRequired && hasMore, revision: row.board.revision,
    nextCursor: !resetRequired && hasMore ? Buffer.from(JSON.stringify({ boardId:row.board.id,after:items[items.length-1]!.sequence })).toString('base64url') : null,
    watermark: row.sequence, resetRequired }
}
