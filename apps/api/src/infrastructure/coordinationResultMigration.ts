/** Keep old native bytes/decisions unchanged. Marked observations retain their
 * first-terminal normalization before physical closure, so a real F1 conflict
 * can still spend the existing same-session repair budget. */
export const coordinationResultMigration = { version: 2026102105, sql: String.raw`
create function preserve_workflow_result_protocol() returns trigger language plpgsql as $$
begin
  if new.record ? 'resultProtocol' and new.record->>'resultProtocol' is distinct from 'f1-f4-v1'
    then raise exception 'WORKFLOW_RESULT_PROTOCOL_INVALID'; end if;
  if tg_op='UPDATE' and new.record->'resultProtocol' is distinct from old.record->'resultProtocol'
    then raise exception 'WORKFLOW_RESULT_PROTOCOL_IMMUTABLE'; end if;
  return new;
end $$;
create trigger workflow_result_protocol_immutable before insert or update on runs
  for each row execute function preserve_workflow_result_protocol();

create table workflow_coordination_terminals (
  execution_id text primary key references harness_executions(id) on delete cascade,
  run_id text not null references runs(id) on delete cascade,
  native_proof_id text not null references workflow_native_proofs(proof_id) on delete cascade deferrable initially deferred,
  settled_native_proof_id text references workflow_native_proofs(proof_id) deferrable initially deferred,
  record jsonb not null,
  record_json text not null check(octet_length(record_json)<=262144),
  record_digest text not null check(record_digest='sha256:' || encode(sha256(convert_to(record_json,'UTF8')),'hex')),
  check(record=record_json::jsonb),
  check(record#>>'{execution,executionId}'=execution_id and record#>>'{scope,runId}'=run_id
    and record->>'nativeProofId'=native_proof_id)
);
create index workflow_coordination_terminals_run on workflow_coordination_terminals(run_id,execution_id);
create function protect_workflow_coordination_terminal() returns trigger language plpgsql as $$
begin
  if tg_op='UPDATE' and new is not distinct from old then return new; end if;
  if tg_op='UPDATE' and old.settled_native_proof_id is null and new.settled_native_proof_id is not null
    and to_jsonb(new)-'settled_native_proof_id' is not distinct from to_jsonb(old)-'settled_native_proof_id'
    then return new; end if;
  raise exception 'COORDINATION_TERMINAL_IMMUTABLE';
end $$;
create trigger workflow_coordination_terminal_immutable before update on workflow_coordination_terminals
  for each row execute function protect_workflow_coordination_terminal();
create constraint trigger workflow_coordination_terminal_retention after delete on workflow_coordination_terminals
  deferrable initially deferred for each row execute function assert_work_evidence_retention();
create trigger workflow_coordination_terminal_no_truncate before truncate on workflow_coordination_terminals
  for each statement execute function reject_work_evidence_truncate();
create function assert_workflow_coordination_terminal() returns trigger language plpgsql as $$
declare item workflow_coordination_terminals%rowtype; execution harness_executions%rowtype;
  proof workflow_native_proofs%rowtype; pinned run_repeat_executions%rowtype; target_execution_id text;
begin
  if tg_table_name='workflow_coordination_terminals' then target_execution_id := new.execution_id;
  else target_execution_id := new.id; end if;
  for item in select * from workflow_coordination_terminals
    where execution_id=target_execution_id loop
    select * into strict execution from harness_executions where id=item.execution_id and run_id=item.run_id;
    select * into strict proof from workflow_native_proofs where proof_id=item.native_proof_id
      and run_id=item.run_id and execution_id=item.execution_id;
    select * into strict pinned from run_repeat_executions where execution_id=item.execution_id and run_id=item.run_id;
    if not exists(select 1 from runs where id=item.run_id and record->>'resultProtocol'='f1-f4-v1'
        and workflow_version_id=item.record#>>'{scope,workflowVersionId}')
      or item.record->'scope' is distinct from proof.record->'scope'
      or item.record->'execution' is distinct from pinned.identity-'occurrence'
      or proof.record->'execution' is distinct from item.record->'execution'
      or proof.record#>>'{original,type}' is distinct from 'history'
      or proof.record#>>'{original,history,terminalTurn,correlationId}' is distinct from item.record->>'nativeCorrelationId'
      or proof.record#>>'{original,history,terminalTurn,providerId}' is distinct from item.record->>'nativeProviderId'
      or execution.record->>'state' is distinct from 'completed'
      or execution.record->'result' is distinct from item.record->'result'
      or not exists(select 1 from run_graph_sources s where s.run_id=item.run_id and s.source_kind='execution'
        and s.source_id=item.record->>'sourceId' and s.source_revision=1
        and s.source_digest=item.record->>'sourceDigest') then raise exception 'COORDINATION_TERMINAL_CONFLICT'; end if;
    if item.settled_native_proof_id is not null and not exists(select 1 from workflow_native_proofs settled
      where settled.proof_id=item.settled_native_proof_id and settled.run_id=item.run_id and settled.execution_id=item.execution_id
        and settled.record#>>'{original,type}'='history'
        and settled.record#>>'{original,history,terminalTurn,correlationId}'=item.record->>'nativeCorrelationId'
        and settled.record#>>'{original,history,terminalTurn,providerId}'=item.record->>'nativeProviderId'
        and settled.record#>'{original,history,terminalTurn,result}'=proof.record#>'{original,history,terminalTurn,result}')
      then raise exception 'COORDINATION_TERMINAL_SETTLEMENT_CONFLICT'; end if;
  end loop;
  return null;
end $$;
create constraint trigger workflow_coordination_terminal_evidence after insert or update on workflow_coordination_terminals
  deferrable initially deferred for each row execute function assert_workflow_coordination_terminal();
create constraint trigger workflow_coordination_native_evidence after update on harness_executions
  deferrable initially deferred for each row execute function assert_workflow_coordination_terminal();

create or replace function assert_repeat_decision() returns trigger language plpgsql as $$
declare occ run_repeat_occurrences%rowtype; execution run_repeat_executions%rowtype;
  pinned jsonb; block jsonb; exit_node jsonb; accepted jsonb; envelope jsonb; outcome text;
  reason text; target jsonb; declaration jsonb; member text; coordinated boolean;
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
  coordinated := coalesce(exit_node->>'kind','agent')<>'job' and exists(select 1 from runs
    where id=occ.run_id and record->>'resultProtocol'='f1-f4-v1');
  if coordinated then
    if jsonb_typeof(envelope) is distinct from 'object'
      or envelope-(case when exit_node ? 'artifactOutputs'
        then array['routing','data','summary','board','artifactOutputs'] else array['routing','data','summary','board'] end)<>'{}'::jsonb
      or jsonb_typeof(envelope->'summary') is distinct from 'string'
      or length(btrim(envelope->>'summary')) not between 1 and 600
      or jsonb_typeof(envelope->'board') is distinct from 'object'
      or envelope#>>'{board,kind}' is null
      or envelope#>>'{board,kind}' not in ('none','changes') then raise exception 'COORDINATION_RESULT_INVALID'; end if;
    if envelope#>>'{board,kind}'='none' then
      if (envelope->'board')-array['kind','reason','appliedCommandIds']<>'{}'::jsonb
        or envelope#>>'{board,reason}' not in ('no_changes','no_access','already_recorded')
        or envelope#>>'{board,reason}' is null
        or (envelope#>'{board,appliedCommandIds}' is not null and
          (jsonb_typeof(envelope#>'{board,appliedCommandIds}') is distinct from 'array'
           or jsonb_array_length(envelope#>'{board,appliedCommandIds}')>32)) then raise exception 'COORDINATION_BOARD_INVALID'; end if;
    elsif (envelope->'board')-array['kind','operations']<>'{}'::jsonb
      or jsonb_typeof(envelope#>'{board,operations}') is distinct from 'array'
      or jsonb_array_length(envelope#>'{board,operations}') not between 1 and 32 then raise exception 'COORDINATION_BOARD_INVALID'; end if;
    if exit_node ? 'artifactOutputs' and jsonb_typeof(envelope->'artifactOutputs') is distinct from 'object'
      then raise exception 'COORDINATION_ARTIFACTS_REQUIRED'; end if;
  elsif jsonb_typeof(envelope) is distinct from 'object' or envelope-array['routing','data']<>'{}'::jsonb
    then raise exception 'REPEAT_EXIT_ENVELOPE_INVALID'; end if;
  if jsonb_typeof(envelope) is distinct from 'object'
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
` } as const
