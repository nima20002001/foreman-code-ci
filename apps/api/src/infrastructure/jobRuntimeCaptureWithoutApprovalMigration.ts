/** CI qualification runs a captured candidate directly on a paired, authorized computer. A native
 * admission keeps its exact run owner and candidate, but no longer names an approver. */
export const jobRuntimeCaptureWithoutApprovalMigration = { version: 2026100605, sql: String.raw`
alter table job_runtime_qualification_approvals drop constraint job_runtime_native_admission_subject;
alter table job_runtime_qualification_approvals add constraint job_runtime_native_admission_subject check (
 native_admission is null or (
  jsonb_typeof(native_admission)='object' and
  native_admission ?& array['kind','approvalId','qualificationId','operationId','workspaceId','profileId','profileRevision','runCommandId','runPrincipalId','leaseId'] and
  run_command_id is not null and run_principal_id is not null and
  native_admission->>'kind'='job-runtime-qualification' and
  native_admission->>'approvalId'=id::text and
  native_admission->>'qualificationId'=qualification_id::text and
  native_admission->>'operationId'=qualification_id::text and
  native_admission->>'workspaceId'=workspace_id and
  native_admission->>'profileId'=profile_id and
  native_admission->>'profileRevision'=profile_revision::text and
  native_admission->>'runCommandId'=run_command_id and
  native_admission->>'runPrincipalId'=run_principal_id and
  (native_admission->>'approvedByPrincipalId' is null or native_admission->>'approvedByPrincipalId'=approved_by)
 )
);
` }
