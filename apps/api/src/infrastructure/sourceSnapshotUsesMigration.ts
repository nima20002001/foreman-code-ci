export const sourceSnapshotUsesMigration = {
  version: 2026101701,
  sql: `create table source_snapshot_uses (
    use_id uuid not null,
    snapshot_id uuid not null references source_snapshots(snapshot_id),
    owner jsonb not null,
    primary key(use_id,snapshot_id)
  );
  create index source_snapshot_uses_snapshot_idx on source_snapshot_uses(snapshot_id);`,
} as const
