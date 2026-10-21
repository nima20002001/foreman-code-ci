/** Select item identities before projecting bodies; no native record crosses the SQL boundary. */
const itemKey = `case
  when n.record#>>'{payload,nativeMethod}'='turn/plan/updated'
    then 'plan:'||coalesce(n.record#>>'{payload,turnId}','')
  when n.record->>'type'='claude.task' then 'task:'||(n.record#>>'{payload,taskId}')
  when n.record->>'type' in ('session.compaction','session.compacted') then 'compaction:'||coalesce(
    n.record#>>'{payload,nativeOperationId}',n.record#>>'{payload,nativeEventId}',n.sequence::text)
  else coalesce(n.record#>>'{payload,item,id}',n.record#>>'{payload,itemId}')||case
    when n.record->>'type'='claude.text' and n.record#>>'{payload,contentIndex}' is not null
      then '#'||(n.record#>>'{payload,contentIndex}') else '' end end`

const publicEvents = `n.execution_id=$1
  and n.record->>'type'<>'native.unlinked_notification'
  and n.record#>>'{payload,subagentNativeId}' is null
  and n.record#>>'{payload,parentToolUseId}' is null
  and coalesce(n.record->>'subagent','false')<>'true'
  and ($2::text is null or coalesce(n.record#>>'{payload,nativeSessionId}',n.record#>>'{payload,threadId}',$2)=$2)
  and ((n.record->>'type' in ('item.started','item.completed','item.snapshot')
      and n.record#>>'{payload,item,type}' in ('agentMessage','userMessage','commandExecution','fileChange',
        'mcpToolCall','dynamicToolCall','webSearch','collabAgentToolCall','contextCompaction','reasoning','plan'))
    or n.record->>'type' in ('claude.text','claude.tool','claude.task','assistant.delta','session.compaction','session.compacted')
    or n.record#>>'{payload,nativeMethod}' in ('turn/plan/updated','item/agentMessage/delta',
      'item/commandExecution/outputDelta','item/reasoning/summaryTextDelta','item/plan/delta'))`

function utf8Prefix(value: string, limit: string) {
  // Drop an incomplete final UTF-8 code point from the byte prefix before decoding it.
  const incomplete = '(c[2-9a-f]|d[0-9a-f]|e[0-9a-f]([89ab][0-9a-f])?|f[0-4]([89ab][0-9a-f]){0,2})$'
  return `convert_from(decode(regexp_replace(encode(substring(convert_to(${value},'UTF8'),1,${limit}),
    'hex'),'${incomplete}',''),'hex'),'UTF8')`
}

