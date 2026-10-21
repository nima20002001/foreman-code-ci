export const jobSourceCapacityWaitMigration = { version: 286015, sql: String.raw`
alter table job_admission_queue drop constraint job_admission_queue_check3;
alter table job_admission_queue add constraint job_admission_queue_reservation_state check(coalesce(
 (record->>'state' in ('claimed','accepted') and record->>'reservationId'=id::text)
 or (record->>'state' in ('waiting','blocked') and record->'reservationId'='null'::jsonb)
 or (record->>'state'='waiting' and record->>'reservationId'=id::text and record ? 'sourceCapacityWait')
 or record->>'state'='terminal', false));
alter table job_admission_queue add constraint job_admission_queue_source_capacity_wait check(
 not (record ? 'sourceCapacityWait') or coalesce(
  record->>'state'='waiting' and record->>'reservationId'=id::text
  and record->'waitingReasons' @> '["busy"]'::jsonb
  and jsonb_typeof(record->'sourceCapacityWait')='object'
  and (record #>> '{sourceCapacityWait,attempts}')::bigint>0
  and (record #>> '{sourceCapacityWait,waitedMs}')::bigint>=0
  and (record #>> '{sourceCapacityWait,retryAt}')::timestamptz
    >= (record #>> '{sourceCapacityWait,startedAt}')::timestamptz, false));
create or replace function preserve_job_admission_queue() returns trigger language plpgsql as $$
declare
 saved_definition jsonb;
 previous_state text;
 next_state text;
 mutable_fields text[] := array['revision','state','waitingReasons','compatibleTargetCount','queuePosition',
  'estimatedStartAt','sourceCapacityWait','reservationId','cancelRequestedAt','terminalReason','finishedAt'];
begin
 if TG_OP='DELETE' then raise exception 'JOB_QUEUE_HISTORY_IMMUTABLE'; end if;
 next_state := NEW.record->>'state';
 if TG_OP='INSERT' then
  if next_state is distinct from 'waiting' or NEW.record->>'revision' is distinct from '1'
   or NEW.record->'reservationId' is distinct from 'null'::jsonb
   or NEW.record->'cancelRequestedAt' is distinct from 'null'::jsonb
   or NEW.owner_id is not null or NEW.owner_fence is not null then
   raise exception 'JOB_QUEUE_INITIAL_STATE_INVALID';
  end if;
  select record into saved_definition from job_definition_versions
   where id=NEW.record #>> '{definition,versionId}' and workspace_id=NEW.workspace_id;
  if saved_definition is distinct from NEW.record->'definition' then
   raise exception 'JOB_QUEUE_DEFINITION_CONFLICT';
  end if;
  if exists(select 1 from job_preparations p where p.execution_id=NEW.execution_id
   or p.attempt_id=NEW.record->>'attemptId' or p.operation_id=NEW.record->>'operationId'
   or (p.principal_id=NEW.principal_id and p.command_id=NEW.command_id))
   or exists(select 1 from job_executions e where e.id=NEW.execution_id
   or e.attempt_id=NEW.record->>'attemptId' or e.operation_id=NEW.record->>'operationId') then
   raise exception 'JOB_QUEUE_IDENTITY_CONFLICT';
  end if;
 else
  -- Generated identities are computed after BEFORE triggers; the frozen record protects their inputs.
  if (to_jsonb(NEW)-array['record','backfill_claims','diagnostic_codes','owner_id','owner_fence',
    'definition_version_id','attempt_id','operation_id'])
   is distinct from (to_jsonb(OLD)-array['record','backfill_claims','diagnostic_codes','owner_id','owner_fence',
    'definition_version_id','attempt_id','operation_id'])
   or NEW.record-mutable_fields is distinct from OLD.record-mutable_fields then
   raise exception 'JOB_QUEUE_REQUEST_IMMUTABLE';
  end if;
  if NEW.record is distinct from OLD.record and (
   NEW.record-'revision'=OLD.record-'revision'
   or (NEW.record->>'revision')::bigint<>(OLD.record->>'revision')::bigint+1) then
   raise exception 'JOB_QUEUE_REVISION_CONFLICT';
  end if;
  if OLD.record->>'reservationId' is not null
   and NEW.record->'reservationId' is distinct from OLD.record->'reservationId' then
   raise exception 'JOB_QUEUE_RESERVATION_IMMUTABLE';
  end if;
  if OLD.record->>'cancelRequestedAt' is not null
   and NEW.record->'cancelRequestedAt' is distinct from OLD.record->'cancelRequestedAt' then
   raise exception 'JOB_QUEUE_CANCELLATION_IMMUTABLE';
  end if;
  previous_state := OLD.record->>'state';
  if (previous_state in ('waiting','blocked') and next_state not in ('waiting','blocked','claimed','terminal')
    and not (OLD.record ? 'sourceCapacityWait' and next_state='accepted'))
   or (previous_state='claimed' and next_state not in ('claimed','accepted','terminal')
    and not (next_state='waiting' and NEW.record ? 'sourceCapacityWait'))
   or (previous_state='accepted' and (next_state not in ('accepted','terminal')
    or (next_state='terminal' and NEW.record->>'terminalReason' is distinct from 'completed')))
   or (previous_state in ('waiting','blocked','claimed') and NEW.record->>'terminalReason'='completed')
   or (previous_state='terminal' and NEW.record is distinct from OLD.record) then
   raise exception 'JOB_QUEUE_STATE_CONFLICT';
  end if;
  if NEW.backfill_claims<OLD.backfill_claims then raise exception 'JOB_QUEUE_BACKFILL_CONFLICT'; end if;
 end if;
 if NEW.record->>'reservationId' is not null and not exists(
  select 1 from job_computer_selections s where s.execution_id=NEW.execution_id
   and s.workspace_id=NEW.workspace_id and s.definition_version_id=NEW.record #>> '{definition,versionId}'
   and s.attempt_id=NEW.record->>'attemptId' and s.operation_id=NEW.record->>'operationId'
   and s.limits=NEW.record #> '{resources,limits}') then
  raise exception 'JOB_QUEUE_SELECTION_CONFLICT';
 end if;
 if (next_state in ('claimed','accepted') or NEW.record ? 'sourceCapacityWait') and not exists(
  select 1 from job_preparations p where p.execution_id=NEW.execution_id
   and p.workspace_id=NEW.workspace_id and p.definition_version_id=NEW.record #>> '{definition,versionId}'
   and p.attempt_id=NEW.record->>'attemptId' and p.operation_id=NEW.record->>'operationId'
   and p.principal_id=NEW.principal_id and p.command_id=NEW.command_id and p.definition=NEW.record->'definition') then
  raise exception 'JOB_QUEUE_PREPARATION_CONFLICT';
 end if;
 if next_state='accepted' and not exists(
  select 1 from job_executions e where e.id=NEW.execution_id and e.workspace_id=NEW.workspace_id
   and e.definition_version_id=NEW.record #>> '{definition,versionId}'
   and e.attempt_id=NEW.record->>'attemptId' and e.operation_id=NEW.record->>'operationId'
   and e.accepted_by=NEW.principal_id) then
  raise exception 'JOB_QUEUE_ACCEPTANCE_CONFLICT';
 end if;
 if next_state='terminal' and NEW.record->>'terminalReason'='completed' and not exists(
  select 1 from job_executions e where e.id=NEW.execution_id and e.workspace_id=NEW.workspace_id
   and e.definition_version_id=NEW.record #>> '{definition,versionId}'
   and e.attempt_id=NEW.record->>'attemptId' and e.operation_id=NEW.record->>'operationId'
   and e.accepted_by=NEW.principal_id
   and e.record #>> '{process,phase}'='terminal' and e.record #> '{process,processStopped}'='true'::jsonb
   and e.record->>'publication' not in ('pending','collecting')
   and e.record->>'finishedAt'=NEW.record->>'finishedAt') then
  raise exception 'JOB_QUEUE_COMPLETION_UNCONFIRMED';
 end if;
 return NEW;
end $$;
` } as const
