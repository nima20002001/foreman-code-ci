import type { JobRuntimeApprovalRecord, JobRuntimeFingerprintRecord, JobRuntimeProfileRecord,
  JobRuntimeQualificationResultRecord } from '@foreman-code/contracts/job-verification-runtime'
import type { JobSql } from './repository.js'
/** CI-A's concrete installed-host producer. Candidate reads metadata; only approved run may probe. */
export interface JobRuntimeQualificationProducer {
  capture(profile:JobRuntimeProfileRecord):Promise<JobRuntimeFingerprintRecord>
  reconcile?(approval:JobRuntimeApprovalRecord,signal:AbortSignal):Promise<JobRuntimeQualificationResultRecord>
  run(approval:JobRuntimeApprovalRecord,signal:AbortSignal):Promise<JobRuntimeQualificationResultRecord>
  /** Pure current HRT/W07/root metadata check. No CLI, filesystem probe, install or model invocation. */
  revalidate(sql:JobSql,profile:JobRuntimeProfileRecord):Promise<{ready:boolean;reasons:string[]}>
}

export type JobRuntimeQualificationResult = JobRuntimeQualificationResultRecord
