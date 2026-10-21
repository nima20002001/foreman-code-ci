export const ciExecutorCleanupMigration = { version: 2026101811, sql: `
  create index ci_runs_executor_cleanup_idx on ci_runs(host_key,id)
    where record->>'executorCleanupPending'='true';
` } as const
