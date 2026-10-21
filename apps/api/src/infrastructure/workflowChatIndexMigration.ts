/** Index message identities once at ingestion; reads reconstruct only the requested page. */
export const workflowChatIndexMigration = { version: 2026102112, sql: String.raw`
create function workflow_native_message_key(event jsonb) returns text language sql immutable as $$
  select case when event#>>'{payload,subagentNativeId}' is null
    and event#>>'{payload,parentToolUseId}' is null and coalesce(event->>'subagent','false')<>'true'
    and ((event->>'type' in ('item.started','item.completed')
        and event#>>'{payload,item,type}' in ('agentMessage','userMessage'))
      or event->>'type' in ('assistant.delta','claude.text')
      or event#>>'{payload,nativeMethod}'='item/agentMessage/delta')
    and coalesce(event#>>'{payload,item,id}',event#>>'{payload,itemId}',
      event#>>'{payload,nativeMessageId}',event#>>'{payload,messageId}') is not null
    then jsonb_build_array(coalesce(event#>>'{payload,nativeTurnId}',event#>>'{payload,turnId}'),
      coalesce(event#>>'{payload,item,id}',event#>>'{payload,itemId}',event#>>'{payload,nativeMessageId}',
        event#>>'{payload,messageId}'),event#>>'{payload,contentIndex}')::text end
$$;
create table workflow_native_chat_items (
  kind text not null check(kind in ('execution','consultation')),
  run_id text not null references runs(id) on delete cascade,
  scope_id text not null,
  source_id text not null,
  message_key text not null,
  sequence bigint not null,
  revision bigint not null,
  primary key(kind,source_id,message_key)
);
create index workflow_native_chat_page on workflow_native_chat_items(kind,run_id,scope_id,sequence desc);
create index workflow_native_chat_revision on workflow_native_chat_items(kind,run_id,scope_id,revision desc);
create index workflow_native_message_events on harness_native_events(execution_id,workflow_native_message_key(record),sequence)
  where workflow_native_message_key(record) is not null;
create index consultation_native_message_events on run_coordinator_native_events(consultation_id,workflow_native_message_key(record),sequence)
  where workflow_native_message_key(record) is not null;

create function index_workflow_native_message() returns trigger language plpgsql as $$
declare message_key text; owner_id text; scope_id text; run_id text; native_session text; kind text;
begin
  message_key := workflow_native_message_key(new.record);
  if message_key is null then return null; end if;
  if tg_table_name='harness_native_events' then
    kind := 'execution'; owner_id := new.execution_id; scope_id := owner_id;
    select e.run_id,e.record->>'nativeSessionId' into strict run_id,native_session from harness_executions e where e.id=owner_id;
  else
    kind := 'consultation'; owner_id := new.consultation_id;
    select c.run_id,c.waiting_activation_id,c.binding->>'nativeSessionId' into strict run_id,scope_id,native_session
      from run_coordinator_consultations c where c.id=owner_id;
  end if;
  if native_session is null or coalesce(new.record#>>'{payload,nativeSessionId}',new.record#>>'{payload,threadId}',native_session)<>native_session then
    return null;
  end if;
  insert into workflow_native_chat_items(kind,run_id,scope_id,source_id,message_key,sequence,revision)
    values(kind,run_id,scope_id,owner_id,message_key,new.sequence,new.sequence)
    on conflict on constraint workflow_native_chat_items_pkey do update
      set sequence=least(workflow_native_chat_items.sequence,excluded.sequence),
        revision=greatest(workflow_native_chat_items.revision,excluded.revision);
  return null;
end $$;
create trigger workflow_native_message_index after insert on harness_native_events
  for each row execute function index_workflow_native_message();
create trigger consultation_native_message_index after insert on run_coordinator_native_events
  for each row execute function index_workflow_native_message();

insert into workflow_native_chat_items(kind,run_id,scope_id,source_id,message_key,sequence,revision)
  select 'execution',e.run_id,e.id,e.id,workflow_native_message_key(n.record),min(n.sequence),max(n.sequence)
    from harness_native_events n join harness_executions e on e.id=n.execution_id
    where workflow_native_message_key(n.record) is not null and e.record->>'nativeSessionId' is not null
      and coalesce(n.record#>>'{payload,nativeSessionId}',n.record#>>'{payload,threadId}',e.record->>'nativeSessionId')=e.record->>'nativeSessionId'
    group by e.run_id,e.id,workflow_native_message_key(n.record);
insert into workflow_native_chat_items(kind,run_id,scope_id,source_id,message_key,sequence,revision)
  select 'consultation',c.run_id,c.waiting_activation_id,c.id,workflow_native_message_key(n.record),min(n.sequence),max(n.sequence)
    from run_coordinator_native_events n join run_coordinator_consultations c on c.id=n.consultation_id
    where workflow_native_message_key(n.record) is not null
      and coalesce(n.record#>>'{payload,nativeSessionId}',n.record#>>'{payload,threadId}',c.binding->>'nativeSessionId')=c.binding->>'nativeSessionId'
    group by c.run_id,c.waiting_activation_id,c.id,workflow_native_message_key(n.record);
` }
