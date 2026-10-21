export const deviceIdentityMigration = { version: 282101, sql: `
create table device_main_identity (main_id uuid primary key, record jsonb not null);
create table device_authorization_secret (singleton boolean primary key check(singleton), secret text not null);
create table device_registrations (
 id uuid primary key, main_id uuid not null, worker_installation_id uuid not null unique,
 public_key text not null, record jsonb not null,
 credential_hash text unique, credential_expires_at timestamptz,
 created_at timestamptz not null default now()
);
create table device_pairing_grants (
 id uuid primary key, token_hash text not null unique, device_id uuid not null references device_registrations(id),
 authorization_revision bigint not null, expires_at timestamptz not null, consumed_request_id uuid, consumed_at timestamptz,
 principal_id text not null references management_principals(id)
);
` } as const
