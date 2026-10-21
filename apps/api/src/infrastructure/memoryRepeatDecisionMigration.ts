/** Extend storage validation for the pinned protocol without changing saved result bytes. */
export const memoryRepeatDecisionMigration = { version: 2026102126, sql: String.raw`
create or replace function assert_repeat_decision() returns trigger language plpgsql as $$
declare occ run_repeat_occurrences%rowtype; execution run_repeat_executions%rowtype;
  pinned jsonb; block jsonb; exit_node jsonb; accepted jsonb; envelope jsonb; outcome text;
  reason text; target jsonb; declaration jsonb; member text; protocol text; board_result jsonb; artifacts jsonb;
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
  select record->>'resultProtocol' into protocol from runs where id=occ.run_id;
  if protocol='f1-f4-v1' and exit_node->>'kind' is distinct from 'job' then
    if (select record->>'resultProtocol' from harness_executions where id=new.exit_execution_id)
        is distinct from protocol
      or jsonb_typeof(envelope->'summary') is distinct from 'string'
      or length(btrim(envelope->>'summary')) not between 1 and 600 then
      raise exception 'COORDINATION_RESULT_INVALID';
    end if;
    board_result := envelope->'board';
    if jsonb_typeof(board_result) is distinct from 'object'
      or (board_result->>'kind' in ('none','changes')) is not true then
      raise exception 'COORDINATION_BOARD_RESULT_INVALID';
    end if;
    if board_result->>'kind'='none' then
      if board_result-array['kind','reason','appliedCommandIds']<>'{}'::jsonb
        or (board_result->>'reason' in ('no_changes','no_access','already_recorded')) is not true then
        raise exception 'COORDINATION_BOARD_RESULT_INVALID';
      end if;
      if board_result ? 'appliedCommandIds' then
        if jsonb_typeof(board_result->'appliedCommandIds') is distinct from 'array'
          or jsonb_array_length(board_result->'appliedCommandIds')>32
          or exists(select 1 from jsonb_array_elements(board_result->'appliedCommandIds') id
            where jsonb_typeof(id) is distinct from 'string' or length(btrim(id #>> '{}'))=0) then
          raise exception 'COORDINATION_BOARD_RESULT_INVALID';
        end if;
      end if;
    else
      if board_result-array['kind','operations']<>'{}'::jsonb
        or jsonb_typeof(board_result->'operations') is distinct from 'array'
        or jsonb_array_length(board_result->'operations') not between 1 and 32 then
        raise exception 'COORDINATION_BOARD_RESULT_INVALID';
      end if;
    end if;
    -- Parsing view only; the original result, digest and carry remain immutable.
    envelope := envelope-array['summary','board'];
  end if;
  if exit_node ? 'artifactOutputs' then
    artifacts := envelope->'artifactOutputs';
    if jsonb_typeof(accepted->'output') is distinct from 'object'
      or (accepted->'output')-'text'<>'{}'::jsonb
      or jsonb_typeof(accepted#>'{output,text}') is distinct from 'string'
      or jsonb_typeof(artifacts) is distinct from 'object'
      or artifacts-array['version','outputs']<>'{}'::jsonb
      or artifacts->'version' is distinct from '1'::jsonb
      or jsonb_typeof(artifacts->'outputs') is distinct from 'array'
      or jsonb_array_length(artifacts->'outputs') is distinct from jsonb_array_length(exit_node#>'{artifactOutputs,outputKeys}')
      or exists(select 1 from jsonb_array_elements(artifacts->'outputs') item
        where jsonb_typeof(item) is distinct from 'object' or item-array['outputKey','commandId']<>'{}'::jsonb
          or jsonb_typeof(item->'outputKey') is distinct from 'string'
          or jsonb_typeof(item->'commandId') is distinct from 'string' or length(btrim(item->>'commandId'))=0
          or not ((exit_node#>'{artifactOutputs,outputKeys}') ? btrim(item->>'outputKey')))
      or (select count(distinct btrim(item->>'outputKey')) from jsonb_array_elements(artifacts->'outputs') item)
        is distinct from jsonb_array_length(artifacts->'outputs')::bigint then
      raise exception 'WORKFLOW_ARTIFACT_OUTPUT_KEYS_MISMATCH';
    end if;
    envelope := envelope-'artifactOutputs';
  end if;
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
` }
