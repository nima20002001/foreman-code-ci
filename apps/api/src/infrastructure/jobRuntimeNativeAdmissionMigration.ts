/** Native diagnostic authority remains on its original human approval row. */
export const jobRuntimeNativeAdmissionMigration={version:283809,sql:String.raw`
alter table job_runtime_qualification_approvals add column native_admission jsonb;
alter table job_runtime_qualification_approvals add constraint job_runtime_native_admission_subject check (
 native_admission is null or (
  jsonb_typeof(native_admission)='object' and
  native_admission ?& array['kind','approvalId','qualificationId','operationId','workspaceId','profileId','profileRevision','runCommandId','runPrincipalId','approvedByPrincipalId','leaseId'] and
  run_command_id is not null and run_principal_id is not null and approved_by is not null and
  native_admission->>'kind'='job-runtime-qualification' and
  native_admission->>'approvalId'=id::text and
  native_admission->>'qualificationId'=qualification_id::text and
  native_admission->>'operationId'=qualification_id::text and
  native_admission->>'workspaceId'=workspace_id and
  native_admission->>'profileId'=profile_id and
  native_admission->>'profileRevision'=profile_revision::text and
  native_admission->>'runCommandId'=run_command_id and
  native_admission->>'runPrincipalId'=run_principal_id and
  native_admission->>'approvedByPrincipalId'=approved_by
 )
);
create unique index job_runtime_native_admission_lease on job_runtime_qualification_approvals ((native_admission->>'leaseId')) where native_admission is not null;
create function preserve_job_runtime_native_admission() returns trigger language plpgsql as $$ begin
 if old.native_admission is not null and new.native_admission is distinct from old.native_admission then
  raise exception 'JOB_RUNTIME_NATIVE_ADMISSION_IMMUTABLE';
 end if;
 return new;
end $$;
create trigger job_runtime_native_admission_immutable before update on job_runtime_qualification_approvals for each row execute function preserve_job_runtime_native_admission();
`}
