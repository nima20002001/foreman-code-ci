/** Shared tickets publish lifecycle observations under every requesting execution. */
export const ciSharedActivityMigration = { version: 2026101603, sql: `
  create function record_requested_ci_activity(ticket jsonb, requester_execution_id text) returns void
  language plpgsql volatile security invoker as $$
  declare
    parent_run_id text;
    execution_id text;
  begin
    -- Run writers lock the parent before the activity sequence advisory lock.
    select r.id,e.id into parent_run_id,execution_id
    from harness_executions e join runs r on r.id=e.run_id
    where e.id=requester_execution_id and r.workspace_id=ticket->>'workspaceId'
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

  create or replace function record_host_ci_activity(ticket jsonb) returns void
  language plpgsql volatile security invoker as $$
  declare requester record;
  begin
    for requester in
      select e.id from harness_executions e join runs r on r.id=e.run_id
      where r.workspace_id=ticket->>'workspaceId' and (e.id=ticket#>>'{initiator,executionId}'
        or exists(select 1 from ci_group_requesters q where q.workspace_id=r.workspace_id
          and q.group_id::text=ticket->>'groupId' and q.execution_id=e.id))
      order by r.id,e.id
    loop
      perform record_requested_ci_activity(ticket,requester.id);
    end loop;
  end $$;

  create function record_joined_ci_activity() returns trigger
  language plpgsql security invoker as $$
  declare ticket record;
  begin
    if NEW.initiator or NEW.execution_id is null then return NEW; end if;
    for ticket in select c.record from ci_runs c
      where c.workspace_id=NEW.workspace_id and c.group_id=NEW.group_id
        and c.record#>>'{initiator,executionId}' is distinct from NEW.execution_id
        and not exists(select 1 from ci_group_requesters q where q.workspace_id=NEW.workspace_id
          and q.group_id=NEW.group_id and q.execution_id=NEW.execution_id
          and q.principal_id<>NEW.principal_id)
      order by c.created_at,c.id
    loop
      perform record_requested_ci_activity(ticket.record,NEW.execution_id);
    end loop;
    return NEW;
  end $$;
  create trigger joined_ci_activity after insert on ci_group_requesters
    for each row execute function record_joined_ci_activity();

  -- Retained joined requests get a present-state observation without invented earlier transitions.
  select record_requested_ci_activity(c.record,q.execution_id)
  from ci_runs c join (select distinct workspace_id,group_id,execution_id from ci_group_requesters
    where not initiator and execution_id is not null) q
    on q.workspace_id=c.workspace_id and q.group_id=c.group_id
  where q.execution_id is distinct from c.record#>>'{initiator,executionId}'
    and not exists(select 1 from run_activity a where a.harness_execution_id=q.execution_id
      and a.kind='ci_state_changed' and a.payload->>'ticketId'=c.id::text)
  order by c.created_at,c.id,q.execution_id;
` } as const
