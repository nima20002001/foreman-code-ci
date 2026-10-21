export const executionWorktreesMigration = { version: 2026101781, sql: `
  alter table run_worktrees drop constraint run_worktrees_pkey;
  alter table run_worktrees add column allocation_id text not null default '';
  alter table run_worktrees add primary key (run_id,allocation_id);
  alter table run_worktrees add column checkout_root text;
  update run_worktrees set checkout_root=record->>'workingDirectory';
  alter table run_worktrees alter column checkout_root set not null;
  alter table run_worktrees add column cleanup_attempts integer not null default 0;
  alter table run_worktrees add column cleanup_after timestamptz not null default now();
  update run_worktrees w set record=jsonb_set(w.record,'{state}','"preparing"'::jsonb)
    where w.record->>'state'='active' and not exists(
      select 1 from harness_executions e where e.run_id=w.run_id
        and e.record->>'workingDirectory'=w.record->>'workingDirectory'
        and e.record->>'nativeSessionId' is not null);
` } as const
