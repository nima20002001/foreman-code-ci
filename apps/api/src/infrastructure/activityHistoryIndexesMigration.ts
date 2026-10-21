export const activityHistoryIndexesMigration = { version: 2026101517, sql: `
  create function native_activity_identity(event jsonb) returns jsonb
    language sql immutable parallel safe as $$
    with normalized as (
      select coalesce(case event->>'type'
          when 'claude.tool' then coalesce(event#>>'{payload,toolUseId}',event#>>'{payload,itemId}')
          when 'claude.task' then event#>>'{payload,taskId}'
          when 'native.unlinked_notification' then event#>>'{payload,turnId}' end,
        event#>>'{payload,item,id}',event#>>'{payload,part,id}',event#>>'{payload,itemId}',
        case when event#>>'{payload,method}' in ('turn/started','turn/completed')
          then event#>>'{payload,turnId}' end) as item_id,
        case when event->>'type'='native.unlinked_notification' then 'subagent'
          when event->>'type'='claude.tool' then 'tool'
          when event->>'type'='claude.task' then 'subagent'
          else coalesce(event#>>'{payload,item,type}',event#>>'{payload,part,type}') end as item_type
    )
    select case when item_id is not null and item_type in
      ('commandExecution','fileChange','webSearch','mcpToolCall','dynamicToolCall','collabAgentToolCall','tool','subagent')
      then jsonb_build_array(
        coalesce(case when event->>'type' in ('claude.tool','claude.task')
          then event#>>'{payload,nativeSessionId}' end,event#>>'{payload,threadId}',event#>>'{payload,part,sessionID}'),
        coalesce(case when event->>'type' in ('claude.tool','claude.task')
          then event#>>'{payload,owner,generation}' end,event#>>'{payload,runtimeGeneration}'),item_id) end
    from normalized;
  $$;

  create function native_activity_finished(event jsonb) returns boolean
    language sql immutable parallel safe as $$
    select coalesce((case when event->>'type'='native.unlinked_notification' then
        case when event#>>'{payload,method}'='turn/completed'
          then coalesce(event#>>'{payload,params,turn,status}','unknown')
          when event#>>'{payload,method}'='turn/started' then 'running' else 'unknown' end
      else coalesce(case when event->>'type' in ('claude.tool','claude.task') then event#>>'{payload,status}' end,
        event#>>'{payload,item,status}',event#>>'{payload,part,state,status}',
        case when event->>'type'='item.completed' then 'completed'
          when event->>'type'='item.started' then 'running' end) end)
      in ('completed','failed','declined','error','canceled','cancelled','interrupted'),false)
      or coalesce(event#>'{payload,item,error}' <> 'null'::jsonb,false)
      or coalesce(event#>>'{payload,item,type}'='dynamicToolCall'
        and event#>'{payload,item,success}'='false'::jsonb,false);
  $$;

  alter table harness_native_events
    add column activity_identity jsonb generated always as (native_activity_identity(record)) stored,
    add column activity_finished boolean generated always as (native_activity_finished(record)) stored,
    add column occurred_at timestamptz;
  create index harness_native_activity_latest_idx
    on harness_native_events(execution_id,activity_identity,sequence desc) include(activity_finished)
    where activity_identity is not null;
  drop index if exists harness_native_activity_items_idx;

  -- Native timestamps accept offsets; store instants instead of ordering their JSON strings.
  update harness_native_events set occurred_at=(record->>'occurredAt')::timestamptz;
  create function set_native_event_occurred_at() returns trigger language plpgsql as $$
  begin
    NEW.occurred_at := (NEW.record->>'occurredAt')::timestamptz;
    return NEW;
  end $$;
  create trigger native_event_occurred_at before insert or update of record on harness_native_events
    for each row execute function set_native_event_occurred_at();
  create index harness_native_event_time_idx on harness_native_events(execution_id,occurred_at desc)
    where occurred_at is not null;
  create index run_activity_execution_time_idx on run_activity(run_id,harness_execution_id,occurred_at desc);
` } as const
