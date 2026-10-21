export const workspaceProvisioningMigration = {
  version: 284101,
  sql: `create table workspace_project_provisioning (
    id text primary key,
    principal_id text not null,
    command_id text not null,
    workspace_id text not null,
    root_path text not null,
    staging_path text not null unique,
    identity jsonb,
    created_at timestamptz not null default now()
  );`,
}
