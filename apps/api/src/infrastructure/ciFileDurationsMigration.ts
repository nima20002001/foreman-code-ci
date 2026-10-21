/** Host CI learns each repository's integration file durations from finished runs; a queued integration run keeps
 * the snapshot it was planned with, so all its partitions split the files the same way. */
export const ciFileDurationsMigration = { version: 2026101101, sql: `
  create table ci_file_durations (
    repository text not null,
    file text not null,
    duration_ms integer not null check (duration_ms > 0),
    samples integer not null default 1,
    updated_at timestamptz not null default now(),
    primary key (repository, file)
  );
  alter table ci_runs add column durations jsonb;
` } as const
