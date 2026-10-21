export const operatorSummaryActivityMigration = {
  version: 2026101702,
  sql: `create index operator_activity_unresolved_summary_idx
    on operator_conversation_activity (conversation_id, (record->>'status'))
    where record->>'kind'<>'thinking' and record->>'status' in ('pending','running','unknown');`,
} as const
