export const ciRuntimePreparationMigration = { version: 285905, sql: String.raw`
create table ci_runtime_preparations (
 id uuid primary key,
 workspace_id text not null references workspaces(id),
 device_id uuid not null references device_registrations(id),
 principal_id text not null references management_principals(id),
 command_id text not null,
 record jsonb not null,
 active boolean not null,
 created_at timestamptz not null default clock_timestamp(),
 unique(principal_id,command_id)
);
create unique index ci_runtime_preparation_owner on ci_runtime_preparations(device_id) where active;
create index ci_runtime_preparation_workspace on ci_runtime_preparations(workspace_id,device_id,created_at desc);
` }
