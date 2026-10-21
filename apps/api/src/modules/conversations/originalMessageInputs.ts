import type { Message } from '@foreman-code/contracts'
import { MessageAttachmentRefsSchema } from '@foreman-code/contracts/files'
import type pg from 'pg'

/** Recover only the exact admitted request; a displayed publication cannot create a send input. */
export async function readOriginalMessageInputs(query: Pick<pg.PoolClient, 'query'>, conversationId: string, messageIds: string[]) {
  if (!messageIds.length) return new Map<string, NonNullable<Message['originalInput']>>()
  const rows = (await query.query<{ id: string; request_id: string; content: string; input_pins: unknown }>(`
    select m.id,t.request_id,t.payload->>'content' as content,coalesce(m.record->'attachmentRefs','[]'::jsonb) as input_pins
    from operator_conversations c join operator_conversation_messages m on m.conversation_id=c.id
    join operator_conversation_turns t on t.conversation_id=c.id and t.message_id=m.id and t.request_id=m.client_request_id
    where c.id=$1 and c.deleted_at is null and c.kind in ('agent','operator') and m.role='user'
      and m.id=any($2::text[]) and jsonb_typeof(t.payload->'content')='string'`, [conversationId, messageIds])).rows
  return new Map(rows.map((row) => [row.id, { requestId: row.request_id, content: row.content,
    attachments: MessageAttachmentRefsSchema.parse(row.input_pins) }]))
}
