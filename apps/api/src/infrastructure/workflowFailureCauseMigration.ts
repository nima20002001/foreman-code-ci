export const workflowFailureCauseMigration = {
  version: 2026100910,
  sql: `alter table run_cleanup_intents add column failure_result jsonb
    check (failure_result is null or (
      jsonb_typeof(failure_result)='object' and failure_result->>'outcome'='failed'
      and jsonb_typeof(failure_result->'error')='object'))`,
} as const
