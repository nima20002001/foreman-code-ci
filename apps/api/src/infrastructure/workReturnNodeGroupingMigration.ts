export const workReturnNodeGroupingMigration = { version: 2026101903, sql: String.raw`
create function work_return_continuation_matches(work_run_id text, continuation_id text, requested_node_id text)
returns boolean language sql stable as $$
  select exists(select 1 from run_work_activations a
    join run_work_returns t on t.run_id=a.run_id and t.return_id=a.cause_id
    join run_work_requests q on q.run_id=t.run_id and q.request_id=t.request_id
    join run_work_activations requester on requester.run_id=q.run_id
      and requester.activation_id=q.requester_activation_id
    where a.run_id=work_run_id and a.activation_id=continuation_id and a.cause_kind='work_return'
      and a.workflow_node_id=requested_node_id and q.requester_node_id=a.workflow_node_id
      and t.requester_continuation_activation_id=a.activation_id and a.lineage_id=requester.lineage_id);
$$;

create or replace function assert_work_return() returns trigger language plpgsql as $$
declare work_request run_work_requests%rowtype; source_activation run_work_activations%rowtype;
  source_execution harness_executions%rowtype; accepted_digest text;
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
    or source_activation.lineage_id<>(select lineage_id from run_work_activations
      where run_id=new.run_id and activation_id=work_request.requester_activation_id)
    or source_execution.run_id<>new.run_id or source_execution.work_activation_id<>new.source_activation_id
    or source_execution.workflow_node_id<>work_request.destination_node_id or not source_execution.accepted
    or source_execution.record->>'state'<>'completed'
    or accepted_digest<>new.result_digest
    or new.record #>> '{scope,workflowVersionId}' is distinct from work_request.workflow_version_id
    or new.record->>'requesterActivationId' is distinct from work_request.requester_activation_id
    or new.record->'latestDeliverable' is null or new.record->'latestDeliverable'='null'::jsonb
    or jsonb_typeof(new.record->'remainingFindings') is distinct from 'array'
    or work_json_bytes(new.record)>65536 then raise exception 'WORK_RETURN_ANCESTRY_CONFLICT'; end if;
  if new.outcome='needs_changes' and not work_return_continuation_matches(new.run_id,
    new.requester_continuation_activation_id,work_request.requester_node_id) then
    raise exception 'WORK_RETURN_CONTINUATION_CONFLICT'; end if;
  return null;
end $$;

create or replace function assert_work_notice_scope() returns trigger language plpgsql as $$
declare pinned jsonb; requester run_work_activations%rowtype; continuation run_work_activations%rowtype;
  work_edge jsonb; destination jsonb; parent_return run_work_returns%rowtype;
  denial run_work_denials%rowtype; request run_work_requests%rowtype;
  alternative jsonb; alt_edge jsonb; alt_node jsonb; options jsonb;
  alt_used integer; alt_maximum integer;
begin
  if not exists(select 1 from run_work_notices where notice_id=new.notice_id) then return null; end if;
  pinned := repeat_pinned_version(new.run_id);
  if pinned #> '{definition,handoffs}' is distinct from '{"contractVersion":1}'::jsonb
    or new.workflow_version_id<>pinned->>'id' then raise exception 'WORK_NOTICE_PIN_CONFLICT'; end if;
  select * into strict requester from run_work_activations where activation_id=new.requester_activation_id;
  select * into strict continuation from run_work_activations where activation_id=new.continuation_activation_id;
  select value into strict work_edge from jsonb_array_elements(pinned #> '{definition,edges}') e
    where e->>'id'=new.relationship_id and e->>'kind'='execution';
  select value into strict destination from jsonb_array_elements(pinned #> '{definition,nodes}') n
    where n->>'id'=new.destination_node_id;
  if requester.run_id<>new.run_id or continuation.run_id<>new.run_id
    or continuation.workflow_node_id<>requester.workflow_node_id
    or new.cause_kind='limit_denial' and continuation.lineage_id<>requester.lineage_id
    or destination->>'agentId' is distinct from new.record->>'destinationAgentId'
    or coalesce(destination->>'name',destination->>'label',destination->>'agentId')
      is distinct from new.record->>'destinationName'
    or new.record->>'message' is distinct from
      ('The maximum number of work handoffs to agent ' || (new.record->>'destinationName')
        || ' has been reached (' || new.used::text || ' of ' || new.maximum::text
        || ' for this Run). Choose another available agent or finish with the remaining findings.')
    or (work_edge->>'source'<>requester.workflow_node_id and
      not (coalesce(work_edge->>'workRequestDirection'='both',false)
        and work_edge->>'target'=requester.workflow_node_id)) then
    raise exception 'WORK_NOTICE_CONTENT_CONFLICT'; end if;
  if new.cause_kind='last_return' then
    select * into strict parent_return from run_work_returns where return_id=new.cause_id;
    select * into strict request from run_work_requests where request_id=parent_return.request_id;
    if parent_return.run_id<>new.run_id or parent_return.outcome<>'needs_changes'
      or parent_return.requester_continuation_activation_id<>new.continuation_activation_id
      or request.relationship_id<>new.relationship_id
      or request.requester_activation_id<>new.requester_activation_id
      or not work_return_continuation_matches(new.run_id,new.continuation_activation_id,requester.workflow_node_id)
      or new.record->'latestDeliverable' is distinct from parent_return.record->'latestDeliverable'
      or new.record->'remainingFindings' is distinct from parent_return.record->'remainingFindings' then
      raise exception 'WORK_NOTICE_RETURN_CONFLICT'; end if;
  else
    select * into strict denial from run_work_denials where denial_id=new.cause_id;
    if denial.run_id<>new.run_id or denial.relationship_id<>new.relationship_id
      or denial.requester_activation_id<>new.requester_activation_id
      or (denial.record->>'used')::integer<>new.used
      or denial.record->>'maxWorkHandoffsPerRun'<>new.maximum::text
      or continuation.cause_kind<>'limit_denial' or continuation.cause_id<>new.cause_id then
      raise exception 'WORK_NOTICE_DENIAL_CONFLICT'; end if;
  end if;
  if not exists(select 1 from run_work_connection_usage u where u.run_id=new.run_id
    and u.workflow_version_id=new.workflow_version_id and u.relationship_id=new.relationship_id
    and u.used=new.used and u.maximum=new.maximum) then raise exception 'WORK_NOTICE_CAP_CONFLICT'; end if;
  if tg_op='INSERT' then
    if jsonb_typeof(new.record->'alternatives') is distinct from 'array' then
      raise exception 'WORK_NOTICE_ALTERNATIVES_INVALID'; end if;
    for alternative in select value from jsonb_array_elements(new.record->'alternatives') loop
      select value into strict alt_edge from jsonb_array_elements(pinned #> '{definition,edges}') e
        where e->>'id'=alternative->>'relationshipId' and e->>'kind'='execution';
      select value into strict alt_node from jsonb_array_elements(pinned #> '{definition,nodes}') n
        where n->>'id'=alternative->>'destinationNodeId';
      select coalesce(jsonb_agg(c->>'outcome' order by c->>'outcome'),'[]'::jsonb) into options
        from jsonb_array_elements((select n->'choice'->'outcomes' from jsonb_array_elements(pinned #> '{definition,nodes}') n
          where n->>'id'=requester.workflow_node_id)) c
        where c #>> '{target,kind}'='edge' and c #>> '{target,relationshipId}'=alternative->>'relationshipId';
      select u.used,u.maximum into alt_used,alt_maximum from run_work_connection_usage u
        where u.run_id=new.run_id and u.workflow_version_id=new.workflow_version_id
          and u.relationship_id=alternative->>'relationshipId';
      alt_used := coalesce(alt_used,0);
      if alternative->>'relationshipId'=new.relationship_id
        or alternative->>'destinationNodeId'=new.destination_node_id
        or not coalesce((alt_edge->>'source'=requester.workflow_node_id
          and alt_edge->>'target'=alternative->>'destinationNodeId'
          or coalesce(alt_edge->>'workRequestDirection'='both',false)
            and alt_edge->>'target'=requester.workflow_node_id
            and alt_edge->>'source'=alternative->>'destinationNodeId'),false)
        or alt_node->>'agentId' is distinct from alternative->>'destinationAgentId'
        or coalesce(alt_node->>'name',alt_node->>'label',alt_node->>'agentId')
          is distinct from alternative->>'destinationName'
        or options='[]'::jsonb and (alt_edge->>'source'<>requester.workflow_node_id
          or exists(select 1 from jsonb_array_elements(pinned #> '{definition,nodes}') n
            where n->>'id'=requester.workflow_node_id and n->'choice' is not null))
        or alternative->'outcomes' is distinct from options
        or alternative->'used' is distinct from to_jsonb(alt_used)
        or alternative->'maxWorkHandoffsPerRun' is distinct from coalesce(alt_edge->'maxWorkHandoffsPerRun','null'::jsonb)
        or (alt_edge->>'maxWorkHandoffsPerRun')::integer is not null
          and alt_used>=(alt_edge->>'maxWorkHandoffsPerRun')::integer
        or alt_maximum is not null and alt_maximum is distinct from (alt_edge->>'maxWorkHandoffsPerRun')::integer then
        raise exception 'WORK_NOTICE_ALTERNATIVE_CONFLICT'; end if;
    end loop;
  end if;
  if new.delivery_state='delivered' and not exists(select 1 from run_work_results x
    join harness_executions e on e.id=x.execution_id where x.run_id=new.run_id
      and x.activation_id=new.continuation_activation_id and e.id=new.acknowledgement_execution_id
      and e.accepted and e.record->>'state'='completed') then raise exception 'WORK_NOTICE_ACK_MISSING'; end if;
  return null;
end $$;
` } as const
