/** Historical executors participate in host-specific directory cleanup. */
export const ciExecutionHistoryMigration = { version: 2026101608, sql: `
  create index ci_runs_terminal_execution_history_idx
    on ci_runs using gin ((record->'executionHistory') jsonb_path_ops)
    where state in ('passed','failed','canceled','lost');
` } as const
