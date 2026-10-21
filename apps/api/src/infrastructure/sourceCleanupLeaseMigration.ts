export const sourceCleanupLeaseMigration = {
  version: 2026100604,
  sql: `alter table source_execution_materializations add column if not exists cleanup_lease_expires_at timestamptz;`,
} as const
