/** Saved hierarchy facts authorize its work transitions independently of structured board-result effects. */
export const hierarchyAdmissionMigration = { version: 2026102114, sql: String.raw`
create or replace function assert_hierarchy_group() returns trigger language plpgsql as $$
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
  if pinned #> '{definition,hierarchy}' is null or g.workflow_version_id<>pinned->>'id'
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

create or replace function assert_hierarchy_direction() returns trigger language plpgsql as $$
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
  if pinned->>'id' is distinct from d.workflow_version_id
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

create or replace function assert_hierarchy_refusal_source() returns trigger language plpgsql as $$
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
    if source.run_id<>f.run_id or source.work_activation_id<>f.source_activation_id or source.accepted
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
` }
