/** CI state changes and their Run activity commit in the same transaction. */
export const agentCiActivityMigration = { version: 2026100901, sql: String.raw`
create function record_agent_ci_activity(ticket jsonb, phase text, outcome text) returns void
language sql volatile security invoker as $$
  insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
  select r.id,'backend','ci_state_changed',e.id,clock_timestamp(),jsonb_build_object(
    'ticketId',ticket->>'id','jobExecutionId',ticket->>'executionId',
    'jobAttemptId',ticket->>'attemptId','jobOperationId',ticket->>'operationId',
    'state',phase,'outcome',outcome,'suite',ticket #>> '{definition,spec,verification,suite}')
  from runs r join harness_executions e on e.run_id=r.id
    and e.id=ticket #>> '{initiatingAgent,executionId}'
    and e.agent_id=ticket #>> '{initiatingAgent,agentId}'
  where r.id=ticket #>> '{initiatingAgent,runId}'
    and r.workspace_id=ticket->>'workspaceId'
    and r.workflow_id=ticket #>> '{initiatingAgent,workflowId}';
$$;

create function record_agent_ci_queue_activity() returns trigger
language plpgsql security invoker as $$
declare phase text; outcome text;
begin
  if NEW.record->'initiatingAgent' is null then return NEW; end if;
  if TG_OP='UPDATE' and OLD.record->>'state' is not distinct from NEW.record->>'state' then return NEW; end if;
  if NEW.record->>'state' in ('waiting','blocked') then phase := 'queued';
  elsif NEW.record->>'state'='claimed' then phase := 'preparing';
  elsif NEW.record->>'state'='terminal' and NEW.record->>'terminalReason'<>'completed' then
    phase := 'terminal'; outcome := NEW.record->>'terminalReason';
  else return NEW;
  end if;
  perform record_agent_ci_activity(NEW.record,phase,outcome);
  return NEW;
end $$;
create trigger agent_ci_queue_activity after insert or update of record on job_admission_queue
for each row execute function record_agent_ci_queue_activity();

create function record_agent_ci_process_activity() returns trigger
language plpgsql security invoker as $$
declare ticket jsonb;
begin
  if NEW.record->'initiatingAgent' is null then return NEW; end if;
  if TG_OP='UPDATE' and OLD.record->'process' is not distinct from NEW.record->'process' then return NEW; end if;
  select q.record into ticket from job_admission_queue q
  where q.workspace_id=NEW.workspace_id and q.execution_id=NEW.id
    and q.attempt_id=NEW.attempt_id and q.operation_id=NEW.operation_id
    and q.definition_version_id=NEW.definition_version_id
    and q.record->'initiatingAgent'=NEW.record->'initiatingAgent';
  if ticket is not null then
    perform record_agent_ci_activity(ticket,NEW.record #>> '{process,phase}',NEW.record #>> '{process,outcome}');
  end if;
  return NEW;
end $$;
create trigger agent_ci_process_activity after insert or update of record on job_executions
for each row execute function record_agent_ci_process_activity();

-- Retained requests get one observation of their present state, not invented historical transitions.
select record_agent_ci_activity(q.record,
  coalesce(j.record #>> '{process,phase}',case q.record->>'state'
    when 'terminal' then 'terminal' when 'claimed' then 'preparing' else 'queued' end),
  coalesce(j.record #>> '{process,outcome}',q.record->>'terminalReason'))
from job_admission_queue q left join job_executions j on j.id=q.execution_id
  and j.workspace_id=q.workspace_id and j.record->'initiatingAgent'=q.record->'initiatingAgent'
where q.record->'initiatingAgent' is not null;
` }
