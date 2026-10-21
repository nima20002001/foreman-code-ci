export const workReturnRequestMigration = { version: 2026101521, sql: String.raw`
create function work_return_request(work_run_id text, work_activation_id text, supplied_id text) returns text
language plpgsql stable as $$
declare request_ids text[];
begin
  select array_agg(request_id order by request_id) into request_ids from run_work_requests
    where run_id=work_run_id and (destination_activation_id=work_activation_id
      or request_id=work_parent_request(work_run_id,work_activation_id));
  if supplied_id is not null and supplied_id=any(request_ids) then return supplied_id; end if;
  if supplied_id is null and cardinality(request_ids)=1 then return request_ids[1]; end if;
  raise exception 'WORK_RETURN_RESULT_CONFLICT';
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
  if new.run_id<>work_request.run_id
    or work_return_request(new.run_id,new.source_activation_id,new.request_id) is distinct from new.request_id
    or source_activation.workflow_node_id<>work_request.destination_node_id
    or source_execution.run_id<>new.run_id or source_execution.work_activation_id<>new.source_activation_id
    or source_execution.workflow_node_id<>work_request.destination_node_id or not source_execution.accepted
    or source_execution.record->>'state'<>'completed'
    or accepted_digest<>new.result_digest
    or new.record #>> '{scope,workflowVersionId}' is distinct from work_request.workflow_version_id
    or new.record->>'requesterActivationId' is distinct from work_request.requester_activation_id
    or new.record->'latestDeliverable' is null or new.record->'latestDeliverable'='null'::jsonb
    or jsonb_typeof(new.record->'remainingFindings') is distinct from 'array'
    or work_json_bytes(new.record)>65536 then raise exception 'WORK_RETURN_ANCESTRY_CONFLICT'; end if;
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

create or replace function assert_work_unresolved() returns trigger language plpgsql as $$
declare accepted run_work_results%rowtype; activation run_work_activations%rowtype;
  payload jsonb; pinned jsonb; node jsonb;
begin
  if not exists(select 1 from run_work_unresolved where unresolved_id=new.unresolved_id) then return null; end if;
  select * into strict accepted from run_work_results where run_id=new.run_id and execution_id=new.execution_id;
  select * into strict activation from run_work_activations where run_id=new.run_id and activation_id=new.activation_id;
  if accepted.activation_id<>new.activation_id or accepted.result_digest<>new.result_digest then
    raise exception 'WORK_UNRESOLVED_RESULT_CONFLICT'; end if;
  payload := accepted.result_json::jsonb->'output';
  if jsonb_typeof(payload)='string' then payload := (accepted.result_json::jsonb->>'output')::jsonb;
  elsif payload->>'text' is not null and payload->'routing' is null then payload := (payload->>'text')::jsonb;
  end if;
  if new.reason='finish_with_findings' then
    if payload #>> '{routing,kind}' is distinct from 'finish'
        and (payload #>> '{routing,kind}' is distinct from 'return'
          or payload #>> '{routing,outcome}' is distinct from 'accepted')
      or jsonb_typeof(payload #> '{data,remainingFindings}') is distinct from 'array'
      or jsonb_array_length(payload #> '{data,remainingFindings}')=0 then
      raise exception 'WORK_UNRESOLVED_FINISH_CONFLICT'; end if;
    if payload #>> '{routing,kind}'='return' and not exists(
      select 1 from run_work_returns r where r.run_id=new.run_id and r.source_execution_id=new.execution_id
        and r.source_activation_id=new.activation_id
        and r.request_id=work_return_request(new.run_id,new.activation_id,payload #>> '{routing,requestId}')
        and r.outcome='accepted' and r.result_digest=new.result_digest
        and r.record->'latestDeliverable'=payload #> '{data,latestDeliverable}'
        and r.record->'remainingFindings'=payload #> '{data,remainingFindings}') then
      raise exception 'WORK_UNRESOLVED_RETURN_CONFLICT'; end if;
  else
    pinned := repeat_pinned_version(new.run_id);
    select value into strict node from jsonb_array_elements(pinned #> '{definition,nodes}') n
      where n->>'id'=activation.workflow_node_id;
    if not (new.relationship_id=any(work_saved_routes(pinned,node,payload)))
      or not exists(select 1 from run_work_denials d join run_work_activations a
        on a.run_id=d.run_id and a.activation_id=d.requester_activation_id
        where d.run_id=new.run_id and d.relationship_id=new.relationship_id
          and a.lineage_id=activation.lineage_id) then
      raise exception 'WORK_UNRESOLVED_DENIAL_CONFLICT'; end if;
  end if;
  return null;
end $$;

` } as const
