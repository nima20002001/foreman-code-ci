/** FIL-40. Register after fileStorageMigration; do not renumber on integration. */
export const fileRetentionMigration = {
  version: 273640,
  sql: `
    create table file_retention_preferences (
      owner_principal_id text primary key references management_principals(id),
      duration_seconds integer not null default 604800
        check (duration_seconds between 3600 and 31536000),
      revision integer not null check (revision >= 0)
    );
    create index files_live_retention_owner_idx on files (owner_principal_id, expires_at, file_id)
      where scope_kind='temporary' and state in ('pending','ready');
  `,
} as const
