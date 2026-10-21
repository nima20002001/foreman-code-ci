/** Identical active CI requests of one workspace share one ticket group. A group's request key finds it while it is
 * active; once another requester joins, every requester (the initiator included) has a row, and a group whose rows
 * are all detached has no requester left. */
export const ciRequestSharingMigration = { version: 2026101601, sql: `
  create table ci_request_groups (
    group_id uuid primary key,
    workspace_id text not null references workspaces(id),
    request_key text not null,
    output jsonb not null,
    created_at timestamptz not null default now()
  );
  create index ci_request_groups_key_idx on ci_request_groups(workspace_id,request_key,created_at desc);
  create table ci_group_requesters (
    group_id uuid not null,
    workspace_id text not null references workspaces(id),
    principal_id text not null,
    execution_id text,
    initiator boolean not null,
    command_id text,
    joined_at timestamptz not null default now(),
    detached_at timestamptz
  );
  create unique index ci_group_requesters_identity_idx
    on ci_group_requesters(group_id,principal_id,coalesce(execution_id,''));
  create index ci_group_requesters_execution_idx on ci_group_requesters(workspace_id,execution_id)
    where execution_id is not null;
  create index ci_group_requesters_principal_idx on ci_group_requesters(workspace_id,principal_id);
` } as const
