/** CI transitions look up their requesters without scanning unrelated execution history. */
export const ciActivityRequesterLookupMigration = { version: 2026102101, sql: `
  create or replace function record_host_ci_activity(ticket jsonb) returns void
  language plpgsql volatile security invoker as $$
  declare
    ticket_workspace_id text := ticket->>'workspaceId';
    ticket_group_id uuid := (ticket->>'groupId')::uuid;
    initiator_execution_id text := ticket#>>'{initiator,executionId}';
    requester record;
  begin
    -- Scalar IDs keep cached generic plans from repeatedly extracting the full ticket JSON.
    for requester in
      select e.id from (
        select initiator_execution_id as execution_id where initiator_execution_id is not null
        union
        select q.execution_id from ci_group_requesters q
        where q.workspace_id=ticket_workspace_id and q.group_id=ticket_group_id
          and q.execution_id is not null
      ) requested
      join harness_executions e on e.id=requested.execution_id
      join runs r on r.id=e.run_id
      where r.workspace_id=ticket_workspace_id
      order by r.id,e.id
    loop
      perform record_requested_ci_activity(ticket,requester.id);
    end loop;
  end $$;
` } as const
