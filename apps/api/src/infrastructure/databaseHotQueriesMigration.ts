export const databaseHotQueriesMigration = { version: 2026101213, sql: `
  create index ci_runs_group_idx on ci_runs(workspace_id,group_id,created_at,id);
  create index harness_native_activity_items_idx on harness_native_events(execution_id,sequence)
    where (case when record->>'type'='native.unlinked_notification' then 'subagent'
      when record->>'type'='claude.tool' then 'tool'
      when record->>'type'='claude.task' then 'subagent'
      else coalesce(record#>>'{payload,item,type}',record#>>'{payload,part,type}') end) in
      ('commandExecution','fileChange','webSearch','mcpToolCall','dynamicToolCall','collabAgentToolCall','tool','subagent');

  create function advance_ci_activity_record_revision() returns trigger
  language plpgsql security invoker as $$
  begin
    NEW.activity_record_revision := OLD.activity_record_revision;
    -- Compare fields directly so a log refresh does not serialize stored test results.
    if NEW.log_tail is distinct from OLD.log_tail or NEW is distinct from OLD then
      NEW.activity_record_revision := OLD.activity_record_revision+1;
    end if;
    return NEW;
  end $$;
  drop trigger ci_activity_record_revision on ci_runs;
  create trigger ci_activity_record_revision before update on ci_runs
    for each row execute function advance_ci_activity_record_revision();
` } as const
