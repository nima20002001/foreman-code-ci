import type { z } from 'zod'
import { MemoryCardWorkBindingSchema, MemoryCardWorkClaimSchema,
  type MemoryCardWorkBinding, type MemoryCardWorkClaim } from '@foreman-code/contracts'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { BoardRow, Page, ReadRequest } from './types.js'
import { decodeCursor, page } from './pagination.js'
import { inputHash } from './identity.js'

const unresolved = "record->'resolution' is null and record->>'state'<>'accepted'"
const bindingPriority = `case when ${unresolved} then 0 else 1 end`
const claimPriority = "case when state='armed' then 0 else 1 end"

async function readWorkPage<T>(tx: GraphTransactionSql, row: BoardRow, request: ReadRequest,
  kind: 'bindings' | 'claims', schema: z.ZodType<T>, priority: string): Promise<Page<T>> {
  const limit = request.limit ?? 20
  const key = inputHash({ boardId: row.board.id, cardId: request.cardId, kind })
  const cursor = decodeCursor(request.cursor, key, row.board.revision)
  const records = await tx.query<{ record: unknown; priority: number; id: string }>(`
    select record,(${priority}) as priority,id from memory_card_${kind}
    where board_id=$1 and card_id=$2
      and ($3::integer is null or ((${priority}),id)>($3,$4))
    order by (${priority}),id limit $5`,
  [row.board.id, request.cardId, cursor?.last[0] ?? null, cursor?.last[1] ?? null, limit + 1])
  const result = page(records.rows, limit, row.board.revision, key, record => [record.priority, record.id])
  return { ...result, items: result.items.map(record => schema.parse(record.record)) }
}

export function readBindingsPage(tx: GraphTransactionSql, row: BoardRow, request: ReadRequest): Promise<Page<MemoryCardWorkBinding>> {
  return readWorkPage(tx, row, request, 'bindings', MemoryCardWorkBindingSchema, bindingPriority)
}
export function readClaimsPage(tx: GraphTransactionSql, row: BoardRow, request: ReadRequest): Promise<Page<MemoryCardWorkClaim>> {
  return readWorkPage(tx, row, request, 'claims', MemoryCardWorkClaimSchema, claimPriority)
}
export async function readWorkSummary(tx: GraphTransactionSql, cardId: string) {
  const bindings = (await tx.query<{ active: string; failed: string }>(`select
    count(*) filter(where record->>'state' not in ('failed','canceled'))::text as active,
    count(*) filter(where record->>'state' in ('failed','canceled'))::text as failed
    from memory_card_bindings where card_id=$1 and ${unresolved}`, [cardId])).rows[0]!
  const claims = (await tx.query<{ armed: string }>(
    "select count(*)::text as armed from memory_card_claims where card_id=$1 and state='armed'", [cardId])).rows[0]!
  return { activeBindings: Number(bindings.active), unresolvedFailures: Number(bindings.failed), armedClaims: Number(claims.armed) }
}
