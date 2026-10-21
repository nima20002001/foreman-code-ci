export const ciFailureHistoryMigration = { version: 2026101606, sql: `
  create index ci_gate_test_files_idx on ci_runs using gin ((test_results->'files') jsonb_path_ops)
    where record->>'gate'='true' and state in ('passed','failed');
` } as const
