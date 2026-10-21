/** SCH-03. Register explicitly; legacy workflow_triggers are deliberately untouched. */
export const workflowScheduleMigration = {
  version: 270203,
  sql: `
    create unique index workflow_schedule_workflow_scope_idx on workflows (workspace_id, id);

    -- A cleared row is a permanent authority/revision tombstone, not a legacy fallback.
    create table workflow_schedules (
      workflow_id text primary key,
      workspace_id text not null,
      revision bigint not null check (revision between 1 and 9007199254740991),
      record jsonb,
      enabled boolean not null,
      next_occurrence_at timestamptz,
      cleared_at timestamptz,
      updated_by_principal_id text not null references management_principals(id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (workspace_id, workflow_id),
      foreign key (workspace_id, workflow_id) references workflows (workspace_id, id),
      check ((
        (record is null and cleared_at is not null and not enabled and next_occurrence_at is null)
        or (record is not null and cleared_at is null and jsonb_typeof(record) = 'object'
          and record->>'workspaceId' = workspace_id and record->>'workflowId' = workflow_id
          and (record->>'revision')::bigint = revision
          and (record->>'enabled')::boolean = enabled
          and (record->>'nextOccurrenceAt')::timestamptz is not distinct from next_occurrence_at)
      ) is true),
      check (enabled or next_occurrence_at is null),
      check (next_occurrence_at = date_trunc('milliseconds', next_occurrence_at))
    );
    create index workflow_schedules_due_idx on workflow_schedules (next_occurrence_at, workflow_id)
      where enabled and cleared_at is null and next_occurrence_at is not null;

    create table workflow_schedule_occurrences (
      id text primary key,
      workspace_id text not null,
      workflow_id text not null,
      due_at timestamptz not null,
      schedule_revision bigint not null check (schedule_revision between 1 and 9007199254740991),
      status text not null check (status in ('accepted', 'skipped', 'missed', 'rejected')),
      reason text,
      workflow_version_id text references workflow_versions(id),
      run_id text references runs(id),
      record jsonb not null,
      recorded_at timestamptz not null default now(),
      foreign key (workspace_id, workflow_id) references workflow_schedules (workspace_id, workflow_id),
      unique (workflow_id, due_at),
      check (due_at = date_trunc('milliseconds', due_at)),
      check ((
        (status = 'accepted' and reason is null and workflow_version_id is not null and run_id is not null)
        or (workflow_version_id is null and run_id is null and (
          (status = 'skipped' and reason in ('overlap', 'disabled'))
          or (status = 'missed' and reason in ('outside_grace', 'superseded'))
          or (status = 'rejected' and length(btrim(reason)) between 1 and 200)))
      ) is true),
      check ((jsonb_typeof(record) = 'object' and record->>'id' = id
        and record->>'workspaceId' = workspace_id and record->>'workflowId' = workflow_id
        and (record->>'dueAt')::timestamptz = due_at
        and (record->>'scheduleRevision')::bigint = schedule_revision
        and record->>'status' = status
        and record->>'reason' is not distinct from reason
        and record->>'workflowVersionId' is not distinct from workflow_version_id
        and record->>'runId' is not distinct from run_id) is true)
    );
    create index workflow_schedule_occurrences_recent_idx
      on workflow_schedule_occurrences (workspace_id, workflow_id, due_at desc);

    create function workflow_schedule_occurrence_immutable() returns trigger language plpgsql as $$
    begin
      raise exception 'Schedule occurrences are immutable' using errcode = '23514';
    end;
    $$;
    create trigger workflow_schedule_occurrences_immutable
      before update or delete on workflow_schedule_occurrences
      for each row execute function workflow_schedule_occurrence_immutable();
  `,
} as const
