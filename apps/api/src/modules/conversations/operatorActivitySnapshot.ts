import type pg from 'pg'
import { ActivitySnapshotV1Schema, projectActivityStatus, type ActivitySnapshotV1, type ActivitySourceRevision, type PendingNativeInteraction, type WorkRef, type WorkSummary } from '@foreman-code/contracts'
import { readActivityCommands } from './activityCommands.js'
import { conversationActivityId, conversationActivityKey, publicActivityProvenance } from './activityIdentity.js'
import { chatInteractionSummary, conversationPublicationItems, conversationTextItems, messageSourceRevisions } from './activityItems.js'
import { PostgresOperatorActivityRepository } from './operatorActivityRepository.js'
import { readConversationPublicationReceipts } from './messagePublications.js'
import { hydrateMessageAttachments } from './messageAttachments.js'

type Queryable = Pick<pg.PoolClient, 'query'>
interface OwnerRow {
  id: string; revision: string; harness: string; native_session_id: string | null; active_request_id: string | null;
  active_native_turn_id: string | null; cancel_requested: boolean; turn_state: string; pending_interaction: PendingNativeInteraction | null;
  response_delivery: 'offered' | 'submitted' | 'uncertain' | null
}
interface Receipt { request_id: string; sequence: string; started_at: Date | null; outcome: string | null; native_turn_id: string | null }

