/** Control-derived negatives retain their exact durable authority without rewriting native results. */
export const hierarchyControlSettlementMigration = { version: 2026102111, sql: String.raw`
create function hierarchy_control_failure(p_run text,p_execution text) returns jsonb language plpgsql stable as $$
declare continuation run_control_continuations%rowtype;
begin
  select * into continuation from run_control_continuations where run_id=p_run and previous_execution_id=p_execution;
  if found then
    if continuation.state not in ('failed','canceled') then return null; end if;
    return jsonb_build_object('outcome',continuation.state,'error',jsonb_build_object(
      'code',coalesce(continuation.record->>'errorCode','CONTROL_CONTINUATION_CLOSED'),
      'message','The reserved continuation could not continue this work.','retryable',false));
  end if;
  if exists(select 1 from run_chat_commands where run_id=p_run and kind='stop'
    and target#>>'{execution,executionId}'=p_execution and native_target is not null
    and state in ('recorded','settling','submitting','accepted','completed','unknown')) then
    return '{"outcome":"failed","error":{"code":"WORKFLOW_TURN_STOPPED","message":"The current work was stopped without a queued continuation.","retryable":false}}'::jsonb;
  end if;
  return null;
end $$;

create or replace function assert_hierarchy_member() returns trigger language plpgsql as $$
declare g run_hierarchy_groups%rowtype; q run_work_requests%rowtype; pinned jsonb;
  source jsonb; node jsonb; selected jsonb; edge_id text;
  failed harness_executions%rowtype; recorded_failure jsonb;
begin
  if not exists(select 1 from run_hierarchy_group_members where run_id=new.run_id and request_id=new.request_id) then return null; end if;
  select * into strict g from run_hierarchy_groups where run_id=new.run_id and group_id=new.group_id;
  select * into strict q from run_work_requests where run_id=new.run_id and request_id=new.request_id;
  pinned := repeat_pinned_version(new.run_id);
  select value into strict node from jsonb_array_elements(pinned #> '{definition,nodes}') n where n->>'id'=g.parent_node_id;
  select result_json::jsonb->'output' into strict source from run_work_results where run_id=new.run_id and execution_id=g.parent_execution_id;
  if jsonb_typeof(source)='string' then source := (source #>> '{}')::jsonb;
  elsif source->>'text' is not null and source->'routing' is null then source := (source->>'text')::jsonb; end if;
  select c #>> '{target,relationshipId}' into strict edge_id from jsonb_array_elements(node #> '{choice,outcomes}') c
    where c->>'outcome'=new.task_json::jsonb->>'outcome' and c #>> '{target,kind}'='edge';
  if source #>> '{routing,kind}'='delegate' then
    select value into strict selected from jsonb_array_elements(source #> '{routing,requests}') r
      where r->>'outcome'=new.task_json::jsonb->>'outcome';
    if selected->'data' is distinct from new.task_data_json::jsonb
      or not exists(select 1 from jsonb_array_elements(pinned #> '{definition,hierarchy,parents}') p
        where p->>'parentNodeId'=g.parent_node_id and p->>'workflowNodeId'=q.destination_node_id)
      then raise exception 'HIERARCHY_MEMBER_TASK_CONFLICT'; end if;
  elsif source #>> '{routing,kind}'='request' then
    if source #>> '{routing,outcome}' is distinct from new.task_json::jsonb->>'outcome'
      or source->'data' is distinct from new.task_data_json::jsonb then raise exception 'HIERARCHY_MEMBER_TASK_CONFLICT'; end if;
  else raise exception 'HIERARCHY_MEMBER_SOURCE_CONFLICT'; end if;
  if q.requester_activation_id<>g.parent_activation_id or q.requester_execution_id<>g.parent_execution_id
    or q.requester_node_id<>g.parent_node_id or q.payload_digest<>g.source_result_digest or q.relationship_id<>edge_id
    or g.record #>> array['memberRequestIds',(new.ordinal-1)::text] is distinct from q.request_id
    then raise exception 'HIERARCHY_MEMBER_ANCESTRY_CONFLICT'; end if;
  if new.failure_execution_id is not null then
    select * into strict failed from harness_executions where id=new.failure_execution_id;
    select failure_result into recorded_failure from approval_execution_state where execution_id=failed.id;
    if failed.run_id<>new.run_id or failed.workflow_node_id<>q.destination_node_id
      or failed.record->>'state'<>'completed'
      or work_parent_request(new.run_id,failed.work_activation_id) is distinct from q.request_id
      or (new.failure_refusal_id is null and new.failure_result is distinct from coalesce(hierarchy_control_failure(new.run_id,failed.id),recorded_failure,failed.record->'result'))
      or (new.failure_refusal_id is not null and not exists(select 1 from run_hierarchy_refusals f
        where f.refusal_id=new.failure_refusal_id and f.run_id=new.run_id and f.source_execution_id=failed.id
          and f.result=new.failure_result))
      or exists(select 1 from run_work_returns where run_id=new.run_id and request_id=new.request_id)
      then raise exception 'HIERARCHY_MEMBER_FAILURE_CONFLICT'; end if;
  end if;
  return null;
end $$;
` }
