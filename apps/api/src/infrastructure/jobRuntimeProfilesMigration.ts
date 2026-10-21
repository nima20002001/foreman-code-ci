/** CI policy/qualification metadata refers to existing workspace/root/device records. */
export const jobRuntimeProfilesMigration={version:283804,sql:String.raw`
create table job_runtime_profiles (
 id text primary key,workspace_id text not null references workspaces(id),revision bigint not null check(revision>0),
 root_id uuid not null,binding_revision bigint not null,record jsonb not null,
 foreign key(root_id,binding_revision) references source_root_bindings(root_id,binding_revision),unique(workspace_id,id)
);
create table job_runtime_profile_versions (
 profile_id text not null references job_runtime_profiles(id),revision bigint not null,record jsonb not null,
 primary key(profile_id,revision)
);
create function preserve_job_runtime_profile_version() returns trigger language plpgsql as $$ begin
 raise exception 'JOB_RUNTIME_PROFILE_VERSION_IMMUTABLE';end $$;
create trigger job_runtime_profile_version_immutable before update or delete on job_runtime_profile_versions for each row execute function preserve_job_runtime_profile_version();
create table job_runtime_qualification_approvals (
 id uuid primary key,qualification_id uuid not null unique,profile_id text not null references job_runtime_profiles(id),profile_revision bigint not null,
 workspace_id text not null references workspaces(id),record jsonb not null,measurement jsonb,run_result jsonb,
 run_command_id text,run_principal_id text references management_principals(id),
 requested_by text not null references management_principals(id),approved_by text references management_principals(id),
 unique(profile_id,profile_revision,qualification_id)
);
`}
