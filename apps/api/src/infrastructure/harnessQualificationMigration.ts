export const harnessQualificationMigration = { version: 278001, sql: `
  create table harness_qualifications (
    harness text not null check (harness in ('codex', 'opencode')),
    version text not null,
    binary_sha256 text not null check (binary_sha256 ~ '^[0-9a-f]{64}$'),
    suite_revision text not null,
    profile text not null,
    status text not null check (status in ('qualifying', 'passed', 'failed')),
    checks jsonb not null default '[]'::jsonb,
    evidence jsonb not null default '{}'::jsonb,
    failure_reason text,
    started_at timestamptz not null default now(),
    checked_at timestamptz,
    primary key (harness, version, binary_sha256, suite_revision)
  );
` } as const