/** Caller authorization stays with OperatorChatService. All component reads use its one read transaction. */
export async function readOperatorActivitySnapshot(pool: pg.Pool, query: Queryable, id: string): Promise<ActivitySnapshotV1 | undefined> {
  const row = (await query.query<OwnerRow>(`select id,revision::text,harness,native_session_id,active_request_id,active_native_turn_id,
    cancel_requested,turn_state,pending_interaction,response_delivery from operator_conversations
    where id=$1 and kind='operator' and deleted_at is null`, [id])).rows[0]
  if (!row) return undefined
  const receipts = (await query.query<Receipt>(`select request_id,turn_sequence::text as sequence,started_at,result->>'outcome' as outcome,native_turn_id
    from operator_conversation_turns where conversation_id=$1 order by turn_sequence desc limit 101`, [id])).rows
  const latest = receipts[0]
  // The exact active owner is read separately; recent receipts cannot evict it.
  const activeReceipt = row.active_request_id ? (await query.query<Receipt>(`select request_id,turn_sequence::text as sequence,started_at,
    result->>'outcome' as outcome,native_turn_id from operator_conversation_turns where conversation_id=$1 and request_id=$2`, [id, row.active_request_id])).rows[0] : undefined
  const native = row.native_session_id ? { harness: row.harness, sessionId: row.native_session_id,
    ...(row.active_native_turn_id ? { turnId: row.active_native_turn_id } : {}) } : undefined
  const ref = (requestId: string): WorkRef => ({ kind: 'chat_request', conversationId: id, requestId })
  const work: WorkSummary[] = row.active_request_id ? [{ ref: ref(row.active_request_id),
    phase: row.cancel_requested ? 'interrupting' : row.pending_interaction ? 'waiting' : row.turn_state === 'starting' ? 'preparing' : 'active',
    outcome: null, delivery: row.turn_state === 'uncertain' ? 'unknown' : row.active_native_turn_id ? 'accepted' : 'submitting',
    evidence: row.turn_state === 'uncertain' ? 'reconciling' : 'confirmed', startedAt: activeReceipt?.started_at?.toISOString() ?? null,
    ...(native ? { native } : {}) }] : []
  const repository = new PostgresOperatorActivityRepository(pool)
  const activityPage = await repository.snapshotPage(id, { limit: 100 }, query)
  const unfinished = await repository.unfinished(id, query)
  for (const activity of unfinished.activities) {
    if (activity.kind === 'thinking') continue
    work.push({ ref: { kind: activity.kind === 'subagent' ? 'subagent' : 'tool', itemId: conversationActivityId(id, activity.requestId, activity.id) }, phase: 'active',
      outcome: null, delivery: null, evidence: activity.status === 'unknown' ? 'unknown' : 'confirmed', startedAt: null })
  }
  const messageRows = (await query.query<{ record: unknown }>(`select record || jsonb_build_object('revision',activity_record_revision::text,
    'sequence',sequence::text) || case when client_request_id is null then '{}'::jsonb else jsonb_build_object('requestId',client_request_id) end as record
    from (select *,sum(octet_length(record::text)) over(order by sequence desc) as bytes from
      (select * from operator_conversation_messages where conversation_id=$1 order by sequence desc limit 100) recent) bounded
    where bytes <= 262144 order by sequence`, [id])).rows
  const fileSourceRevisions: ActivitySourceRevision[] = []
  const messages = await hydrateMessageAttachments(query, id, messageRows.map((entry) => entry.record), (source) => fileSourceRevisions.push(source))
  const publicationReceipts = await readConversationPublicationReceipts(query, id, messages.filter((message) => message.role === 'user').map((message) => message.id))
  const scope = { kind: 'operator_chat' as const, conversationId: id }
  const commandActivity = await readActivityCommands(query, id, scope, row.revision)
  return ActivitySnapshotV1Schema.parse({ schemaVersion: 1, scope, revision: row.revision,
    sourceRevisions: [{ source: 'scope', id, revision: row.revision }, ...commandActivity.sourceRevisions, ...messageSourceRevisions(messages), ...fileSourceRevisions, ...publicationReceipts.flatMap((receipt) => [{ source: 'publication', id: receipt.receiptId, revision: '0' },
      { source: 'file', id: receipt.fileId, revision: receipt.fileActivityRevision }])],
    ...projectActivityStatus({ work, queued: [], latest: latest ? ref(latest.request_id) : null }),
    ...(unfinished.hasMore ? { hasMoreActiveWork: true } : {}),
    ...(commandActivity.hasMore ? { hasMorePendingInteractions: true } : {}),
    pendingInteractions: [...new Map([...chatInteractionSummary({ conversationId: id, requestId: row.active_request_id, revision: row.revision,
      pending: row.pending_interaction, responseDelivery: row.response_delivery }), ...commandActivity.summaries].map((summary) => [summary.id, summary])).values()].filter((summary) => summary.delivery !== 'delivered'),
    activities: [...commandActivity.summaries.map((summary) => ({ kind: 'interaction', id: summary.id, revision: summary.revision, order: '0',
      owner: summary.owner, source: { schemaVersion: 1, system: 'management_command_receipt', observedAt: null },
      evidence: summary.delivery === 'uncertain' ? 'reconciling' : 'confirmed', interaction: summary })), ...conversationPublicationItems(id, messages, publicationReceipts), ...conversationTextItems(id, messages, { harness: row.harness, sessionId: row.native_session_id,
      turnIdFor: (requestId) => (requestId === row.active_request_id ? activeReceipt : receipts.find((receipt) => receipt.request_id === requestId))?.native_turn_id ?? undefined }),
      ...activityPage.activities.map((activity) => ({ id: conversationActivityId(id, activity.requestId, activity.id), ...publicActivityProvenance(activityPage.itemProvenance[conversationActivityKey(activity.requestId, activity.id)]), revision: activityPage.itemRevisions[conversationActivityKey(activity.requestId, activity.id)], order: activity.sequence,
        orderSource: 'conversation_activity', owner: ref(activity.requestId), source: { schemaVersion: 1, system: 'conversation_record', observedAt: null },
        evidence: activity.status === 'unknown' ? 'unknown' : 'confirmed',
        ...(activity.kind === 'thinking' ? { kind: 'reasoning_summary', summary: activity.title }
          : { kind: activity.kind === 'subagent' ? 'subagent' : 'tool', toolKind: activity.kind, title: activity.title, status: activity.status }) }))],
    page: { before: null, nextCursor: activityPage.nextCursor, hasMore: activityPage.nextCursor !== null } })
}
