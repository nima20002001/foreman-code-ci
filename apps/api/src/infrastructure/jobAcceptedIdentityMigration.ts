/** Original job and W08 subjects are immutable accepted facts. Mutable main
 * session ownership and observed process/transport/publication remain separate. */
export const jobAcceptedIdentityMigration={version:283807,sql:String.raw`
create function preserve_job_accepted_identity() returns trigger language plpgsql as $$ begin
 if new.id is distinct from old.id
 or new.record->'id' is distinct from old.record->'id'
 or new.record->'workspaceId' is distinct from old.record->'workspaceId'
 or new.record->'operationId' is distinct from old.record->'operationId'
 or new.record->'attemptId' is distinct from old.record->'attemptId'
 or new.record->'owner' is distinct from old.record->'owner'
 or new.record->'workflow' is distinct from old.record->'workflow' then
  raise exception 'JOB_ACCEPTED_IDENTITY_IMMUTABLE';
 end if;return new;
end $$;
create trigger job_accepted_identity_immutable before update on job_executions for each row execute function preserve_job_accepted_identity();
create function preserve_job_dispatch_identity() returns trigger language plpgsql as $$ begin
 if new.execution_id is distinct from old.execution_id or new.workspace_id is distinct from old.workspace_id or new.intent is distinct from old.intent then
  raise exception 'JOB_DISPATCH_IDENTITY_IMMUTABLE';
 end if;return new;
end $$;
create trigger job_dispatch_identity_immutable before update on job_dispatch_intents for each row execute function preserve_job_dispatch_identity();
`}
