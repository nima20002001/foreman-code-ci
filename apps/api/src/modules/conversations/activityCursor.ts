import type pg from 'pg'
import { withTransaction } from '../../infrastructure/transaction.js'
import { DomainError } from '../errors.js'
type Queryable = Pick<pg.PoolClient, 'query'>
export async function withConversationPageRead<T>(pool: pg.Pool, work: (query: Queryable) => Promise<T>): Promise<T> {
  return withTransaction(pool, work, { isolation: 'repeatable read', readOnly: true })
}
/** The numeric key belongs to one actual stored source row, never another conversation's page. */
export async function assertConversationCursor(query: Queryable, conversationId: string, before: string | undefined,
  source: 'messages' | 'turns' | 'activity') {
  if (before === undefined) return
  const table = source === 'messages' ? 'operator_conversation_messages' : source === 'turns' ? 'operator_conversation_turns' : 'operator_conversation_activity'
  const column = source === 'turns' ? 'turn_sequence' : 'sequence'
  const anchor = (await query.query<{ conversation_id: string }>(`select conversation_id from ${table} where ${column}=$1::bigint`, [before])).rows[0]
  const prefix = source === 'messages' ? 'MESSAGE_HISTORY' : source === 'turns' ? 'TURN_HISTORY' : 'ACTIVITY'
  if (!anchor) throw new DomainError(`${prefix}_CURSOR_EXPIRED`, 'The cursor source is unavailable. Reload this conversation.', 410)
  if (anchor.conversation_id !== conversationId) throw new DomainError(`${prefix}_CURSOR_SCOPE_CONFLICT`, 'The cursor belongs to another conversation.', 409)
}
