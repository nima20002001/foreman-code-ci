/** Existing receipts own immutable admission time; no synthetic historical start is backfilled. */
export const activitySnapshotMigration = {
  version: 282501,
  sql: `alter table operator_conversation_turns add column started_at timestamptz;
    alter table operator_conversation_activity add column source_provenance jsonb not null default '{}'::jsonb;`,
}
