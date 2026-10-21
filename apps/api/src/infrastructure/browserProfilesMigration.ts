/** Team D registers this SQL under the next migration version in dependency order. */
export const browserProfilesMigration = {
  name: 'managed-browser-profiles',
  sql: String.raw`
create table browser_catalog_revision (singleton boolean primary key default true check(singleton), revision bigint not null);
insert into browser_catalog_revision(singleton,revision) values(true,0);
create table browser_profiles (
 id text primary key, record jsonb not null, deleted boolean not null default false
);
create index browser_profiles_live on browser_profiles(id) where not deleted;
create table browser_profile_replicas (
 profile_id text not null references browser_profiles(id), computer_id text not null,
 record jsonb not null, primary key(profile_id, computer_id)
);
create table browser_profile_sync_jobs (
 id text primary key, record jsonb not null
);
create table browser_profile_job_installations (
 job_id text not null references browser_profile_sync_jobs(id), computer_id text not null, installation_id text not null,
 primary key(job_id,computer_id)
);
create table browser_profile_commands (
 command_key text primary key, input_hash text not null, result jsonb not null
);
create table browser_profile_intents (
 id text primary key, profile_id text not null references browser_profiles(id), record jsonb not null
);
create index browser_profile_intents_profile on browser_profile_intents(profile_id, id);
create table browser_profile_presence (
 profile_id text not null references browser_profiles(id), computer_id text not null,
 present boolean not null default false, presence_revision bigint not null default 0,
 current_revision bigint not null default 0, current_intent jsonb, primary key(profile_id,computer_id)
);
create index browser_profile_replicas_computer on browser_profile_replicas(computer_id,profile_id);
create table browser_profile_retention_dirty (profile_id text primary key references browser_profiles(id), revision bigint not null default 1);
create index browser_profile_intents_pending on browser_profile_intents(id) where record->>'state' in ('queued','running') and record->>'operation'<>'sync';
create index browser_profile_sync_pending on browser_profile_sync_jobs(id) where record->>'state' in ('queued','running');
create table browser_profile_exports (
 profile_id text primary key references browser_profiles(id), job_id text not null
);
create table browser_profile_publications (
 profile_id text primary key references browser_profiles(id), manifest jsonb not null
);
create table browser_session_locations (
 session_id text primary key, computer_id text not null, installation_id text not null, session jsonb not null
);
create index browser_session_locations_computer on browser_session_locations(computer_id,session_id);
create table browser_view_locations (view_id text primary key,session_id text not null references browser_session_locations(session_id));
create table browser_runtime_receipts (
 receipt_key text primary key, input_hash text not null, state text not null,
 result jsonb, updated_at timestamptz not null default now()
);
`,
}
