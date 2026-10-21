/** Source-keyed projections use the existing committed Run activity stream. */
export const workflowCollaborationMigration = { version: 2026102104, sql: String.raw`
create unique index run_activity_collaboration_source
  on run_activity(run_id,(payload->>'sourceEventKey'))
  where source='backend' and kind='collaboration_lifecycle';

create table workflow_collaboration_preparations (
  execution_id text primary key references harness_executions(id),
  run_id text not null references runs(id) on delete cascade,
  subject jsonb not null,
  work jsonb not null,
  board_digest jsonb,
  browser_input jsonb,
  browser_state text check(browser_state in ('preparing','ready','unavailable','releasing','released')),
  browser_session_id text,
  browser_unavailable jsonb,
  browser_release_reason text check(browser_release_reason in ('terminal','stop')),
  check((browser_input is null) = (browser_state is null)),
  check(browser_state <> 'ready' or browser_session_id is not null),
  check(browser_state <> 'releasing' or browser_release_reason is not null),
  check(subject->>'kind'='execution'),
  check(subject->'execution'->>'executionId'=execution_id),
  check(subject->'execution'->>'runId'=run_id),
  check(work->>'runId'=run_id)
);
create index workflow_collaboration_cleanup on workflow_collaboration_preparations(run_id)
  where browser_state is not null and browser_state <> 'released';
create index workflow_collaboration_memory_work on workflow_collaboration_preparations(run_id,work)
  where board_digest is not null;

create function retain_workflow_collaboration_identity() returns trigger language plpgsql as $$
begin
  if new.execution_id is distinct from old.execution_id or new.run_id is distinct from old.run_id
    or new.subject is distinct from old.subject or new.work is distinct from old.work
    or old.board_digest is not null and new.board_digest is distinct from old.board_digest
    or old.browser_input is not null and new.browser_input is distinct from old.browser_input
    or old.browser_session_id is not null and new.browser_session_id is distinct from old.browser_session_id
    or old.browser_release_reason is not null and new.browser_release_reason is distinct from old.browser_release_reason
    or old.browser_state='released' and new is distinct from old then
    raise exception 'COLLABORATION_PREPARATION_IDENTITY_CONFLICT';
  end if;
  return new;
end $$;
create trigger workflow_collaboration_identity before update on workflow_collaboration_preparations
  for each row execute function retain_workflow_collaboration_identity();
` } as const
