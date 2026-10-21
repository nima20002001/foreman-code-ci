import type pg from 'pg'
import type { ActivityScope, ActivitySourceRevision, InteractionSummary } from '@foreman-code/contracts'
import { AcceptedChatResponseControlSchema, matchingChatResponseAcknowledgment } from '@foreman-code/contracts/interaction-activity'

interface Receipt { principal_id: string; operation: string; command_id: string; revision: string; status: string; control: unknown; acknowledgment?: unknown }
export function projectActivityCommands(conversationId: string, scope: ActivityScope, rows: readonly Receipt[], scopeRevision: string) {
  const summaries = new Map<string, InteractionSummary>()
  const sourceRevisions: ActivitySourceRevision[] = []
  for (const row of rows.slice(0, 200)) {
    const commandRevision: ActivitySourceRevision = { source: 'command', id: JSON.stringify([row.principal_id, row.operation, row.command_id]), revision: row.revision }
    sourceRevisions.push(commandRevision)
    const parsed = AcceptedChatResponseControlSchema.safeParse(row.control)
    if (!parsed.success) continue // Legacy receipts carry no accepted native-response identity.
    const control = parsed.data
    if (control.conversationId !== conversationId || JSON.stringify(control.scope) !== JSON.stringify(scope)) continue
    const acknowledged = Boolean(matchingChatResponseAcknowledgment(control, row.acknowledgment))
    const id = JSON.stringify(['chat-interaction', conversationId, control.modelRequestId, control.native.requestId])
    const previous = summaries.get(id)
    const delivery = acknowledged ? 'delivered' : row.status === 'uncertain' ? 'uncertain' : row.status === 'rejected' ? 'failed' : 'answer_recorded'
    const combinedDelivery = previous?.providerAcknowledged || acknowledged ? 'delivered' : previous?.delivery === 'uncertain' || delivery === 'uncertain' ? 'uncertain'
      : previous?.delivery === 'answer_recorded' || delivery === 'answer_recorded' ? 'answer_recorded' : 'failed'
    summaries.set(id, { id, revision: scopeRevision,
      sourceRevisions: previous ? [...(previous.sourceRevisions ?? []), commandRevision] : [{ source: 'scope', id: conversationId, revision: scopeRevision }, commandRevision], owner: { kind: 'chat_request', conversationId, requestId: control.modelRequestId },
      native: { harness: control.native.harness, sessionId: control.native.sessionId, turnId: control.native.turnId,
        ...(control.native.messageId ? { messageId: control.native.messageId } : {}),
        ...(control.native.generation ? { generation: control.native.generation } : {}), requestId: control.native.requestId },
      delivery: combinedDelivery,
      answerRecorded: true, providerAcknowledged: Boolean(previous?.providerAcknowledged || acknowledged), workerAcknowledged: false, responseAvailability: 'unknown' })
  }
  return { summaries: [...summaries.values()], sourceRevisions, hasMore: rows.length > 200 }
}
/** One component of the same conversation snapshot transaction; stored state snapshots are deliberately not selected. */
export async function readActivityCommands(query: Pick<pg.PoolClient, 'query'>, conversationId: string, scope: ActivityScope, scopeRevision: string) {
  const rows = (await query.query<Receipt>(`with candidates as materialized (
    select r.principal_id,r.operation,r.command_id,r.activity_record_revision::text as revision,r.created_at,
      r.activity_status as status,r.activity_control as control,r.activity_acknowledgment as acknowledgment
    from management_command_receipts r
    where r.target_key=$1 and r.operation in ('agent_chat_control','operator_chat_control')
  ), open as (
    select * from candidates where status in ('pending','uncertain')
      order by created_at desc,principal_id,command_id limit 201
  ), recent as (
    select * from candidates where status not in ('pending','uncertain')
      order by created_at desc,principal_id,command_id limit greatest(0,201-(select count(*) from open))
  ), visible as (select * from open union all select * from recent), ranked as (
    select *,row_number() over (order by case when status in ('pending','uncertain') then 0 else 1 end,
      created_at desc,principal_id,command_id) as retention_order from visible
  ) select * from ranked
    -- Keep the lookahead last; chronological presentation cannot evict a prioritized control.
    order by case when retention_order>200 then 1 else 0 end,created_at,principal_id,command_id`, [conversationId])).rows
  return projectActivityCommands(conversationId, scope, rows, scopeRevision)
}
