/** Interval checks are extra executions of an Agent node in its own slot. They never route
 * the graph, so they have no work activation or repeat occurrence. The check index is written
 * explicitly beside the frozen slot input; existing rows keep their exact keys and uniqueness.
 * Plain nullable columns and NOT VALID checks avoid rewriting or rescanning existing rows. */
export const agentIntervalMigration = { version: 2026101201, sql: String.raw`
alter table run_repeat_slots add column tick_index integer;
alter table run_repeat_slots add constraint tick_slot_outside
  check (tick_index is not distinct from (input_json::jsonb #>> '{tick,index}')::integer
    and (tick_index is null or (tick_index>0 and occurrence_id is null and work_activation_id is null))) not valid;
drop index run_repeat_slots_outside;
create unique index run_repeat_slots_outside on run_repeat_slots(run_id,workflow_node_id)
  where occurrence_id is null and work_activation_id is null and tick_index is null;
create unique index run_repeat_slots_tick on run_repeat_slots(run_id,workflow_node_id,tick_index)
  where tick_index is not null;

alter table harness_executions add column tick_index integer;
alter table harness_executions add constraint tick_execution_outside
  check (tick_index is not distinct from (record #>> '{input,tick,index}')::integer
    and (tick_index is null or (tick_index>0 and repeat_occurrence_id is null and work_activation_id is null))) not valid;
drop index harness_executions_legacy_attempt;
create unique index harness_executions_legacy_attempt on harness_executions(run_id,workflow_node_id,attempt)
  where repeat_occurrence_id is null and work_activation_id is null and tick_index is null;
create unique index harness_executions_tick_attempt on harness_executions(run_id,workflow_node_id,tick_index,attempt)
  where tick_index is not null;

-- Handoff Runs require a work activation for every ordinary slot and execution, not for checks.
drop trigger work_slot_identity on run_repeat_slots;
create constraint trigger work_slot_identity after insert on run_repeat_slots
  deferrable initially deferred for each row when (new.tick_index is null)
  execute function assert_work_slot_identity();
drop trigger work_native_activation on harness_executions;
create constraint trigger work_native_activation after insert or update on harness_executions
  deferrable initially deferred for each row when (new.tick_index is null)
  execute function assert_work_native_activation();

create or replace function assert_work_attempt_identity() returns trigger language plpgsql as $$
declare slot run_repeat_slots%rowtype; native harness_executions%rowtype; pinned jsonb; job_record jsonb;
begin
  if not exists(select 1 from run_repeat_executions where execution_id=new.execution_id) then return null; end if;
  select * into strict slot from run_repeat_slots where slot_id=new.slot_id;
  pinned := repeat_pinned_version(new.run_id);
  if new.executor_kind='job' then
    select record into strict job_record from job_executions where id=new.execution_id;
    if new.work_activation_id is not null or slot.work_activation_id is not null
      or pinned #> '{definition,handoffs}' = '{"contractVersion":1}'::jsonb
      or slot.run_id is distinct from new.run_id
      or slot.workflow_node_id is distinct from new.workflow_node_id
      or slot.occurrence_id is distinct from new.occurrence_id
      or job_record #>> '{workflow,runId}' is distinct from new.run_id
      or job_record #>> '{workflow,nodeId}' is distinct from new.workflow_node_id
      or job_record #>> '{workflow,nodeExecutionId}' is distinct from new.execution_id then
      raise exception 'JOB_WORKFLOW_EXECUTION_PIN_CONFLICT';
    end if;
    return null;
  end if;
  select * into strict native from harness_executions where id=new.execution_id;
  if slot.tick_index is not null or native.tick_index is not null then
    if new.work_activation_id is not null or new.occurrence_id is not null
      or native.tick_index is distinct from slot.tick_index then raise exception 'TICK_ATTEMPT_CONFLICT'; end if;
    return null;
  end if;
  if pinned #> '{definition,handoffs}' is distinct from '{"contractVersion":1}'::jsonb then
    if new.work_activation_id is not null then raise exception 'WORK_ATTEMPT_ON_OLD_RUN'; end if;
    return null;
  end if;
  if new.work_activation_id is null or new.occurrence_id is not null
    or new.work_activation_id<>slot.work_activation_id or new.work_activation_id<>native.work_activation_id
    or new.run_id<>slot.run_id or new.run_id<>native.run_id then
    raise exception 'WORK_ATTEMPT_ACTIVATION_CONFLICT';
  end if;
  return null;
end $$;
` } as const
