import { releaseUnstartedJobComputer } from './computerSelection.js'
import { readRunJobCleanup } from './runCleanup.js'
import { requireJobPreparationDeadline } from './preparationDeadline.js'
import { AcceptedWorkflowRunV3Schema, canonicalGraphJson, type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { JobWorkflowNodeSchema } from '@foreman-code/contracts/job-workflow'
import type { JobArtifact } from '@foreman-code/contracts/jobs'
import type { PreparedJobSpecRecord, JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'
import { beforeGraphCommit, type GraphTransactionSql } from '../run-graph/connection.js'
import type { RunOwnership } from '../runs/ownership.js'
import { DomainError } from '../errors.js'
import type { WorkflowJobLockedPort, WorkflowJobDriver } from './workflowRuntimePorts.js'
import type { WorkflowJobPreparation } from './workflowPreparation.js'
import type { JobService } from './service.js'
import type { PostgresJobDispatch } from './dispatch.js'
import { RemoteJobOperationReceiptRecordSchema } from '@foreman-code/contracts/remote-job-execution'

export interface WorkflowJobOutputs {
  listCanonicalOutputs(sql:GraphTransactionSql,execution:JobExecutionRecord):Promise<JobArtifact[]>
  verifyRequiredOutputs(sql:GraphTransactionSql,execution:JobExecutionRecord):Promise<void>
}
export function createWorkflowJobComposition(input:{jobs:JobService;dispatch:PostgresJobDispatch;outputs:WorkflowJobOutputs}) {
  const forOwner=(owner:RunOwnership,version:WorkflowVersionV3)=>{
    const authorize=async(sql:GraphTransactionSql,nodeId:string)=>{
      owner.assertOwned();await owner.readOneShotFence(sql)
      const row=(await sql.query<{record:unknown;stopped:boolean;cleanup:boolean}>(`select record,stop_requested_at is not null as stopped,exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) cleanup from runs r where id=$1 for update`,[owner.runId])).rows[0]
      if(!row)throw new DomainError('RUN_NOT_FOUND','The current Run is missing.',404)
      const run=AcceptedWorkflowRunV3Schema.parse(row.record)
      if(run.workflowVersionId!==version.id||run.workspaceId!==version.workspaceId||run.workflowId!==version.workflowId||row.stopped||row.cleanup||['completed','interrupted'].includes(run.executionState))throw new DomainError('GRAPH_STOP_CONFLICT','The exact Run no longer admits job work.',409)
      const node=JobWorkflowNodeSchema.parse(version.definition.nodes.find(node=>node.id===nodeId))
      const principal=await readLiveManagementPrincipal(sql,run.authorizationPrincipalId)
      requireAuthorization(principal,'runs:start',{workspaceId:run.workspaceId,workflowId:run.workflowId,runId:run.id})
      const binding=(await sql.query('select 1 from run_authority_principals where principal_id=$1 and run_id=$2 for share',[principal.id,run.id])).rows.length
      if(!binding)throw new DomainError('AUTH_INVALID','The Job cannot borrow another Run authority.',403)
      const definition=await input.jobs.repository.version(sql,run.workspaceId,node.jobDefinitionVersionId,node.jobDefinitionId)
      if(definition.revision!==node.jobDefinitionRevision)throw new DomainError('JOB_VERSION_PIN_CONFLICT','The immutable job revision differs from the saved node.',409)
      return {run,node,principal,definition}
    }
    const locked:WorkflowJobLockedPort={
      admitPrepared:async(sql,ref,preparation,spec)=>{
        const {run,principal,definition}=await authorize(sql,ref.nodeId)
        await requireJobPreparationDeadline(sql,'workflow',preparation.executionId,definition.spec.policy.preparationTimeoutMs)
        beforeGraphCommit(sql,async()=>{await authorize(sql,ref.nodeId)})
        const execution=await input.jobs.admitPrepared(sql,principal,definition,{workflowId:run.workflowId,runId:run.id,nodeId:ref.nodeId,nodeExecutionId:preparation.executionId},preparation.input,spec,preparation)
        await sql.query('insert into workflow_job_executions(run_id,node_execution_id,job_execution_id,reference,input_json) values($1,$2,$3,$4::jsonb,$5)',[run.id,execution.id,execution.id,JSON.stringify({kind:'job',workspaceId:run.workspaceId,workflowId:run.workflowId,workflowVersionId:version.id,runId:run.id,nodeId:ref.nodeId,nodeExecutionId:execution.id,jobExecutionId:execution.id,occurrenceId:ref.occurrence?.occurrenceId??null,occurrenceIndex:ref.occurrence?.occurrenceIndex??0}),canonicalGraphJson(preparation.input,4*1024*1024)])
        return execution
      },
      read:async(sql,id)=>{
        const execution=await input.jobs.repository.execution(sql,version.workspaceId,id,true)
        if(execution.workflow?.runId!==owner.runId||execution.workflow.workflowId!==version.workflowId)throw new DomainError('JOB_WORKFLOW_PIN_CONFLICT','The Job belongs to a different Run.',409)
        return execution
      },
      artifacts:(sql,execution)=>input.outputs.listCanonicalOutputs(sql,execution),
      verifyResult:async(sql,execution)=>{
        owner.assertOwned();await owner.readOneShotFence(sql)
        if(execution.workflow?.runId!==owner.runId||execution.workflow.workflowId!==version.workflowId)throw new DomainError('JOB_WORKFLOW_PIN_CONFLICT','The settled Job belongs to another Run.',409)
        const row=(await sql.query<{last_receipt:unknown;delivery_attempted:boolean;launch_blocked_reason:string|null;cancel_command_id:string|null;cancel_principal_id:string|null;cancel_action:'jobs:cancel'|'runs:stop'|null}>('select last_receipt,delivery_attempted,launch_blocked_reason,cancel_command_id,cancel_principal_id,cancel_action from job_dispatch_intents where execution_id=$1 for share',[execution.id])).rows[0]
        if (row?.launch_blocked_reason === 'build_disabled' && !row.delivery_attempted && row.last_receipt === null
          && execution.launchIssue === 'build_disabled' && execution.startedAt === null
          && execution.process.outcome === 'preparation_failed' && execution.process.processStopped
          && execution.publication === 'complete') return
        if(row && !row.delivery_attempted && row.last_receipt===null && row.cancel_command_id && execution.process.outcome==='cancelled' && execution.process.processStopped && execution.startedAt===null && execution.finishedAt && execution.publication==='complete') {
          if(!await readRunJobCleanup(sql,execution)) {
            if(!row.cancel_principal_id||!row.cancel_action)throw new DomainError('JOB_STOP_AUTHORITY_MISSING','The original main cancellation authority is missing.',409)
            const actor=await readLiveManagementPrincipal(sql,row.cancel_principal_id)
            requireAuthorization(actor,row.cancel_action,{workspaceId:execution.workspaceId,workflowId:version.workflowId,runId:owner.runId})
          }
          return // Durable main cancellation before delivery is positive no-launch evidence, not a fabricated worker receipt.
        }
        const receipt=RemoteJobOperationReceiptRecordSchema.parse(row?.last_receipt)
        if(!receipt.terminal||receipt.intent.executionId!==execution.id||receipt.intent.attemptId!==execution.attemptId||receipt.intent.bindingHash!==execution.acceptedSpec.bindingHash||!execution.process.processStopped||execution.process.phase!=='terminal'||['pending','collecting'].includes(execution.publication))throw new DomainError('JOB_RESULT_PENDING','The original durable process/output result is not settled.',409)
        if(execution.publication==='complete'&&execution.process.outcome==='succeeded')await input.outputs.verifyRequiredOutputs(sql,execution)
      },
    }
    const driver:WorkflowJobDriver={
      prepare:async(preparation:WorkflowJobPreparation,signal)=>{
        signal.throwIfAborted()
        const captured=await owner.oneShotConnection().transaction(async sql => {
          const captured = await authorize(sql, preparation.nodeId)
          await input.jobs.resolveDefinition(sql, captured.principal, captured.definition, preparation)
          return captured
        })
        // Only source/byte preparation crosses this gap. The final writer rereads exact Run, input and authority.
        let spec: PreparedJobSpecRecord
        try { spec=await input.jobs.prepareDefinition(owner.oneShotConnection(),captured.principal,captured.definition,preparation) }
        catch (error) {
          await owner.oneShotConnection().transaction(sql => releaseUnstartedJobComputer(sql, preparation))
          throw error
        }
        signal.throwIfAborted();owner.assertOwned();return spec
      },
      observe:async(execution,signal,observe)=>{
        signal.throwIfAborted();await input.dispatch.wake(execution.id)
        try {while(true) {
          owner.assertOwned();signal.throwIfAborted()
          const current=await observe()
          if(current.process.phase==='terminal'&&!['pending','collecting'].includes(current.publication))return
          await new Promise<void>((resolve,reject)=>{
            const abort=()=>{clearTimeout(timer);reject(signal.reason)}
            const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve()},250)
            signal.addEventListener('abort',abort,{once:true})
            if(signal.aborted)abort()
          })
        }} catch(error) {
          if(signal.aborted) {
            await owner.oneShotConnection().transaction(async sql=>{
              const current=await input.jobs.repository.execution(sql,execution.workspaceId,execution.id)
              const reason=signal.reason instanceof DomainError&&signal.reason.code==='ENGINE_RESTART'?'engine-restart':signal.reason instanceof DomainError&&signal.reason.code.startsWith('AUTH_')?'authority-revoked':'run-failure'
              if(current.process.phase!=='terminal')await input.dispatch.cancelForRunCleanup(sql,current,owner,reason)
            })
            await input.dispatch.wake(execution.id)
          }
          throw error
        }
      },
    }
    return {locked,driver}
  }
  return {forOwner}
}
