// Dedicated block after HAP-07. Preserve all history and existing credential grants.
export const operatorMcpMigration = { version: 800, sql: `
  alter table agents add column if not exists archived_at timestamptz;
  create index if not exists agents_active_workspace_idx on agents(workspace_id,id) where archived_at is null;
  create table if not exists workspace_skill_versions (
    workspace_id text not null references workspaces(id),
    skill_id text not null,
    version text not null,
    record jsonb not null,
    created_at timestamptz not null default now(),
    primary key(workspace_id,skill_id,version)
  );
  create table if not exists workflow_triggers (
    workspace_id text not null references workspaces(id),
    workflow_id text primary key references workflows(id),
    revision bigint not null default 0,
    principal_id text not null references management_principals(id),
    record jsonb not null,
    enabled boolean not null,
    next_fire_at timestamptz,
    last_error text
  );
  create index if not exists workflow_trigger_due_idx on workflow_triggers(next_fire_at,workflow_id) where enabled;
  create table if not exists workflow_trigger_jobs (
    id text primary key,
    workspace_id text not null references workspaces(id),
    workflow_id text not null references workflows(id),
    principal_id text not null references management_principals(id),
    trigger_revision bigint not null,
    payload jsonb not null,
    status text not null default 'queued' check(status in ('queued','leased','started','blocked')),
    run_id text references runs(id),
    error_code text,
    lease_owner text,
    lease_expires_at timestamptz,
    attempts integer not null default 0,
    available_at timestamptz not null default now(),
    created_at timestamptz not null default now()
  );
  create index if not exists workflow_trigger_jobs_ready_idx on workflow_trigger_jobs(available_at,created_at,id) where status='queued';
  create index if not exists workflow_trigger_jobs_expired_idx on workflow_trigger_jobs(lease_expires_at,id) where status='leased';
` } as const
