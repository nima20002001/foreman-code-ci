/** Runtime overlays only. No saved WorkflowVersion or Run facts are rewritten. */
export const runSubagentsMigration = { version: 3101001, sql: String.raw`
create table run_subagents (
 id text primary key, run_id text not null references runs(id) on delete cascade,
 parent_execution_id text not null references harness_executions(id) on delete cascade,
 native_mode text not null, parent_native_session_id text not null, provider_child_id text not null,
 parent_subagent_id text references run_subagents(id), lifecycle_at timestamptz, revision bigint not null check(revision>0), record jsonb not null,
 unique(parent_execution_id,native_mode,parent_native_session_id,provider_child_id),
 check(record->>'id'=id and record->>'runId'=run_id and record->>'parentExecutionId'=parent_execution_id
   and record->>'revision'=revision::text and record->>'nativeMode'=native_mode)
);
create index run_subagents_page on run_subagents(run_id,id);
create table run_subagent_items (
 subagent_id text not null references run_subagents(id) on delete cascade, kind text not null check(kind in ('message','tool')),
 id text not null, ordinal bigint generated always as identity, revision bigint not null check(revision>0), record jsonb not null,
 primary key(subagent_id,kind,id), unique(subagent_id,kind,ordinal),
 check(record->>'subagentId'=subagent_id and record->>'id'=id and record->>'revision'=revision::text)
);
create index run_subagent_items_page on run_subagent_items(subagent_id,kind,ordinal);
create table run_subagent_sources (
 subagent_id text not null references run_subagents(id) on delete cascade, execution_id text not null,
 sequence integer not null, digest text not null, primary key(subagent_id,execution_id,sequence)
);
create table run_subagent_lifecycle (
 subagent_id text not null references run_subagents(id) on delete cascade, execution_id text not null, sequence integer not null,
 fact jsonb not null, primary key(subagent_id,execution_id,sequence)
);
create index run_subagent_lifecycle_task_alias on run_subagent_lifecycle(execution_id,(fact->>'taskId'));
create index run_subagent_lifecycle_spawn_alias on run_subagent_lifecycle(execution_id,(fact->>'spawnToolUseId'));
create table run_subagent_projection_queue (
 execution_id text primary key references harness_executions(id) on delete cascade,
 projected_sequence integer not null default -1, latest_sequence integer not null
);
insert into run_subagent_projection_queue(execution_id,latest_sequence)
 select execution_id,max(sequence) from harness_native_events group by execution_id;
create table run_subagent_backfill_state (
 execution_id text primary key references harness_executions(id) on delete cascade, child_cursor text,
 complete boolean not null default false, updated_at timestamptz not null default now(), last_failure text
);
create function queue_run_subagent_projection() returns trigger language plpgsql as $$ begin
 insert into run_subagent_projection_queue(execution_id,latest_sequence) values(NEW.execution_id,NEW.sequence)
 on conflict(execution_id) do update set latest_sequence=greatest(run_subagent_projection_queue.latest_sequence,excluded.latest_sequence);
 if NEW.connection_id is null or NEW.connection_id not like 'child-history-%' then
   update run_subagent_backfill_state set complete=false,child_cursor=null where execution_id=NEW.execution_id and complete;
 end if;
 return NEW; end $$;
create trigger queue_run_subagent_projection after insert on harness_native_events for each row execute function queue_run_subagent_projection();
create table run_subagent_pending_events (
 execution_id text not null, sequence integer not null, primary key(execution_id,sequence),
 foreign key(execution_id,sequence) references harness_native_events(execution_id,sequence) on delete cascade
);
create table run_subagent_message_roles (
 execution_id text not null references harness_executions(id) on delete cascade, native_session_id text not null,
 native_message_id text not null, role text not null check(role in ('assistant','user')), primary key(execution_id,native_session_id,native_message_id)
);
create table run_subagent_command_receipts (
 id text primary key, principal_id text not null references management_principals(id), operation text not null,
 command_id text not null, subagent_id text not null references run_subagents(id), input_hash text not null,
 record jsonb not null, unique(principal_id,operation,command_id),
 check(record->>'id'=id and record->>'principalId'=principal_id and record->>'commandId'=command_id and record->>'operation'=operation)
);
` } as const
