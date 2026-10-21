import { repeatOccurrenceMigrationSql } from './repeatOccurrenceMigration.js'
/** Existing Run slots, input bindings, results and resolutions now reference either
 * a real HarnessExecution or a real JobExecution. Historical JSON is untouched. */
function replacement(name:string,variables:string,branch:string) {
  const source=repeatOccurrenceMigrationSql.match(new RegExp(`create function ${name}\\(\\)[\\s\\S]*?end \\$\\$;`))?.[0]
  if(!source)throw new Error(`Current workflow guard ${name} changed.`)
  return source.replace(`create function ${name}(`,`create or replace function ${name}(`)
    .replace('begin\n',`${variables}\nbegin\n${branch}\n`)
}
const executionGuard=replacement('assert_repeat_execution_evidence','  job_record jsonb; job_node jsonb; job_input jsonb;',String.raw`
  if new.executor_kind='job' then
    perform repeat_node_scope(new.run_id,new.workflow_node_id,new.occurrence_id);
    select j.record into strict job_record from job_executions j where j.id=new.execution_id;
    select n into strict job_node from jsonb_array_elements(repeat_pinned_version(new.run_id) #> '{definition,nodes}') n where n->>'id'=new.workflow_node_id;
    expected := jsonb_build_object('kind','job','executionId',new.execution_id,'workflowNodeId',new.workflow_node_id,
      'jobDefinitionId',job_node->>'jobDefinitionId','jobDefinitionVersionId',job_node->>'jobDefinitionVersionId','attempt',1);
    if new.occurrence_id is not null then expected:=expected||jsonb_build_object('occurrence',(select record->'identity' from run_repeat_occurrences where occurrence_id=new.occurrence_id)); end if;
    select input_json::jsonb into strict input from run_repeat_slots where slot_id=new.slot_id;
    if job_node->>'kind' is distinct from 'job' or new.technical_attempt<>1 or new.previous_execution_id is not null
      or new.identity is distinct from expected or job_record #>> '{workflow,runId}' is distinct from new.run_id
      or job_record #>> '{workflow,nodeId}' is distinct from new.workflow_node_id
      or job_record #>> '{workflow,nodeExecutionId}' is distinct from new.execution_id
      or job_record #>> '{acceptedSpec,definitionId}' is distinct from job_node->>'jobDefinitionId'
      or job_record #>> '{acceptedSpec,definitionVersionId}' is distinct from job_node->>'jobDefinitionVersionId'
      or job_record #> '{acceptedSpec,workflowInput}' is distinct from input
      or not exists(select 1 from workflow_job_executions w where w.run_id=new.run_id and w.node_execution_id=new.execution_id and w.job_execution_id=new.execution_id and w.input_json::jsonb=input)
      then raise exception 'JOB_WORKFLOW_EXECUTION_PIN_CONFLICT'; end if;
    expected_bindings:=jsonb_array_length(input->'predecessors');
    if input->'entry'<>'null'::jsonb then expected_bindings:=expected_bindings+jsonb_array_length(input #> '{entry,external}')+case when input #> '{entry,carry}'<>'null'::jsonb then 1 else 0 end; end if;
    if expected_bindings is null or (select count(*) from run_repeat_bindings where recipient_execution_id=new.execution_id)<>expected_bindings
      or exists(select 1 from run_repeat_bindings where recipient_execution_id=new.execution_id and ordinal>=expected_bindings) then raise exception 'JOB_WORKFLOW_INPUTS_INCOMPLETE'; end if;
    return null;
  end if;
`)
const resultGuard=replacement('assert_repeat_accepted_result','  job_record jsonb; result jsonb; data jsonb;',String.raw`
  if exists(select 1 from run_repeat_executions x where x.execution_id=new.execution_id and x.executor_kind='job') then
    select j.record into strict job_record from job_executions j where j.id=new.execution_id;
    result:=new.result_json::jsonb; data:=coalesce(result #> '{output,data}',result->'output');
    if job_record #>> '{workflow,runId}' is distinct from new.run_id
      or job_record #>> '{process,phase}' is distinct from 'terminal' or job_record #> '{process,processStopped}' is distinct from 'true'::jsonb
      or job_record->>'publication' not in ('complete','failed','expired') or result->>'outcome' is distinct from 'succeeded'
      or data #>> '{latestDeliverable,jobExecutionId}' is distinct from new.execution_id
      or data #> '{latestDeliverable,process}' is distinct from jsonb_build_object('outcome',job_record #>> '{process,outcome}','exitCode',job_record #> '{process,exitCode}','signal',job_record #> '{process,signal}')
      or not exists(select 1 from workflow_job_executions w where w.run_id=new.run_id and w.job_execution_id=new.execution_id and w.accepted)
      then raise exception 'JOB_WORKFLOW_RESULT_NOT_ACCEPTED'; end if;
    return null;
  end if;
`)
export const workflowJobsMigration={version:283803,sql:String.raw`
alter table run_repeat_executions drop constraint run_repeat_executions_execution_id_fkey;
alter table run_repeat_executions add column executor_kind text generated always as (coalesce(identity->>'kind','agent')) stored;
alter table run_repeat_executions add constraint workflow_executor_kind check(executor_kind in ('agent','job'));
alter table run_repeat_executions add column harness_execution_id text generated always as (case when coalesce(identity->>'kind','agent')='agent' then execution_id end) stored;
alter table run_repeat_executions add column job_execution_id text generated always as (case when identity->>'kind'='job' then execution_id end) stored;
alter table run_repeat_executions add foreign key(harness_execution_id) references harness_executions(id) on delete cascade deferrable initially deferred;
alter table run_repeat_executions add foreign key(job_execution_id) references job_executions(id) on delete cascade deferrable initially deferred;
`+executionGuard+resultGuard}
