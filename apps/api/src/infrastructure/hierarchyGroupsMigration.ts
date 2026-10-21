/** Additive same-Run hierarchy reservations. Existing work rows and parsers are untouched. */
export const hierarchyGroupsMigration = { version: 2026102102, sql: String.raw`
create table run_hierarchy_groups (
  group_id text primary key,
  run_id text not null references runs(id) on delete cascade,
  workflow_version_id text not null references workflow_versions(id),
  parent_activation_id text not null,
  parent_execution_id text not null,
  parent_node_id text not null,
  continuation_activation_id text not null,
  source_result_digest text not null,
  state text not null check (state in ('waiting','ready','continued','canceled')),
  ready_source_activation_id text,
  record jsonb not null,
  created_at timestamptz not null,
  unique(run_id,group_id),
  unique(run_id,parent_execution_id),
  unique(run_id,parent_activation_id,source_result_digest),
  unique(run_id,continuation_activation_id),
  foreign key(run_id,parent_activation_id) references run_work_activations(run_id,activation_id)
    on delete cascade deferrable initially deferred,
  foreign key(run_id,continuation_activation_id) references run_work_activations(run_id,activation_id)
    on delete cascade deferrable initially deferred,
  foreign key(run_id,ready_source_activation_id) references run_work_activations(run_id,activation_id)
    deferrable initially deferred,
  foreign key(run_id,parent_execution_id,source_result_digest)
    references run_work_results(run_id,execution_id,result_digest) deferrable initially deferred,
  check(record->>'groupId' is not distinct from group_id),
  check(record #>> '{scope,runId}' is not distinct from run_id),
  check(record #>> '{scope,workflowVersionId}' is not distinct from workflow_version_id),
  check(record->>'parentActivationId' is not distinct from parent_activation_id),
  check(record->>'parentExecutionId' is not distinct from parent_execution_id),
  check(record->>'parentNodeId' is not distinct from parent_node_id),
  check(record->>'continuationActivationId' is not distinct from continuation_activation_id),
  check(record->>'sourceResultDigest' is not distinct from source_result_digest),
  check(jsonb_typeof(record->'memberRequestIds')='array'),
  check(jsonb_array_length(record->'memberRequestIds') between 1 and 1000),
  check(parent_activation_id<>continuation_activation_id),
  check(state not in ('ready','continued') or ready_source_activation_id is not null)
);
create table run_hierarchy_group_members (
  run_id text not null,
  group_id text not null,
  request_id text not null,
  ordinal integer not null check(ordinal between 1 and 1000),
  task_json text not null check(octet_length(task_json)<=66560),
  task_data_json text not null check(octet_length(task_data_json)<=65536),
  task_digest text not null,
  failure_execution_id text references harness_executions(id) deferrable initially deferred,
  failure_refusal_id text,
  failure_result jsonb,
  primary key(run_id,request_id),
  unique(run_id,group_id,ordinal),
  foreign key(run_id,group_id) references run_hierarchy_groups(run_id,group_id) on delete cascade deferrable initially deferred,
  foreign key(run_id,request_id) references run_work_requests(run_id,request_id) on delete cascade deferrable initially deferred,
  check(task_json::jsonb->>'groupId' is not distinct from group_id),
  check(task_json::jsonb->>'digest' is not distinct from task_digest),
  check(task_json::jsonb->'data' is not distinct from task_data_json::jsonb),
  check(task_digest='sha256:' || encode(sha256(convert_to(task_data_json,'UTF8')),'hex')),
  check((failure_execution_id is null)=(failure_result is null)),
  check(failure_result is null or failure_result->>'outcome' in ('failed','canceled'))
);
create table run_hierarchy_refusals (
  refusal_id text primary key,
  run_id text not null references runs(id) on delete cascade,
  source_activation_id text not null,
  source_execution_id text not null,
  source_result_digest text not null,
  code text not null check(code in ('WORK_RUN_EXECUTION_BUDGET_EXHAUSTED','WORK_ROUTE_LIMIT_EXHAUSTED',
    'HIERARCHY_INPUT_TOO_LARGE')),
  relationship_id text,
  result jsonb not null check(result->>'outcome'='failed'),
  created_at timestamptz not null,
  unique(run_id,source_execution_id),
  foreign key(run_id,source_activation_id) references run_work_activations(run_id,activation_id) deferrable initially deferred,
  foreign key(run_id,source_execution_id,source_result_digest)
    references run_work_results(run_id,execution_id,result_digest) deferrable initially deferred,
  check((code='WORK_ROUTE_LIMIT_EXHAUSTED')=(relationship_id is not null)),
  check(result #>> '{error,code}' is not distinct from code)
);
alter table run_hierarchy_group_members add constraint hierarchy_member_refusal
  foreign key(failure_refusal_id) references run_hierarchy_refusals(refusal_id) deferrable initially deferred;

-- Extend the exact legacy constraints; no historical activation is rewritten.
do $$
declare constraint_name text; removed integer := 0;
begin
  for constraint_name in select conname from pg_constraint
    where conrelid='run_work_activations'::regclass and contype='c'
      and (pg_get_constraintdef(oid) like '%cause_kind = ANY%'
        or pg_get_constraintdef(oid) like '%CASE cause_kind%')
  loop
    execute format('alter table run_work_activations drop constraint %I',constraint_name);
    removed := removed+1;
  end loop;
  if removed<>2 then raise exception 'WORK_ACTIVATION_CAUSE_CONSTRAINTS_CHANGED'; end if;
end $$;
alter table run_work_activations add constraint work_activation_cause_kind
  check(cause_kind in ('entry','dependency','join','work_request','work_return','limit_denial','hierarchy_group'));
alter table run_work_activations add constraint work_activation_cause_identity check(
  case cause_kind when 'entry' then cause_id=run_id
    when 'dependency' then cause_id=record #>> '{cause,resolutionId}'
    when 'join' then cause_id=record #>> '{cause,joinId}'
    when 'work_request' then cause_id=record #>> '{cause,requestId}'
    when 'work_return' then cause_id=record #>> '{cause,returnId}'
    when 'limit_denial' then cause_id=record #>> '{cause,denialId}'
    when 'hierarchy_group' then cause_id=record #>> '{cause,groupId}' else false end);

create function assert_hierarchy_group() returns trigger language plpgsql as $$
declare g run_hierarchy_groups%rowtype; parent run_work_activations%rowtype;
  continuation run_work_activations%rowtype; pinned jsonb; members jsonb; source jsonb; selected jsonb; admitted jsonb;
begin
  select * into g from run_hierarchy_groups where run_id=new.run_id and group_id=new.group_id;
  if not found then return null; end if;
  pinned := repeat_pinned_version(g.run_id);
  select * into strict parent from run_work_activations where run_id=g.run_id and activation_id=g.parent_activation_id;
  select * into strict continuation from run_work_activations where run_id=g.run_id and activation_id=g.continuation_activation_id;
  select jsonb_agg(request_id order by ordinal) into members from run_hierarchy_group_members
    where run_id=g.run_id and group_id=g.group_id;
  select result_json::jsonb->'output' into strict source from run_work_results
    where run_id=g.run_id and execution_id=g.parent_execution_id;
  if jsonb_typeof(source)='string' then source := (source #>> '{}')::jsonb;
  elsif source->>'text' is not null and source->'routing' is null then source := (source->>'text')::jsonb; end if;
  if source #>> '{routing,kind}'='delegate' then
    select jsonb_agg(r->>'outcome' order by ordinal) into selected
      from jsonb_array_elements(source #> '{routing,requests}') with ordinality as requests(r,ordinal);
  elsif source #>> '{routing,kind}'='request' then
    selected := jsonb_build_array(source #>> '{routing,outcome}');
  else raise exception 'HIERARCHY_GROUP_SOURCE_CONFLICT'; end if;
  select jsonb_agg(task_json::jsonb->>'outcome' order by ordinal) into admitted
    from run_hierarchy_group_members where run_id=g.run_id and group_id=g.group_id;
  if (select record->>'resultProtocol' from runs where id=g.run_id) is distinct from 'f1-f4-v1'
    or pinned #> '{definition,hierarchy}' is null or g.workflow_version_id<>pinned->>'id'
    or parent.workflow_node_id<>g.parent_node_id or continuation.workflow_node_id<>g.parent_node_id
    or continuation.lineage_id<>parent.lineage_id or continuation.cause_kind<>'hierarchy_group'
    or continuation.cause_id<>g.group_id or g.record->'memberRequestIds' is distinct from members
    or selected is distinct from admitted
    or g.record->>'parentRequestId' is distinct from work_parent_request(g.run_id,parent.activation_id)
    or not exists(select 1 from run_work_results x join harness_executions e on e.id=x.execution_id
      where x.run_id=g.run_id and x.activation_id=g.parent_activation_id and x.execution_id=g.parent_execution_id
        and x.result_digest=g.source_result_digest and e.accepted and e.record->>'state'='completed')
    or exists(select 1 from run_hierarchy_refusals f where f.run_id=g.run_id and f.source_execution_id=g.parent_execution_id)
    then raise exception 'HIERARCHY_GROUP_EVIDENCE_CONFLICT'; end if;
  if g.state in ('ready','continued') and exists(select 1 from run_hierarchy_group_members m
    left join run_work_returns t on t.run_id=m.run_id and t.request_id=m.request_id
    where m.run_id=g.run_id and m.group_id=g.group_id and t.return_id is null and m.failure_execution_id is null)
    then raise exception 'HIERARCHY_GROUP_NOT_SETTLED'; end if;
  return null;
end $$;
create constraint trigger hierarchy_group_evidence after insert or update on run_hierarchy_groups
  deferrable initially deferred for each row execute function assert_hierarchy_group();
create constraint trigger hierarchy_member_group_evidence after insert or update on run_hierarchy_group_members
  deferrable initially deferred for each row execute function assert_hierarchy_group();

create function assert_hierarchy_member() returns trigger language plpgsql as $$
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
      or (new.failure_refusal_id is null and new.failure_result is distinct from coalesce(recorded_failure,failed.record->'result'))
      or (new.failure_refusal_id is not null and not exists(select 1 from run_hierarchy_refusals f
        where f.refusal_id=new.failure_refusal_id and f.run_id=new.run_id and f.source_execution_id=failed.id
          and f.result=new.failure_result))
      or exists(select 1 from run_work_returns where run_id=new.run_id and request_id=new.request_id)
      then raise exception 'HIERARCHY_MEMBER_FAILURE_CONFLICT'; end if;
  end if;
  return null;
end $$;
create constraint trigger hierarchy_member_evidence after insert or update on run_hierarchy_group_members
  deferrable initially deferred for each row execute function assert_hierarchy_member();

create function protect_hierarchy_group_update() returns trigger language plpgsql as $$
begin
  if to_jsonb(new)-'state'-'ready_source_activation_id' is distinct from to_jsonb(old)-'state'-'ready_source_activation_id'
    or old.ready_source_activation_id is not null and new.ready_source_activation_id is distinct from old.ready_source_activation_id
    or new.state<>old.state and not (old.state='waiting' and new.state in ('ready','canceled')
      or old.state='ready' and new.state in ('continued','canceled'))
    then raise exception 'HIERARCHY_GROUP_IMMUTABLE'; end if;
  return new;
end $$;
create trigger hierarchy_group_immutable before update on run_hierarchy_groups
  for each row execute function protect_hierarchy_group_update();
create function protect_hierarchy_member_update() returns trigger language plpgsql as $$
begin
  if to_jsonb(new)-'failure_execution_id'-'failure_result'-'failure_refusal_id'
      is distinct from to_jsonb(old)-'failure_execution_id'-'failure_result'-'failure_refusal_id'
    or old.failure_execution_id is not null and (new.failure_execution_id is distinct from old.failure_execution_id
      or new.failure_result is distinct from old.failure_result or new.failure_refusal_id is distinct from old.failure_refusal_id)
    then raise exception 'HIERARCHY_MEMBER_IMMUTABLE'; end if;
  return new;
end $$;
create trigger hierarchy_member_immutable before update on run_hierarchy_group_members
  for each row execute function protect_hierarchy_member_update();
create trigger hierarchy_refusal_immutable before update on run_hierarchy_refusals
  for each row execute function reject_work_evidence_update();
do $$ declare table_name text;
begin
  foreach table_name in array array['run_hierarchy_groups','run_hierarchy_group_members','run_hierarchy_refusals'] loop
    execute format('create constraint trigger hierarchy_retention after delete on %I deferrable initially deferred
      for each row execute function assert_work_evidence_retention()',table_name);
    execute format('create trigger hierarchy_no_truncate before truncate on %I
      for each statement execute function reject_work_evidence_truncate()',table_name);
  end loop;
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
  if input_record #>> '{work,kind}' not in ('work_return','limit_denial','hierarchy_group') then return null; end if;
  parent_id := work_parent_request(new.run_id,new.work_activation_id);
  if parent_id is not null then
    select record into strict parent_record from run_work_requests where run_id=new.run_id and request_id=parent_id;
  end if;
  if input_record->'parentRequest' is distinct from parent_record then raise exception 'WORK_PARENT_INPUT_CONFLICT'; end if;
  return null;
end $$;

create or replace function work_return_continuation_matches(work_run_id text, continuation_id text, requested_node_id text)
returns boolean language sql stable as $$
  select exists(select 1 from run_work_activations a
    join run_work_returns t on t.run_id=a.run_id and t.return_id=a.cause_id
    join run_work_requests q on q.run_id=t.run_id and q.request_id=t.request_id
    join run_work_activations requester on requester.run_id=q.run_id
      and requester.activation_id=q.requester_activation_id
    where a.run_id=work_run_id and a.activation_id=continuation_id and a.cause_kind='work_return'
      and a.workflow_node_id=requested_node_id and q.requester_node_id=a.workflow_node_id
      and t.requester_continuation_activation_id=a.activation_id and a.lineage_id=requester.lineage_id)
    or exists(select 1 from run_hierarchy_groups g
      join run_work_activations a on a.run_id=g.run_id and a.activation_id=g.continuation_activation_id
      join run_work_activations parent on parent.run_id=g.run_id and parent.activation_id=g.parent_activation_id
      where g.run_id=work_run_id and g.continuation_activation_id=continuation_id
        and g.parent_node_id=requested_node_id and a.workflow_node_id=requested_node_id
        and a.cause_kind='hierarchy_group' and a.cause_id=g.group_id and a.lineage_id=parent.lineage_id);
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
  if exists(select 1 from run_hierarchy_group_members m join run_hierarchy_groups g
    on g.run_id=m.run_id and g.group_id=m.group_id where m.run_id=new.run_id and m.request_id=new.request_id
      and (m.failure_execution_id is not null or new.outcome='needs_changes'
        and g.continuation_activation_id is distinct from new.requester_continuation_activation_id))
    then raise exception 'HIERARCHY_RETURN_GROUP_CONFLICT'; end if;
  if new.outcome='needs_changes' and exists(select 1 from run_work_activations a
    where a.run_id=new.run_id and a.activation_id=new.requester_continuation_activation_id
      and a.cause_kind='hierarchy_group') and not exists(select 1 from run_hierarchy_groups g
        join run_hierarchy_group_members m on m.run_id=g.run_id and m.group_id=g.group_id
        where g.run_id=new.run_id and g.continuation_activation_id=new.requester_continuation_activation_id
          and g.parent_activation_id=work_request.requester_activation_id and m.request_id=new.request_id)
    then raise exception 'HIERARCHY_RETURN_GROUP_CONFLICT'; end if;
  return null;
end $$;

create function hierarchy_result_payload(result jsonb) returns jsonb
language plpgsql immutable as $$
declare payload jsonb := result->'output';
begin
  if jsonb_typeof(payload)='string' then return (payload #>> '{}')::jsonb;
  elsif payload->>'text' is not null and payload->'routing' is null then return (payload->>'text')::jsonb;
  else return payload; end if;
end $$;
create function hierarchy_group_feedback(work_run_id text, work_group_id text) returns jsonb
language sql stable as $$
  select jsonb_build_object('group',g.record,
    'returns',coalesce((select jsonb_agg((jsonb_build_object('requestId',q.request_id,
      'destinationNodeId',q.destination_node_id,'returnId',t.return_id,
      'sourceActivationId',t.source_activation_id,'sourceExecutionId',t.source_execution_id,
      'resultDigest',t.result_digest,'outcome',t.outcome,
      'summary',left(hierarchy_result_payload(x.result_json::jsonb)->>'summary',300),
      'remainingFindingsCount',jsonb_array_length(t.record->'remainingFindings'))
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
