export const ciRetainedExecutorsMigration = { version: 2026101901, sql: `
  create index ci_runs_retained_executors_idx on ci_runs(id)
    where record->'retainedExecutions' @> '[{"executor":"retained"}]'::jsonb;
` } as const
