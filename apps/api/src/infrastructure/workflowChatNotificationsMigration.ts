export const workflowChatNotificationsMigration = { version: 2026102122, sql: String.raw`
create function notify_workflow_chat_message() returns trigger language plpgsql as $$
begin
  perform pg_notify('workflow_chat_changed', json_build_object('schema',current_schema(),
    'runId',new.run_id,'kind',new.kind,'scopeId',new.scope_id)::text);
  return null;
end $$;
create trigger workflow_chat_message_changed after insert or update on workflow_native_chat_items
  for each row execute function notify_workflow_chat_message();

create function notify_workflow_chat_state() returns trigger language plpgsql as $$
declare run_id text;
begin
  if tg_table_name='runs' then run_id:=new.id; else run_id:=new.run_id; end if;
  perform pg_notify('workflow_chat_changed', json_build_object('schema',current_schema(),
    'runId',run_id)::text);
  return null;
end $$;
create trigger workflow_chat_activity_changed after insert on run_activity
  for each row execute function notify_workflow_chat_state();
create trigger workflow_chat_run_changed after update on runs
  for each row when (old.execution_state is distinct from new.execution_state
    or old.stop_requested_at is distinct from new.stop_requested_at)
  execute function notify_workflow_chat_state();
create trigger workflow_chat_execution_changed after update on harness_executions
  for each row when (old.record->>'state' is distinct from new.record->>'state'
    or old.record->>'nativeSessionId' is distinct from new.record->>'nativeSessionId'
    or old.accepted is distinct from new.accepted)
  execute function notify_workflow_chat_state();
create trigger workflow_chat_consultation_changed after insert or update on run_coordinator_consultations
  for each row execute function notify_workflow_chat_state();
` } as const
