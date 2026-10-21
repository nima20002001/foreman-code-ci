export const workParentRequestMigration = { version: 269302, sql: String.raw`
create function work_parent_request(work_run_id text, work_activation_id text) returns text
language plpgsql stable as $$
declare activation run_work_activations%rowtype; original_node text; next_id text;
  visited text[] := '{}';
begin
  loop
    if work_activation_id=any(visited) then raise exception 'WORK_PARENT_REQUEST_CYCLE'; end if;
    visited := array_append(visited,work_activation_id);
    select * into strict activation from run_work_activations
      where run_id=work_run_id and activation_id=work_activation_id;
    if original_node is null then original_node := activation.workflow_node_id;
    elsif activation.workflow_node_id<>original_node then raise exception 'WORK_PARENT_REQUEST_NODE_CONFLICT'; end if;
    if activation.cause_kind='work_request' then
      if not exists(select 1 from run_work_requests where run_id=work_run_id
        and request_id=activation.cause_id and destination_activation_id=activation.activation_id
        and destination_node_id=original_node) then raise exception 'WORK_PARENT_REQUEST_CONFLICT'; end if;
      return activation.cause_id;
    elsif activation.cause_kind='work_return' then
      select record->>'requesterActivationId' into strict next_id from run_work_returns
        where run_id=work_run_id and return_id=activation.cause_id
          and requester_continuation_activation_id=activation.activation_id;
    elsif activation.cause_kind='limit_denial' then
      select d.requester_activation_id into strict next_id from run_work_denials d
        join run_work_notices n on n.run_id=d.run_id and n.cause_kind='limit_denial' and n.cause_id=d.denial_id
        where d.run_id=work_run_id and d.denial_id=activation.cause_id
          and n.continuation_activation_id=activation.activation_id;
    else
      return null;
    end if;
    work_activation_id := next_id;
  end loop;
end $$;

create or replace function assert_work_return() returns trigger language plpgsql as $$
declare work_request run_work_requests%rowtype; source_activation run_work_activations%rowtype;
  source_execution harness_executions%rowtype; accepted_digest text;
  continuation run_work_activations%rowtype;
begin
  if not exists(select 1 from run_work_returns where return_id=new.return_id) then return null; end if;
  select * into strict work_request from run_work_requests where request_id=new.request_id;
  select * into strict source_activation from run_work_activations where activation_id=new.source_activation_id;
  select * into strict source_execution from harness_executions where id=new.source_execution_id;
  select result_digest into strict accepted_digest from run_work_results
    where run_id=new.run_id and execution_id=new.source_execution_id and activation_id=new.source_activation_id;
  if new.run_id<>work_request.run_id or work_parent_request(new.run_id,new.source_activation_id) is distinct from new.request_id
    or source_activation.workflow_node_id<>work_request.destination_node_id
    or source_execution.run_id<>new.run_id or source_execution.work_activation_id<>new.source_activation_id
    or source_execution.workflow_node_id<>work_request.destination_node_id or not source_execution.accepted
    or source_execution.record->>'state'<>'completed'
    or accepted_digest<>new.result_digest
    or new.record #>> '{scope,workflowVersionId}' is distinct from work_request.workflow_version_id
    or new.record->>'requesterActivationId' is distinct from work_request.requester_activation_id
    or new.record->'latestDeliverable' is null or new.record->'latestDeliverable'='null'::jsonb
    or jsonb_typeof(new.record->'remainingFindings') is distinct from 'array'
    or octet_length(new.record::text)>65536 then raise exception 'WORK_RETURN_ANCESTRY_CONFLICT'; end if;
  if new.outcome='needs_changes' then
    select * into strict continuation from run_work_activations
      where activation_id=new.requester_continuation_activation_id;
    if continuation.run_id<>new.run_id or continuation.workflow_node_id<>work_request.requester_node_id
      or continuation.lineage_id<>source_activation.lineage_id
      or continuation.cause_kind<>'work_return' or continuation.cause_id<>new.return_id then
      raise exception 'WORK_RETURN_CONTINUATION_CONFLICT'; end if;
  end if;
  return null;
end $$;
create function assert_work_parent_input() returns trigger language plpgsql as $$
declare parent_id text; parent_record jsonb; input_record jsonb;
begin
  if new.work_activation_id is null then return null; end if;
  input_record := new.input_json::jsonb;
  if input_record #>> '{work,kind}' not in ('work_return','limit_denial') then return null; end if;
  parent_id := work_parent_request(new.run_id,new.work_activation_id);
  if parent_id is not null then
    select record into strict parent_record from run_work_requests where run_id=new.run_id and request_id=parent_id;
  end if;
  if input_record->'parentRequest' is distinct from parent_record then raise exception 'WORK_PARENT_INPUT_CONFLICT'; end if;
  return null;
end $$;
create constraint trigger work_parent_input after insert on run_repeat_slots
  deferrable initially deferred for each row execute function assert_work_parent_input();
` } as const
