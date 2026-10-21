export const ciDispatchClaimsMigration = { version: 2026101503, sql: `
  create table ci_dispatch_claims (
    ticket_id text primary key,
    owner_id uuid not null,
    expires_at timestamptz not null
  );
` } as const
