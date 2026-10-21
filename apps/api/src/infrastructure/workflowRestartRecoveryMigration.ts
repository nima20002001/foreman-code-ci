/** ENG06-A: additive physical recovery evidence. No historical receipt backfill
 * and no changes to the immutable original close/detach generation records. */
export const workflowRestartRecoveryMigration = { version: 265501, sql: String.raw`
create table execution_native_recoveries (
  generation bigint primary key references execution_native_closures(generation),
  execution_id text not null references harness_executions(id),
  execution_identity jsonb not null check(jsonb_typeof(execution_identity)='object'),
  reference jsonb check(reference is null or jsonb_typeof(reference)='object'),
  owner_id text not null,
  owner_fence text not null,
  recovered_at timestamptz not null default clock_timestamp()
);
create index execution_native_recoveries_execution on execution_native_recoveries(execution_id,generation);
create function guard_execution_native_recovery() returns trigger language plpgsql as $$
declare e harness_executions%rowtype; c execution_native_closures%rowtype; native jsonb; r runs%rowtype;
begin
  if TG_OP<>'INSERT' then
    raise exception 'NATIVE_WORKFLOW_RECOVERY_IMMUTABLE' using errcode='P2655';
  end if;
  select * into e from harness_executions where id=NEW.execution_id;
  select * into r from runs where id=e.run_id for update;
  select * into e from harness_executions where id=NEW.execution_id for update;
  select * into c from execution_native_closures where generation=NEW.generation for update;
  select reference into native from execution_native_sessions where execution_id=e.id for share;
  if c.execution_id is distinct from e.id or c.execution_identity is distinct from NEW.execution_identity
    or NEW.execution_identity is distinct from jsonb_strip_nulls(jsonb_build_object(
      'id',e.id,'runId',e.run_id,'workflowNodeId',e.record->>'workflowNodeId',
      'agentId',e.record->>'agentId','agentConfigurationVersionId',e.record->>'agentConfigurationVersionId',
      'attempt',e.record->'attempt','workingDirectory',e.record->>'workingDirectory','runtimeDirectory',e.record->>'runtimeDirectory'))
    or r.record->>'id' is distinct from r.id or r.record->>'executionState' is distinct from r.execution_state
    or r.record->'executionSemanticsVersion' is distinct from '3'::jsonb
    or not (r.stop_requested_at is not null or r.execution_state='completed'
      or exists(select 1 from run_cleanup_intents where run_id=r.id and pending))
    or exists(select 1 from execution_native_closures n where n.execution_id=e.id and n.generation>c.generation)
    or exists(select 1 from execution_native_closures n where n.execution_id=e.id
      and n.generation<c.generation and n.closed_at is null and n.detached_at is null)
    or NEW.reference is distinct from native
    or (e.record->>'nativeSessionId') is distinct from (native->>'nativeSessionId')
    or (c.expected_reference is not null and c.expected_reference is distinct from native)
    or (c.detached_at is not null and c.detached_reference is distinct from native)
    or NEW.owner_id is distinct from pg_backend_pid()::text
    or not exists(select 1 from pg_stat_activity a where a.pid=pg_backend_pid()
      and (extract(epoch from a.backend_start)*1000000)::bigint::text=NEW.owner_fence
      and exists(select 1 from pg_locks l where l.pid=a.pid and l.locktype='advisory'
        and l.classid=810002::oid and l.objid=(hashtext(r.id)::bigint & 4294967295)::oid
        and l.objsubid=2 and l.mode='ExclusiveLock' and l.granted)) then
    raise exception 'NATIVE_WORKFLOW_RECOVERY_CONFLICT' using errcode='P2655';
  end if;
  return NEW;
end $$;
create trigger execution_native_recovery_guard before insert or update or delete on execution_native_recoveries
  for each row execute function guard_execution_native_recovery();
create trigger execution_native_recovery_no_truncate before truncate on execution_native_recoveries
  for each statement execute function guard_execution_native_recovery();
` } as const
