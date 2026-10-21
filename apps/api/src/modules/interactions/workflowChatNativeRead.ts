import { canonicalJson, CoordinatorConsultationBindingSchema, EngineChatMessageSchema,
  type CoordinatorConsultationBinding, type EngineChatMessage } from '@foreman-code/contracts'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'
import { controlDigest, workflowTargetRunId } from '../collaboration/workflowControlRecords.js'
import type { WorkflowChatTarget, WorkflowNativeChatPage } from '../collaboration/workflowControlTypes.js'
import { nativePersistenceRedactor } from './nativePersistence.js'

interface TextRow {
  owner_id: string; binding: unknown | null; item_key: string; harness: string; session_id: string
  turn_id: string | null; message_id: string; part_id: string | null; request_id: string | null
  role: 'assistant' | 'user'; content: string; original_bytes: number; complete: boolean
  sequence: string; revision: string; scope_revision: string
}

const textProjection = `, public_events as (
  select *,record->>'type' as type,record->'payload' as payload from source_events
  where record#>>'{payload,subagentNativeId}' is null
    and record#>>'{payload,parentToolUseId}' is null and coalesce(record->>'subagent','false')<>'true'
    and coalesce(record#>>'{payload,nativeSessionId}',record#>>'{payload,threadId}',session_id)=session_id
    and ((record->>'type' in ('item.started','item.completed')
        and record#>>'{payload,item,type}' in ('agentMessage','userMessage'))
      or record->>'type' in ('assistant.delta','claude.text')
      or record#>>'{payload,nativeMethod}'='item/agentMessage/delta')
), text_events as (
  select *,coalesce(payload->>'nativeTurnId',payload->>'turnId') as turn_id,
    coalesce(payload#>>'{item,id}',payload->>'itemId',payload->>'nativeMessageId',payload->>'messageId') as message_id,
    payload->>'contentIndex' as part_id,coalesce(payload->>'clientCorrelationId',payload->>'correlationId') as request_id,
    jsonb_build_array(owner_id,session_id,coalesce(payload->>'nativeTurnId',payload->>'turnId'),
      coalesce(payload#>>'{item,id}',payload->>'itemId',payload->>'nativeMessageId',payload->>'messageId'),
      payload->>'contentIndex')::text as item_key,
    case when payload#>>'{item,type}'='userMessage' or payload->>'role'='user' then 'user' else 'assistant' end as role,
    case when payload#>>'{item,type}'='userMessage' then
      (select string_agg(part->>'text','' order by ordinality)
        from jsonb_array_elements(payload#>'{item,content}') with ordinality as parts(part,ordinality)
        where part->>'type'='text')
      else coalesce(payload#>>'{item,text}',payload->>'text',payload->>'delta') end as text,
    type in ('item.started','item.completed') or payload->>'operation'='replace' as replaces,
    (payload#>>'{truncation,originalBytes}')::integer as original_bytes,
    type='item.completed' or (type='claude.text' and payload->>'final'='true') as complete
  from public_events
), boundaries as (
  select *,max(sequence) filter(where replaces) over(partition by item_key) as last_replace,
    max(sequence) filter(where complete) over(partition by item_key) as final_sequence
  from text_events where message_id is not null
), messages as (
  select owner_id,binding,item_key,harness,session_id,turn_id,message_id,part_id,max(request_id) as request_id,role,
    min(sequence) as sequence,max(sequence) as revision,bool_or(coalesce(complete,false)) as complete,
    max(original_bytes) as original_bytes,
    string_agg(coalesce(text,''),'' order by sequence) filter(where
      (final_sequence is not null and sequence=final_sequence)
      or (final_sequence is null and (last_replace is null or sequence>=last_replace))) as content
  from boundaries group by owner_id,binding,item_key,harness,session_id,turn_id,message_id,part_id,role
)
select owner_id,binding,item_key,harness,session_id,turn_id,message_id,part_id,request_id,role,
  case when $7::jsonb is null then left(content,65536) else content end as content,greatest(coalesce(original_bytes,0),octet_length(content)) as original_bytes,
  complete,sequence::text,revision::text,(select coalesce(max(revision),0)::text from workflow_native_chat_items where kind=$6 and run_id=$1 and scope_id=$2) as scope_revision
from messages where ($4::bigint is null or sequence<$4) order by messages.sequence desc limit $5`

function beforeCursor(target: WorkflowChatTarget, cursor?: string): string | null {
  if (!cursor) return null
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { target?: string; before?: string }
    if (value.target !== controlDigest(target) || !value.before || !/^[1-9][0-9]*$/.test(value.before)) throw new Error('scope')
    return value.before
  } catch { throw new DomainError('INVALID_CURSOR', 'Use this native history cursor with its original exact target.', 400) }
}

