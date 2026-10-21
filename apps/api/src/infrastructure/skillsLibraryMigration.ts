/** Skills v1 (NIM-2672): one logical head per workspace skill over the existing immutable
 * versions. Existing versions are kept byte-for-byte; heads are backfilled deterministically
 * from the latest version by (created_at, version). */
export const skillsLibraryMigration = { version: 267201, sql: `
  alter table workspace_skill_versions add column if not exists sequence integer;
  update workspace_skill_versions v set sequence=ordered.sequence from (
    select workspace_id,skill_id,version,row_number() over (partition by workspace_id,skill_id order by created_at,version)::integer as sequence
    from workspace_skill_versions
  ) ordered where v.workspace_id=ordered.workspace_id and v.skill_id=ordered.skill_id and v.version=ordered.version and v.sequence is null;
  alter table workspace_skill_versions alter column sequence set not null;
  create unique index if not exists workspace_skill_versions_sequence_idx on workspace_skill_versions(workspace_id,skill_id,sequence);

  create table if not exists workspace_skills (
    workspace_id text not null references workspaces(id),
    skill_id text not null,
    head_version text not null,
    revision bigint not null check (revision > 0),
    version_count integer not null check (version_count > 0),
    archived_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key(workspace_id,skill_id),
    foreign key(workspace_id,skill_id,head_version) references workspace_skill_versions(workspace_id,skill_id,version)
  );
  insert into workspace_skills(workspace_id,skill_id,head_version,revision,version_count,created_at,updated_at)
  select distinct on (workspace_id,skill_id) workspace_id,skill_id,version,
    count(*) over (partition by workspace_id,skill_id),count(*) over (partition by workspace_id,skill_id),
    min(created_at) over (partition by workspace_id,skill_id),created_at
  from workspace_skill_versions order by workspace_id,skill_id,sequence desc
  on conflict do nothing;
` } as const
