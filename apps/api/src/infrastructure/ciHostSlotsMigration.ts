export const ciHostSlotsMigration = { version: 2026101304, sql: `
  drop index ci_runs_one_per_computer;
  create index ci_runs_active_computer_idx on ci_runs(host_key) where state in ('starting','running');
` } as const
