/** Append-only configuration history; native credentials and qualification claims are excluded. */
export const harnessInstanceSettingsMigration = { version: 283401, sql: `
create table harness_instance_settings (
 instance_id uuid not null, revision bigint not null check (revision > 0),
 host_key text not null, application_installation_id uuid not null,
 record jsonb not null, configuration_fingerprint text not null,
 created_by text not null references management_principals(id),
 created_at timestamptz not null default now(),
 primary key(instance_id, revision)
);
create index harness_instance_settings_host_idx on harness_instance_settings(host_key, application_installation_id, instance_id, revision desc);
` } as const
