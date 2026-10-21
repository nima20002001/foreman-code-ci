export const ciGateSpeedIndexMigration = { version: 2026101609, sql: `
  create index if not exists ci_passed_gate_integration_idx on ci_runs (created_at desc)
    where state='passed' and record->>'suite'='integration' and record->>'gate'='true'
      and record->>'finishedAt' is not null;
` } as const
