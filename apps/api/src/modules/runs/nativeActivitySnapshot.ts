import type { SqlQuery } from '../../infrastructure/transaction.js'
import { type ActivityItem, type WorkRef, type WorkSummary } from '@foreman-code/contracts'
import { nativeActivityStatus } from './nativeActivityStatus.js'
import { claudeConversationActivity } from '../harnesses/claudeSdk/conversationActivity.js'
import { nativeToolTitle } from './nativeAction.js'

export interface NativeActivityFact {
  execution_id: string; sequence: string; item_id: string; item_type: string; status: string | null;
  native_session_id: string | null; native_turn_id: string | null; generation: string | null; observed_at: string | null;
  native_type?: string | null; tool_name?: string | null; command_name?: string | null; item_error?: boolean;
}
/** Only protocol metadata and the first executable token cross this read boundary. */
// Seek past each identity's history; hydrate payloads only after the two independent page limits.
export const RUN_NATIVE_ACTIVITY_FACTS_SQL = `with normalized as materialized (
  select e.id as execution_id,item.* from harness_executions e
  cross join lateral (
    with recursive latest as (
      (select n.sequence,n.activity_identity,n.activity_finished from harness_native_events n
        where n.execution_id=e.id and n.activity_identity is not null
        order by n.activity_identity,n.sequence desc limit 1)
      union all
      select following.* from latest l cross join lateral (
        select n.sequence,n.activity_identity,n.activity_finished from harness_native_events n
        where n.execution_id=e.id and n.activity_identity is not null and n.activity_identity>l.activity_identity
        order by n.activity_identity,n.sequence desc limit 1
      ) following
    ) select * from latest
  ) item where e.run_id=$1
), bounded as materialized (
  (select * from normalized where not activity_finished order by execution_id,sequence limit 1001)
  union all
  (select * from normalized where activity_finished order by execution_id,sequence limit 1000)
)
select l.execution_id,l.sequence::text,l.activity_identity->>2 as item_id,
  case when n.record->>'type'='native.unlinked_notification' then 'subagent'
    when n.record->>'type'='claude.tool' then 'tool'
    when n.record->>'type'='claude.task' then 'subagent'
    else coalesce(n.record#>>'{payload,item,type}',n.record#>>'{payload,part,type}') end as item_type,
  case when n.record->>'type'='native.unlinked_notification' then
    case when n.record#>>'{payload,method}'='turn/completed' then coalesce(n.record#>>'{payload,params,turn,status}','unknown')
      when n.record#>>'{payload,method}'='turn/started' then 'running' else 'unknown' end
    else coalesce(case when n.record->>'type' in ('claude.tool','claude.task') then n.record#>>'{payload,status}' end,
      n.record#>>'{payload,item,status}',n.record#>>'{payload,part,state,status}',
      case when n.record->>'type'='item.completed' then 'completed' when n.record->>'type'='item.started' then 'running' end) end as status,
  l.activity_identity->>0 as native_session_id,l.activity_identity->>1 as generation,
  n.record#>>'{payload,turnId}' as native_turn_id,
  n.record->>'occurredAt' as observed_at,n.record->>'type' as native_type,
  (coalesce(n.record#>'{payload,item,error}' <> 'null'::jsonb,false)
    or (n.record#>>'{payload,item,type}'='dynamicToolCall'
      and coalesce(n.record#>'{payload,item,success}'='false'::jsonb,false))) as item_error,
  coalesce(case when n.record->>'type'='claude.tool' then n.record#>>'{payload,name}' end,
    n.record#>>'{payload,item,tool}',n.record#>>'{payload,part,tool}') as tool_name,
  substring(n.record#>>'{payload,item,command}' from '^[[:space:]]*([A-Za-z0-9_./-]+)') as command_name
from bounded l cross join lateral (
  select n.record from harness_native_events n
  where n.execution_id=l.execution_id and n.sequence=l.sequence offset 0
) n
order by l.execution_id,l.sequence`

export async function readNativeActivityFacts(sql: SqlQuery, runId: string) {
  return (await sql.query<NativeActivityFact>(RUN_NATIVE_ACTIVITY_FACTS_SQL, [runId])).rows
}
export function projectNativeActivityFacts(rows: readonly NativeActivityFact[], resolve: (executionId: string) =>
  { owner: WorkRef; harness: string | null; sessionId: string | null; terminal: boolean }) {
  const activities: ActivityItem[] = []
  const active: WorkSummary[] = []
  let finishedCount = 0
  let unfinishedCount = 0
  for (const row of rows) {
    let observed = nativeActivityStatus(row.status)
    if (observed !== 'canceled' && row.item_error) observed = 'failed'
    const provenTerminal = observed === 'completed' || observed === 'failed' || observed === 'canceled'
    if (provenTerminal) {
      if (++finishedCount > 1000) continue
    } else if (++unfinishedCount > 1000) continue
    const context = resolve(row.execution_id)
    const child = row.item_type === 'subagent'
    const kind = child ? 'subagent' : 'tool'
    const claude = claudeConversationActivity({ type: row.native_type ?? '', payload: {
      itemId: row.item_id, taskId: row.item_id, name: row.tool_name, status: row.status,
    } }, row.execution_id)
    let status: Extract<ActivityItem, { kind: 'tool' }>['status'] = observed ?? 'running'
    if (!provenTerminal && context.terminal) status = 'unknown'
    const nativeSession = row.native_session_id ?? (child ? null : context.sessionId)
    const native = nativeSession && context.harness ? { harness: context.harness, sessionId: nativeSession,
      ...(row.native_turn_id ? { turnId: row.native_turn_id } : {}), itemId: row.item_id,
      ...(row.generation ? { generation: row.generation } : {}) } : undefined
    const id = JSON.stringify(['native-item', row.execution_id, row.native_session_id, row.generation, row.item_id])
    const ref: WorkRef = { kind, itemId: id, ...(native ? { native } : {}) }
    activities.push({ kind, id, title: claude?.title ?? nativeToolTitle(row.item_type, row.tool_name, row.command_name), status,
      revision: row.sequence, order: row.sequence, owner: context.owner, ...(native ? { native } : {}),
      source: { schemaVersion: 1, system: 'harness_native_events', observedAt: row.observed_at },
      evidence: status === 'unknown' ? 'unknown' : 'confirmed' })
    if (!provenTerminal) active.push({ ref, phase: 'active', outcome: null, delivery: null, startedAt: null,
      evidence: context.terminal || status === 'unknown' ? 'unknown' : 'confirmed', ...(native ? { native } : {}) })
  }
  return { activities, active, hasMore: unfinishedCount > 1000 }
}