// All aggregates below consume bounded prefixes, even when a message has millions of deltas.
// The native journal remains the history store; readers retain no complete-execution cache.
export const executionItemsSql = `with identities as (
  select ${itemKey} as item_key,min(n.sequence) as first_sequence,max(n.sequence) as revision
  from harness_native_events n where ${publicEvents}
  group by ${itemKey}
  having bool_or(coalesce(n.record#>>'{payload,item,type}','')<>'reasoning'
      and (coalesce(n.record#>>'{payload,nativeMethod}','')<>'item/reasoning/summaryTextDelta'
        or coalesce(n.record#>>'{payload,delta}','')<>''))
    or max(n.sequence) filter (where exists(select 1 from jsonb_array_elements(
      case when jsonb_typeof(n.record#>'{payload,item,summary}')='array'
        then n.record#>'{payload,item,summary}' else '[]'::jsonb end) part
      where jsonb_typeof(part)='string' and part#>>'{}'<>''))
      =max(n.sequence) filter (where n.record#>>'{payload,item,type}'='reasoning')
), selected as (
  select * from identities where item_key is not null
    and ($3<>'item' or item_key=$6)
    and ($3<>'earlier' or $5::bigint is null or first_sequence<$5)
    and ($3<>'changes' or ($14::boolean or revision>$4)
      and ($7::bigint is null or (revision,item_key)>($7,$8)))
  order by case when $3='changes' then revision end asc,
    case when $3='changes' then item_key end asc,first_sequence desc,item_key
  limit $9::integer
), events as materialized (
  select s.item_key,n.sequence,n.record->>'type' as type,n.record->'payload' as payload,
    n.record->>'occurredAt' as occurred_at
  from selected s join harness_native_events n on n.execution_id=$1 and (${itemKey})=s.item_key
  where ${publicEvents}
), message_events as (
  select e.*,
    coalesce(payload#>>'{item,text}',payload->>'text',payload->>'delta','') as raw_text,
    type='item.completed' or (type='claude.text' and payload->>'final'='true') as complete,
    type in ('item.started','item.completed') or payload->>'operation'='replace' as replaces
  from events e where type in ('claude.text','assistant.delta')
    or payload->>'nativeMethod'='item/agentMessage/delta'
    or (type in ('item.started','item.completed','item.snapshot')
      and payload#>>'{item,type}' in ('agentMessage','userMessage'))
), message_parts as (
  select e.*,coalesce(u.content,left(raw_text,$10::integer)) as content,
    coalesce(u.characters,length(raw_text)) as characters,
    greatest(coalesce(u.bytes,octet_length(raw_text)),coalesce((payload#>>'{truncation,originalBytes}')::bigint,0)) as bytes
  from message_events e left join lateral (
    select string_agg(left(value->>'text',greatest($10::integer-prefix_characters,0)::integer),'' order by position)
        filter (where prefix_characters<$10::integer) as content,
      sum(length(value->>'text')) as characters,sum(octet_length(value->>'text')) as bytes
    from (select value,position,coalesce(sum(length(value->>'text')) over (
      order by position rows between unbounded preceding and 1 preceding),0) as prefix_characters
      from jsonb_array_elements(case when payload#>>'{item,type}'='userMessage'
        and jsonb_typeof(payload#>'{item,content}')='array'
        then payload#>'{item,content}' else '[]'::jsonb end) with ordinality p(value,position)
      where value->>'type'='text') parts
  ) u on true
), message_boundaries as (
  select *,max(sequence) filter (where complete) over (partition by item_key) as final_sequence,
    max(sequence) filter (where replaces) over (partition by item_key) as last_replace
  from message_parts
), chunks as (
  select item_key,sequence,'message' as kind,content,characters,bytes from message_boundaries
  where (final_sequence is not null and sequence=final_sequence)
    or (final_sequence is null and (last_replace is null or sequence>=last_replace))
  union all
  select item_key,sequence,'input',left(payload->>'inputJsonDelta',$11::integer),
    length(payload->>'inputJsonDelta'),octet_length(payload->>'inputJsonDelta')
  from events where payload->>'inputJsonDelta' is not null
  union all
  select item_key,sequence,'output',left(payload->>'delta',$12::integer),
    length(payload->>'delta'),octet_length(payload->>'delta')
  from events where payload->>'nativeMethod' in (
    'item/commandExecution/outputDelta','item/reasoning/summaryTextDelta','item/plan/delta')
), offsets as (
  select *,coalesce(sum(characters) over (partition by item_key,kind order by sequence
    rows between unbounded preceding and 1 preceding),0) as prefix_characters,
    case kind when 'message' then $10::integer when 'input' then $11::integer else $12::integer end as bound
  from chunks
), bodies as (
  select item_key,kind,string_agg(left(content,greatest(bound-prefix_characters,0)::integer),'' order by sequence)
      filter (where prefix_characters<bound) as content,sum(bytes) as bytes
  from offsets group by item_key,kind
), latest as (
  select distinct on (item_key) * from events
  where type<>'assistant.delta' and coalesce(payload->>'nativeMethod','') not in (
    'item/agentMessage/delta','item/commandExecution/outputDelta','item/reasoning/summaryTextDelta','item/plan/delta')
    and payload->>'inputJsonDelta' is null
  order by item_key,sequence desc
), fields as (
  select s.*,e.type,e.occurred_at,e.payload,coalesce(e.payload->'item','{}'::jsonb) as item,
    m.content as message,m.bytes as message_bytes,
    coalesce(i.value,d.content) as input,coalesce(o.value,b.content) as output,
    coalesce(i.bytes,d.bytes,0) as input_bytes,coalesce(o.bytes,b.bytes,0) as output_bytes,
    name.value as tool_name,i.command as tool_command,i.file as tool_file
  from selected s left join latest e using(item_key)
  left join bodies m on m.item_key=s.item_key and m.kind='message'
  left join bodies d on d.item_key=s.item_key and d.kind='input'
  left join bodies b on b.item_key=s.item_key and b.kind='output'
  left join lateral (
    select left(case when jsonb_typeof(payload->'input')='string' then payload->>'input'
      else (payload->'input')::text end,$11::integer) as value,
      octet_length((payload->'input')::text) as bytes,
      left(payload#>>'{input,command}',624) as command,left(payload#>>'{input,file_path}',624) as file
    from events where item_key=s.item_key and payload->'input' is not null
      and payload->'input'<>'null'::jsonb order by sequence desc limit 1
  ) i on true
  left join lateral (
    select left(coalesce(parts.value,case when jsonb_typeof(payload->'output')='string'
      then payload->>'output' else (payload->'output')::text end),$12::integer) as value,
      coalesce(parts.bytes,octet_length((payload->'output')::text)) as bytes
    from events left join lateral (
      select string_agg(left(value->>'text',greatest($12::integer-prefix_characters,0)::integer),E'\\n' order by position)
        filter (where prefix_characters<$12::integer) as value,sum(octet_length(value->>'text')+1) as bytes
      from (select value,position,coalesce(sum(length(value->>'text')+1) over (
        order by position rows between unbounded preceding and 1 preceding),0) as prefix_characters
        from jsonb_array_elements(case when jsonb_typeof(payload->'output')='array'
          then payload->'output' else '[]'::jsonb end) with ordinality p(value,position)
        where value->>'type'='text') parts
    ) parts on true
    where item_key=s.item_key and payload->'output' is not null
      and payload->'output'<>'null'::jsonb order by sequence desc limit 1
  ) o on true
  left join lateral (select left(payload->>'name',624) as value from events
    where item_key=s.item_key and payload->>'name' is not null order by sequence desc limit 1) name on true
), tool_bodies as (
  select f.*,case when type='claude.tool' then input
    when item->>'type'='commandExecution' then left(jsonb_build_object(
      'command',left(item->>'command',$11::integer),'cwd',left(item->>'cwd',1024))::text,$11::integer)
    when item->>'type'='fileChange' then left((item->'changes')::text,$11::integer)
    when item->>'type' in ('mcpToolCall','dynamicToolCall') then left((item->'arguments')::text,$11::integer)
    when item->>'type'='webSearch' then left(coalesce((item->'action')::text,item->>'query'),$11::integer)
    when item->>'type'='collabAgentToolCall' then left(jsonb_build_object('prompt',left(item->>'prompt',$11::integer),
      'model',left(item->>'model',240),'effort',left(item->>'reasoningEffort',240),
      'agents',left((item->'receiverThreadIds')::text,$11::integer))::text,$11::integer) end as tool_input,
    case when type='claude.tool' then output
      when payload->>'nativeMethod'='turn/plan/updated' then left(concat_ws(E'\\n',
        left(payload->>'explanation',$12::integer),plan.value),$12::integer)
      when item->>'type'='plan' then left(item->>'text',$12::integer)
      when item->>'type'='commandExecution' then coalesce(left(item->>'aggregatedOutput',$12::integer),output)
      when item->>'type'='reasoning' then coalesce(nullif(summary.value,''),output)
      when item->>'type'='mcpToolCall' then left(coalesce(nullif(item->'error','null'::jsonb)::text,mcp.value,(item->'result')::text),$12::integer)
      when item->>'type'='webSearch' then left((item->'results')::text,$12::integer)
      when item->>'type'='collabAgentToolCall' then left((item->'agentsStates')::text,$12::integer)
      when item->>'type'='dynamicToolCall' then left((item->'contentItems')::text,$12::integer)
      else output end as tool_output
  from fields f
  left join lateral (select string_agg(part,E'\\n' order by position) as value from (
    select position,left(case value->>'status' when 'completed' then '[x] ' when 'inProgress' then '[~] '
      else '[ ] ' end||(value->>'step'),240) as part
    from jsonb_array_elements(case when jsonb_typeof(payload->'plan')='array'
      then payload->'plan' else '[]'::jsonb end) with ordinality p(value,position)
    limit 100) parts) plan on true
  left join lateral (select string_agg(part,E'\\n\\n' order by position) as value from (
    select position,left(value#>>'{}',240) as part
    from jsonb_array_elements(case when jsonb_typeof(item->'summary')='array'
      then item->'summary' else '[]'::jsonb end) with ordinality p(value,position)
    where jsonb_typeof(value)='string' limit 100) parts) summary on true
  left join lateral (select string_agg(left(value->>'text',greatest($12::integer-prefix_characters,0)::integer),E'\\n' order by position)
      filter (where prefix_characters<$12::integer) as value
    from (select value,position,coalesce(sum(length(value->>'text')+1) over (
      order by position rows between unbounded preceding and 1 preceding),0) as prefix_characters
      from jsonb_array_elements(case when jsonb_typeof(item#>'{result,content}')='array'
      then item#>'{result,content}' else '[]'::jsonb end) with ordinality p(value,position)
      where value->>'type'='text') parts) mcp on true
), bounded as (
  select f.*,${utf8Prefix('message', '$10::integer')} as bounded_message,
    ${utf8Prefix('tool_input', '$11::integer')} as bounded_input,${utf8Prefix('tool_output', '$12::integer')} as bounded_output
  from tool_bodies f
), projected as (
  select item_key,first_sequence,revision,jsonb_build_object('type',case when message is not null
      then 'claude.text' else type end,'occurredAt',occurred_at,'payload',case when message is not null then
    jsonb_build_object('itemId',item_key,'text',bounded_message,
      'role',case when payload#>>'{item,type}'='userMessage' or payload->>'role'='user' then 'user' else 'assistant' end,
      'operation','replace','final',exists(select 1 from message_events m where m.item_key=f.item_key and m.complete),
      'truncation',jsonb_build_object('originalBytes',message_bytes)) else
    jsonb_build_object('itemId',item_key,'taskId',left(payload->>'taskId',1024),'name',tool_name,
      'status',payload->>'status','nativeMethod',payload->>'nativeMethod','turnId',left(payload->>'turnId',1024),
      'nativeOperationId',left(payload->>'nativeOperationId',1024),'nativeEventId',left(payload->>'nativeEventId',1024),
      'publicInput',bounded_input,'publicOutput',bounded_output,
      'publicTitle',case when type='claude.tool' and tool_name='Bash' and tool_command is not null
          then regexp_replace(tool_command,'\\s+',' ','g')
        when type='claude.tool' and tool_file is not null then tool_name||' '||tool_file
        when type='claude.tool' and tool_name like 'mcp\\_\\_%' escape '\\' then tool_name end,
      'publicTruncated',input_bytes>$11::integer or output_bytes>$12::integer
        or octet_length(coalesce(tool_input,''))>$11::integer or octet_length(coalesce(tool_output,''))>$12::integer
        or octet_length(coalesce(item->>'command',''))+octet_length(coalesce(item->>'cwd',''))+32>$11::integer
        or octet_length(coalesce(item->>'prompt',''))>$11::integer
        or octet_length(coalesce((payload->'plan')::text,(item->'summary')::text,item->>'text',''))>$12::integer
        or octet_length(coalesce(item->>'aggregatedOutput',''))>$12::integer
        or octet_length(coalesce(nullif(item->'changes','null'::jsonb)::text,nullif(item->'arguments','null'::jsonb)::text,''))>$11::integer
        or octet_length(coalesce((item->'result')::text,(item->'contentItems')::text,(item->'results')::text,''))>$12::integer,
      'item',jsonb_build_object('id',item_key,'type',item->>'type','status',item->>'status',
        'server',left(item->>'server',504),'tool',left(item->>'tool',504),
        'error',case when item->'error' is not null and item->'error'<>'null'::jsonb then 'error' end,
        'success',item->'success','action',jsonb_build_object('type',item#>>'{action,type}'),
        'command',left(item->>'command',624),'commandActions',coalesce(actions.value,'[]'::jsonb))) end) as record
  from bounded f left join lateral (
    select jsonb_build_array(jsonb_build_object('type',value->>'type','name',left(value->>'name',624),
      'path',left(value->>'path',624),'command',left(value->>'command',624))) as value
    from jsonb_array_elements(case when jsonb_typeof(item->'commandActions')='array'
      then item->'commandActions' else '[]'::jsonb end) value
    order by case when value->>'type' in ('read','listFiles','search') then 0 else 1 end limit 1
  ) actions on true
), costed as (
  select *,coalesce(sum(octet_length(record::text)+4096) over (order by
    case when $3='changes' then revision end asc,case when $3='changes' then item_key end asc,
    first_sequence desc,item_key rows between unbounded preceding and 1 preceding),0) as preceding_bytes
  from projected
)
select item_key,first_sequence,revision,case when preceding_bytes<$13 then record end as record
from costed order by case when $3='changes' then revision end asc,
  case when $3='changes' then item_key end asc,first_sequence desc,item_key`
