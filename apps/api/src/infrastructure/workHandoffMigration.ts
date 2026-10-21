/** FLOW-02 additive evidence. Old WorkflowVersions, Runs and repeat rows are not rewritten. */
export const workHandoffMigration = { version: 269301, sql: String.raw`
create table run_work_activations (
  activation_id text primary key,
  activation_sequence bigint generated always as identity,
  run_id text not null references runs(id) on delete cascade,
  workflow_version_id text not null references workflow_versions(id),
  workflow_node_id text not null,
  lineage_id text generated always as (record->>'lineageId') stored not null,
  cause_kind text not null check (cause_kind in ('entry','dependency','join','work_request','work_return','limit_denial')),
  cause_id text not null,
  state text not null check (state in ('queued','running','waiting','completed','needs_direction','unknown')),
  input_digest text check (input_digest ~ '^sha256:[0-9a-f]{64}$'),
  record jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (run_id,activation_id),
  unique (run_id,activation_sequence),
  unique (run_id,cause_kind,cause_id),
  check (record->>'activationId' is not distinct from activation_id),
  check (record #>> '{scope,runId}' is not distinct from run_id),
  check (record #>> '{scope,workflowVersionId}' is not distinct from workflow_version_id),
  check (record->>'workflowNodeId' is not distinct from workflow_node_id),
  check (lineage_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  check (record #>> '{cause,kind}' is not distinct from cause_kind),
  check (case cause_kind when 'entry' then cause_id=run_id
    when 'dependency' then cause_id=record #>> '{cause,resolutionId}'
    when 'join' then cause_id=record #>> '{cause,joinId}'
    when 'work_request' then cause_id=record #>> '{cause,requestId}'
    when 'work_return' then cause_id=record #>> '{cause,returnId}'
    else cause_id=record #>> '{cause,denialId}' end)
);
create index run_work_activations_node_recent on run_work_activations(run_id,workflow_node_id,activation_sequence desc);

create table run_work_results (
  execution_id text primary key references harness_executions(id) on delete cascade deferrable initially deferred,
  run_id text not null references runs(id) on delete cascade,
  activation_id text not null,
  result_json text not null check (octet_length(result_json)<=65536),
  result_digest text not null check (result_digest = 'sha256:' || encode(sha256(convert_to(result_json,'UTF8')),'hex')),
  accepted_at timestamptz not null,
  foreign key (run_id,activation_id) references run_work_activations(run_id,activation_id)
    on delete cascade deferrable initially deferred,
  unique (run_id,execution_id,result_digest),
  unique (run_id,activation_id,execution_id,result_digest)
);
create index run_work_results_activation on run_work_results(run_id,activation_id,accepted_at,execution_id);

create table run_work_connection_usage (
  run_id text not null references runs(id) on delete cascade,
  workflow_version_id text not null references workflow_versions(id),
  relationship_id text not null,
  used integer not null default 0 check (used>=0),
  maximum integer check (maximum between 1 and 2147483647),
  primary key (run_id,workflow_version_id,relationship_id),
  check (maximum is null or used<=maximum)
);

create table run_work_requests (
  request_id text primary key,
  run_id text not null,
  workflow_version_id text not null,
  relationship_id text not null,
  ordinal integer not null check (ordinal>0),
  requester_activation_id text not null,
  requester_execution_id text not null references harness_executions(id) on delete cascade deferrable initially deferred,
  destination_activation_id text not null,
  requester_node_id text not null,
  destination_node_id text not null,
  payload_digest text not null check (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  record jsonb not null,
  accepted_at timestamptz not null default clock_timestamp(),
  foreign key (run_id,workflow_version_id,relationship_id)
    references run_work_connection_usage(run_id,workflow_version_id,relationship_id) on delete cascade deferrable initially deferred,
  foreign key (run_id,requester_activation_id)
    references run_work_activations(run_id,activation_id) on delete cascade deferrable initially deferred,
  foreign key (run_id,destination_activation_id)
    references run_work_activations(run_id,activation_id) on delete cascade deferrable initially deferred,
  unique (run_id,request_id),
  unique (run_id,requester_execution_id,relationship_id),
  unique (run_id,workflow_version_id,relationship_id,ordinal),
  check (requester_node_id<>destination_node_id),
  check (record->>'requestId' is not distinct from request_id),
  check (record #>> '{scope,runId}' is not distinct from run_id),
  check (record #>> '{scope,workflowVersionId}' is not distinct from workflow_version_id),
  check (record->>'relationshipId' is not distinct from relationship_id),
  check (record->>'requesterActivationId' is not distinct from requester_activation_id),
  check (record->>'requesterExecutionId' is not distinct from requester_execution_id),
  check (record->>'destinationActivationId' is not distinct from destination_activation_id),
  check (record->>'requesterNodeId' is not distinct from requester_node_id),
  check (record->>'destinationNodeId' is not distinct from destination_node_id),
  check (record->>'payloadDigest' is not distinct from payload_digest),
  check (record->'ordinal' is not distinct from to_jsonb(ordinal))
);
create index run_work_requests_activation on run_work_requests(run_id,requester_activation_id,accepted_at,request_id);

create table run_work_returns (
  return_id text primary key,
  run_id text not null,
  request_id text not null,
  source_activation_id text not null,
  source_execution_id text not null references harness_executions(id) on delete cascade deferrable initially deferred,
  requester_continuation_activation_id text,
  result_digest text not null check (result_digest ~ '^sha256:[0-9a-f]{64}$'),
  outcome text not null check (outcome in ('accepted','needs_changes')),
  record jsonb not null,
  returned_at timestamptz not null default clock_timestamp(),
  foreign key (run_id,request_id) references run_work_requests(run_id,request_id) on delete cascade deferrable initially deferred,
  foreign key (run_id,source_activation_id) references run_work_activations(run_id,activation_id) on delete cascade deferrable initially deferred,
  foreign key (run_id,requester_continuation_activation_id) references run_work_activations(run_id,activation_id) on delete cascade deferrable initially deferred,
  unique (run_id,request_id),
  unique (run_id,requester_continuation_activation_id),
  check (record->>'returnId' is not distinct from return_id),
  check (record #>> '{scope,runId}' is not distinct from run_id),
  check (record->>'requestId' is not distinct from request_id),
  check (record->>'sourceActivationId' is not distinct from source_activation_id),
  check (record->>'sourceExecutionId' is not distinct from source_execution_id),
  check (record->>'continuationActivationId' is not distinct from requester_continuation_activation_id),
  check (record->>'acceptedResultDigest' is not distinct from result_digest),
  check (record->>'outcome' is not distinct from outcome),
  check ((outcome='needs_changes') = (requester_continuation_activation_id is not null))
);

create table run_work_denials (
  denial_id text primary key,
  run_id text not null,
  request_id text not null,
  workflow_version_id text not null,
  relationship_id text not null,
  requester_activation_id text not null,
  requester_execution_id text not null references harness_executions(id) on delete cascade deferrable initially deferred,
  payload_digest text not null check (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  record jsonb not null,
  denied_at timestamptz not null default clock_timestamp(),
  foreign key (run_id,workflow_version_id,relationship_id)
    references run_work_connection_usage(run_id,workflow_version_id,relationship_id) on delete cascade deferrable initially deferred,
  foreign key (run_id,requester_activation_id)
    references run_work_activations(run_id,activation_id) on delete cascade deferrable initially deferred,
  unique (run_id,request_id),
  unique (run_id,requester_execution_id,relationship_id),
  check (record->>'denialId' is not distinct from denial_id),
  check (record #>> '{scope,runId}' is not distinct from run_id),
  check (record->>'requestId' is not distinct from request_id),
  check (record->>'relationshipId' is not distinct from relationship_id),
  check (record->>'requesterExecutionId' is not distinct from requester_execution_id),
  check (record->>'payloadDigest' is not distinct from payload_digest)
);

-- The old no-occurrence uniqueness remains exact for old Runs. New activations
-- get an independent attempt namespace; they cannot alias a repeat occurrence.
alter table harness_executions add column work_activation_id text;
alter table harness_executions add constraint work_execution_activation_fk
  foreign key (run_id,work_activation_id) references run_work_activations(run_id,activation_id)
  deferrable initially deferred;
alter table harness_executions add constraint work_execution_not_repeat
  check (work_activation_id is null or repeat_occurrence_id is null);
drop index harness_executions_legacy_attempt;
create unique index harness_executions_legacy_attempt on harness_executions(run_id,workflow_node_id,attempt)
  where repeat_occurrence_id is null and work_activation_id is null;
create unique index harness_executions_work_attempt on harness_executions(run_id,work_activation_id,workflow_node_id,attempt)
  where work_activation_id is not null;

-- The same native receipt/launch implementation can now bind its existing
-- slot and technical-attempt rows to a work activation. Old outside slots keep
-- their one-per-(Run,node) uniqueness and exact historical JSON/keys.
alter table run_repeat_slots add column work_activation_id text;
alter table run_repeat_slots add constraint work_slot_activation_fk
  foreign key (run_id,work_activation_id) references run_work_activations(run_id,activation_id)
  deferrable initially deferred;
alter table run_repeat_slots add constraint work_slot_not_repeat
  check (work_activation_id is null or occurrence_id is null);
drop index run_repeat_slots_outside;
create unique index run_repeat_slots_outside on run_repeat_slots(run_id,workflow_node_id)
  where occurrence_id is null and work_activation_id is null;
create unique index run_repeat_slots_work on run_repeat_slots(run_id,work_activation_id,workflow_node_id)
  where work_activation_id is not null;
alter table run_repeat_executions add column work_activation_id text;
alter table run_repeat_executions add constraint work_attempt_activation_fk
  foreign key (run_id,work_activation_id) references run_work_activations(run_id,activation_id)
  deferrable initially deferred;
alter table run_repeat_executions add constraint work_attempt_not_repeat
  check (work_activation_id is null or occurrence_id is null);
create index run_repeat_executions_work_recent on run_repeat_executions(run_id,workflow_node_id,work_activation_id,technical_attempt desc)
  where work_activation_id is not null;

create function assert_work_slot_identity() returns trigger language plpgsql as $$
declare pinned jsonb; activation run_work_activations%rowtype; request run_work_requests%rowtype;
  returned run_work_returns%rowtype; source_result jsonb; work_input jsonb; joined jsonb; expected integer;
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
    if returned.run_id<>new.run_id or returned.requester_continuation_activation_id<>activation.activation_id
      or work_input->'returned' is distinct from returned.record
      or work_input->'acceptedSourceResult' is distinct from source_result then
      raise exception 'WORK_SLOT_INPUT_CONFLICT'; end if;
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
create constraint trigger work_slot_identity after insert on run_repeat_slots
  deferrable initially deferred for each row execute function assert_work_slot_identity();

create function assert_work_attempt_identity() returns trigger language plpgsql as $$
declare slot run_repeat_slots%rowtype; native harness_executions%rowtype; pinned jsonb;
begin
  if not exists(select 1 from run_repeat_executions where execution_id=new.execution_id) then return null; end if;
  select * into strict slot from run_repeat_slots where slot_id=new.slot_id;
  select * into strict native from harness_executions where id=new.execution_id;
  pinned := repeat_pinned_version(new.run_id);
  if pinned #> '{definition,handoffs}' is distinct from '{"contractVersion":1}'::jsonb then
    if new.work_activation_id is not null then raise exception 'WORK_ATTEMPT_ON_OLD_RUN'; end if;
    return null;
  end if;
  if new.work_activation_id is null or new.occurrence_id is not null
    or new.work_activation_id<>slot.work_activation_id or new.work_activation_id<>native.work_activation_id
    or new.run_id<>slot.run_id or new.run_id<>native.run_id then
    raise exception 'WORK_ATTEMPT_ACTIVATION_CONFLICT'; end if;
  return null;
end $$;
create constraint trigger work_attempt_identity after insert on run_repeat_executions
  deferrable initially deferred for each row execute function assert_work_attempt_identity();

create function protect_work_activation_identity() returns trigger language plpgsql as $$
begin
  if new.work_activation_id is distinct from old.work_activation_id then
    raise exception 'WORK_ACTIVATION_IDENTITY_IMMUTABLE';
  end if;
  return new;
end $$;
create trigger work_activation_native_identity before update on harness_executions
  for each row execute function protect_work_activation_identity();

create function assert_work_handoff_scope() returns trigger language plpgsql as $$
declare pinned jsonb; work_edge jsonb; current_usage run_work_connection_usage%rowtype; actual integer;
begin
  if not exists(select 1 from runs where id=new.run_id) then return null; end if;
  pinned := repeat_pinned_version(new.run_id);
  if pinned #> '{definition,handoffs}' is distinct from '{"contractVersion":1}'::jsonb
    or pinned #> '{definition,repeat}' is not null then raise exception 'WORK_POLICY_PIN_CONFLICT'; end if;
  if tg_table_name='run_work_activations' then
    if new.workflow_version_id is distinct from pinned->>'id'
      or (select count(*) from jsonb_array_elements(pinned #> '{definition,nodes}') n
        where n->>'id'=new.workflow_node_id)<>1 then raise exception 'WORK_ACTIVATION_SCOPE_CONFLICT'; end if;
    if new.cause_kind='entry' and (new.workflow_node_id<>pinned->>'entryNodeId'
      or new.lineage_id<>new.run_id) then raise exception 'WORK_ENTRY_PIN_CONFLICT'; end if;
  elsif tg_table_name='run_work_connection_usage' then
    select * into strict current_usage from run_work_connection_usage
      where run_id=new.run_id and workflow_version_id=new.workflow_version_id and relationship_id=new.relationship_id;
    select value into strict work_edge from jsonb_array_elements(pinned #> '{definition,edges}') e
      where e->>'id'=new.relationship_id and e->>'kind'='execution';
    if new.workflow_version_id is distinct from pinned->>'id'
      or current_usage.maximum is distinct from (work_edge->>'maxWorkHandoffsPerRun')::integer then
      raise exception 'WORK_CONNECTION_PIN_CONFLICT'; end if;
    select count(*) into actual from run_work_requests
      where run_id=new.run_id and workflow_version_id=new.workflow_version_id and relationship_id=new.relationship_id;
    if actual<>current_usage.used then raise exception 'WORK_COUNTER_EVIDENCE_CONFLICT'; end if;
  end if;
  return null;
end $$;
create constraint trigger work_activation_scope after insert or update on run_work_activations
  deferrable initially deferred for each row execute function assert_work_handoff_scope();
create constraint trigger work_usage_scope after insert or update on run_work_connection_usage
  deferrable initially deferred for each row execute function assert_work_handoff_scope();

create function assert_work_request() returns trigger language plpgsql as $$
declare pinned jsonb; work_edge jsonb; current_usage run_work_connection_usage%rowtype;
  source_activation run_work_activations%rowtype; destination_activation run_work_activations%rowtype;
  source_execution harness_executions%rowtype; accepted_digest text;
begin
  if not exists(select 1 from run_work_requests where request_id=new.request_id) then return null; end if;
  pinned := repeat_pinned_version(new.run_id);
  if pinned #> '{definition,handoffs}' is distinct from '{"contractVersion":1}'::jsonb
    or new.workflow_version_id is distinct from pinned->>'id' then raise exception 'WORK_POLICY_PIN_CONFLICT'; end if;
  select * into strict current_usage from run_work_connection_usage
    where run_id=new.run_id and workflow_version_id=new.workflow_version_id and relationship_id=new.relationship_id;
  select value into strict work_edge from jsonb_array_elements(pinned #> '{definition,edges}') e
    where e->>'id'=new.relationship_id and e->>'kind'='execution';
  if not ((work_edge->>'source'=new.requester_node_id and work_edge->>'target'=new.destination_node_id)
      or (work_edge->>'workRequestDirection'='both' and work_edge->>'target'=new.requester_node_id
        and work_edge->>'source'=new.destination_node_id))
    or new.ordinal>current_usage.used or current_usage.maximum is not null and new.ordinal>current_usage.maximum then
    raise exception 'WORK_REQUEST_ROUTE_OR_QUOTA_CONFLICT'; end if;
  select * into strict source_activation from run_work_activations where activation_id=new.requester_activation_id;
  select * into strict destination_activation from run_work_activations where activation_id=new.destination_activation_id;
  select * into strict source_execution from harness_executions where id=new.requester_execution_id;
  select result_digest into strict accepted_digest from run_work_results
    where run_id=new.run_id and execution_id=new.requester_execution_id
      and activation_id=new.requester_activation_id;
  if source_activation.run_id<>new.run_id or source_activation.workflow_node_id<>new.requester_node_id
    or source_execution.run_id<>new.run_id or source_execution.work_activation_id<>new.requester_activation_id
    or source_execution.workflow_node_id<>new.requester_node_id or not source_execution.accepted
    or source_execution.record->>'state'<>'completed'
    or accepted_digest<>new.payload_digest
    or destination_activation.run_id<>new.run_id or destination_activation.workflow_node_id<>new.destination_node_id
    or destination_activation.lineage_id<>source_activation.lineage_id
    or not (destination_activation.cause_kind='work_request' and destination_activation.cause_id=new.request_id
      or destination_activation.cause_kind='join'
        and destination_activation.cause_id=destination_activation.activation_id) then
    raise exception 'WORK_REQUEST_ANCESTRY_CONFLICT'; end if;
  if (select count(*) from run_work_requests where run_id=new.run_id
      and workflow_version_id=new.workflow_version_id and relationship_id=new.relationship_id)<>current_usage.used then
    raise exception 'WORK_COUNTER_EVIDENCE_CONFLICT'; end if;
  return null;
end $$;
create constraint trigger work_request_evidence after insert on run_work_requests
  deferrable initially deferred for each row execute function assert_work_request();

create function assert_work_return() returns trigger language plpgsql as $$
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
  if new.run_id<>work_request.run_id or new.source_activation_id<>work_request.destination_activation_id
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
create constraint trigger work_return_evidence after insert on run_work_returns
  deferrable initially deferred for each row execute function assert_work_return();

create function assert_work_denial() returns trigger language plpgsql as $$
declare usage run_work_connection_usage%rowtype; pinned jsonb; work_edge jsonb;
  source_activation run_work_activations%rowtype; source_execution harness_executions%rowtype;
  accepted_digest text;
begin
  if not exists(select 1 from run_work_denials where denial_id=new.denial_id) then return null; end if;
  pinned := repeat_pinned_version(new.run_id);
  select * into strict usage from run_work_connection_usage
    where run_id=new.run_id and workflow_version_id=new.workflow_version_id and relationship_id=new.relationship_id;
  select value into strict work_edge from jsonb_array_elements(pinned #> '{definition,edges}') e
    where e->>'id'=new.relationship_id and e->>'kind'='execution';
  select * into strict source_activation from run_work_activations where activation_id=new.requester_activation_id;
  select * into strict source_execution from harness_executions where id=new.requester_execution_id;
  select result_digest into strict accepted_digest from run_work_results
    where run_id=new.run_id and execution_id=new.requester_execution_id and activation_id=new.requester_activation_id;
  if pinned #> '{definition,handoffs}' is distinct from '{"contractVersion":1}'::jsonb
    or usage.maximum is null or usage.used<>usage.maximum
    or new.record->'used' is distinct from to_jsonb(usage.used)
    or new.record->'maxWorkHandoffsPerRun' is distinct from to_jsonb(usage.maximum)
    or new.workflow_version_id<>pinned->>'id' or source_activation.run_id<>new.run_id
    or source_execution.run_id<>new.run_id or source_execution.work_activation_id<>new.requester_activation_id
    or not source_execution.accepted or accepted_digest<>new.payload_digest
    or new.record->>'requesterActivationId' is distinct from new.requester_activation_id
    or new.record->>'destinationNodeId' is distinct from
      (case when work_edge->>'source'=source_activation.workflow_node_id then work_edge->>'target'
        when work_edge->>'workRequestDirection'='both' and work_edge->>'target'=source_activation.workflow_node_id
          then work_edge->>'source' else null end)
    or exists(select 1 from run_work_requests where request_id=new.request_id
      or (run_id=new.run_id and requester_execution_id=new.requester_execution_id
        and relationship_id=new.relationship_id)) then
    raise exception 'WORK_DENIAL_ANCESTRY_CONFLICT'; end if;
  return null;
end $$;
create constraint trigger work_denial_evidence after insert on run_work_denials
  deferrable initially deferred for each row execute function assert_work_denial();

create function assert_work_native_activation() returns trigger language plpgsql as $$
declare pinned jsonb; activation run_work_activations%rowtype; semantics smallint;
begin
  if not exists(select 1 from harness_executions where id=new.id) then return null; end if;
  select v.execution_semantics_version into strict semantics from runs r
    join workflow_versions v on v.id=r.workflow_version_id where r.id=new.run_id;
  if semantics<>3 then
    if new.work_activation_id is not null then raise exception 'WORK_ACTIVATION_ON_OLD_RUN'; end if;
    return null;
  end if;
  pinned := repeat_pinned_version(new.run_id);
  if pinned #> '{definition,handoffs}' is distinct from '{"contractVersion":1}'::jsonb then
    if new.work_activation_id is not null then raise exception 'WORK_ACTIVATION_ON_OLD_RUN'; end if;
    return null;
  end if;
  if new.work_activation_id is null or new.repeat_occurrence_id is not null then
    raise exception 'WORK_NATIVE_ACTIVATION_REQUIRED'; end if;
  select * into strict activation from run_work_activations where activation_id=new.work_activation_id;
  if activation.run_id<>new.run_id or activation.workflow_node_id<>new.workflow_node_id
    or activation.workflow_version_id<>pinned->>'id' then raise exception 'WORK_NATIVE_ACTIVATION_CONFLICT'; end if;
  return null;
end $$;
create constraint trigger work_native_activation after insert or update on harness_executions
  deferrable initially deferred for each row execute function assert_work_native_activation();

create function assert_work_accepted_result() returns trigger language plpgsql as $$
declare native harness_executions%rowtype; activation run_work_activations%rowtype;
begin
  if not exists(select 1 from run_work_results where execution_id=new.execution_id) then return null; end if;
  select * into strict native from harness_executions where id=new.execution_id;
  select * into strict activation from run_work_activations where activation_id=new.activation_id;
  if native.run_id<>new.run_id or native.work_activation_id<>new.activation_id
    or activation.run_id<>new.run_id or activation.workflow_node_id<>native.workflow_node_id
    or not native.accepted or native.record->>'state' is distinct from 'completed'
    or native.record->'result' is distinct from new.result_json::jsonb then
    raise exception 'WORK_RESULT_NOT_ACCEPTED'; end if;
  return null;
end $$;
create constraint trigger work_accepted_result after insert on run_work_results
  deferrable initially deferred for each row execute function assert_work_accepted_result();

create function protect_work_activation_update() returns trigger language plpgsql as $$
begin
  if new.activation_id is distinct from old.activation_id or new.run_id is distinct from old.run_id
    or new.workflow_version_id is distinct from old.workflow_version_id
    or new.workflow_node_id is distinct from old.workflow_node_id
    or new.cause_kind is distinct from old.cause_kind or new.cause_id is distinct from old.cause_id
    or new.record is distinct from old.record or new.created_at is distinct from old.created_at
    or old.state='completed' and new.state<>'completed'
    or old.state<>'queued' and new.state='queued' and old.state<>'waiting' then
    raise exception 'WORK_ACTIVATION_IMMUTABLE'; end if;
  return new;
end $$;
create trigger work_activation_update before update on run_work_activations
  for each row execute function protect_work_activation_update();

create function protect_work_usage_update() returns trigger language plpgsql as $$
begin
  if new.run_id is distinct from old.run_id or new.workflow_version_id is distinct from old.workflow_version_id
    or new.relationship_id is distinct from old.relationship_id or new.maximum is distinct from old.maximum
    or new.used<old.used then raise exception 'WORK_COUNTER_IMMUTABLE'; end if;
  return new;
end $$;
create trigger work_usage_update before update on run_work_connection_usage
  for each row execute function protect_work_usage_update();

create function reject_work_evidence_update() returns trigger language plpgsql as $$
begin raise exception 'WORK_EVIDENCE_IMMUTABLE'; end $$;
create function assert_work_evidence_retention() returns trigger language plpgsql as $$
begin
  if exists(select 1 from runs where id=old.run_id) then raise exception 'WORK_RETAIN_WITH_RUN'; end if;
  return null;
end $$;
create function reject_work_evidence_truncate() returns trigger language plpgsql as $$
begin raise exception 'WORK_TRUNCATE_FORBIDDEN_USE_RUN_RETENTION'; end $$;
do $$ declare name text; begin
  foreach name in array array['run_work_activations','run_work_results','run_work_connection_usage',
    'run_work_requests','run_work_returns','run_work_denials'] loop
    execute format('create constraint trigger work_retention after delete on %I deferrable initially deferred
      for each row execute function assert_work_evidence_retention()',name);
    execute format('create trigger work_no_truncate before truncate on %I
      for each statement execute function reject_work_evidence_truncate()',name);
  end loop;
  foreach name in array array['run_work_results','run_work_requests','run_work_returns','run_work_denials'] loop
    execute format('create trigger work_no_update before update on %I
      for each row execute function reject_work_evidence_update()',name);
  end loop;
end $$;
` } as const
