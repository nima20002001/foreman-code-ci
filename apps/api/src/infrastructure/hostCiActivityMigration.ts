/** Host CI lifecycle observations commit with the persisted CI run. */
export const hostCiActivityMigration = { version: 2026101104, sql: `
  drop trigger agent_ci_queue_activity on job_admission_queue;
  drop trigger agent_ci_process_activity on job_executions;
  drop function record_agent_ci_queue_activity();
  drop function record_agent_ci_process_activity();
  drop function record_agent_ci_activity(jsonb,text,text);

  alter table ci_runs add column activity_record_revision bigint not null default 0;
  create trigger ci_activity_record_revision before update on ci_runs
    for each row execute function advance_activity_record_revision();
  create index ci_runs_initiating_execution_idx on ci_runs(workspace_id,(record#>>'{initiator,executionId}'));

  create function record_host_ci_activity(ticket jsonb) returns void
  language sql volatile security invoker as $$
    insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
    select r.id,'backend','ci_state_changed',e.id,clock_timestamp(),jsonb_build_object(
      'ticketId',ticket->>'id','ci',jsonb_build_object(
        'id',ticket->>'id','groupId',ticket->>'groupId','suite',ticket->>'suite',
        'part',ticket->'part','partition',ticket->'partition','state',ticket->>'state',
        'computer',case when ticket->'computer' <> 'null'::jsonb then jsonb_build_object(
          'hostRef',ticket#>'{computer,hostRef}','label',left(ticket#>>'{computer,label}',100)) else null end,
        'step',left(ticket->>'step',80),'exitCode',ticket->'exitCode',
        'queuedAt',ticket->>'queuedAt','startedAt',ticket->>'startedAt','finishedAt',ticket->>'finishedAt'))
    from harness_executions e join runs r on r.id=e.run_id
    where e.id=ticket#>>'{initiator,executionId}' and r.workspace_id=ticket->>'workspaceId'
      and e.record->>'agentConfigurationVersionId'=r.record->'agentConfigurationVersionIds'->>e.agent_id;
  $$;

  create function record_host_ci_state_change() returns trigger
  language plpgsql security invoker as $$
  begin
    if TG_OP='UPDATE' then
      if NEW.workspace_id is distinct from OLD.workspace_id or NEW.group_id is distinct from OLD.group_id
        or NEW.record->'initiator' is distinct from OLD.record->'initiator' then
        raise exception 'CI run ownership cannot change';
      end if;
      if OLD.state=NEW.state and OLD.record->'computer' is not distinct from NEW.record->'computer'
        and OLD.record->'step' is not distinct from NEW.record->'step' then return NEW; end if;
    end if;
    perform record_host_ci_activity(NEW.record);
    return NEW;
  end $$;
  create trigger host_ci_run_activity after insert or update of record on ci_runs
    for each row execute function record_host_ci_state_change();

  -- Retained runs get one present-state observation; earlier transitions remain unknown.
  select record_host_ci_activity(record) from ci_runs where record#>>'{initiator,executionId}' is not null;
` } as const
