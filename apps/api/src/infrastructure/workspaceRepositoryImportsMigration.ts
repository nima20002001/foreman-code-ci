export const workspaceRepositoryImportsMigration = {
  version: 2026101002,
  sql: `create table workspace_repository_imports (
    import_id uuid primary key,
    principal_id text not null references management_principals(id),
    workspace_id text not null references workspaces(id),
    command_id text not null,
    input_hash text not null,
    input jsonb not null,
    phase text not null check (phase in
      ('reserved','cloned','published','metadata','location','approved','bound','ready')),
    preparation jsonb not null,
    results jsonb not null default '{}'::jsonb,
    failure jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    finished_at timestamptz,
    unique(principal_id,command_id)
  );
  create unique index workspace_repository_import_pending
    on workspace_repository_imports(workspace_id) where finished_at is null;
  create index workspace_repository_import_readback
    on workspace_repository_imports(workspace_id,created_at desc);`,
} as const
