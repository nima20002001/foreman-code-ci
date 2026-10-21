export const bugReportsMigration = { version: 2026101003, sql: `
  create table bug_reports (
    id text primary key,
    workspace_id text not null references workspaces(id),
    workflow_id text references workflows(id),
    run_id text references runs(id),
    fingerprint text not null unique,
    status text not null check (status in ('open','triaged','fixed','wont-fix')),
    severity text not null check (severity in ('low','medium','high','critical')),
    revision bigint not null check (revision > 0),
    record jsonb not null,
    created_at timestamptz not null default now()
  );
  create index bug_reports_recent_idx on bug_reports(created_at desc,id desc);
  create index bug_reports_workspace_idx on bug_reports(workspace_id,status,severity,created_at desc,id desc);
  update management_principals p
    set grants=p.grants || '[{"actions":["bug_reports:report","bug_reports:read","bug_reports:update"],"scope":{}}]'::jsonb
    from local_human_principal h where h.principal_id=p.id;
` } as const
