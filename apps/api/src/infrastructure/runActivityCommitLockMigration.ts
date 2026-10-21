/** Publish activity sequences at commit, independently of mutable Run rows. */
export const runActivityCommitLockMigration = { version: 2026101610, sql: `
  -- Block admission while installing the stream trigger and backfilling existing parents.
  lock table runs in share row exclusive mode;
  create table run_activity_streams (
    run_id text primary key references runs(id) on delete cascade
  );
  insert into run_activity_streams(run_id) select id from runs;

  create function create_run_activity_stream() returns trigger
  language plpgsql security invoker as $$
  begin
    insert into run_activity_streams(run_id) values(NEW.id);
    return NEW;
  end $$;
  -- AFTER triggers run by name: the stream must precede graphql_live_run's activity insert.
  create trigger activity_stream_created after insert on runs
    for each row execute function create_run_activity_stream();

  -- Activity checks an immutable identity row, so workflow mutation locks cannot block it.
  -- Deleting a Run still cascades through the stream to all of its activity.
  alter table run_activity drop constraint run_activity_run_id_fkey;
  alter table run_activity add constraint run_activity_run_id_fkey
    foreign key(run_id) references run_activity_streams(run_id) on delete cascade;

  drop trigger run_activity_commit_order on run_activity;
  drop function order_run_activity_insert();
  create function order_run_activity_commit() returns trigger
  language plpgsql security invoker as $$
  begin
    perform pg_advisory_xact_lock(hashtextextended(
      current_schema() || ':run_activity:' || NEW.run_id, 0));
    -- The insert identity is private until commit. Allocate the published identity under the lock,
    -- after application work and finalizers, so cursors cannot skip a later-committing writer.
    update run_activity set sequence=default where run_id=NEW.run_id and sequence=NEW.sequence;
    return null;
  end $$;
  create constraint trigger run_activity_commit_order after insert on run_activity
    deferrable initially deferred for each row execute function order_run_activity_commit();

  create or replace function record_requested_ci_activity(ticket jsonb, requester_execution_id text) returns void
  language plpgsql volatile security invoker as $$
  declare
    parent_run_id text;
    execution_id text;
  begin
    -- The saved Run/configuration identity is immutable; the stream FK protects parent existence.
    select r.id,e.id into parent_run_id,execution_id
    from harness_executions e join runs r on r.id=e.run_id
    where e.id=requester_execution_id and r.workspace_id=ticket->>'workspaceId'
      and e.record->>'agentConfigurationVersionId'=r.record->'agentConfigurationVersionIds'->>e.agent_id;
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
