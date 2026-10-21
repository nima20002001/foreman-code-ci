/** FLOW-03 notice outbox. The application deploys this with FLOW-02 before any
 * marked Run is admitted; historical ordinary/repeat Runs are untouched. */
export const workNoticeMigration = { version: 269401, sql: String.raw`
create table run_work_notices (
  notice_id text primary key,
  run_id text not null references runs(id) on delete cascade,
  workflow_version_id text not null references workflow_versions(id),
  requester_activation_id text not null,
  continuation_activation_id text not null,
  cause_kind text not null check (cause_kind in ('last_return','limit_denial')),
  cause_id text not null,
  relationship_id text not null,
  destination_node_id text not null,
  used integer not null check (used>0),
  maximum integer not null check (maximum>0 and used=maximum),
  delivery_state text not null check (delivery_state in ('queued','pending','delivered','unknown','failed')),
  acknowledgement_execution_id text references harness_executions(id) deferrable initially deferred,
  revision integer not null default 0 check (revision>=0),
  record jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  foreign key (run_id,requester_activation_id) references run_work_activations(run_id,activation_id)
    on delete cascade deferrable initially deferred,
  foreign key (run_id,continuation_activation_id) references run_work_activations(run_id,activation_id)
    on delete cascade deferrable initially deferred,
  unique (run_id,cause_kind,cause_id),
  unique (run_id,continuation_activation_id),
  check ((delivery_state='delivered')=(acknowledgement_execution_id is not null)),
  check (record->>'noticeId' is not distinct from notice_id),
  check (record #>> '{scope,runId}' is not distinct from run_id),
  check (record #>> '{scope,workflowVersionId}' is not distinct from workflow_version_id),
  check (record->>'requesterActivationId' is not distinct from requester_activation_id),
  check (record->>'continuationActivationId' is not distinct from continuation_activation_id),
  check (record #>> '{cause,kind}' is not distinct from cause_kind),
  check (case cause_kind when 'last_return' then record #>> '{cause,returnId}' else record #>> '{cause,denialId}' end
    is not distinct from cause_id),
  check (record->>'relationshipId' is not distinct from relationship_id),
  check (record->>'destinationNodeId' is not distinct from destination_node_id),
  check (record->'used' is not distinct from to_jsonb(used)),
  check (record->'maxWorkHandoffsPerRun' is not distinct from to_jsonb(maximum)),
  check (record->>'delivery' is not distinct from delivery_state),
  check (record->>'acknowledgementId' is not distinct from acknowledgement_execution_id),
  check (record->>'createdAt' is not distinct from to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  check (record->>'updatedAt' is not distinct from to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  check (octet_length(record::text)<=65536)
);
create index run_work_notices_run_state on run_work_notices(run_id,delivery_state,created_at,notice_id);

create table run_work_unresolved (
  unresolved_id text primary key,
  run_id text not null references runs(id) on delete cascade,
  activation_id text not null,
  execution_id text not null,
  result_digest text not null check (result_digest ~ '^sha256:[0-9a-f]{64}$'),
  reason text not null check (reason in ('finish_with_findings','repeated_exhausted_route')),
  relationship_id text,
  created_at timestamptz not null,
  foreign key (run_id,activation_id,execution_id,result_digest)
    references run_work_results(run_id,activation_id,execution_id,result_digest)
    on delete cascade deferrable initially deferred,
  unique (run_id,execution_id),
  check ((reason='repeated_exhausted_route')=(relationship_id is not null))
);
create index run_work_unresolved_run on run_work_unresolved(run_id,created_at,unresolved_id);
create function assert_work_unresolved() returns trigger language plpgsql as $$
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
      or jsonb_typeof(payload #> '{data,remainingFindings}') is distinct from 'array'
      or jsonb_array_length(payload #> '{data,remainingFindings}')=0 then
      raise exception 'WORK_UNRESOLVED_FINISH_CONFLICT'; end if;
  else
    pinned := repeat_pinned_version(new.run_id);
    select value into strict node from jsonb_array_elements(pinned #> '{definition,nodes}') n
      where n->>'id'=activation.workflow_node_id;
    if payload #>> '{routing,kind}' is distinct from 'request'
      or not exists(select 1 from jsonb_array_elements(node #> '{choice,outcomes}') c
        where c->>'outcome'=payload #>> '{routing,outcome}'
          and c #>> '{target,kind}'='edge' and c #>> '{target,relationshipId}'=new.relationship_id)
      or not exists(select 1 from run_work_denials d join run_work_activations a
        on a.run_id=d.run_id and a.activation_id=d.requester_activation_id
        where d.run_id=new.run_id and d.relationship_id=new.relationship_id
          and a.lineage_id=activation.lineage_id) then
      raise exception 'WORK_UNRESOLVED_DENIAL_CONFLICT'; end if;
  end if;
  return null;
end $$;
create constraint trigger work_unresolved_evidence after insert on run_work_unresolved
  deferrable initially deferred for each row execute function assert_work_unresolved();
create function protect_work_unresolved() returns trigger language plpgsql as $$
begin raise exception 'WORK_UNRESOLVED_IMMUTABLE'; end $$;
create trigger work_unresolved_no_update before update on run_work_unresolved
  for each row execute function protect_work_unresolved();

create table run_work_direction_waits (
  run_id text primary key references runs(id) on delete cascade,
  workflow_version_id text not null references workflow_versions(id),
  unresolved_ids jsonb not null check (jsonb_typeof(unresolved_ids)='array'
    and jsonb_array_length(unresolved_ids)>0 and jsonb_array_length(unresolved_ids)<=1000),
  created_at timestamptz not null
);
create function assert_work_direction_wait() returns trigger language plpgsql as $$
declare pinned jsonb; ids jsonb;
begin
  if not exists(select 1 from run_work_direction_waits where run_id=new.run_id) then return null; end if;
  pinned := repeat_pinned_version(new.run_id);
  select coalesce(jsonb_agg(unresolved_id order by unresolved_id),'[]'::jsonb) into ids
    from run_work_unresolved where run_id=new.run_id;
  if pinned->>'id' is distinct from new.workflow_version_id
    or pinned #> '{definition,handoffs}' is distinct from '{"contractVersion":1}'::jsonb
    or ids is distinct from new.unresolved_ids
    or not exists(select 1 from runs where id=new.run_id and execution_state='waiting'
      and record->>'executionState'='waiting' and record->>'outcome'='pending'
      and stop_requested_at is null) then raise exception 'WORK_DIRECTION_WAIT_CONFLICT'; end if;
  return null;
end $$;
create constraint trigger work_direction_wait_evidence after insert on run_work_direction_waits
  deferrable initially deferred for each row execute function assert_work_direction_wait();
create trigger work_direction_wait_no_update before update on run_work_direction_waits
  for each row execute function protect_work_unresolved();

create function assert_work_notice_scope() returns trigger language plpgsql as $$
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
    or continuation.lineage_id<>requester.lineage_id
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
      or continuation.cause_kind<>'work_return' or continuation.cause_id<>new.cause_id
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
        or options='[]'::jsonb or alternative->'outcomes' is distinct from options
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
create constraint trigger work_notice_scope after insert or update on run_work_notices
  deferrable initially deferred for each row execute function assert_work_notice_scope();

create function protect_work_notice_update() returns trigger language plpgsql as $$
begin
  if new.notice_id is distinct from old.notice_id or new.run_id is distinct from old.run_id
    or new.workflow_version_id is distinct from old.workflow_version_id
    or new.requester_activation_id is distinct from old.requester_activation_id
    or new.continuation_activation_id is distinct from old.continuation_activation_id
    or new.cause_kind is distinct from old.cause_kind or new.cause_id is distinct from old.cause_id
    or new.relationship_id is distinct from old.relationship_id
    or new.destination_node_id is distinct from old.destination_node_id
    or new.used is distinct from old.used or new.maximum is distinct from old.maximum
    or new.created_at is distinct from old.created_at or new.revision<>old.revision+1
    or (new.record - array['delivery','acknowledgementId','updatedAt'])
       is distinct from (old.record - array['delivery','acknowledgementId','updatedAt'])
    or (old.delivery_state='delivered' and new.delivery_state<>'delivered')
    or (old.delivery_state='queued' and new.delivery_state not in ('pending','unknown','failed'))
    or (old.delivery_state='pending' and new.delivery_state not in ('delivered','unknown','failed'))
    or (old.delivery_state='unknown' and new.delivery_state not in ('delivered','failed'))
    or (old.delivery_state='failed' and new.delivery_state<>'failed') then
    raise exception 'WORK_NOTICE_IDENTITY_IMMUTABLE'; end if;
  return new;
end $$;
create trigger work_notice_update before update on run_work_notices
  for each row execute function protect_work_notice_update();

create function require_work_notice() returns trigger language plpgsql as $$
declare request run_work_requests%rowtype; usage run_work_connection_usage%rowtype;
begin
  if tg_table_name='run_work_denials' then
    if exists(select 1 from run_work_denials where denial_id=new.denial_id)
      and not exists(select 1 from run_work_notices where run_id=new.run_id
        and cause_kind='limit_denial' and cause_id=new.denial_id) then
      raise exception 'WORK_DENIAL_NOTICE_MISSING'; end if;
  elsif tg_table_name='run_work_returns' and new.outcome='needs_changes' then
    select * into strict request from run_work_requests where request_id=new.request_id;
    select * into strict usage from run_work_connection_usage
      where run_id=new.run_id and relationship_id=request.relationship_id;
    if usage.maximum is not null and usage.used=usage.maximum
      and not exists(select 1 from run_work_notices where run_id=new.run_id
        and cause_kind='last_return' and cause_id=new.return_id) then
      raise exception 'WORK_LAST_RETURN_NOTICE_MISSING'; end if;
  end if;
  return null;
end $$;
create constraint trigger work_denial_notice after insert on run_work_denials
  deferrable initially deferred for each row execute function require_work_notice();
create constraint trigger work_last_return_notice after insert on run_work_returns
  deferrable initially deferred for each row execute function require_work_notice();

-- Preserve the old slot checks while accepting a new limit-denial activation.
-- Delivery revisions never alter the queued notice snapshot frozen into native input.
create function assert_frozen_work_notice(input_notice jsonb, current_notice jsonb)
  returns void language plpgsql as $$
begin
  if input_notice is null or current_notice is null
    or (input_notice - array['delivery','acknowledgementId','updatedAt'])
      is distinct from (current_notice - array['delivery','acknowledgementId','updatedAt'])
    or input_notice->>'delivery'<>'queued'
    or input_notice->>'acknowledgementId' is not null
    or input_notice->>'updatedAt' is distinct from current_notice->>'createdAt' then
    raise exception 'WORK_NOTICE_INPUT_CONFLICT'; end if;
end $$;
create or replace function assert_work_slot_identity() returns trigger language plpgsql as $$
declare pinned jsonb; activation run_work_activations%rowtype; request run_work_requests%rowtype;
  returned run_work_returns%rowtype; denial run_work_denials%rowtype;
  source_result jsonb; work_input jsonb; joined jsonb; expected integer; notice jsonb;
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
    select count(*) into expected from jsonb_array_elements(pinned #> '{definition,edges}') e
      where e->>'kind'='execution' and e->>'target'=new.workflow_node_id;
    if activation.state<>'queued' or expected<2 or jsonb_array_length(joined)<>expected
      or (select count(distinct r.relationship_id) from run_work_requests r
        where r.run_id=new.run_id and r.destination_activation_id=new.work_activation_id)<>expected
      or work_input->'sources' is distinct from joined then
      raise exception 'WORK_JOIN_INPUT_CONFLICT'; end if;
  else
    raise exception 'WORK_SLOT_CAUSE_UNSUPPORTED';
  end if;
  return null;
end $$;

create function retain_work_notice() returns trigger language plpgsql as $$
begin
  if exists(select 1 from runs where id=old.run_id) then raise exception 'WORK_NOTICE_RETAIN_WITH_RUN'; end if;
  return null;
end $$;
create constraint trigger work_notice_retention after delete on run_work_notices
  deferrable initially deferred for each row execute function retain_work_notice();
create constraint trigger work_unresolved_retention after delete on run_work_unresolved
  deferrable initially deferred for each row execute function retain_work_notice();
create constraint trigger work_direction_wait_retention after delete on run_work_direction_waits
  deferrable initially deferred for each row execute function retain_work_notice();
` } as const
