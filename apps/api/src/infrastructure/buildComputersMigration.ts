export const buildComputersMigration = { version: 285801, sql: String.raw`
create table build_computer_preferences (
 host_key text primary key, target jsonb not null, revision bigint not null check(revision>0),
 build_enabled boolean not null, build_priority integer not null check(build_priority between 0 and 100),
 updated_by text not null references management_principals(id)
);
create table job_computer_selections (
 execution_id text primary key, workspace_id text not null references workspaces(id),
 definition_version_id text not null references job_definition_versions(id),
 attempt_id text not null, operation_id text not null unique, host_key text not null,
 spec jsonb not null, limits jsonb not null, selection jsonb not null,
 source_scope text not null, source_bytes bigint not null check(source_bytes>=0),
 released_at timestamptz
);
create index job_computer_capacity on job_computer_selections(host_key) where released_at is null;
alter table job_dispatch_intents add column launch_blocked_reason text
 check(launch_blocked_reason in ('build_disabled'));
create function preserve_job_computer_selection() returns trigger language plpgsql as $$ begin
 if (to_jsonb(new)-'released_at') is distinct from (to_jsonb(old)-'released_at') then
  raise exception 'JOB_COMPUTER_SELECTION_IMMUTABLE';
 end if;
 return new;
end $$;
create trigger job_computer_selection_immutable before update on job_computer_selections
 for each row execute function preserve_job_computer_selection();
` }
