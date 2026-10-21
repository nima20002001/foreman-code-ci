export const ciRecoveryIndexesMigration = { version: 2026101510, sql: `
  create index ci_runs_recovery_idx on ci_runs(id)
    where state in ('starting','running') or record->>'collection'='pending'
      or (state in ('passed','failed','canceled','lost') and record#>>'{observation,status}'='unavailable');
  create index ci_runs_failed_gate_group_idx on ci_runs(group_id)
    where state in ('failed','lost') and record->>'gate'='true';
` } as const
