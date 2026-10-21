export const workflowJobAttemptIdentityMigration = {
  version: 2026100912,
  sql: String.raw`
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
`,
} as const
