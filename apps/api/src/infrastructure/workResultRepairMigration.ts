export const workResultRepairMigration = { version: 2026101212, sql: `
  create table execution_work_result_repairs (
    execution_id text not null references harness_executions(id) on delete cascade,
    attempt integer not null check (attempt between 1 and 2),
    rejected_provider_id text not null,
    created_at timestamptz not null default now(),
    primary key (execution_id, attempt),
    unique (execution_id, rejected_provider_id)
  );
` } as const
