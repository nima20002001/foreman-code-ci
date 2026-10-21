/** Reserved separately from the parallel runtime/reviewer bundles. No native credentials are stored. */
export const harnessSettingsMigration = {
  version: 170017,
  sql: `
    create table if not exists harness_mcp_change_plans (
      id uuid primary key,
      harness text not null check (harness in ('codex', 'opencode')),
      revision text not null,
      change jsonb not null,
      requested_by text not null references management_principals(id),
      status text not null check (status in ('pending','submitting','applied','rejected','failed','uncertain')),
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      decided_by text references management_principals(id),
      error text
    );
    create index if not exists harness_mcp_plans_status_idx on harness_mcp_change_plans(harness,status,created_at desc);
  `,
}
