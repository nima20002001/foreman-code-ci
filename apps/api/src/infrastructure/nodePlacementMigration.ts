/** Additive evidence only: historical executions are not assigned a new host. */
export const nodePlacementMigration = { version: 284301, sql: String.raw`
create table run_node_placements (
  run_id text not null references runs(id), node_id text not null,
  binding_hash text not null check(binding_hash ~ '^[a-f0-9]{64}$'),
  record jsonb not null check(jsonb_typeof(record)='object'),
  primary key(run_id,node_id), unique(run_id,node_id,binding_hash),
  check(record ?& array['schemaVersion','runId','nodeId','bindingHash']),
  check(record->>'schemaVersion'='1' and record->>'runId'=run_id
    and record->>'nodeId'=node_id and record->>'bindingHash'=binding_hash)
);
create table execution_dispatch_intents (
  operation_id text primary key, execution_id text not null unique references harness_executions(id),
  run_id text not null, node_id text not null, binding_hash text not null,
  attempt_id text not null unique, record jsonb not null check(jsonb_typeof(record)='object'),
  scheduler_owner_id text not null, scheduler_owner_fence text not null,
  foreign key(run_id,node_id,binding_hash) references run_node_placements(run_id,node_id,binding_hash),
  check(record ?& array['schemaVersion','protocolVersion','operationId','executionId','attemptId','runId','nodeId','bindingHash']),
  check(record->>'schemaVersion'='1' and record->>'protocolVersion'='1'
    and record->>'operationId'=operation_id and record->>'executionId'=execution_id
    and record->>'attemptId'=attempt_id and record->>'runId'=run_id
    and record->>'nodeId'=node_id and record->>'bindingHash'=binding_hash)
);
create function guard_placement_admission() returns trigger language plpgsql as $$
declare r runs%rowtype;
begin
 select * into r from runs where id=NEW.run_id;
 if r.id is null or r.execution_state<>'queued'
   or not exists(select 1 from runs where id=NEW.run_id and xmin=pg_current_xact_id()::text::xid)
   or NEW.record#>>'{payload,kind}' is distinct from 'agent'
   or NEW.record#>>'{payload,agentConfigurationVersionId}' is distinct from
     (r.record->'agentConfigurationVersionIds'->>(NEW.record#>>'{payload,agentId}')) then
   raise exception 'PLACEMENT_ADMISSION_CONFLICT' using errcode='P2843';
 end if;
 return NEW;
end $$;
create trigger run_node_placement_admission before insert on run_node_placements
  for each row execute function guard_placement_admission();
create function assert_run_placement_complete() returns trigger language plpgsql as $$
declare nodes jsonb;
begin
 select record#>'{definition,nodes}' into nodes from workflow_versions where id=NEW.workflow_version_id;
 if exists(select 1 from jsonb_array_elements(nodes) n where n ? 'placement')
   or exists(select 1 from run_node_placements where run_id=NEW.id) then
   if exists(select 1 from jsonb_array_elements(nodes) n
     where not exists(select 1 from run_node_placements p where p.run_id=NEW.id and p.node_id=n->>'id'
       and p.record#>>'{payload,agentId}'=n->>'agentId'))
     or (select count(*) from run_node_placements where run_id=NEW.id)<>jsonb_array_length(nodes) then
     raise exception 'RUN_PLACEMENT_EVIDENCE_MISSING' using errcode='P2843';
   end if;
 end if;
 return NEW;
end $$;
create constraint trigger run_placement_complete after insert on runs
  deferrable initially deferred for each row execute function assert_run_placement_complete();
create function assert_execution_dispatch_complete() returns trigger language plpgsql as $$
begin
 if exists(select 1 from run_node_placements p where p.run_id=NEW.run_id and p.node_id=NEW.workflow_node_id)
   and not exists(select 1 from execution_dispatch_intents d where d.execution_id=NEW.id) then
   raise exception 'EXECUTION_DISPATCH_EVIDENCE_MISSING' using errcode='P2844';
 end if;
 return NEW;
end $$;
create constraint trigger execution_dispatch_complete after insert on harness_executions
  deferrable initially deferred for each row execute function assert_execution_dispatch_complete();
create function guard_placement_immutable() returns trigger language plpgsql as $$
begin raise exception 'PLACEMENT_EVIDENCE_IMMUTABLE' using errcode='P2843'; end $$;
create trigger run_node_placement_immutable before update or delete on run_node_placements
  for each row execute function guard_placement_immutable();
create trigger run_node_placement_no_truncate before truncate on run_node_placements
  for each statement execute function guard_placement_immutable();
create trigger execution_dispatch_intent_immutable before update or delete on execution_dispatch_intents
  for each row execute function guard_placement_immutable();
create trigger execution_dispatch_intent_no_truncate before truncate on execution_dispatch_intents
  for each statement execute function guard_placement_immutable();
create function guard_dispatch_owner() returns trigger language plpgsql as $$
declare e harness_executions%rowtype; x run_repeat_executions%rowtype; s run_repeat_slots%rowtype;
begin
 select * into e from harness_executions where id=NEW.execution_id;
 select * into x from run_repeat_executions where execution_id=NEW.execution_id;
 select * into s from run_repeat_slots where slot_id=x.slot_id;
 if not exists(select 1 from harness_executions where id=NEW.execution_id and xmin=pg_current_xact_id()::text::xid)
   or x.execution_id is null or x.run_id is distinct from NEW.run_id
   or x.technical_attempt is distinct from (NEW.record->>'technicalAttempt')::integer
   or x.occurrence_id is distinct from (NEW.record->>'occurrenceId')
   or s.input_digest is distinct from (NEW.record->>'inputDigest')
   or e.run_id is distinct from NEW.run_id or e.record->>'workflowNodeId' is distinct from NEW.node_id
   or NEW.scheduler_owner_id is distinct from pg_backend_pid()::text
   or not exists(select 1 from pg_stat_activity a where a.pid=pg_backend_pid()
     and (extract(epoch from a.backend_start)*1000000)::bigint::text=NEW.scheduler_owner_fence
     and exists(select 1 from pg_locks l where l.pid=a.pid and l.locktype='advisory'
       and l.classid=810002::oid and l.objid=(hashtext(NEW.run_id)::bigint & 4294967295)::oid
       and l.objsubid=2 and l.mode='ExclusiveLock' and l.granted)) then
   raise exception 'DISPATCH_OWNER_CONFLICT' using errcode='P2844';
 end if;
 return NEW;
end $$;
create constraint trigger execution_dispatch_owner after insert on execution_dispatch_intents
  deferrable initially deferred for each row execute function guard_dispatch_owner();
` } as const
