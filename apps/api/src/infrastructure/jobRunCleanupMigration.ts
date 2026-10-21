/** Additive stop-only owner receipt on the existing job intent, not a queue. */
export const jobRunCleanupMigration={version:283806,sql:String.raw`
alter table job_dispatch_intents add column cancel_cleanup jsonb;
alter table job_dispatch_intents add constraint job_cleanup_actual_subject check(cancel_cleanup is null or (
 (jsonb_typeof(cancel_cleanup)='object' and cancel_cleanup ?& array['schemaVersion','id','commandId','workspaceId','workflowId','workflowVersionId','runId','nodeId','nodeExecutionId','executionId','attemptId','operationId','bindingHash','jobOwner','runOwner','reason','cleanupRequestedAt','requestedAt']
 and cancel_cleanup->>'schemaVersion'='1' and cancel_cleanup->>'executionId'=execution_id
 and cancel_cleanup->>'commandId'=cancel_command_id
 and cancel_cleanup->>'attemptId'=intent->>'attemptId'
 and cancel_cleanup->>'operationId'=intent->>'operationId'
 and cancel_cleanup->>'bindingHash'=intent->>'bindingHash'
 and cancel_cleanup->'jobOwner'=intent->'owner'
 and intent->'subject'->>'kind'='workflow-node'
 and cancel_cleanup->>'runId'=intent->'subject'->>'runId'
 and cancel_cleanup->>'nodeId'=intent->'subject'->>'nodeId'
 and cancel_cleanup->>'nodeExecutionId'=intent->'subject'->>'nodeExecutionId'
 and cancel_cleanup->>'workflowId'=intent->'subject'->>'workflowId'
 and cancel_cleanup->>'workspaceId'=workspace_id) is true));
create function preserve_job_run_cleanup() returns trigger language plpgsql as $$ begin
 if old.cancel_cleanup is not null and new.cancel_cleanup is distinct from old.cancel_cleanup then
  raise exception 'JOB_CLEANUP_IMMUTABLE';
 end if;
 return new;
end $$;
create trigger job_run_cleanup_immutable before update on job_dispatch_intents for each row execute function preserve_job_run_cleanup();
`}
