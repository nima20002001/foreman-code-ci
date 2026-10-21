export const workDirectionResponseMigration = { version: 2026101010, sql: `
  create table run_work_direction_responses (
    interaction_id text primary key references durable_interactions(id) on delete cascade,
    principal_id text not null references management_principals(id),
    source text not null check (source in ('http','mcp')),
    start_input jsonb,
    continuation_run_id text references runs(id),
    check (start_input is null or jsonb_typeof(start_input)='object')
  );
` } as const
