export const runWorktreesMigration = { version: 2026101012, sql: `
  create table run_worktrees (
    run_id text primary key references runs(id),
    repository_root text not null,
    record jsonb not null,
    created_at timestamptz not null default now()
  );
  alter table source_execution_materializations add column worktree_cleanup jsonb;
` } as const
