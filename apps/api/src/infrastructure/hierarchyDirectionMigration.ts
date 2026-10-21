/** A held same-Run input boundary. Native success remains immutable and nonfinal. */
export const hierarchyDirectionMigration = { version: 2026102103, sql: String.raw`
create index hierarchy_node_activation_history on run_work_activations(run_id,workflow_node_id,activation_sequence desc);
create table run_hierarchy_direction_waits (
  direction_id text primary key,
  run_id text not null references runs(id) on delete cascade,
  workflow_version_id text not null references workflow_versions(id),
  workflow_node_id text not null,
  source_activation_id text not null,
  source_execution_id text not null references harness_executions(id) deferrable initially deferred,
  source_result_json text not null check(octet_length(source_result_json)<=65536),
  source_result_digest text not null check(source_result_digest='sha256:' || encode(sha256(convert_to(source_result_json,'UTF8')),'hex')),
  held_activation_id text not null,
  held_execution_id text not null references harness_executions(id) deferrable initially deferred,
  state text not null check(state in ('waiting','released','canceled')),
  released_receipt_id text,
  record jsonb not null,
  created_at timestamptz not null,
  unique(run_id,direction_id), unique(run_id,source_execution_id), unique(run_id,source_activation_id),
  unique(run_id,held_activation_id), unique(run_id,held_execution_id),
  foreign key(run_id,source_activation_id) references run_work_activations(run_id,activation_id)
    on delete cascade deferrable initially deferred,
  foreign key(run_id,held_activation_id) references run_work_activations(run_id,activation_id)
    on delete cascade deferrable initially deferred,
  check(source_activation_id<>held_activation_id and source_execution_id<>held_execution_id),
  check(state<>'released' or released_receipt_id is not null),
  check(record->>'directionId' is not distinct from direction_id),
  check(record #>> '{scope,runId}' is not distinct from run_id),
  check(record #>> '{scope,workflowVersionId}' is not distinct from workflow_version_id),
  check(record->>'workflowNodeId' is not distinct from workflow_node_id),
  check(record->>'sourceActivationId' is not distinct from source_activation_id),
  check(record->>'sourceExecutionId' is not distinct from source_execution_id),
  check(record->>'sourceResultDigest' is not distinct from source_result_digest),
  check(record->>'heldActivationId' is not distinct from held_activation_id),
  check(record->>'heldExecutionId' is not distinct from held_execution_id)
);

alter table run_work_activations drop constraint work_activation_cause_kind;
alter table run_work_activations drop constraint work_activation_cause_identity;
alter table run_work_activations add constraint work_activation_cause_kind
  check(cause_kind in ('entry','dependency','join','work_request','work_return','limit_denial','hierarchy_group','hierarchy_direction'));
alter table run_work_activations add constraint work_activation_cause_identity check(
  case cause_kind when 'entry' then cause_id=run_id
    when 'dependency' then cause_id=record #>> '{cause,resolutionId}'
    when 'join' then cause_id=record #>> '{cause,joinId}'
    when 'work_request' then cause_id=record #>> '{cause,requestId}'
    when 'work_return' then cause_id=record #>> '{cause,returnId}'
    when 'limit_denial' then cause_id=record #>> '{cause,denialId}'
    when 'hierarchy_group' then cause_id=record #>> '{cause,groupId}'
    when 'hierarchy_direction' then cause_id=record #>> '{cause,directionId}' else false end);

create function assert_hierarchy_direction() returns trigger language plpgsql as $$
declare d run_hierarchy_direction_waits%rowtype; source harness_executions%rowtype;
  held harness_executions%rowtype; parent run_work_activations%rowtype; activation run_work_activations%rowtype;
  pinned jsonb; payload jsonb; direction_key text; native_key text; activation_key text;
begin
  if tg_table_name='run_hierarchy_direction_waits' then
    direction_key := new.direction_id;
  elsif tg_table_name='run_work_activations' then
    activation_key := new.activation_id;
  else
    native_key := new.id;
  end if;
  -- A held execution may later itself produce the next direction boundary.
  -- Recheck every matching immutable source rather than choosing one row.
  for d in select * from run_hierarchy_direction_waits where direction_id=direction_key
    or held_execution_id=native_key or source_execution_id=native_key
    or held_activation_id=activation_key or source_activation_id=activation_key loop
  select * into strict source from harness_executions where id=d.source_execution_id;
  select * into strict held from harness_executions where id=d.held_execution_id;
  select * into strict parent from run_work_activations where run_id=d.run_id and activation_id=d.source_activation_id;
  select * into strict activation from run_work_activations where run_id=d.run_id and activation_id=d.held_activation_id;
  pinned := repeat_pinned_version(d.run_id);
  payload := hierarchy_result_payload(source.record->'result');
  if (select record->>'resultProtocol' from runs where id=d.run_id) is distinct from 'f1-f4-v1'
    or pinned->>'id' is distinct from d.workflow_version_id
    or pinned #>> '{definition,hierarchy,masterNodeId}' is distinct from d.workflow_node_id
    or source.run_id<>d.run_id or source.workflow_node_id<>d.workflow_node_id
    or source.work_activation_id<>d.source_activation_id or source.accepted
    or source.record->>'state' is distinct from 'completed'
    or source.record #>> '{result,outcome}' is distinct from 'succeeded'
    or source.record->'result' is distinct from d.source_result_json::jsonb
    or payload #>> '{routing,kind}' is distinct from 'finish'
    or coalesce(jsonb_array_length(payload #> '{data,remainingFindings}'),0)<1
    or payload->>'summary' is distinct from d.record->>'summary'
    or jsonb_array_length(payload #> '{data,remainingFindings}')<>(d.record->>'remainingFindingsCount')::int
    or parent.state<>'completed' or work_parent_request(d.run_id,parent.activation_id) is not null
    or held.run_id<>d.run_id or held.workflow_node_id<>d.workflow_node_id
    or held.work_activation_id<>d.held_activation_id or held.agent_id<>source.agent_id
    or held.record->>'agentConfigurationVersionId' is distinct from source.record->>'agentConfigurationVersionId'
    or activation.workflow_node_id<>d.workflow_node_id or activation.lineage_id<>parent.lineage_id
    or activation.workflow_version_id<>d.workflow_version_id or parent.workflow_version_id<>d.workflow_version_id
    or activation.cause_kind<>'hierarchy_direction' or activation.cause_id<>d.direction_id
    or d.state='waiting' and (held.record->>'state'<>'queued' or activation.state<>'waiting')
    then raise exception 'HIERARCHY_DIRECTION_PROOF_CONFLICT'; end if;
  end loop;
  return null;
end $$;
create constraint trigger hierarchy_direction_proof after insert or update on run_hierarchy_direction_waits
  deferrable initially deferred for each row execute function assert_hierarchy_direction();
create constraint trigger hierarchy_direction_native_proof after insert or update on harness_executions
  deferrable initially deferred for each row execute function assert_hierarchy_direction();
create constraint trigger hierarchy_direction_activation_proof after insert or update on run_work_activations
  deferrable initially deferred for each row execute function assert_hierarchy_direction();
create function protect_hierarchy_direction_update() returns trigger language plpgsql as $$
begin
  if to_jsonb(new)-'state'-'released_receipt_id' is distinct from to_jsonb(old)-'state'-'released_receipt_id'
    or old.released_receipt_id is not null and new.released_receipt_id is distinct from old.released_receipt_id
    or new.state<>old.state and not (old.state='waiting' and new.state in ('released','canceled')
      or old.state='released' and new.state='canceled')
    then raise exception 'HIERARCHY_DIRECTION_IMMUTABLE'; end if;
  return new;
end $$;
create trigger hierarchy_direction_immutable before update on run_hierarchy_direction_waits
  for each row execute function protect_hierarchy_direction_update();
create trigger hierarchy_direction_retention before delete on run_hierarchy_direction_waits
  for each row execute function assert_work_evidence_retention();
create trigger hierarchy_direction_no_truncate before truncate on run_hierarchy_direction_waits
  for each statement execute function reject_work_evidence_truncate();

-- A root may fail to reserve direction after native success, before final acceptance.
-- Retain exact original bytes for that refusal; group refusals still require their accepted source.
alter table run_hierarchy_refusals add column source_result_json text;
alter table run_hierarchy_refusals add constraint hierarchy_refusal_source_bytes check(source_result_json is null
  or octet_length(source_result_json)<=65536 and source_result_digest='sha256:' || encode(sha256(convert_to(source_result_json,'UTF8')),'hex'));
do $$ declare item record; begin
  for item in select conname from pg_constraint where conrelid='run_hierarchy_refusals'::regclass
    and confrelid='run_work_results'::regclass loop
    execute format('alter table run_hierarchy_refusals drop constraint %I',item.conname);
  end loop;
end $$;
create function assert_hierarchy_refusal_source() returns trigger language plpgsql as $$
declare source harness_executions%rowtype; payload jsonb; pinned jsonb;
  f run_hierarchy_refusals%rowtype; refusal_key text; native_key text;
begin
  if tg_table_name='run_hierarchy_refusals' then refusal_key := new.refusal_id;
  else native_key := new.id; end if;
  for f in select * from run_hierarchy_refusals where refusal_id=refusal_key or source_execution_id=native_key loop
  if f.source_result_json is null then
    if not exists(select 1 from run_work_results x where x.run_id=f.run_id
      and x.execution_id=f.source_execution_id and x.activation_id=f.source_activation_id
      and x.result_digest=f.source_result_digest) then raise exception 'HIERARCHY_REFUSAL_SOURCE_CONFLICT'; end if;
  else
    select * into strict source from harness_executions where id=f.source_execution_id;
    payload := hierarchy_result_payload(source.record->'result');
    pinned := repeat_pinned_version(f.run_id);
    if (select record->>'resultProtocol' from runs where id=f.run_id) is distinct from 'f1-f4-v1'
      or source.run_id<>f.run_id or source.work_activation_id<>f.source_activation_id or source.accepted
      or source.record->>'state'<>'completed' or source.record #>> '{result,outcome}'<>'succeeded'
      or source.record->'result' is distinct from f.source_result_json::jsonb
      or source.workflow_node_id is distinct from pinned #>> '{definition,hierarchy,masterNodeId}'
      or work_parent_request(f.run_id,f.source_activation_id) is not null
      or payload #>> '{routing,kind}' is distinct from 'finish'
      or coalesce(jsonb_array_length(payload #> '{data,remainingFindings}'),0)<1
      then raise exception 'HIERARCHY_REFUSAL_SOURCE_CONFLICT'; end if;
  end if;
  end loop;
  return null;
end $$;
create constraint trigger hierarchy_refusal_source after insert on run_hierarchy_refusals
  deferrable initially deferred for each row execute function assert_hierarchy_refusal_source();
create constraint trigger hierarchy_refusal_native_source after update on harness_executions
  deferrable initially deferred for each row execute function assert_hierarchy_refusal_source();

-- Preserve the current ordinary return/join routes; only an explicit saved
-- hierarchy delegation selects its named direct-child set.
create or replace function work_saved_routes(pinned jsonb, node jsonb, payload jsonb) returns text[]
language plpgsql immutable as $$
declare selected text[]; route_kind text; accepted_return boolean := false;
begin
  if payload is not null then
    if jsonb_typeof(payload)='string' then payload := (payload #>> '{}')::jsonb;
    elsif payload->>'text' is not null and payload->'routing' is null then payload := (payload->>'text')::jsonb;
    end if;
    route_kind := payload #>> '{routing,kind}';
    if route_kind='delegate' then
      if pinned #> '{definition,hierarchy}' is null then return '{}'; end if;
      select coalesce(array_agg(c #>> '{target,relationshipId}' order by c #>> '{target,relationshipId}'),'{}')
        into selected from jsonb_array_elements(node #> '{choice,outcomes}') c
        join jsonb_array_elements(payload #> '{routing,requests}') r on r->>'outcome'=c->>'outcome'
        join jsonb_array_elements(pinned #> '{definition,edges}') e on e->>'id'=c #>> '{target,relationshipId}'
        where c #>> '{target,kind}'='edge' and e->>'kind'='execution' and e->>'source'=node->>'id'
          and exists(select 1 from jsonb_array_elements(pinned #> '{definition,hierarchy,parents}') p
            where p->>'parentNodeId'=node->>'id' and p->>'workflowNodeId'=e->>'target');
      return selected;
    end if;
    if route_kind='return' then
      if payload #>> '{routing,outcome}' is distinct from 'accepted'
        or jsonb_array_length(payload #> '{data,remainingFindings}')>0 then return '{}'; end if;
      accepted_return := true;
      payload := jsonb_set(payload,'{routing}','{"kind":"finish"}'::jsonb);
      route_kind := 'finish';
    end if;
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
    where e->>'kind'='execution' and e->>'source'=node->>'id'
      and (not accepted_return or exists(select 1 from jsonb_array_elements(pinned #> '{definition,nodes}') target
        where target->>'id'=e->>'target' and target #>> '{join,mode}'='all'));
  return selected;
end $$;

create or replace function work_parent_request(work_run_id text, work_activation_id text) returns text
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
    elsif activation.cause_kind='hierarchy_group' then
      select parent_activation_id into strict next_id from run_hierarchy_groups
        where run_id=work_run_id and group_id=activation.cause_id
          and continuation_activation_id=activation.activation_id;
    elsif activation.cause_kind='hierarchy_direction' then
      select source_activation_id into strict next_id from run_hierarchy_direction_waits
        where run_id=work_run_id and direction_id=activation.cause_id
          and held_activation_id=activation.activation_id;
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

create or replace function assert_work_parent_input() returns trigger language plpgsql as $$
declare parent_id text; parent_record jsonb; input_record jsonb;
begin
  if new.work_activation_id is null then return null; end if;
  input_record := new.input_json::jsonb;
  if input_record #>> '{work,kind}' not in ('work_return','limit_denial','hierarchy_group','hierarchy_direction') then return null; end if;
  parent_id := work_parent_request(new.run_id,new.work_activation_id);
  if parent_id is not null then
    select record into strict parent_record from run_work_requests where run_id=new.run_id and request_id=parent_id;
  end if;
  if input_record->'parentRequest' is distinct from parent_record then raise exception 'WORK_PARENT_INPUT_CONFLICT'; end if;
  return null;
end $$;

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
      or work_input->'returns' is distinct from group_feedback->'returns'
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
