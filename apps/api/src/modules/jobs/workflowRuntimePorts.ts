import type { JobArtifact } from '@foreman-code/contracts/jobs'
import type { JobExecutionRecord, PreparedJobSpecRecord } from '@foreman-code/contracts/job-verification'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { RepeatNodeRef, RepeatResolution } from '../runs/repeatResolution.js'
import type { WorkflowJobPreparation } from './workflowPreparation.js'

export type WorkflowJobAdmission={kind:'waiting'}|{kind:'resolved';resolution:RepeatResolution}
  |{kind:'preparation';preparation:WorkflowJobPreparation;ref:RepeatNodeRef}|{kind:'admitted';execution:JobExecutionRecord}
/** Narrow composition on the one existing Run owner/graph. No scheduler or provider identifiers. */
export interface WorkflowJobLockedPort {
  admitPrepared(sql:GraphTransactionSql,ref:RepeatNodeRef,preparation:WorkflowJobPreparation,spec:PreparedJobSpecRecord):Promise<JobExecutionRecord>
  read(sql:GraphTransactionSql,executionId:string):Promise<JobExecutionRecord>
  artifacts(sql:GraphTransactionSql,execution:JobExecutionRecord):Promise<JobArtifact[]>
  verifyResult(sql:GraphTransactionSql,execution:JobExecutionRecord):Promise<void>
}
export interface WorkflowJobDriver {
  /** Source/byte I/O happens outside the owner's GraphTransactionSql. */
  prepare(preparation:WorkflowJobPreparation,signal:AbortSignal):Promise<PreparedJobSpecRecord>
  observe(execution:JobExecutionRecord,signal:AbortSignal,observe:()=>Promise<JobExecutionRecord>):Promise<void>
}
