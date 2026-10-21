/** CI polling reads the last background refresh without contacting build computers. */
export const ciLogTailMigration = { version: 2026101211, sql: `
  alter table ci_runs add column log_tail text not null default '';
` } as const
