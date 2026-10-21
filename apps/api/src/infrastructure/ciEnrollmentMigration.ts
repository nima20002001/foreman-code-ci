export const ciEnrollmentMigration = { version: 2026100905, sql: String.raw`
create table ci_enrollment_workspaces (
 workspace_id text primary key references workspaces(id),
 principal jsonb not null
);
create table ci_enrollment_computers (
 workspace_id text not null references workspaces(id),
 host_key text not null,
 revision bigint not null default 0,
 enabled boolean not null default true,
 profiles jsonb not null default '{}'::jsonb,
 state jsonb not null,
 primary key(workspace_id,host_key)
);
` }
