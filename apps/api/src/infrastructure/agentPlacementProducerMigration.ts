/** No historical host/source or native owner grant backfill. */
export const agentPlacementProducerMigration = { version: 284302, sql: String.raw`
create table execution_dispatch_owner_grants (
 execution_id text not null references harness_executions(id), operation_id text not null references execution_dispatch_intents(operation_id) deferrable initially deferred,
 grant_id text primary key, epoch text not null check(epoch ~ '^[1-9][0-9]*$'), revoked boolean not null default false,
 scheduler_owner_id text not null, scheduler_owner_fence text not null, unique(execution_id,epoch)
);
create function guard_agent_owner_grant() returns trigger language plpgsql as $$
begin
 if NEW.scheduler_owner_id is distinct from pg_backend_pid()::text
  or not exists(select 1 from harness_executions e join pg_stat_activity a on a.pid=pg_backend_pid()
    where e.id=NEW.execution_id and (extract(epoch from a.backend_start)*1000000)::bigint::text=NEW.scheduler_owner_fence
    and exists(select 1 from pg_locks l where l.pid=a.pid and l.locktype='advisory' and l.classid=810002::oid
      and l.objid=(hashtext(e.run_id)::bigint & 4294967295)::oid and l.objsubid=2 and l.mode='ExclusiveLock' and l.granted))
  or NEW.epoch='1' and not exists(select 1 from harness_executions where id=NEW.execution_id and xmin=pg_current_xact_id()::text::xid)
  or NEW.epoch<>'1' and not exists(select 1 from remote_execution_owner_reconciliations x
    where x.operation_id=NEW.operation_id and x.transition#>>'{nextOwner,grantId}'=NEW.grant_id and x.transition#>>'{nextOwner,epoch}'=NEW.epoch) then
  raise exception 'AGENT_OWNER_GRANT_CONFLICT' using errcode='P2844';
 end if;
 return NEW;
end $$;
create constraint trigger agent_owner_grant after insert on execution_dispatch_owner_grants
 deferrable initially deferred for each row execute function guard_agent_owner_grant();
create or replace function assert_run_placement_complete() returns trigger language plpgsql as $$
declare nodes jsonb;
begin
 select coalesce(jsonb_agg(n),'[]'::jsonb) into nodes from workflow_versions v,
   lateral jsonb_array_elements(v.record#>'{definition,nodes}') n
   where v.id=NEW.workflow_version_id and coalesce(n->>'kind','agent')='agent';
 if exists(select 1 from jsonb_array_elements(nodes) n where n ? 'placement')
   or exists(select 1 from run_node_placements where run_id=NEW.id) then
  if exists(select 1 from jsonb_array_elements(nodes) n where not exists(select 1 from run_node_placements p
    where p.run_id=NEW.id and p.node_id=n->>'id' and p.record#>>'{payload,agentId}'=n->>'agentId'))
   or (select count(*) from run_node_placements where run_id=NEW.id)<>jsonb_array_length(nodes) then
   raise exception 'RUN_PLACEMENT_EVIDENCE_MISSING' using errcode='P2843';
  end if;
 end if;
 return NEW;
end $$;
create table execution_native_placements (
 execution_id text primary key references harness_executions(id), operation_id text not null unique references execution_dispatch_intents(operation_id),
 accepted_binding_hash text not null, binding_hash text not null check(binding_hash ~ '^[a-f0-9]{64}$'),
 record jsonb not null, check(record->>'executionId'=execution_id and record->>'operationId'=operation_id
   and record->>'bindingHash'=binding_hash and record->>'acceptedBindingHash'=accepted_binding_hash)
);
create function guard_agent_native_placement() returns trigger language plpgsql as $$
declare intent execution_dispatch_intents%rowtype; material source_execution_materializations%rowtype;
begin
 select * into intent from execution_dispatch_intents where execution_id=NEW.execution_id;
 select * into material from source_execution_materializations where materialization_id=(NEW.record#>>'{materialization,receipt,materializationId}')::uuid;
 if intent.operation_id is distinct from NEW.operation_id or intent.binding_hash is distinct from NEW.accepted_binding_hash
   or material.execution_id is distinct from NEW.execution_id or material.operation_id is distinct from NEW.operation_id
   or material.attempt_id is distinct from intent.attempt_id then
  raise exception 'NATIVE_PLACEMENT_CONFLICT' using errcode='P2844';
 end if;
 return NEW;
end $$;
create trigger agent_native_placement before insert on execution_native_placements
 for each row execute function guard_agent_native_placement();
create trigger execution_native_placement_immutable before update or delete on execution_native_placements
 for each row execute function guard_placement_immutable();
create trigger execution_native_placement_no_truncate before truncate on execution_native_placements
 for each statement execute function guard_placement_immutable();
` } as const
