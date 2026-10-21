export const pr17AuditMigration = {
  version: 1701,
  sql: `
    create table run_authority_principals (
      principal_id text primary key references management_principals(id),
      run_id text not null unique references runs(id) on delete cascade,
      owner_principal_id text not null references management_principals(id),
      caller_principal_id text not null,
      grant_ceiling jsonb not null check (jsonb_typeof(grant_ceiling)='array'),
      accepted_expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      check (principal_id <> owner_principal_id)
    );
    create table run_cleanup_intents (
      run_id text primary key references runs(id) on delete cascade,
      pending boolean not null default true,
      attempts integer not null default 0,
      last_error text,
      requested_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index run_cleanup_pending_idx on run_cleanup_intents(run_id) where pending;
    -- Recover already-recorded cleanup failures without changing the Run's business outcome.
    insert into run_cleanup_intents(run_id,last_error)
      select id,'Legacy RUN_CLEANUP_FAILED requires confirmed native cleanup.' from runs
      where record->'error'->>'code'='RUN_CLEANUP_FAILED'
         or record->'result'->'error'->>'code'='RUN_CLEANUP_FAILED'
      on conflict do nothing;
  `,
} as const
