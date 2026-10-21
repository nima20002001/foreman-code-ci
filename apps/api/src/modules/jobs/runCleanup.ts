import { JobWorkflowExecutionReferenceSchema } from '@foreman-code/contracts/job-workflow'
import { randomUUID } from 'node:crypto'
import { AcceptedWorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import { JobRunCleanupSchema,type JobRunCleanup } from '@foreman-code/contracts/job-run-cleanup'
import type { JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { RemoteJobDispatchIntentSchema } from '@foreman-code/contracts/remote-job-execution'
import { assertGraphTransaction,beforeGraphCommit,type GraphTransactionSql } from '../run-graph/connection.js'
import type { RunOwnership } from '../runs/ownership.js'
import { DomainError } from '../errors.js'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { JobRepository, type JobSql } from './repository.js'

export function requireCleanupPins(execution:JobExecutionRecord,cleanup:JobRunCleanup) {
  if(!execution.workflow||cleanup.workspaceId!==execution.workspaceId||cleanup.workflowId!==execution.workflow.workflowId||cleanup.runId!==execution.workflow.runId||cleanup.nodeId!==execution.workflow.nodeId||cleanup.nodeExecutionId!==execution.workflow.nodeExecutionId||cleanup.executionId!==execution.id||cleanup.attemptId!==execution.attemptId||cleanup.operationId!==execution.operationId||cleanup.bindingHash!==execution.acceptedSpec.bindingHash||canonicalJson(cleanup.jobOwner)!==canonicalJson(execution.owner))throw new DomainError('JOB_CLEANUP_PIN_CONFLICT','Owned cleanup cannot stop another placement, attempt or operation.',409)
}
async function requireRunJobMapping(sql:JobSql,execution:JobExecutionRecord,workflowVersionId:string) {
  const workflow=execution.workflow
  if(!workflow)throw new DomainError('JOB_CLEANUP_PIN_CONFLICT','Manual jobs cannot borrow a Run-node mapping.',409)
  const row=(await sql.query<{reference:unknown;run_id:string;node_execution_id:string;job_execution_id:string}>('select reference,run_id,node_execution_id,job_execution_id from workflow_job_executions where job_execution_id=$1',[execution.id])).rows[0]
  if(!row||row.run_id!==workflow.runId||row.node_execution_id!==workflow.nodeExecutionId||row.job_execution_id!==execution.id)throw new DomainError('JOB_CLEANUP_PIN_CONFLICT','The authoritative Run-node-to-Job relationship is missing.',409)
  const reference=JobWorkflowExecutionReferenceSchema.parse(row.reference)
  if(reference.workspaceId!==execution.workspaceId||reference.workflowId!==workflow.workflowId||reference.workflowVersionId!==workflowVersionId||reference.runId!==workflow.runId||reference.nodeId!==workflow.nodeId||reference.nodeExecutionId!==workflow.nodeExecutionId||reference.jobExecutionId!==execution.id)throw new DomainError('JOB_CLEANUP_PIN_CONFLICT','The original accepted Run-node-to-Job relationship changed.',409)
}
/** Request is recorded before any native control. Existing Run cleanup must
 * already be persisted by the common lifecycle before it aborts job drivers. */
export async function requestRunJobCleanup(sql:GraphTransactionSql,execution:JobExecutionRecord,owner:RunOwnership,reason:JobRunCleanup['reason']):Promise<JobRunCleanup> {
  assertGraphTransaction(sql);owner.assertOwned()
  if(execution.workflow?.runId!==owner.runId)throw new DomainError('JOB_CLEANUP_PIN_CONFLICT','Cleanup belongs to a different actual Run owner.',409)
  const readAuthority=async()=>{
    const fence=await owner.readOneShotFence(sql)
    const row=(await sql.query<{record:unknown;requested_at:Date;stopped:boolean}>(`select r.record,c.requested_at,r.stop_requested_at is not null as stopped from runs r join run_cleanup_intents c on c.run_id=r.id where r.id=$1 and c.pending for update of r,c`,[owner.runId])).rows[0]
    if(!row)throw new DomainError('JOB_CLEANUP_AUTHORITY_MISSING','Persist the real Run cleanup intent before aborting owned jobs.',409)
    const run=AcceptedWorkflowRunV3Schema.parse(row.record)
    if(run.workspaceId!==execution.workspaceId||run.workflowId!==execution.workflow!.workflowId)throw new DomainError('JOB_CLEANUP_PIN_CONFLICT','Cleanup must use the accepted Job Run scope.',409)
    await requireRunJobMapping(sql,execution,run.workflowVersionId)
    return {run,fence,stopped:row.stopped,requestedAt:row.requested_at.toISOString()}
  }
  const actual=await readAuthority()
  const row=(await sql.query<{intent:unknown;cancel_command_id:string|null;cancel_cleanup:unknown}>(`select intent,cancel_command_id,cancel_cleanup from job_dispatch_intents where execution_id=$1 for update`,[execution.id])).rows[0]
  if(!row)throw new DomainError('JOB_DISPATCH_MISSING','The original job intent is missing.',409)
  const intent=RemoteJobDispatchIntentSchema.parse(row.intent)
  if(intent.subject.kind!=='workflow-node'||intent.subject.runId!==owner.runId||intent.bindingHash!==execution.acceptedSpec.bindingHash||intent.attemptId!==execution.attemptId||intent.operationId!==execution.operationId||canonicalJson(intent.owner)!==canonicalJson(execution.owner))throw new DomainError('JOB_CLEANUP_PIN_CONFLICT','The job cleanup target changed.',409)
  if(row.cancel_cleanup){const existing=JobRunCleanupSchema.parse(row.cancel_cleanup);requireCleanupPins(execution,existing);return existing}
  if(reason==='run-stop'&&!actual.stopped)throw new DomainError('JOB_CLEANUP_REASON_CONFLICT','A user Stop reason requires the actual persisted Run Stop.',409)
  const cleanup=JobRunCleanupSchema.parse({schemaVersion:1,id:randomUUID(),commandId:row.cancel_command_id??randomUUID(),workspaceId:execution.workspaceId,workflowId:actual.run.workflowId,workflowVersionId:actual.run.workflowVersionId,runId:owner.runId,nodeId:execution.workflow.nodeId,nodeExecutionId:execution.workflow.nodeExecutionId,executionId:execution.id,attemptId:execution.attemptId,operationId:execution.operationId,bindingHash:execution.acceptedSpec.bindingHash,jobOwner:execution.owner,runOwner:actual.fence,reason:actual.stopped?'run-stop':reason,cleanupRequestedAt:actual.requestedAt,requestedAt:new Date().toISOString()})
  beforeGraphCommit(sql,async()=>{const current=await readAuthority();if(canonicalJson(current.fence)!==canonicalJson(actual.fence)||current.run.workflowVersionId!==cleanup.workflowVersionId||current.requestedAt!==cleanup.cleanupRequestedAt)throw new DomainError('JOB_CLEANUP_AUTHORITY_CHANGED','The original Run cleanup authority changed before commit.',409)})
  await sql.query('update job_dispatch_intents set cancel_command_id=$2,cancel_cleanup=$3::jsonb where execution_id=$1',[execution.id,cleanup.commandId,JSON.stringify(cleanup)])
  const repository=new JobRepository(),current=await repository.execution(sql,execution.workspaceId,execution.id,true)
  requireCleanupPins(current,cleanup)
  if(current.process.phase!=='terminal'){current.cancelRequestedAt??=cleanup.requestedAt;current.updatedAt=cleanup.requestedAt;await repository.putExecution(sql,current)}
  await requireRunJobMapping(sql,execution,cleanup.workflowVersionId)
  return cleanup
}
/** The committed receipt may outlive its Run owner session. Reconciliation only
 * uses this original stop authority; it never authorizes a fresh launch/publication. */
export async function readRunJobCleanup(sql:JobSql,execution:JobExecutionRecord):Promise<JobRunCleanup|null> {
  const row=(await sql.query<{cancel_cleanup:unknown;cancel_command_id:string|null}>('select cancel_cleanup,cancel_command_id from job_dispatch_intents where execution_id=$1 for share',[execution.id])).rows[0]
  if(!row?.cancel_cleanup)return null
  const cleanup=JobRunCleanupSchema.parse(row.cancel_cleanup);requireCleanupPins(execution,cleanup)
  if(cleanup.commandId!==row.cancel_command_id)throw new DomainError('JOB_CLEANUP_PIN_CONFLICT','Original cleanup command identity changed.',409)
  // Run -> Job is the graph lock order. This is immutable scope readback of a
  // committed owner receipt, not a new Run authorization or launch grant.
  const run=(await sql.query<{record:unknown;requested_at:Date}>(`select r.record,c.requested_at from runs r join run_cleanup_intents c on c.run_id=r.id where r.id=$1`,[cleanup.runId])).rows[0]
  if(!run)throw new DomainError('JOB_CLEANUP_AUTHORITY_MISSING','The original Run cleanup authority disappeared.',409)
  const accepted=AcceptedWorkflowRunV3Schema.parse(run.record)
  if(accepted.workspaceId!==cleanup.workspaceId||accepted.workflowId!==cleanup.workflowId||accepted.workflowVersionId!==cleanup.workflowVersionId||run.requested_at.toISOString()!==cleanup.cleanupRequestedAt)throw new DomainError('JOB_CLEANUP_PIN_CONFLICT','The original accepted Run cleanup scope changed.',409)
  await requireRunJobMapping(sql,execution,cleanup.workflowVersionId)
  return cleanup
}
