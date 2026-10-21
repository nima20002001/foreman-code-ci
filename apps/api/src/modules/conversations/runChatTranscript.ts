import type pg from 'pg'
import type { HarnessExecution } from '@foreman-code/contracts'
import { AgentChatSourceTranscriptSchema, type AgentChatSourceTranscript } from '@foreman-code/contracts/agent-chat'
import { nativePersistenceRedactor } from '../interactions/nativePersistence.js'

interface TextRow {
  item_key: string
  role: 'assistant' | 'user'
  content: string
  original_bytes: number
  complete: boolean
  sequence: string
  revision: string
}

// Project public message text only. Tool bodies, private reasoning and child sessions stay out of chat.
const transcriptSql = `with public_events as (
  select n.sequence,n.record->>'type' as type,n.record->'payload' as payload
  from harness_native_events n join harness_executions e on e.id=n.execution_id
  where e.id=$1 and e.run_id=$2 and e.workflow_node_id=$3 and e.agent_id=$4
    and n.record#>>'{payload,subagentNativeId}' is null
    and n.record#>>'{payload,parentToolUseId}' is null
    and coalesce(n.record->>'subagent','false')<>'true'
    and (e.record->>'nativeSessionId' is null or
      coalesce(n.record#>>'{payload,nativeSessionId}',n.record#>>'{payload,threadId}',e.record->>'nativeSessionId')
        =e.record->>'nativeSessionId')
    and ((n.record->>'type' in ('item.started','item.completed')
        and n.record#>>'{payload,item,type}' in ('agentMessage','userMessage'))
      or n.record->>'type' in ('assistant.delta','claude.text')
      or n.record#>>'{payload,nativeMethod}'='item/agentMessage/delta')
), text_events as (
  select sequence,
    jsonb_build_array(coalesce(payload->>'nativeSessionId',payload->>'threadId'),
      coalesce(payload->>'nativeTurnId',payload->>'turnId'),
      coalesce(payload#>>'{item,id}',payload->>'itemId'),payload->>'contentIndex')::text as item_key,
    case when payload#>>'{item,type}'='userMessage' or payload->>'role'='user'
      then 'user' else 'assistant' end as role,
    case when payload#>>'{item,type}'='userMessage' then
      (select string_agg(part->>'text','' order by ordinality)
        from jsonb_array_elements(payload#>'{item,content}') with ordinality as parts(part,ordinality)
        where part->>'type'='text')
      else coalesce(payload#>>'{item,text}',payload->>'text',payload->>'delta') end as text,
    type in ('item.started','item.completed') or payload->>'operation'='replace' as replaces,
    (payload#>>'{truncation,originalBytes}')::integer as original_bytes,
    type='item.completed' or (type='claude.text' and payload->>'final'='true') as complete
  from public_events
  where coalesce(payload#>>'{item,id}',payload->>'itemId') is not null
), boundaries as (
  select *,max(sequence) filter (where replaces) over (partition by item_key) as last_replace,
    max(sequence) filter (where complete) over (partition by item_key) as final_sequence
  from text_events
), messages as (
  select item_key,role,min(sequence) as sequence,max(sequence) as revision,
    bool_or(coalesce(complete,false)) as complete,
    max(original_bytes) as original_bytes,
    string_agg(coalesce(text,''),'' order by sequence) filter (
      where (final_sequence is not null and sequence=final_sequence)
        or (final_sequence is null and (last_replace is null or sequence>=last_replace))) as content
  from boundaries group by item_key,role
), recent as (
  select * from messages order by sequence desc limit 101
)
select item_key,role,left(content,16384) as content,greatest(original_bytes,octet_length(content)) as original_bytes,
  complete,sequence::text,revision::text from recent order by sequence`

export function projectRunChatTranscript(execution: HarnessExecution, rows: readonly TextRow[]): AgentChatSourceTranscript {
  const redactor = nativePersistenceRedactor([])
  const messages: AgentChatSourceTranscript['messages'] = []
  let remainingBytes = 128 * 1024
  // Keep the newest text within the response budget, then restore chronological order.
  for (const row of rows.slice(-100).reverse()) {
    const safeText = redactor.text(row.content)
    const bytes = Buffer.from(safeText)
    const limit = Math.min(16 * 1024, remainingBytes)
    const content = new TextDecoder().decode(bytes.subarray(0, limit), { stream: bytes.length > limit })
    remainingBytes -= Buffer.byteLength(content)
    messages.push({ id: JSON.stringify([execution.id, row.item_key]), role: row.role, content,
      sequence: row.sequence, revision: row.revision, nativeMessageComplete: row.complete,
      ...(row.original_bytes > Buffer.byteLength(content)
        ? { truncation: { truncated: true, originalBytes: row.original_bytes } } : {}) })
  }
  return AgentChatSourceTranscriptSchema.parse({ executionId: execution.id, state: execution.state,
    revision: rows.reduce((latest, row) => BigInt(row.revision) > BigInt(latest) ? row.revision : latest, '0'),
    messages: messages.reverse(), hasEarlierMessages: rows.length > 100 })
}

export async function readRunChatTranscript(sql: Pick<pg.Pool, 'query'>, execution: HarnessExecution) {
  const result = await sql.query<TextRow>(transcriptSql,
    [execution.id, execution.runId, execution.workflowNodeId, execution.agentId])
  return projectRunChatTranscript(execution, result.rows)
}
