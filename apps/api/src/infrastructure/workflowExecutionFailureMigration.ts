export const workflowExecutionFailureMigration = {
  version: 2026101001,
  sql: `alter table approval_execution_state add column failure_result jsonb
    check (failure_result is null or (
      jsonb_typeof(failure_result)='object' and failure_result->>'outcome'='failed'
      and jsonb_typeof(failure_result->'error')='object'))`,
} as const
