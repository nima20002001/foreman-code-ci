export const workJoinRoundMigration = { version: 269303, sql: String.raw`
create function work_round_id(work_run_id text, work_activation_id text, visited text[] default '{}')
returns text language plpgsql stable as $$
declare activation run_work_activations%rowtype; requester_id text; relationship_id text; round_ids text[];
begin
  if work_activation_id=any(visited) then raise exception 'WORK_ROUND_CYCLE'; end if;
  visited := array_append(visited,work_activation_id);
  select * into strict activation from run_work_activations
    where run_id=work_run_id and activation_id=work_activation_id;
  if activation.cause_kind in ('entry','dependency') then return activation.lineage_id;
  elsif activation.cause_kind in ('work_return','limit_denial') then return activation.activation_id;
  elsif activation.cause_kind='work_request' then
    select r.requester_activation_id,r.relationship_id into strict requester_id,relationship_id from run_work_requests r
      where run_id=work_run_id and request_id=activation.cause_id
        and destination_activation_id=activation.activation_id;
    if exists(select 1 from jsonb_array_elements(repeat_pinned_version(work_run_id) #> '{definition,edges}') e
      where e->>'id'=relationship_id and e->>'source'=activation.workflow_node_id) then
      return activation.activation_id;
    end if;
    return work_round_id(work_run_id,requester_id,visited);
  elsif activation.cause_kind='join' then
    select array_agg(distinct work_round_id(work_run_id,requester_activation_id,visited)) into round_ids
      from run_work_requests where run_id=work_run_id and destination_activation_id=activation.activation_id;
    if cardinality(round_ids) is distinct from 1 then raise exception 'WORK_JOIN_ROUND_CONFLICT'; end if;
    return round_ids[1];
  end if;
  raise exception 'WORK_ROUND_CAUSE_UNSUPPORTED';
end $$;

-- A missing result keeps every possible saved route open. An accepted result narrows it to the selected routes.
create function work_saved_routes(pinned jsonb, node jsonb, payload jsonb) returns text[]
language plpgsql immutable as $$
declare selected text[]; route_kind text;
begin
  if payload is not null then
    if jsonb_typeof(payload)='string' then payload := (payload #>> '{}')::jsonb;
    elsif payload->>'text' is not null and payload->'routing' is null then payload := (payload->>'text')::jsonb;
    end if;
    route_kind := payload #>> '{routing,kind}';
    if route_kind='return' then return '{}'; end if;
    if route_kind='finish' and payload #>> '{routing,outcome}' is null
      and jsonb_array_length(payload #> '{data,remainingFindings}')>0 then return '{}'; end if;
  end if;
  if node->'choice' is not null then
    select coalesce(array_agg(c #>> '{target,relationshipId}' order by c #>> '{target,relationshipId}'),'{}')
      into selected from jsonb_array_elements(node #> '{choice,outcomes}') c
      where c #>> '{target,kind}'='edge'
        and (payload is null or c->>'outcome'=payload #>> '{routing,outcome}');
    return selected;
  end if;
  if payload is not null and route_kind is distinct from 'finish' then return '{}'; end if;
  select coalesce(array_agg(e->>'id' order by e->>'id'),'{}') into selected
    from jsonb_array_elements(pinned #> '{definition,edges}') e
    where e->>'kind'='execution' and e->>'source'=node->>'id';
  return selected;
end $$;

create function work_join_required_edges(work_run_id text, round_id text, join_node_id text) returns text[]
language sql stable as $$
  with recursive
  pinned as (select repeat_pinned_version(work_run_id) as value),
  nodes as (select n.value from pinned p
    cross join lateral jsonb_array_elements(p.value #> '{definition,nodes}') n(value)),
  edges as (select e.value from pinned p
    cross join lateral jsonb_array_elements(p.value #> '{definition,edges}') e(value)
    where e.value->>'kind'='execution'),
  decisions as (
    select a.workflow_node_id, x.result_json::jsonb->'output' as payload
    from run_work_results x join run_work_activations a on a.run_id=x.run_id and a.activation_id=x.activation_id
    where x.run_id=work_run_id and work_round_id(x.run_id,a.activation_id)=round_id
  ),
  routes as (
    select e.value->>'id' as relationship_id,n.value->>'id' as source,
      case when e.value->>'source'=n.value->>'id' then e.value->>'target' else e.value->>'source' end as target
    from pinned cross join nodes n left join decisions d on d.workflow_node_id=n.value->>'id'
    join edges e on (e.value->>'source'=n.value->>'id'
      or e.value->>'workRequestDirection'='both' and e.value->>'target'=n.value->>'id')
      and e.value->>'id'=any(work_saved_routes(pinned.value,n.value,d.payload))
  ),
  reachable(node_id) as (
    select coalesce((select workflow_node_id from run_work_activations
      where run_id=work_run_id and activation_id=round_id),(select value->>'entryNodeId' from pinned))
    union
    select routes.target from reachable join routes on routes.source=reachable.node_id
      where reachable.node_id<>join_node_id
  )
  select coalesce(array_agg(distinct r.relationship_id order by r.relationship_id),'{}')
    from routes r join reachable on reachable.node_id=r.source join edges e on e.value->>'id'=r.relationship_id
    where r.target=join_node_id and e.value->>'target'=join_node_id;
$$;

create or replace function assert_work_slot_identity() returns trigger language plpgsql as $$
declare pinned jsonb; activation run_work_activations%rowtype; request run_work_requests%rowtype;
  returned run_work_returns%rowtype; denial run_work_denials%rowtype;
  source_result jsonb; work_input jsonb; joined jsonb; expected integer; notice jsonb; required_edges text[];
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

` } as const
