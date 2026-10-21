/** Cleanup filters by either executor before extracting the retained ticket records. */
export const ciDirectoryRetentionMigration = { version: 2026101604, sql: `
  create index ci_runs_terminal_computer_idx
    on ci_runs using gin ((record#>'{computer,hostRef}') jsonb_path_ops)
    where state in ('passed','failed','canceled','lost');
  create index ci_runs_terminal_failed_computer_idx
    on ci_runs using gin ((record#>'{setupRetry,failedComputer}') jsonb_path_ops)
    where state in ('passed','failed','canceled','lost');
` } as const
