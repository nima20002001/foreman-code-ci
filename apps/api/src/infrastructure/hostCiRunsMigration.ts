/** Host CI runs: one row per suite run (or integration partition) a build computer executes directly. */
export const hostCiRunsMigration = { version: 2026101015, sql: `
  create table ci_runs (
    id uuid primary key,
    workspace_id text not null references workspaces(id),
    group_id uuid not null,
    state text not null check (state in ('queued','starting','running','passed','failed','canceled','lost')),
    host_key text,
    record jsonb not null,
    created_at timestamptz not null default now()
  );
  create index ci_runs_queue_idx on ci_runs(state,created_at,id);
  create index ci_runs_workspace_idx on ci_runs(workspace_id,created_at desc);
  create unique index ci_runs_one_per_computer on ci_runs(host_key) where state in ('starting','running');
` } as const
