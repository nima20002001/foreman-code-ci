export const checkpointOwnerMigration = {
  version: 2026101311,
  sql: `create table run_checkpoint_owners (
    run_id text primary key,
    generation bigint not null check (generation > 0),
    owner_pid integer not null,
    owner_started_at timestamptz not null
  )`,
} as const
