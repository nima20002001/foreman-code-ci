export const computerSyncMigration = { version: 2026100859, sql: `
create table computer_sync_preferences (
 workspace_id text not null references workspaces(id), host_key text not null,
 target jsonb not null, revision bigint not null check(revision>0), enabled boolean not null,
 updated_by text not null references management_principals(id),
 primary key(workspace_id,host_key)
);
` }