function nativeMessage(target: WorkflowChatTarget, row: TextRow, content: string): EngineChatMessage {
  const provenance = target.kind === 'workflow_execution'
    ? { kind: 'execution' as const, execution: target.execution }
    : { kind: 'consultation' as const, binding: CoordinatorConsultationBindingSchema.parse(row.binding) }
  return EngineChatMessageSchema.parse({ id: row.item_key, role: row.role, content,
    revision: row.revision, sequence: row.sequence, nativeMessageId: row.message_id,
    ...(row.request_id ? { requestId: row.request_id } : {}), nativeMessageComplete: row.complete,
    activityNative: { harness: row.harness, sessionId: row.session_id, itemId: row.message_id,
      ...(row.turn_id ? { turnId: row.turn_id } : {}), ...(row.part_id ? { partId: row.part_id } : {}) },
    ...(row.original_bytes > Buffer.byteLength(content) ? { truncation: { truncated: true, originalBytes: row.original_bytes } } : {}),
    provenance })
}

/** SQL projection of the existing single observer's retained native source.
 * Old consultation pages load their actual bindings; recent hints are not a history limit. */
export async function readWorkflowNativeChat(sql: GraphSqlClient, target: WorkflowChatTarget,
  input: { cursor?: string; limit: number; bindings: CoordinatorConsultationBinding[]; messageId?: string;
    afterRevision?: string; messageBytes?: number }): Promise<WorkflowNativeChatPage> {
  const kind = target.kind === 'workflow_execution' ? 'execution' : 'consultation'
  const page = `with message_page as materialized (select source_id,message_key from workflow_native_chat_items
    where kind=$6 and run_id=$1 and scope_id=$2 and ($4::bigint is null or sequence<$4)
      and ($8::bigint is null or revision>$8)
      and ($7::jsonb is null or (source_id=$7::jsonb->>0
        and message_key::jsonb=jsonb_build_array($7::jsonb->2,$7::jsonb->3,$7::jsonb->4)))
    order by sequence desc limit $5), source_events as (`
  const source = page + (target.kind === 'workflow_execution' ? `
    select n.sequence,n.record,e.id as owner_id,null::jsonb as binding,
      c.record#>>'{harness,harness}' as harness,e.record->>'nativeSessionId' as session_id
    from message_page p cross join lateral (
      select * from harness_native_events where execution_id=p.source_id
        and workflow_native_message_key(record)=p.message_key offset 0
    ) n join harness_executions e on e.id=n.execution_id
    join agent_configuration_versions c on c.id=e.record->>'agentConfigurationVersionId'
    where e.run_id=$1 and e.id=$2 and e.workflow_node_id=$3
  )` : `
    select n.sequence,n.record,c.id as owner_id,c.binding,m.agent->>'configurationVersionId' as configuration_id,
      a.record#>>'{harness,harness}' as harness,c.binding->>'nativeSessionId' as session_id
    from message_page p cross join lateral (
      select * from run_coordinator_native_events where consultation_id=p.source_id
        and workflow_native_message_key(record)=p.message_key offset 0
    ) n join run_coordinator_consultations c
      on c.id=n.consultation_id and c.run_id=n.run_id
    join run_coordinator_mailboxes m on m.run_id=c.run_id and m.waiting_activation_id=c.waiting_activation_id
    join agent_configuration_versions a on a.id=m.agent->>'configurationVersionId'
    where c.run_id=$1 and c.waiting_activation_id=$2 and m.workflow_node_id=$3
  )`)
  const rows = (await sql.query<TextRow>(source + textProjection, [workflowTargetRunId(target),
    target.kind === 'workflow_execution' ? target.execution.executionId : target.waitingActivationId,
    target.agent.workflowNodeId, beforeCursor(target, input.cursor), Math.min(100, input.limit) + 1, kind,
    input.messageId ?? null, input.afterRevision ?? null])).rows
  const messages: EngineChatMessage[] = [], redactor = nativePersistenceRedactor([])
  let usedBytes = 2
  for (const row of rows.slice(0, Math.min(100, input.limit))) {
    const safe = redactor.text(row.content)
    let message = nativeMessage(target, row, safe)
    let bytes = Buffer.byteLength(canonicalJson(message)) + (messages.length ? 1 : 0)
    if (input.messageBytes && bytes > input.messageBytes) {
      const fixed = Buffer.byteLength(canonicalJson(nativeMessage(target, row, ''))) + 128
      const text = Buffer.from(safe).subarray(0, Math.max(0, Math.floor((input.messageBytes - fixed) / 6)))
      message = nativeMessage(target, row, new TextDecoder().decode(text, { stream: true }))
      bytes = Buffer.byteLength(canonicalJson(message))
    }
    if (!input.messageId && usedBytes + bytes > 192 * 1024) {
      if (messages.length) break
      const fixed = Buffer.byteLength(canonicalJson(nativeMessage(target, row, ''))) + 128
      const text = Buffer.from(safe).subarray(0, Math.max(0, 192 * 1024 - fixed - usedBytes))
      message = nativeMessage(target, row, new TextDecoder().decode(text, { stream: true }))
      bytes = Buffer.byteLength(canonicalJson(message))
    }
    messages.push(message); usedBytes += bytes
  }
  const hasMore = rows.length > messages.length, last = messages.at(-1)
  return { messages: messages.reverse(), hasMore,
    nextCursor: hasMore && last ? Buffer.from(canonicalJson({ target: controlDigest(target), before: last.sequence })).toString('base64url') : null,
    revision: Number(rows[0]?.scope_revision ?? 0) }
}
