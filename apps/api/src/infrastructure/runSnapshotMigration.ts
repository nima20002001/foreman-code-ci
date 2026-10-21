/** SCH-05: no backfill from mutable workflows/Agents. No Agent or edge foreign
 * keys: saving/removing current nodes cannot cascade into these Run facts. */
export const runSnapshotMigration = { version: 270205, sql: `
  create unique index runs_board_snapshot_scope_idx
    on runs(id, workspace_id, workflow_id, workflow_version_id);
  create index runs_dropdown_admission_idx
    on runs(workspace_id, workflow_id, created_at desc, id collate "C" desc);

  create table run_board_snapshots (
    run_id text primary key,
    workspace_id text not null,
    workflow_id text not null,
    workflow_version_id text not null,
    captured_at timestamptz not null,
    admission_trigger text not null check (admission_trigger in ('manual','schedule')),
    record jsonb not null,
    foreign key (run_id, workspace_id, workflow_id, workflow_version_id)
      references runs(id, workspace_id, workflow_id, workflow_version_id) on delete restrict,
    check (jsonb_typeof(record) = 'object'),
    check ((record->>'kind' = 'available'
      and record->>'runId' = run_id
      and record->>'workspaceId' = workspace_id
      and record->>'workflowId' = workflow_id
      and record->>'workflowVersionId' = workflow_version_id
      and (record->>'capturedAt')::timestamptz = captured_at
      and jsonb_typeof(record->'nodes') = 'array'
      and jsonb_typeof(record->'edges') = 'array') is true)
  );

  create function protect_run_board_snapshot() returns trigger language plpgsql as $$
  begin
    raise exception 'Run board snapshots are immutable' using errcode = '23514';
  end;
  $$;
  create trigger run_board_snapshot_immutable
    before update or delete on run_board_snapshots
    for each row execute function protect_run_board_snapshot();

  -- The keyset is an admission fact; status/start/finish updates remain legal.
  create function protect_run_dropdown_order() returns trigger language plpgsql as $$
  begin
    if new.id is distinct from old.id or new.created_at is distinct from old.created_at
      or new.workspace_id is distinct from old.workspace_id
      or new.workflow_id is distinct from old.workflow_id then
      raise exception 'Run admission identity and ordering are immutable' using errcode = '23514';
    end if;
    return new;
  end;
  $$;
  create trigger run_dropdown_order_immutable before update on runs
    for each row execute function protect_run_dropdown_order();
` } as const
