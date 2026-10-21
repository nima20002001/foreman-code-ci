export const providerAccountsMigration = {
  version: 2026101102,
  sql: `
    create table provider_account_accepted_bindings (
      owner_kind text not null check (owner_kind in ('run-node', 'operator-command', 'agent-conversation')),
      owner_id text not null,
      binding jsonb not null,
      account_id uuid,
      created_at timestamptz not null default now(),
      primary key (owner_kind, owner_id)
    );
    create index provider_account_accepted_uses on provider_account_accepted_bindings(account_id)
      where account_id is not null;
    create table provider_account_authentication_operations (
      id uuid primary key,
      principal_id text not null,
      cancel_principal_id text,
      source text not null check (source in ('http', 'mcp', 'device')),
      account_id uuid not null,
      target_key text not null,
      command_id text not null,
      input_hash text not null,
      record jsonb not null,
      native_closed boolean not null default false,
      unique (principal_id, command_id, target_key)
    );
    create unique index provider_account_authentication_slot_owner
      on provider_account_authentication_operations(account_id, target_key) where not native_closed;
  `,
} as const

export const providerAccountObservationsMigration = {
  version: 2026101103,
  sql: `create table provider_account_observations (
    target_key text not null, account_id uuid not null, record jsonb not null,
    primary key (target_key, account_id)
  );`,
} as const
