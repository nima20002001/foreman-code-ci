/** Retain exact old summary inputs; new expanded fields must match the immutable child return. */
export const hierarchyFeedbackMigration = { version: 2026102113, sql: String.raw`
create or replace function hierarchy_group_feedback(work_run_id text, work_group_id text) returns jsonb
language sql stable as $$
  select jsonb_build_object('group',g.record,
    'returns',coalesce((select jsonb_agg((jsonb_build_object('requestId',q.request_id,
      'destinationNodeId',q.destination_node_id,'returnId',t.return_id,
      'sourceActivationId',t.source_activation_id,'sourceExecutionId',t.source_execution_id,
      'resultDigest',t.result_digest,'outcome',t.outcome,
      'summary',left(hierarchy_result_payload(x.result_json::jsonb)->>'summary',300),
      'remainingFindingsCount',jsonb_array_length(t.record->'remainingFindings'),
      'latestDeliverable',t.record->'latestDeliverable','remainingFindings',t.record->'remainingFindings')
      || case when t.requester_continuation_activation_id is null then '{}'::jsonb
        else jsonb_build_object('continuationActivationId',t.requester_continuation_activation_id) end) order by m.ordinal)
      from run_hierarchy_group_members m join run_work_requests q on q.run_id=m.run_id and q.request_id=m.request_id
      join run_work_returns t on t.run_id=q.run_id and t.request_id=q.request_id
      join run_work_results x on x.run_id=t.run_id and x.execution_id=t.source_execution_id
      where m.run_id=g.run_id and m.group_id=g.group_id),'[]'::jsonb),
    'failures',coalesce((select jsonb_agg(jsonb_build_object('requestId',q.request_id,
      'destinationNodeId',q.destination_node_id,'executionId',m.failure_execution_id,
      'outcome',m.failure_result->>'outcome',
      'code',left(coalesce(nullif(m.failure_result #>> '{error,code}',''),'WORK_EXECUTION_FAILED'),80),
      'summary',left(coalesce(nullif(m.failure_result #>> '{error,message}',''),'The child work did not complete.'),300)) order by m.ordinal)
      from run_hierarchy_group_members m join run_work_requests q on q.run_id=m.run_id and q.request_id=m.request_id
      where m.run_id=g.run_id and m.group_id=g.group_id and m.failure_execution_id is not null),'[]'::jsonb))
    from run_hierarchy_groups g where g.run_id=work_run_id and g.group_id=work_group_id and g.state in ('ready','continued');
$$;

create function hierarchy_feedback_matches(actual jsonb,expected jsonb) returns boolean language sql immutable as $$
  select actual=expected or actual=(select coalesce(jsonb_agg(value-array['latestDeliverable','remainingFindings'] order by ordinality),'[]'::jsonb)
    from jsonb_array_elements(expected) with ordinality);
$$;

create or replace function assert_work_slot_identity() returns trigger language plpgsql as $$
declare pinned jsonb; activation run_work_activations%rowtype; request run_work_requests%rowtype;
  returned run_work_returns%rowtype; denial run_work_denials%rowtype;
  group_feedback jsonb; task jsonb; source_result jsonb; work_input jsonb; joined jsonb; expected integer; notice jsonb; required_edges text[];
begin
  if not exists(select 1 from run_repeat_slots where slot_id=new.slot_id) then return null; end if;
  pinned := repeat_pinned_version(new.run_id);
  if pinned #> '{definition,handoffs}' is distinct from '{"contractVersion":1}'::jsonb then
    if new.work_activation_id is not null then raise exception 'WORK_SLOT_ON_OLD_RUN'; end if;
    return null;
  end if;
  if new.work_activation_id is null or new.occurrence_id is not null
    or new.input_json::jsonb #>> '{work,activation,activationId}' is distinct from new.work_activation_id then
    raise exception 'WORK_SLOT_ACTIVATION_CONFLICT'; end if;
  select * into strict activation from run_work_activations where activation_id=new.work_activation_id;
  if activation.run_id<>new.run_id or activation.workflow_node_id<>new.workflow_node_id
    or activation.workflow_version_id<>pinned->>'id' then raise exception 'WORK_SLOT_ACTIVATION_CONFLICT'; end if;
  work_input := new.input_json::jsonb->'work';
  if work_input->>'kind' is distinct from activation.cause_kind
    or work_input->'activation' is distinct from activation.record then
    raise exception 'WORK_SLOT_INPUT_CONFLICT'; end if;
  if activation.cause_kind='entry' then
    if activation.workflow_node_id<>pinned->>'entryNodeId' then raise exception 'WORK_ENTRY_NODE_CONFLICT'; end if;
  elsif activation.cause_kind='work_request' then
    select * into strict request from run_work_requests where request_id=activation.cause_id;
    select result_json::jsonb into strict source_result from run_work_results
      where run_id=new.run_id and execution_id=request.requester_execution_id;
    if request.run_id<>new.run_id or request.destination_activation_id<>activation.activation_id
      or work_input->'request' is distinct from request.record
      or work_input->'acceptedSourceResult' is distinct from source_result then
      raise exception 'WORK_SLOT_INPUT_CONFLICT'; end if;
    select task_json::jsonb into task from run_hierarchy_group_members
      where run_id=new.run_id and request_id=request.request_id;
    if work_input->'task' is distinct from task then raise exception 'HIERARCHY_TASK_INPUT_CONFLICT'; end if;
  elsif activation.cause_kind='hierarchy_group' then
    group_feedback := hierarchy_group_feedback(new.run_id,activation.cause_id);
    if group_feedback is null or work_input->'group' is distinct from group_feedback->'group'
      or not hierarchy_feedback_matches(work_input->'returns',group_feedback->'returns')
      or work_input->'failures' is distinct from group_feedback->'failures'
      then raise exception 'HIERARCHY_GROUP_INPUT_CONFLICT'; end if;
  elsif activation.cause_kind='hierarchy_direction' then
    select record into strict group_feedback from run_hierarchy_direction_waits
      where run_id=new.run_id and direction_id=activation.cause_id and held_activation_id=activation.activation_id;
    if work_input->'direction' is distinct from group_feedback then raise exception 'HIERARCHY_DIRECTION_INPUT_CONFLICT'; end if;
  elsif activation.cause_kind='work_return' then
    select * into strict returned from run_work_returns where return_id=activation.cause_id;
    select result_json::jsonb into strict source_result from run_work_results
      where run_id=new.run_id and execution_id=returned.source_execution_id;
    select record into notice from run_work_notices where run_id=new.run_id
      and cause_kind='last_return' and cause_id=returned.return_id;
    if returned.run_id<>new.run_id or returned.requester_continuation_activation_id<>activation.activation_id
      or work_input->'returned' is distinct from returned.record
      or work_input->'acceptedSourceResult' is distinct from source_result then
      raise exception 'WORK_SLOT_INPUT_CONFLICT'; end if;
    if notice is not null then perform assert_frozen_work_notice(work_input->'notice',notice);
    elsif work_input ? 'notice' then raise exception 'WORK_NOTICE_INPUT_CONFLICT'; end if;
  elsif activation.cause_kind='limit_denial' then
    select * into strict denial from run_work_denials where denial_id=activation.cause_id;
    select result_json::jsonb into strict source_result from run_work_results
      where run_id=new.run_id and execution_id=denial.requester_execution_id;
    select record into strict notice from run_work_notices where run_id=new.run_id
      and cause_kind='limit_denial' and cause_id=denial.denial_id;
    if denial.run_id<>new.run_id or work_input->'denial' is distinct from denial.record
      or work_input->'acceptedSourceResult' is distinct from source_result then
      raise exception 'WORK_DENIAL_INPUT_CONFLICT'; end if;
    perform assert_frozen_work_notice(work_input->'notice',notice);
  elsif activation.cause_kind='join' then
    select coalesce(jsonb_agg(jsonb_build_object('request',r.record,'acceptedSourceResult',x.result_json::jsonb)
      order by r.relationship_id),'[]'::jsonb) into joined
      from run_work_requests r join run_work_results x on x.run_id=r.run_id
        and x.execution_id=r.requester_execution_id
      where r.run_id=new.run_id and r.destination_activation_id=new.work_activation_id;
    required_edges := work_join_required_edges(new.run_id,
      work_round_id(new.run_id,new.work_activation_id),new.workflow_node_id);
    expected := cardinality(required_edges);
    if activation.state<>'queued' or expected<1 or jsonb_array_length(joined)<>expected
      or (select count(distinct r.relationship_id) from run_work_requests r
        where r.run_id=new.run_id and r.destination_activation_id=new.work_activation_id)<>expected
      or exists(select 1 from run_work_requests r where r.run_id=new.run_id
        and r.destination_activation_id=new.work_activation_id and not (r.relationship_id=any(required_edges)))
      or work_input->'sources' is distinct from joined then
      raise exception 'WORK_JOIN_INPUT_CONFLICT'; end if;
  else
    raise exception 'WORK_SLOT_CAUSE_UNSUPPORTED';
  end if;
  return null;
end $$;
` }
