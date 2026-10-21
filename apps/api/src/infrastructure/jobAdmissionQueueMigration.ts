export const jobAdmissionQueueMigration = { version: 285901, sql: String.raw`
create sequence job_admission_queue_sequence as bigint minvalue 1 no cycle;
create table job_admission_queue (
 id uuid primary key,
 workspace_id text not null references workspaces(id),
 principal_id text not null references management_principals(id),
 command_id text not null,
 execution_id text not null unique,
 enqueue_sequence bigint not null unique check(enqueue_sequence>0),
 record jsonb not null,
 definition_version_id text generated always as (record #>> '{definition,versionId}') stored not null
  references job_definition_versions(id),
 attempt_id text generated always as (record->>'attemptId') stored not null unique,
 operation_id text generated always as (record->>'operationId') stored not null unique,
 check(length(command_id)>0 and length(execution_id)>0 and length(attempt_id)>0 and length(operation_id)>0),
 backfill_claims integer not null default 0 check(backfill_claims>=0),
 diagnostic_codes jsonb not null default '[]'::jsonb
  check(jsonb_typeof(diagnostic_codes)='array'),
 owner_id text,
 owner_fence text,
 unique(principal_id,command_id),
 check(jsonb_typeof(record)='object' and record ?& array[
  'schemaVersion','id','workspaceId','principalId','commandId','commandDigest','definition',
  'executionId','attemptId','operationId','resources','placement','placementOverride','workflow','gateId',
  'revision','enqueueSequence','enqueuedAt','deadlineAt','state','waitingReasons','compatibleTargetCount',
  'queuePosition','estimatedStartAt','reservationId','cancelRequestedAt','terminalReason','finishedAt'
 ]),
 check(coalesce(record->>'schemaVersion'='1'
  and record->>'id'=id::text and record->>'workspaceId'=workspace_id
  and record->>'principalId'=principal_id and record->>'commandId'=command_id
  and record->>'executionId'=execution_id and record->>'enqueueSequence'=enqueue_sequence::text
  and record #>> '{definition,workspaceId}'=workspace_id, false)),
 check(jsonb_typeof(record->'revision')='number'
  and (record->>'revision')::numeric between 1 and 9007199254740991
  and (record->>'revision')::numeric=trunc((record->>'revision')::numeric)),
 check(coalesce(record->>'commandDigest' ~ '^[a-f0-9]{64}$', false)),
 check(coalesce(record->>'state' in ('waiting','blocked','claimed','accepted','terminal'), false)),
 check(jsonb_typeof(record->'waitingReasons')='array'),
 check(coalesce(record->'reservationId'='null'::jsonb or record->>'reservationId'=id::text, false)),
 check(coalesce((record->>'state' in ('claimed','accepted') and record->>'reservationId'=id::text)
  or (record->>'state' in ('waiting','blocked') and record->'reservationId'='null'::jsonb)
  or record->>'state'='terminal', false)),
 check(coalesce((record->>'state'='terminal'
  and record->>'terminalReason' in ('cancelled','timed_out','authorization_revoked','request_exceeds_maximum')
  and record->>'finishedAt' is not null)
  or (record->>'state'<>'terminal' and record->'terminalReason'='null'::jsonb
  and record->'finishedAt'='null'::jsonb), false)),
 check(record->>'terminalReason' is distinct from 'cancelled' or record->>'cancelRequestedAt' is not null),
 check(coalesce((record->>'deadlineAt')::timestamptz-(record->>'enqueuedAt')::timestamptz
  = ((record #>> '{definition,spec,policy,queueTimeoutMs}')::bigint * interval '1 millisecond'), false)),
 check((owner_id is null)=(owner_fence is null)),
 check(owner_id is null or (owner_id ~ '^[1-9][0-9]*$' and owner_fence ~ '^[1-9][0-9]*$'))
);
create index job_admission_queue_pending on job_admission_queue(enqueue_sequence)
 where record->>'state' in ('waiting','blocked','claimed');
create index job_admission_queue_workspace on job_admission_queue(workspace_id,enqueue_sequence desc);

create function preserve_job_admission_queue() returns trigger language plpgsql as $$
declare
 saved_definition jsonb;
 previous_state text;
 next_state text;
 mutable_fields text[] := array['revision','state','waitingReasons','compatibleTargetCount','queuePosition',
  'estimatedStartAt','reservationId','cancelRequestedAt','terminalReason','finishedAt'];
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
  if (previous_state in ('waiting','blocked') and next_state not in ('waiting','blocked','claimed','terminal'))
   or (previous_state='claimed' and next_state not in ('claimed','accepted','terminal'))
   or (previous_state='accepted' and next_state<>'accepted')
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
 if next_state in ('claimed','accepted') and not exists(
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
 return NEW;
end $$;
create trigger job_admission_queue_immutable before insert or update or delete on job_admission_queue
 for each row execute function preserve_job_admission_queue();
` }
