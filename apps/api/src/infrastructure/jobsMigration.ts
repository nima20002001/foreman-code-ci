/** Job truth is main-owned; W08 remains the dispatch/ownership authority. */
export const jobsMigration = { version: 283801, sql: String.raw`
create table job_definitions (
 id text primary key, workspace_id text not null references workspaces(id),
 revision bigint not null check(revision>0), version_id text not null unique,
 record jsonb not null, updated_by text not null references management_principals(id),
 unique(workspace_id,id)
);
create table job_definition_versions (
 id text primary key, definition_id text not null references job_definitions(id),
 workspace_id text not null references workspaces(id), revision bigint not null,
 record jsonb not null, unique(definition_id,revision)
);
create function preserve_job_definition_version() returns trigger language plpgsql as $$ begin
 raise exception 'JOB_DEFINITION_VERSION_IMMUTABLE'; end $$;
create trigger job_definition_version_immutable before update or delete on job_definition_versions for each row execute function preserve_job_definition_version();
create table job_dispatch_intents (
 execution_id text primary key, workspace_id text not null references workspaces(id), intent jsonb not null,
 owner_id text, owner_fence text, receipt_sequence bigint not null default 0, last_receipt jsonb, delivery_attempted boolean not null default false, cancel_command_id text,cancel_principal_id text references management_principals(id),cancel_action text check(cancel_action in ('jobs:cancel','runs:stop'))
);
create table job_executions (
 id text primary key, workspace_id text not null references workspaces(id),
 definition_version_id text not null references job_definition_versions(id),
 operation_id text not null unique, attempt_id text not null, record jsonb not null,
 accepted_spec jsonb not null, accepted_by text not null references management_principals(id),
 created_at timestamptz not null default clock_timestamp(),
 log_bytes bigint not null default 0 check(log_bytes>=0),
 log_sequence bigint not null default 0 check(log_sequence>=0), log_truncated boolean not null default false,
 unique(workspace_id,id)
);
create table job_preparations (
 execution_id text primary key, attempt_id text not null unique, operation_id text not null unique,
 workspace_id text not null references workspaces(id), definition_version_id text not null references job_definition_versions(id),
 principal_id text not null references management_principals(id), command_id text not null, definition jsonb not null,
 created_at timestamptz not null default clock_timestamp(), unique(principal_id,command_id)
);
create table workflow_job_preparations (
 slot_id text primary key references run_repeat_slots(slot_id), run_id text not null references runs(id),
 preparation jsonb not null, bindings jsonb not null
);
create table workflow_job_executions (
 run_id text not null references runs(id), node_execution_id text not null,
 job_execution_id text not null unique references job_executions(id), reference jsonb not null,input_json text not null check(octet_length(input_json)<=4194304),
 accepted boolean not null default false, primary key(run_id,node_execution_id)
);
alter table job_dispatch_intents add foreign key(execution_id) references job_executions(id) deferrable initially deferred;
create index job_execution_workspace on job_executions(workspace_id,id);
create table job_log_chunks (
 execution_id text not null references job_executions(id), sequence bigint not null check(sequence>0),
 attempt_id text not null, stream text not null check(stream in ('stdout','stderr')),
 text text not null, byte_size integer not null check(byte_size>=0 and byte_size<=65536), created_at timestamptz not null,
 primary key(execution_id,sequence)
);
create function preserve_job_acceptance() returns trigger language plpgsql as $$ begin
 if NEW.accepted_spec is distinct from OLD.accepted_spec or NEW.definition_version_id is distinct from OLD.definition_version_id
 or NEW.accepted_by is distinct from OLD.accepted_by or NEW.workspace_id is distinct from OLD.workspace_id
 or NEW.operation_id is distinct from OLD.operation_id or NEW.attempt_id is distinct from OLD.attempt_id
 or NEW.record->'acceptedSpec' is distinct from OLD.record->'acceptedSpec' then
 raise exception 'JOB_ACCEPTANCE_IMMUTABLE'; end if; return NEW;
end $$;
create trigger job_acceptance_immutable before update on job_executions for each row execute function preserve_job_acceptance();
` }
