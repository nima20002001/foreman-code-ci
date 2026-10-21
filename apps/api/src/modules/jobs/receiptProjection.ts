import { JobExecutionRecordSchema, type JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { RemoteJobOperationReceiptRecordSchema, type RemoteJobOperationReceiptRecord } from '@foreman-code/contracts/remote-job-execution'
import { DomainError } from '../errors.js'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { JobRepository, type JobSql } from './repository.js'
export interface JobCanonicalOutputVerifier {verifyRequiredOutputs(sql:JobSql,execution:JobExecutionRecord):Promise<void>}
/** Inside the original main owner transaction. Native exit and output delivery remain separate facts. */
export async function deriveJobReceiptLocked(sql:JobSql,original:JobExecutionRecord,raw:RemoteJobOperationReceiptRecord,outputs:JobCanonicalOutputVerifier):Promise<JobExecutionRecord> {
  const execution=JobExecutionRecordSchema.parse(original)
  const receipt=RemoteJobOperationReceiptRecordSchema.parse(raw)
  const subject=execution.workflow?{kind:'workflow-node',workspaceId:execution.workspaceId,...execution.workflow}
    :{kind:'manual-job',workspaceId:execution.workspaceId,jobExecutionId:execution.id,definitionId:execution.acceptedSpec.definitionId}
  if(receipt.intent.executionId!==execution.id||receipt.intent.attemptId!==execution.attemptId||receipt.intent.operationId!==execution.operationId
    ||receipt.intent.mainId!==execution.acceptedSpec.target.mainId||receipt.intent.bindingHash!==execution.acceptedSpec.bindingHash
    ||receipt.intent.inputDigest!==`sha256:${execution.acceptedSpec.specDigest}`||canonicalJson(receipt.intent.subject)!==canonicalJson(subject)
    ||canonicalJson(receipt.intent.owner)!==canonicalJson(execution.owner)||receipt.execution.id!==execution.id||receipt.execution.workspaceId!==execution.workspaceId
    ||receipt.execution.attemptId!==execution.attemptId||receipt.execution.operationId!==execution.operationId
    ||canonicalJson(receipt.execution.owner)!==canonicalJson(execution.owner)||canonicalJson(receipt.execution.workflow)!==canonicalJson(execution.workflow)) throw new DomainError('JOB_RECEIPT_PIN_CONFLICT','Observed receipt does not match accepted job facts.',409)
  if(canonicalJson(receipt.execution.acceptedSpec)!==canonicalJson(execution.acceptedSpec)) throw new DomainError('JOB_RECEIPT_SPEC_CONFLICT','Observed job specification changed after acceptance.',409)
  execution.transport='connected';execution.lastSeenAt=receipt.observedAt;execution.updatedAt=receipt.observedAt
  if(receipt.native?.startedAt) {
    if(execution.startedAt&&execution.startedAt!==receipt.native.startedAt)throw new DomainError('JOB_PROCESS_IDENTITY_CONFLICT','Original process start observation is immutable.',409)
    execution.startedAt=receipt.native.startedAt
  }
  if(receipt.terminal) {
    const terminal=receipt.terminal
    const process={phase:'terminal' as const,outcome:terminal.outcome,exitCode:terminal.exitCode,signal:terminal.signal,processStopped:terminal.processStopped}
    if(execution.process.phase==='terminal'&&(canonicalJson(execution.process)!==canonicalJson(process)||execution.finishedAt!==terminal.finishedAt)) throw new DomainError('JOB_TERMINAL_CONFLICT','Original process result is immutable.',409)
    execution.process=process;execution.finishedAt=terminal.finishedAt
    if(terminal.logGapPossible)execution.resultIssue='log_delivery_unknown'
    else if(execution.resultIssue==='log_delivery_unknown')execution.resultIssue=null
    if(terminal.logsTruncated)execution.resultIssue='log_overflow'
    if(receipt.publication==='complete') {
      try {await outputs.verifyRequiredOutputs(sql,execution);execution.publication='complete'} catch(error) {
        if(!(error instanceof DomainError)||!['JOB_REQUIRED_OUTPUT_MISSING','JOB_REQUIRED_OUTPUT_CORRUPT'].includes(error.code))throw error
        execution.publication='failed';execution.resultIssue=error.code==='JOB_REQUIRED_OUTPUT_MISSING'?'missing_output':error.code==='JOB_REQUIRED_OUTPUT_CORRUPT'?'corrupt_output':'publication_failed'
      }
    } else if(receipt.publication==='failed'||terminal.outputCollectionError) {execution.publication='failed';execution.resultIssue='publication_failed'}
    else execution.publication='collecting'
  } else if(execution.process.phase!=='terminal') {
    if(receipt.phase==='running'||receipt.phase==='start_acknowledged')execution.process.phase='running'
    else if(receipt.phase==='native_entry_attempted')execution.process.phase='preparing'
  }
  return JobExecutionRecordSchema.parse(execution)
}

/** Manual jobs have no Run graph. Workflow callers enlist the derived state in
 * publishWorkflowJobReceiptLocked before the same transaction mutates this row. */
export async function projectJobReceiptLocked(sql:JobSql,execution:JobExecutionRecord,raw:RemoteJobOperationReceiptRecord,outputs:JobCanonicalOutputVerifier):Promise<void> {
  const next=await deriveJobReceiptLocked(sql,execution,raw,outputs)
  await new JobRepository().putExecution(sql,next)
  Object.assign(execution,next)
}
