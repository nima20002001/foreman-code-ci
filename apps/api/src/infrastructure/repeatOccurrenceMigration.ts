/** ENG-04 migration successor, PostgreSQL 17. First registration of the previously
 * unregistered A proposal; applied migrations and historical JSON stay untouched.
 * Registry retry is idempotent. Raw SQL deliberately fails on schema drift or a
 * second direct application. Apply only in the registry's ordinary transaction.
 * REQUIRED co-integration: legacy ensureExecution's partial-index predicate; see
 * the migration handoff. This DDL is not permission to admit or launch v3 work. */
export const repeatOccurrenceMigrationSql = String.raw`

-- Compare ONLY the two known semantics checks, using PostgreSQL's own expression
-- renderer rather than a guessed smallint/ANY pretty-print. Fail closed on drift.
create temporary table eng04_migration_expected_checks (
  execution_semantics_version smallint not null,
  record jsonb not null,
  constraint eng04_membership check (execution_semantics_version in (1,2)),
  constraint eng04_record_pin check
    (execution_semantics_version=coalesce((record->>'executionSemanticsVersion')::smallint,1))
) on commit drop;
do $$ begin
  if (select pg_get_expr(conbin,conrelid) from pg_constraint
      where conrelid='workflow_versions'::regclass and contype='c' and convalidated
        and conname='workflow_versions_execution_semantics_version_check')
    is distinct from
    (select pg_get_expr(conbin,conrelid) from pg_constraint
      where conrelid='eng04_migration_expected_checks'::regclass and conname='eng04_membership')
    or (select pg_get_expr(conbin,conrelid) from pg_constraint
      where conrelid='workflow_versions'::regclass and contype='c' and convalidated
        and conname='run_graph_semantics_pin_matches_record')
    is distinct from
    (select pg_get_expr(conbin,conrelid) from pg_constraint
      where conrelid='eng04_migration_expected_checks'::regclass and conname='eng04_record_pin') then
    raise exception 'REPEAT_SEMANTICS_CONSTRAINT_DRIFT';
  end if;
end $$;
drop table eng04_migration_expected_checks;
alter table workflow_versions drop constraint workflow_versions_execution_semantics_version_check;
alter table workflow_versions add constraint workflow_versions_execution_semantics_version_check
  check (execution_semantics_version in (1,2,3));
-- Keep run_graph_semantics_pin_matches_record unchanged. Add strict v3-only
-- agreement without imposing new shape requirements on legacy saved versions.
alter table workflow_versions add constraint repeat_version_record_pin check
  (execution_semantics_version<>3 or ((record->'executionSemanticsVersion'='3'::jsonb
    and record #> '{definition,executionSemanticsVersion}'='3'::jsonb
    and record->>'id'=id and record->>'workspaceId'=workspace_id and record->>'workflowId'=workflow_id
    and record #> '{definition,repeat,contractVersion}'='1'::jsonb
    and jsonb_typeof(record #> '{definition,repeat,blocks}')='array') is true));

create table run_repeat_occurrences (
  occurrence_id text primary key check (occurrence_id<>''),
  run_id text not null references runs(id) on delete cascade deferrable initially deferred,
  workspace_id text not null references workspaces(id) deferrable initially deferred,
  workflow_id text not null references workflows(id) deferrable initially deferred,
  workflow_version_id text not null references workflow_versions(id) deferrable initially deferred,
  block_id text not null,
  occurrence_index integer not null check (occurrence_index > 0),
  binding_id text not null unique,
  input_json text not null check (octet_length(input_json) <= 4194304),
  input_digest text not null check (input_digest = 'sha256:' || encode(sha256(convert_to(input_json,'UTF8')),'hex')),
  previous_occurrence_id text,
  previous_occurrence_index integer,
  previous_decision_id text,
  previous_result_digest text,
  record jsonb not null,
  unique (run_id,workflow_version_id,block_id,occurrence_index),
  unique (occurrence_id,run_id),
  unique (occurrence_id,run_id,workflow_version_id,block_id,occurrence_index),
  foreign key (previous_occurrence_id,run_id,workflow_version_id,block_id,previous_occurrence_index)
    references run_repeat_occurrences(occurrence_id,run_id,workflow_version_id,block_id,occurrence_index) deferrable initially deferred,
  check ((occurrence_index=1 and previous_occurrence_id is null and previous_occurrence_index is null
    and previous_decision_id is null and previous_result_digest is null)
    or (occurrence_index>1 and previous_occurrence_id is not null and previous_occurrence_index is not null and previous_occurrence_index=occurrence_index-1
    and previous_decision_id is not null and previous_result_digest is not null)),
  check (record->'contractVersion' is not distinct from '1'::jsonb),
  check ((jsonb_typeof(input_json::jsonb)='object' and input_json::jsonb ? 'runInput'
    and jsonb_typeof(input_json::jsonb->'external')='array' and input_json::jsonb ? 'carry') is true),
  check ((occurrence_index=1 and record #> '{input,previous}'='null'::jsonb
    and input_json::jsonb->'carry'='null'::jsonb
    or occurrence_index>1 and jsonb_typeof(record #> '{input,previous}')='object') is true),
  check ((record #>> '{identity,occurrenceId}') is not distinct from occurrence_id),
  check ((record #>> '{identity,scope,runId}') is not distinct from run_id),
  check ((record #>> '{identity,scope,workflowVersionId}') is not distinct from workflow_version_id),
  check ((record #>> '{identity,scope,workspaceId}') is not distinct from workspace_id),
  check ((record #>> '{identity,scope,workflowId}') is not distinct from workflow_id),
  check ((record #> '{identity,scope,executionSemanticsVersion}') is not distinct from '3'::jsonb),
  check ((record #>> '{identity,blockId}') is not distinct from block_id),
  check ((record #> '{identity,occurrenceIndex}') is not distinct from to_jsonb(occurrence_index)),
  check ((record #>> '{input,previous,occurrenceId}') is not distinct from previous_occurrence_id),
  check ((record #> '{input,previous,occurrenceIndex}') is not distinct from to_jsonb(previous_occurrence_index)),
  check ((record #>> '{input,previous,decisionId}') is not distinct from previous_decision_id),
  check ((record #>> '{input,previous,acceptedResultDigest}') is not distinct from previous_result_digest),
  check ((record #>> '{input,inputDigest}') is not distinct from input_digest),
  check ((record #>> '{input,bindingId}') is not distinct from binding_id)
);
create index run_repeat_occurrences_head on run_repeat_occurrences
  (run_id,block_id,occurrence_index desc);

-- Keep the old uniqueness on every legacy/outside row. The trigger below
-- forbids using the new column to evade semantics-1/2 uniqueness.
do $$ begin
  if not exists (select 1 from pg_constraint
    where conrelid='harness_executions'::regclass and contype='u'
    and conname='harness_executions_run_id_workflow_node_id_attempt_key'
    and pg_get_constraintdef(oid)='UNIQUE (run_id, workflow_node_id, attempt)') then
    raise exception 'REPEAT_LEGACY_UNIQUENESS_DRIFT';
  end if;
end $$;
alter table harness_executions add column repeat_occurrence_id text;
alter table harness_executions add constraint repeat_execution_occurrence_fk
  foreign key (repeat_occurrence_id,run_id) references run_repeat_occurrences(occurrence_id,run_id) deferrable initially deferred;
alter table harness_executions drop constraint harness_executions_run_id_workflow_node_id_attempt_key;
create unique index harness_executions_legacy_attempt on harness_executions
  (run_id,workflow_node_id,attempt) where repeat_occurrence_id is null;
create unique index harness_executions_repeat_attempt on harness_executions
  (run_id,repeat_occurrence_id,workflow_node_id,attempt) where repeat_occurrence_id is not null;

create table run_repeat_slots (
  slot_id text primary key,
  run_id text not null references runs(id) on delete cascade deferrable initially deferred,
  occurrence_id text,
  workflow_node_id text not null,
  input_json text not null check (octet_length(input_json)<=4194304),
  input_digest text not null check (input_digest = 'sha256:' || encode(sha256(convert_to(input_json,'UTF8')),'hex')),
  foreign key (occurrence_id,run_id) references run_repeat_occurrences(occurrence_id,run_id) deferrable initially deferred,
  occurrence_key text generated always as (coalesce(occurrence_id,'')) stored,
  unique (slot_id,run_id), unique (slot_id,input_digest),
  unique (slot_id,run_id,occurrence_key,workflow_node_id)
);
create unique index run_repeat_slots_outside on run_repeat_slots(run_id,workflow_node_id) where occurrence_id is null;
create unique index run_repeat_slots_occurrence on run_repeat_slots(occurrence_id,workflow_node_id) where occurrence_id is not null;
create table run_repeat_executions (
  execution_id text primary key references harness_executions(id) on delete cascade,
  run_id text not null references runs(id) on delete cascade deferrable initially deferred,
  slot_id text not null,
  occurrence_id text,
  technical_attempt integer not null check (technical_attempt>0),
  previous_execution_id text unique,
  previous_technical_attempt integer generated always as (case when technical_attempt>1 then technical_attempt-1 end) stored,
  identity jsonb not null,
  occurrence_key text generated always as (coalesce(occurrence_id,'')) stored,
  workflow_node_id text generated always as (identity->>'workflowNodeId') stored not null,
  foreign key (slot_id,run_id,occurrence_key,workflow_node_id)
    references run_repeat_slots(slot_id,run_id,occurrence_key,workflow_node_id) deferrable initially deferred,
  foreign key (occurrence_id,run_id) references run_repeat_occurrences(occurrence_id,run_id) deferrable initially deferred,
  unique (slot_id,technical_attempt), unique (execution_id,run_id), unique (execution_id,occurrence_id),
  unique (execution_id,run_id,occurrence_key),
  unique (execution_id,slot_id,technical_attempt), unique (execution_id,slot_id,run_id),
  foreign key (previous_execution_id,slot_id,previous_technical_attempt)
    references run_repeat_executions(execution_id,slot_id,technical_attempt) deferrable initially deferred,
  check ((technical_attempt=1) = (previous_execution_id is null)),
  check ((identity->>'executionId') is not distinct from execution_id),
  check ((identity->>'attempt')::integer is not distinct from technical_attempt)
);
create table run_repeat_results (
  execution_id text primary key,
  run_id text not null references runs(id) on delete cascade deferrable initially deferred,
  occurrence_id text,
  occurrence_key text generated always as (coalesce(occurrence_id,'')) stored,
  result_json text not null check (octet_length(result_json)<=65536),
  result_digest text not null check (result_digest = 'sha256:' || encode(sha256(convert_to(result_json,'UTF8')),'hex')),
  accepted_at timestamptz not null,
  foreign key (execution_id,run_id) references run_repeat_executions(execution_id,run_id) deferrable initially deferred,
  -- A nullable occurrence pair would skip the FK under MATCH SIMPLE. Use the
  -- non-null namespace key so a repeated result cannot pretend to be outside.
  foreign key (execution_id,run_id,occurrence_key)
    references run_repeat_executions(execution_id,run_id,occurrence_key) deferrable initially deferred,
  unique (execution_id,result_digest), unique (run_id,execution_id,result_digest),
  unique (execution_id,occurrence_id,result_digest),
  check ((result_json::jsonb->>'outcome') is not distinct from 'succeeded')
);
create table run_repeat_bindings (
  binding_id text primary key,
  run_id text not null references runs(id) on delete cascade deferrable initially deferred,
  recipient_execution_id text not null,
  source_execution_id text not null,
  source_result_digest text not null,
  input_digest text not null,
  slot_id text not null,
  ordinal integer not null check (ordinal>=0 and ordinal<16001),
  record jsonb not null,
  foreign key (recipient_execution_id,slot_id,run_id) references run_repeat_executions(execution_id,slot_id,run_id) deferrable initially deferred,
  foreign key (run_id,source_execution_id,source_result_digest) references run_repeat_results(run_id,execution_id,result_digest) deferrable initially deferred,
  foreign key (slot_id,input_digest) references run_repeat_slots(slot_id,input_digest) deferrable initially deferred,
  unique (recipient_execution_id,ordinal), check (recipient_execution_id<>source_execution_id),
  check ((record->>'bindingId') is not distinct from binding_id),
  check ((record->>'inputDigest') is not distinct from input_digest),
  check ((record->>'ordinal')::integer is not distinct from ordinal),
  check ((record #>> '{recipient,executionId}') is not distinct from recipient_execution_id),
  check ((record #>> '{source,execution,executionId}') is not distinct from source_execution_id),
  check ((record #>> '{source,acceptedResultDigest}') is not distinct from source_result_digest)
);
create table run_repeat_resolutions (
  run_id text not null references runs(id) on delete cascade deferrable initially deferred,
  -- Empty string is the outside graph namespace, NOT a business occurrence.
  occurrence_key text not null,
  workflow_node_id text not null,
  source_occurrence_id text,
  execution_id text,
  record jsonb not null,
  primary key (run_id,occurrence_key,workflow_node_id),
  foreign key (source_occurrence_id,run_id) references run_repeat_occurrences(occurrence_id,run_id) deferrable initially deferred,
  foreign key (execution_id,run_id) references run_repeat_executions(execution_id,run_id) deferrable initially deferred,
  check ((occurrence_key='' or occurrence_key=source_occurrence_id) is true),
  check ((record #>> '{value,workflowNodeId}') is not distinct from workflow_node_id),
  check ((record #>> '{ref,nodeId}') is not distinct from workflow_node_id),
  check ((record #>> '{ref,occurrence,occurrenceId}') is not distinct from source_occurrence_id),
  check ((record #>> '{value,execution,executionId}') is not distinct from execution_id)
);
create table run_repeat_decisions (
  decision_id text primary key,
  occurrence_id text not null unique references run_repeat_occurrences(occurrence_id) on delete cascade deferrable initially deferred,
  run_id text generated always as (record #>> '{occurrence,identity,scope,runId}') stored not null,
  exit_execution_id text not null,
  result_digest text not null,
  record jsonb not null,
  foreign key (exit_execution_id,occurrence_id,result_digest) references run_repeat_results(execution_id,occurrence_id,result_digest) deferrable initially deferred,
  unique (decision_id,occurrence_id,result_digest),
  foreign key (occurrence_id,run_id) references run_repeat_occurrences(occurrence_id,run_id) deferrable initially deferred,
  check ((record->>'decisionId') is not distinct from decision_id),
  check ((record #>> '{occurrence,identity,occurrenceId}') is not distinct from occurrence_id),
  check ((record #>> '{exitExecution,occurrence,occurrenceId}') is not distinct from occurrence_id),
  check ((record->>'acceptedResultDigest') is not distinct from result_digest),
  check ((record #>> '{exitExecution,executionId}') is not distinct from exit_execution_id)
);
alter table run_repeat_occurrences add constraint repeat_predecessor_decision_fk
  foreign key (previous_decision_id,previous_occurrence_id,previous_result_digest)
  references run_repeat_decisions(decision_id,occurrence_id,result_digest) deferrable initially deferred;
create table run_repeat_effects (
  run_id text not null references runs(id) on delete cascade deferrable initially deferred,
  effect_kind text not null check (effect_kind in ('occurrence.create','input.bind','terminal.accept','node.inactive','run.complete')),
  entity_id text not null,
  payload_digest text not null check (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  owner_id text not null,
  owner_fence text not null,
  primary key (run_id,effect_kind,entity_id)
);

-- These functions validate durable correlation, not authority or native receipts.
-- All cross-row evidence checks run AFTER INSERT, deferred to the same COMMIT as
-- acceptance/decision/successor. Never read a generated column in a BEFORE trigger.
create function repeat_pinned_version(target_run_id text) returns jsonb language plpgsql as $$
declare parent_run runs%rowtype; version workflow_versions%rowtype;
begin
  select * into strict parent_run from runs where id=target_run_id;
  select * into strict version from workflow_versions where id=parent_run.workflow_version_id;
  if version.execution_semantics_version<>3
    or version.workspace_id<>parent_run.workspace_id or version.workflow_id<>parent_run.workflow_id
    or (parent_run.record->'executionSemanticsVersion') is distinct from '3'::jsonb
    or (parent_run.record->>'id') is distinct from parent_run.id
    or (parent_run.record->>'workspaceId') is distinct from parent_run.workspace_id
    or (parent_run.record->>'workflowId') is distinct from parent_run.workflow_id
    or (parent_run.record->>'workflowVersionId') is distinct from version.id
    or (parent_run.record->>'executionState') is distinct from parent_run.execution_state
    or parent_run.record->'agentConfigurationVersionIds' is distinct from version.record->'agentConfigurationVersionIds'
    or not exists(select 1 from workflows where id=version.workflow_id and workspace_id=version.workspace_id) then
    raise exception 'REPEAT_SCOPE_CONFLICT';
  end if;
  return version.record;
end $$;
create function repeat_saved_block(pinned jsonb, target_block_id text) returns jsonb language plpgsql as $$
declare block jsonb; cap numeric;
begin
  select value into strict block from jsonb_array_elements(pinned #> '{definition,repeat,blocks}')
    where value->>'id'=target_block_id;
  -- JSON null, strings, fractional numbers and absent caps must not make an IF
  -- condition UNKNOWN and accidentally authorize an unbounded occurrence.
  if jsonb_typeof(block->'maxOccurrences') is distinct from 'number' then
    raise exception 'REPEAT_LIMIT_INVALID';
  end if;
  cap := (block->>'maxOccurrences')::numeric;
  if cap<1 or cap>2147483647 or cap<>trunc(cap)
    or jsonb_typeof(block->'nodeIds') is distinct from 'array'
    or not coalesce(block->'nodeIds' ? (block->>'entryNodeId'),false)
    or not coalesce(block->'nodeIds' ? (block->>'exitNodeId'),false)
    or block->>'repeatOutcome' is null or block->>'earlyExitOutcome' is null
    or block->>'repeatOutcome'=block->>'earlyExitOutcome' then
    raise exception 'REPEAT_BLOCK_INVALID';
  end if;
  return block;
end $$;
create function repeat_node_scope(target_run_id text, node_id text, target_occurrence_id text)
  returns jsonb language plpgsql as $$
declare pinned jsonb; block jsonb; occ run_repeat_occurrences%rowtype; member_count integer;
begin
  pinned := repeat_pinned_version(target_run_id);
  if (select count(*) from jsonb_array_elements(pinned #> '{definition,nodes}') n where n->>'id'=node_id)<>1 then
    raise exception 'REPEAT_NODE_SCOPE_CONFLICT';
  end if;
  select count(*) into member_count from jsonb_array_elements(pinned #> '{definition,repeat,blocks}') b
    where b->'nodeIds' ? node_id;
  if member_count>1 or (member_count=0)<>(target_occurrence_id is null) then
    raise exception 'REPEAT_EXECUTION_SCOPE_CONFLICT';
  end if;
  if target_occurrence_id is not null then
    select * into strict occ from run_repeat_occurrences where occurrence_id=target_occurrence_id;
    block := repeat_saved_block(pinned,occ.block_id);
    if occ.run_id<>target_run_id or not coalesce(block->'nodeIds' ? node_id,false) then
      raise exception 'REPEAT_EXECUTION_SCOPE_CONFLICT';
    end if;
    return block;
  end if;
  return null;
end $$;

create function assert_repeat_occurrence_scope() returns trigger language plpgsql as $$
declare pinned jsonb; block jsonb; prior run_repeat_occurrences%rowtype;
  decision run_repeat_decisions%rowtype; accepted jsonb; expected_carry jsonb;
begin
  -- A complete Run may have been deleted later in this transaction. Retention
  -- checks below still reject any splice which leaves that Run present.
  if not exists(select 1 from run_repeat_occurrences where occurrence_id=new.occurrence_id) then return null; end if;
  pinned := repeat_pinned_version(new.run_id);
  block := repeat_saved_block(pinned,new.block_id);
  if new.workspace_id is distinct from pinned->>'workspaceId'
    or new.workflow_id is distinct from pinned->>'workflowId'
    or new.workflow_version_id is distinct from pinned->>'id' then raise exception 'REPEAT_SCOPE_CONFLICT'; end if;
  if new.occurrence_index>(block->>'maxOccurrences')::integer then raise exception 'REPEAT_LIMIT_EXCEEDED'; end if;
  if new.input_json::jsonb->'runInput' is distinct from (select record->'input' from runs where id=new.run_id) then
    raise exception 'REPEAT_RUN_INPUT_CONFLICT';
  end if;
  if new.previous_occurrence_id is not null then
    select * into strict prior from run_repeat_occurrences where occurrence_id=new.previous_occurrence_id;
    select * into strict decision from run_repeat_decisions where decision_id=new.previous_decision_id;
    select result_json::jsonb into strict accepted from run_repeat_results where execution_id=decision.exit_execution_id;
    expected_carry := jsonb_build_object('decisionId',decision.decision_id,'execution',decision.record->'exitExecution',
      'acceptedResultDigest',decision.result_digest,'acceptedResult',accepted);
    if decision.record->>'reason' is distinct from 'repeat'
      or decision.record->'target' is distinct from jsonb_build_object('kind','next_occurrence',
        'entryNodeId',block->>'entryNodeId','occurrenceIndex',new.occurrence_index)
      or new.input_json::jsonb->'external' is distinct from prior.input_json::jsonb->'external'
      or new.input_json::jsonb->'runInput' is distinct from prior.input_json::jsonb->'runInput'
      or new.input_json::jsonb->'carry' is distinct from expected_carry then
      raise exception 'REPEAT_LINEAGE_CONFLICT';
    end if;
  end if;
  return null;
end $$;
create constraint trigger repeat_occurrence_scope after insert on run_repeat_occurrences
  deferrable initially deferred for each row execute function assert_repeat_occurrence_scope();

-- Identity is immutable immediately; scope is checked on final transaction state.
-- The old v1/v2 unique keys, terminal writers and JSON records are not rewritten.
create function protect_repeat_native_identity() returns trigger language plpgsql as $$
declare is_repeat boolean;
begin
  if new.repeat_occurrence_id is distinct from old.repeat_occurrence_id then raise exception 'REPEAT_EXECUTION_IDENTITY_IMMUTABLE'; end if;
  select exists(select 1 from runs where id in (old.run_id,new.run_id)
    and record->>'executionSemanticsVersion'='3') into is_repeat;
  if is_repeat or old.repeat_occurrence_id is not null then
    if new.id is distinct from old.id or new.run_id is distinct from old.run_id
      or new.workflow_node_id is distinct from old.workflow_node_id or new.agent_id is distinct from old.agent_id
      or new.attempt is distinct from old.attempt
      or new.record->>'agentConfigurationVersionId' is distinct from old.record->>'agentConfigurationVersionId'
      or new.record->'input' is distinct from old.record->'input' then raise exception 'REPEAT_EXECUTION_IDENTITY_IMMUTABLE'; end if;
    if old.accepted and (not new.accepted or new.record->'result' is distinct from old.record->'result'
      or new.record->'state' is distinct from old.record->'state'
      or new.record->'finishedAt' is distinct from old.record->'finishedAt') then raise exception 'REPEAT_ACCEPTED_RESULT_IMMUTABLE'; end if;
  end if;
  return new;
end $$;
create trigger repeat_native_identity before update on harness_executions
  for each row execute function protect_repeat_native_identity();
create function assert_repeat_execution_scope() returns trigger language plpgsql as $$
declare pinned jsonb; node jsonb; current_execution harness_executions%rowtype;
begin
  select * into current_execution from harness_executions where id=new.id;
  if not found then return null; end if;
  select v.record into strict pinned from runs r join workflow_versions v on v.id=r.workflow_version_id where r.id=current_execution.run_id;
  if pinned->>'executionSemanticsVersion' is distinct from '3' then
    if current_execution.repeat_occurrence_id is not null then raise exception 'REPEAT_LEGACY_SCOPE_CONFLICT'; end if;
    return null;
  end if;
  perform repeat_node_scope(current_execution.run_id,current_execution.workflow_node_id,current_execution.repeat_occurrence_id);
  select value into strict node from jsonb_array_elements(pinned #> '{definition,nodes}') where value->>'id'=current_execution.workflow_node_id;
  if current_execution.agent_id is distinct from node->>'agentId'
    or current_execution.record->>'id' is distinct from current_execution.id
    or current_execution.record->>'runId' is distinct from current_execution.run_id
    or current_execution.record->>'workflowNodeId' is distinct from current_execution.workflow_node_id
    or current_execution.record->>'agentId' is distinct from current_execution.agent_id
    or current_execution.record->'attempt' is distinct from to_jsonb(current_execution.attempt)
    or current_execution.record->>'agentConfigurationVersionId' is null
    or current_execution.record->>'agentConfigurationVersionId' is distinct from
      pinned #>> array['agentConfigurationVersionIds',current_execution.agent_id] then raise exception 'REPEAT_EXECUTION_PIN_CONFLICT'; end if;
  return null;
end $$;
create constraint trigger repeat_execution_scope after insert or update on harness_executions
  deferrable initially deferred for each row execute function assert_repeat_execution_scope();

create function assert_repeat_slot() returns trigger language plpgsql as $$
declare block jsonb; occ run_repeat_occurrences%rowtype; input jsonb;
begin
  if not exists(select 1 from run_repeat_slots where slot_id=new.slot_id) then return null; end if;
  block := repeat_node_scope(new.run_id,new.workflow_node_id,new.occurrence_id);
  input := new.input_json::jsonb;
  if input->'executionSemanticsVersion' is distinct from '3'::jsonb
    or input->'runInput' is distinct from (select record->'input' from runs where id=new.run_id)
    or jsonb_typeof(input->'predecessors') is distinct from 'array' then raise exception 'REPEAT_SLOT_INPUT_CONFLICT'; end if;
  if new.occurrence_id is not null then
    select * into strict occ from run_repeat_occurrences where occurrence_id=new.occurrence_id;
    if input->'occurrence' is distinct from occ.record
      or input->'entry' is distinct from (case when block->>'entryNodeId'=new.workflow_node_id
        then occ.input_json::jsonb else 'null'::jsonb end) then raise exception 'REPEAT_SLOT_INPUT_CONFLICT'; end if;
  elsif input->'occurrence' is distinct from 'null'::jsonb or input->'entry' is distinct from 'null'::jsonb then
    raise exception 'REPEAT_SLOT_INPUT_CONFLICT';
  end if;
  return null;
end $$;
create constraint trigger repeat_slot_input after insert on run_repeat_slots
  deferrable initially deferred for each row execute function assert_repeat_slot();

create function assert_repeat_execution_evidence() returns trigger language plpgsql as $$
declare native harness_executions%rowtype; expected jsonb; input jsonb; expected_bindings integer;
begin
  if not exists(select 1 from run_repeat_executions where execution_id=new.execution_id) then return null; end if;
  perform repeat_node_scope(new.run_id,new.workflow_node_id,new.occurrence_id);
  select * into strict native from harness_executions where id=new.execution_id;
  expected := jsonb_build_object('executionId',native.id,'workflowNodeId',native.workflow_node_id,
    'agentId',native.agent_id,'agentConfigurationVersionId',native.record->>'agentConfigurationVersionId','attempt',native.attempt);
  if new.occurrence_id is not null then
    expected := expected || jsonb_build_object('occurrence',(select record->'identity' from run_repeat_occurrences where occurrence_id=new.occurrence_id));
  end if;
  if native.run_id<>new.run_id or native.repeat_occurrence_id is distinct from new.occurrence_id
    or native.workflow_node_id<>new.workflow_node_id or native.attempt<>new.technical_attempt
    or new.identity is distinct from expected then raise exception 'REPEAT_EXECUTION_IDENTITY_CONFLICT'; end if;
  select input_json::jsonb into strict input from run_repeat_slots where slot_id=new.slot_id;
  if native.record->'input' is distinct from input then raise exception 'REPEAT_EXECUTION_INPUT_CONFLICT'; end if;
  expected_bindings := jsonb_array_length(input->'predecessors');
  if input->'entry'<>'null'::jsonb then
    expected_bindings := expected_bindings + jsonb_array_length(input #> '{entry,external}')
      + case when input #> '{entry,carry}'<>'null'::jsonb then 1 else 0 end;
  end if;
  if expected_bindings is null or (select count(*) from run_repeat_bindings where recipient_execution_id=new.execution_id)<>expected_bindings
    or exists(select 1 from run_repeat_bindings where recipient_execution_id=new.execution_id and ordinal>=expected_bindings) then
    raise exception 'REPEAT_INPUT_BINDINGS_INCOMPLETE';
  end if;
  return null;
end $$;
create constraint trigger repeat_execution_evidence after insert on run_repeat_executions
  deferrable initially deferred for each row execute function assert_repeat_execution_evidence();
create function assert_repeat_accepted_result() returns trigger language plpgsql as $$
declare native harness_executions%rowtype;
begin
  if not exists(select 1 from run_repeat_results where execution_id=new.execution_id) then return null; end if;
  select * into strict native from harness_executions where id=new.execution_id;
  if native.run_id<>new.run_id or native.repeat_occurrence_id is distinct from new.occurrence_id
    or not native.accepted or native.record->>'state' is distinct from 'completed'
    or native.record->'result' is distinct from new.result_json::jsonb then raise exception 'REPEAT_RESULT_NOT_ACCEPTED'; end if;
  return null;
end $$;
create constraint trigger repeat_accepted_result after insert on run_repeat_results
  deferrable initially deferred for each row execute function assert_repeat_accepted_result();

create function assert_repeat_binding() returns trigger language plpgsql as $$
declare recipient run_repeat_executions%rowtype; source run_repeat_executions%rowtype;
  slot_input jsonb; pinned jsonb; edge jsonb; expected_source jsonb; expected_kind text; n integer; entry jsonb;
begin
  if not exists(select 1 from run_repeat_bindings where binding_id=new.binding_id) then return null; end if;
  select * into strict recipient from run_repeat_executions where execution_id=new.recipient_execution_id;
  select * into strict source from run_repeat_executions where execution_id=new.source_execution_id;
  select input_json::jsonb into strict slot_input from run_repeat_slots where slot_id=new.slot_id;
  n := jsonb_array_length(slot_input->'predecessors');
  entry := slot_input->'entry';
  if new.ordinal<n then expected_kind := 'predecessor'; expected_source := slot_input->'predecessors'->new.ordinal;
  elsif entry is not null and entry<>'null'::jsonb and new.ordinal-n<jsonb_array_length(entry->'external') then
    expected_kind := 'external'; expected_source := entry->'external'->(new.ordinal-n);
  elsif entry is not null and entry<>'null'::jsonb and new.ordinal=n+jsonb_array_length(entry->'external') then
    expected_kind := 'carry'; expected_source := entry->'carry';
  else raise exception 'REPEAT_BINDING_ORDINAL_CONFLICT'; end if;
  if new.record->>'kind' is distinct from expected_kind or expected_source is null or expected_source='null'::jsonb
    or new.record->'source' is distinct from expected_source
    or new.record->'recipient' is distinct from recipient.identity-'occurrence'
    or new.record->'recipientOccurrence' is distinct from coalesce(recipient.identity->'occurrence','null'::jsonb)
    or new.record #> '{source,acceptedResult}' is distinct from (select result_json::jsonb from run_repeat_results where execution_id=source.execution_id) then
    raise exception 'REPEAT_BINDING_IDENTITY_CONFLICT';
  end if;
  if expected_kind='carry' then
    if new.record #> '{source,execution}' is distinct from source.identity then raise exception 'REPEAT_CARRY_CONFLICT'; end if;
    -- The occurrence and slot checks already bind this exact carry to the
    -- preceding same-block decision, not an arbitrary successful body result.
  else
    if new.record #> '{source,execution}' is distinct from source.identity-'occurrence'
      or new.record #> '{source,occurrence}' is distinct from coalesce(source.identity->'occurrence','null'::jsonb) then
      raise exception 'REPEAT_BINDING_IDENTITY_CONFLICT';
    end if;
    pinned := repeat_pinned_version(new.run_id);
    select value into strict edge from jsonb_array_elements(pinned #> '{definition,edges}')
      where value->>'id'=new.record #>> '{source,relationshipId}';
    if edge->>'kind' is distinct from 'execution' or edge->>'source' is distinct from source.workflow_node_id
      or edge->>'target' is distinct from recipient.workflow_node_id then raise exception 'REPEAT_BINDING_EDGE_CONFLICT'; end if;
    if expected_kind='predecessor' and recipient.occurrence_id is not null
      and source.occurrence_id is distinct from recipient.occurrence_id then raise exception 'REPEAT_CROSS_OCCURRENCE_JOIN'; end if;
    if expected_kind='external' and source.occurrence_id is not distinct from recipient.occurrence_id then
      raise exception 'REPEAT_EXTERNAL_SOURCE_CONFLICT';
    end if;
    if source.occurrence_id is not null and source.occurrence_id is distinct from recipient.occurrence_id
      and not exists(select 1 from run_repeat_resolutions r where r.run_id=new.run_id and r.occurrence_key=''
        and r.workflow_node_id=source.workflow_node_id and r.source_occurrence_id=source.occurrence_id and r.execution_id=source.execution_id) then
      raise exception 'REPEAT_EGRESS_UNRESOLVED';
    end if;
  end if;
  return null;
end $$;
create constraint trigger repeat_binding_evidence after insert on run_repeat_bindings
  deferrable initially deferred for each row execute function assert_repeat_binding();

-- Verify a frozen external/selected predecessor against exact retained evidence.
-- No lookup by digest alone and no use of a previous occurrence's local join.
create function repeat_assert_selected_source(target_run_id text, target_node_id text,
  target_occurrence_id text, source_json jsonb, source_kind text) returns void language plpgsql as $$
declare source run_repeat_executions%rowtype; result run_repeat_results%rowtype;
  pinned jsonb; edge jsonb; source_key text;
begin
  pinned := repeat_pinned_version(target_run_id);
  select * into strict source from run_repeat_executions where execution_id=source_json #>> '{execution,executionId}';
  select * into strict result from run_repeat_results where execution_id=source.execution_id;
  if source.run_id<>target_run_id or result.run_id<>target_run_id
    or source_json->'execution' is distinct from source.identity-'occurrence'
    or source_json->'occurrence' is distinct from coalesce(source.identity->'occurrence','null'::jsonb)
    or source_json->>'acceptedResultDigest' is distinct from result.result_digest
    or source_json->'acceptedResult' is distinct from result.result_json::jsonb then raise exception 'REPEAT_SOURCE_CONFLICT'; end if;
  select value into strict edge from jsonb_array_elements(pinned #> '{definition,edges}')
    where value->>'id'=source_json->>'relationshipId';
  if edge->>'kind' is distinct from 'execution' or edge->>'source' is distinct from source.workflow_node_id
    or edge->>'target' is distinct from target_node_id then raise exception 'REPEAT_BINDING_EDGE_CONFLICT'; end if;
  if source_kind='predecessor' and target_occurrence_id is not null
    and source.occurrence_id is distinct from target_occurrence_id then raise exception 'REPEAT_CROSS_OCCURRENCE_JOIN'; end if;
  if source_kind='external' and source.occurrence_id is not null and exists(
    select 1 from run_repeat_occurrences a join run_repeat_occurrences b on a.run_id=b.run_id and a.block_id=b.block_id
      where a.occurrence_id=source.occurrence_id and b.occurrence_id=target_occurrence_id) then
    raise exception 'REPEAT_EXTERNAL_SOURCE_CONFLICT';
  end if;
  source_key := case when source.occurrence_id is not null and source.occurrence_id=target_occurrence_id
    then source.occurrence_id else '' end;
  if not exists(select 1 from run_repeat_resolutions r where r.run_id=target_run_id and r.occurrence_key=source_key
    and r.workflow_node_id=source.workflow_node_id and r.execution_id=source.execution_id
    and r.record #>> '{value,resolution}'='succeeded'
    and r.record #>> '{value,acceptedResultDigest}'=result.result_digest
    and (r.record #> '{value,selectedRelationshipIds}') ? (edge->>'id')) then
    raise exception 'REPEAT_SOURCE_NOT_SELECTED';
  end if;
end $$;
create function assert_repeat_frozen_sources() returns trigger language plpgsql as $$
declare input jsonb; pinned jsonb; block jsonb; source jsonb; recipient_node text; sources jsonb; source_kind text;
begin
  if tg_table_name='run_repeat_occurrences' then
    if not exists(select 1 from run_repeat_occurrences where occurrence_id=new.occurrence_id) then return null; end if;
    pinned := repeat_pinned_version(new.run_id); block := repeat_saved_block(pinned,new.block_id);
    input := new.input_json::jsonb; sources := input->'external'; recipient_node := block->>'entryNodeId'; source_kind := 'external';
  else
    if not exists(select 1 from run_repeat_slots where slot_id=new.slot_id) then return null; end if;
    input := new.input_json::jsonb; sources := input->'predecessors'; recipient_node := new.workflow_node_id; source_kind := 'predecessor';
  end if;
  if jsonb_typeof(sources) is distinct from 'array' or jsonb_array_length(sources)>8000
    or jsonb_array_length(sources)<>(select count(distinct s->>'relationshipId') from jsonb_array_elements(sources) s) then
    raise exception 'REPEAT_SOURCE_SET_INVALID';
  end if;
  for source in select value from jsonb_array_elements(sources) loop
    perform repeat_assert_selected_source(new.run_id,recipient_node,new.occurrence_id,source,source_kind);
  end loop;
  return null;
end $$;
create constraint trigger repeat_occurrence_sources after insert on run_repeat_occurrences
  deferrable initially deferred for each row execute function assert_repeat_frozen_sources();
create constraint trigger repeat_slot_sources after insert on run_repeat_slots
  deferrable initially deferred for each row execute function assert_repeat_frozen_sources();

create function assert_repeat_resolution() returns trigger language plpgsql as $$
declare pinned jsonb; block jsonb; execution run_repeat_executions%rowtype; decision run_repeat_decisions%rowtype;
  source_identity jsonb; kind text; target jsonb; selected jsonb; unselected jsonb;
begin
  if not exists(select 1 from run_repeat_resolutions where run_id=new.run_id and occurrence_key=new.occurrence_key
    and workflow_node_id=new.workflow_node_id) then return null; end if;
  pinned := repeat_pinned_version(new.run_id);
  if (select count(*) from jsonb_array_elements(pinned #> '{definition,nodes}') n where n->>'id'=new.workflow_node_id)<>1 then
    raise exception 'REPEAT_NODE_SCOPE_CONFLICT';
  end if;
  kind := new.record #>> '{value,resolution}';
  if kind is null or kind not in ('succeeded','failed','canceled','skipped','excluded') then raise exception 'REPEAT_RESOLUTION_INVALID'; end if;
  if new.source_occurrence_id is not null then
    perform repeat_node_scope(new.run_id,new.workflow_node_id,new.source_occurrence_id);
    select record->'identity' into strict source_identity from run_repeat_occurrences where occurrence_id=new.source_occurrence_id;
    if new.record #> '{ref,occurrence}' is distinct from source_identity then raise exception 'REPEAT_RESOLUTION_SCOPE_CONFLICT'; end if;
  elsif new.record #> '{ref,occurrence}' is distinct from 'null'::jsonb then raise exception 'REPEAT_RESOLUTION_SCOPE_CONFLICT'; end if;
  if kind in ('skipped','excluded') then
    if new.execution_id is not null or new.record #>> '{value,acceptedResultDigest}' is not null then raise exception 'REPEAT_RESOLUTION_INVALID'; end if;
  else
    select * into strict execution from run_repeat_executions where execution_id=new.execution_id;
    if execution.run_id<>new.run_id or execution.workflow_node_id<>new.workflow_node_id
      or execution.occurrence_id is distinct from new.source_occurrence_id
      or new.record #> '{value,execution}' is distinct from execution.identity-'occurrence' then
      raise exception 'REPEAT_RESOLUTION_EXECUTION_CONFLICT';
    end if;
    if kind='succeeded' and not exists(select 1 from run_repeat_results where execution_id=new.execution_id
      and result_digest=new.record #>> '{value,acceptedResultDigest}') then raise exception 'REPEAT_RESOLUTION_RESULT_CONFLICT'; end if;
    if kind<>'succeeded' and new.record #>> '{value,acceptedResultDigest}' is not null then raise exception 'REPEAT_RESOLUTION_INVALID'; end if;
  end if;
  if new.occurrence_key='' then
    select value into block from jsonb_array_elements(pinned #> '{definition,repeat,blocks}') b where b->'nodeIds' ? new.workflow_node_id;
    if block is not null then
      if block->>'exitNodeId' is distinct from new.workflow_node_id then raise exception 'REPEAT_EXPORT_SCOPE_CONFLICT'; end if;
      if new.source_occurrence_id is null then
        if kind not in ('skipped','excluded') then raise exception 'REPEAT_EXPORT_SCOPE_CONFLICT'; end if;
      else
        select * into strict decision from run_repeat_decisions where occurrence_id=new.source_occurrence_id;
        if decision.exit_execution_id is distinct from new.execution_id or kind<>'succeeded'
          or decision.record->>'reason' not in ('early_exit','limit_exit') then raise exception 'REPEAT_EGRESS_UNRESOLVED'; end if;
        target := decision.record->'target';
        selected := case when target->>'kind'='edge' then jsonb_build_array(target->>'relationshipId') else '[]'::jsonb end;
        select coalesce(jsonb_agg(e->>'id' order by (e->>'id') collate "C"),'[]'::jsonb) into unselected
          from jsonb_array_elements(pinned #> '{definition,edges}') e where e->>'kind'='execution'
            and e->>'source'=new.workflow_node_id and not (selected ? (e->>'id'));
        if new.record->'deferredRelationshipIds' is distinct from '[]'::jsonb
          or new.record #> '{value,selectedRelationshipIds}' is distinct from selected
          or new.record #> '{value,unselectedRelationshipIds}' is distinct from unselected
          or new.record #> '{value,branchEnded}' is distinct from to_jsonb(target->>'kind'='branch_end')
          or new.record #>> '{value,outcome}' is distinct from decision.record->>'outcome' then raise exception 'REPEAT_EXPORT_ROUTE_CONFLICT'; end if;
      end if;
    end if;
  end if;
  return null;
end $$;
create constraint trigger repeat_resolution_evidence after insert on run_repeat_resolutions
  deferrable initially deferred for each row execute function assert_repeat_resolution();

create function assert_repeat_decision() returns trigger language plpgsql as $$
declare occ run_repeat_occurrences%rowtype; execution run_repeat_executions%rowtype;
  pinned jsonb; block jsonb; exit_node jsonb; accepted jsonb; envelope jsonb; outcome text;
  reason text; target jsonb; declaration jsonb; member text;
begin
  if not exists(select 1 from run_repeat_decisions where decision_id=new.decision_id) then return null; end if;
  select * into strict occ from run_repeat_occurrences where occurrence_id=new.occurrence_id;
  pinned := repeat_pinned_version(occ.run_id); block := repeat_saved_block(pinned,occ.block_id);
  select * into strict execution from run_repeat_executions where execution_id=new.exit_execution_id;
  select result_json::jsonb into strict accepted from run_repeat_results where execution_id=new.exit_execution_id;
  select value into strict exit_node from jsonb_array_elements(pinned #> '{definition,nodes}') where value->>'id'=block->>'exitNodeId';
  -- Parsing-only view, exactly as the pinned parseRepeatExitResultV1: direct
  -- object, entire JSON string, or the exact single-key native {text} carrier.
  -- Original result text/digest/carry remain untouched.
  envelope := accepted->'output';
  if jsonb_typeof(envelope)='object' and envelope-'text'='{}'::jsonb and jsonb_typeof(envelope->'text')='string' then
    envelope := (envelope->>'text')::jsonb;
  elsif jsonb_typeof(envelope)='string' then envelope := (envelope #>> '{}')::jsonb; end if;
  if jsonb_typeof(envelope) is distinct from 'object' or envelope-array['routing','data']<>'{}'::jsonb
    or jsonb_typeof(envelope->'routing') is distinct from 'object' or (envelope->'routing')-'outcome'<>'{}'::jsonb
    or jsonb_typeof(envelope #> '{routing,outcome}') is distinct from 'string'
    or jsonb_typeof(envelope->'data') is distinct from 'object'
    or (envelope->'data')-array['latestDeliverable','remainingFindings']<>'{}'::jsonb
    or envelope #> '{data,latestDeliverable}' is null or envelope #> '{data,latestDeliverable}'='null'::jsonb
    or jsonb_typeof(envelope #> '{data,remainingFindings}') is distinct from 'array' then raise exception 'REPEAT_EXIT_ENVELOPE_INVALID'; end if;
  outcome := envelope #>> '{routing,outcome}';
  if outcome not in (block->>'earlyExitOutcome',block->>'repeatOutcome') then raise exception 'REPEAT_OUTCOME_UNDECLARED'; end if;
  if jsonb_array_length(exit_node #> '{choice,outcomes}') is distinct from 2 then raise exception 'REPEAT_EXIT_CHOICE_INVALID'; end if;
  select value into strict declaration from jsonb_array_elements(exit_node #> '{choice,outcomes}') where value->>'outcome'=block->>'repeatOutcome';
  if declaration->'target' is distinct from block->'limitExit' then raise exception 'REPEAT_LIMIT_ROUTE_CONFLICT'; end if;
  select value into strict declaration from jsonb_array_elements(exit_node #> '{choice,outcomes}') where value->>'outcome'=outcome;
  reason := case when outcome=block->>'earlyExitOutcome' then 'early_exit'
    when occ.occurrence_index=(block->>'maxOccurrences')::integer then 'limit_exit' else 'repeat' end;
  target := case when reason='early_exit' then declaration->'target' when reason='limit_exit' then block->'limitExit'
    else jsonb_build_object('kind','next_occurrence','entryNodeId',block->>'entryNodeId','occurrenceIndex',occ.occurrence_index+1) end;
  if reason<>'repeat' then
    if ((target=jsonb_build_object('kind','branch_end')) or
      (target->>'kind'='edge' and target=jsonb_build_object('kind','edge','relationshipId',target->>'relationshipId')
        and exists(select 1 from jsonb_array_elements(pinned #> '{definition,edges}') e where e->>'id'=target->>'relationshipId'
          and e->>'kind'='execution' and e->>'source'=execution.workflow_node_id))) is not true then
      raise exception 'REPEAT_EXIT_TARGET_INVALID';
    end if;
  end if;
  if new.record->'contractVersion' is distinct from '1'::jsonb
    or execution.occurrence_id is distinct from occ.occurrence_id or execution.run_id<>occ.run_id
    or execution.workflow_node_id is distinct from block->>'exitNodeId'
    or new.record->'occurrence' is distinct from occ.record or new.record->'exitExecution' is distinct from execution.identity
    or new.record->>'outcome' is distinct from outcome or new.record->>'reason' is distinct from reason
    or new.record->'target' is distinct from target or new.record->'resultData' is distinct from envelope->'data' then
    raise exception 'REPEAT_DECISION_PROVENANCE_CONFLICT';
  end if;
  for member in select jsonb_array_elements_text(block->'nodeIds') loop
    if not exists(select 1 from run_repeat_resolutions r where r.run_id=occ.run_id and r.occurrence_key=occ.occurrence_id
      and r.workflow_node_id=member and r.record #>> '{value,resolution}' in ('succeeded','skipped')) then
      raise exception 'REPEAT_BODY_UNRESOLVED';
    end if;
  end loop;
  if not exists(select 1 from run_repeat_resolutions r where r.run_id=occ.run_id and r.occurrence_key=occ.occurrence_id
    and r.workflow_node_id=execution.workflow_node_id and r.execution_id=new.exit_execution_id
    and r.record #>> '{value,resolution}'='succeeded' and r.record #>> '{value,acceptedResultDigest}'=new.result_digest) then
    raise exception 'REPEAT_EXIT_NOT_ACCEPTED';
  end if;
  if reason='repeat' then
    if not exists(select 1 from run_repeat_occurrences o where o.previous_decision_id=new.decision_id
      and o.previous_occurrence_id=occ.occurrence_id and o.occurrence_index=occ.occurrence_index+1) then
      raise exception 'REPEAT_SUCCESSOR_MISSING';
    end if;
  elsif not exists(select 1 from run_repeat_resolutions r where r.run_id=occ.run_id and r.occurrence_key=''
    and r.workflow_node_id=execution.workflow_node_id and r.execution_id=new.exit_execution_id
    and r.source_occurrence_id=occ.occurrence_id) then raise exception 'REPEAT_FINAL_EXPORT_MISSING'; end if;
  return null;
end $$;
create constraint trigger repeat_decision_evidence after insert on run_repeat_decisions
  deferrable initially deferred for each row execute function assert_repeat_decision();

create function assert_repeat_effect_scope() returns trigger language plpgsql as $$
begin
  if exists(select 1 from run_repeat_effects where run_id=new.run_id and effect_kind=new.effect_kind and entity_id=new.entity_id) then
    perform repeat_pinned_version(new.run_id);
  end if;
  return null;
end $$;
create constraint trigger repeat_effect_scope after insert on run_repeat_effects
  deferrable initially deferred for each row execute function assert_repeat_effect_scope();

-- A new saved version / Run is required for v3. No retagging legacy history;
-- do not replace the old v2 reliability function or broaden its legacy behavior.
create function protect_repeat_version_pin() returns trigger language plpgsql as $$
begin
  if old.execution_semantics_version=3 or new.execution_semantics_version=3 then
    if new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
      or new.workflow_id is distinct from old.workflow_id or new.version is distinct from old.version
      or new.entry_node_id is distinct from old.entry_node_id or new.record is distinct from old.record
      or new.execution_semantics_version is distinct from old.execution_semantics_version
      or new.created_at is distinct from old.created_at then raise exception 'REPEAT_VERSION_IMMUTABLE'; end if;
  end if;
  return new;
end $$;
create trigger repeat_version_pin before update on workflow_versions for each row execute function protect_repeat_version_pin();
create function assert_repeat_version_scope() returns trigger language plpgsql as $$
begin
  if exists(select 1 from workflow_versions where id=new.id and execution_semantics_version=3)
    and not exists(select 1 from workflows where id=new.workflow_id and workspace_id=new.workspace_id) then
    raise exception 'REPEAT_VERSION_SCOPE_CONFLICT';
  end if;
  return null;
end $$;
create constraint trigger repeat_version_scope after insert or update on workflow_versions
  deferrable initially deferred for each row execute function assert_repeat_version_scope();
create function protect_repeat_run_pin() returns trigger language plpgsql as $$
begin
  if old.record->>'executionSemanticsVersion'='3' or new.record->>'executionSemanticsVersion'='3' then
    if new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
      or new.workflow_id is distinct from old.workflow_id or new.workflow_version_id is distinct from old.workflow_version_id
      or new.record->'executionSemanticsVersion' is distinct from old.record->'executionSemanticsVersion'
      or new.record->'workflowVersionId' is distinct from old.record->'workflowVersionId'
      or new.record->'agentConfigurationVersionIds' is distinct from old.record->'agentConfigurationVersionIds'
      or new.record->'approval' is distinct from old.record->'approval'
      or new.record->'input' is distinct from old.record->'input' then raise exception 'REPEAT_RUN_PIN_IMMUTABLE'; end if;
    if new.record->>'executionState' is distinct from new.execution_state then raise exception 'REPEAT_RUN_STATE_CONFLICT'; end if;
    if old.execution_state='completed' and (new.execution_state is distinct from old.execution_state
      or new.record->'outcome' is distinct from old.record->'outcome' or new.record->'result' is distinct from old.record->'result'
      or new.record->'finishedAt' is distinct from old.record->'finishedAt') then raise exception 'REPEAT_RUN_TERMINAL_IMMUTABLE'; end if;
    if new.stop_requested_at is not null and new.execution_state is distinct from old.execution_state
      and new.execution_state not in ('completed','interrupted') then raise exception 'REPEAT_RUN_STOPPED'; end if;
    if new.stop_requested_at is not null and old.execution_state<>'completed'
      and new.execution_state='completed' and new.record->>'outcome'='succeeded' then raise exception 'REPEAT_RUN_STOPPED'; end if;
  end if;
  return new;
end $$;
create trigger repeat_run_pin before update on runs for each row execute function protect_repeat_run_pin();
create function assert_repeat_run_pin() returns trigger language plpgsql as $$
begin
  if exists(select 1 from runs r join workflow_versions v on v.id=r.workflow_version_id
    where r.id=new.id and (r.record->>'executionSemanticsVersion'='3' or v.execution_semantics_version=3)) then
    perform repeat_pinned_version(new.id);
  end if;
  return null;
end $$;
create constraint trigger repeat_run_scope after insert or update on runs
  deferrable initially deferred for each row execute function assert_repeat_run_pin();

-- Retention is tied to the actual Run, NOT a graph journal row or a mutable GUC.
-- Deferred DELETE checks permit whole-Run cascades independent of cascade order,
-- and reject deleting/reinserting evidence or standalone native execution deletion.
create function reject_repeat_evidence_update() returns trigger language plpgsql as $$
begin raise exception 'REPEAT_IMMUTABLE_EVIDENCE'; end $$;
create function assert_repeat_evidence_retention() returns trigger language plpgsql as $$
begin
  if exists(select 1 from runs where id=old.run_id) then raise exception 'REPEAT_RETAIN_WITH_RUN'; end if;
  return null;
end $$;
create function reject_repeat_evidence_truncate() returns trigger language plpgsql as $$
begin raise exception 'REPEAT_TRUNCATE_FORBIDDEN_USE_RUN_RETENTION'; end $$;
do $$ declare name text; begin
  foreach name in array array['run_repeat_occurrences','run_repeat_slots','run_repeat_executions','run_repeat_results',
    'run_repeat_bindings','run_repeat_resolutions','run_repeat_decisions','run_repeat_effects'] loop
    execute format('create trigger repeat_no_update before update on %I for each row execute function reject_repeat_evidence_update()',name);
    execute format('create constraint trigger repeat_retention after delete on %I deferrable initially deferred for each row execute function assert_repeat_evidence_retention()',name);
    execute format('create trigger repeat_no_truncate before truncate on %I for each statement execute function reject_repeat_evidence_truncate()',name);
  end loop;
end $$;
`

/** Collision-free at 58dada6d958d328dcff20442101f4abae5f1d681; one registry entry. */
export const repeatOccurrenceMigration = { version: 264501, sql: repeatOccurrenceMigrationSql } as const
