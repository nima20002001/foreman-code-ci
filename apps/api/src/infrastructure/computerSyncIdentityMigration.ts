export const computerSyncIdentityMigration = { version: 2026101605, sql: `
create table computer_sync_identities (
 host_key text not null, target jsonb not null, identity jsonb not null,
 primary key(host_key,target)
);
` }
