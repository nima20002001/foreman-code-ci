export const ciActivityRunLockMigration = { version: 2026101502, sql: `
  create or replace function record_host_ci_activity(ticket jsonb) returns void
  language plpgsql volatile security invoker as $$
  declare
    parent_run_id text;
    execution_id text;
  begin
    -- Run writers lock the parent before the activity sequence advisory lock.
    select r.id,e.id into parent_run_id,execution_id
    from harness_executions e join runs r on r.id=e.run_id
    where e.id=ticket#>>'{initiator,executionId}' and r.workspace_id=ticket->>'workspaceId'
      and e.record->>'agentConfigurationVersionId'=r.record->'agentConfigurationVersionIds'->>e.agent_id
    for key share of r;
    if parent_run_id is null then return; end if;

    insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
    values(parent_run_id,'backend','ci_state_changed',execution_id,clock_timestamp(),jsonb_build_object(
      'ticketId',ticket->>'id','ci',jsonb_build_object(
        'id',ticket->>'id','groupId',ticket->>'groupId','suite',ticket->>'suite',
        'part',ticket->'part','partition',ticket->'partition','state',ticket->>'state',
        'computer',case when ticket->'computer' <> 'null'::jsonb then jsonb_build_object(
          'hostRef',ticket#>'{computer,hostRef}','label',left(ticket#>>'{computer,label}',100)) else null end,
        'step',left(ticket->>'step',80),'exitCode',ticket->'exitCode',
        'queuedAt',ticket->>'queuedAt','startedAt',ticket->>'startedAt','finishedAt',ticket->>'finishedAt')));
  end $$;
` } as const
