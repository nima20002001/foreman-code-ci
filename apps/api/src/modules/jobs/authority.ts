import type { JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import { JobRepository, type JobSql } from './repository.js'
import type { JobPreparationPort } from './ports.js'
import type { JobWorkerFence } from './worker.js'
/** W08 supplies the live owner grant/connection proof; equality with stored fields alone is insufficient. */
export interface JobRuntimeAuthority {
  require(sql:JobSql,execution:JobExecutionRecord,fence:JobWorkerFence):Promise<void>
}
export class JobPublicationAuthority {
  private readonly repository=new JobRepository()
  constructor(private readonly runtime:JobRuntimeAuthority,private readonly preparation:Pick<JobPreparationPort,'revalidateAccepted'>) {}
  async authorizePublication(sql:JobSql,input:{workspaceId:string;executionId:string;attemptId:string;owner:JobExecutionRecord['owner']}):Promise<{execution:JobExecutionRecord;principal:ManagementPrincipal}> {
    const execution=await this.repository.execution(sql,input.workspaceId,input.executionId,true)
    if(execution.attemptId!==input.attemptId||execution.owner.grantId!==input.owner.grantId||execution.owner.epoch!==input.owner.epoch) throw new DomainError('JOB_STALE_ATTEMPT','Artifact publication belongs to a stale attempt or owner.',409)
    const row=(await sql.query<{accepted_by:string}>('select accepted_by from job_executions where workspace_id=$1 and id=$2 for share',[input.workspaceId,input.executionId])).rows[0]!
    const principal=await readLiveManagementPrincipal(sql,row.accepted_by)
    requireAuthorization(principal,execution.workflow?'runs:start':'jobs:start',{workspaceId:execution.workspaceId,...(execution.workflow?{workflowId:execution.workflow.workflowId,runId:execution.workflow.runId}:{})})
    await this.runtime.require(sql,execution,{attemptId:input.attemptId,owner:input.owner})
    if(execution.process.phase!=='terminal'||!execution.process.processStopped) throw new DomainError('JOB_OUTPUT_NOT_QUIESCENT','Artifact publication requires proven process closure.',409)
    await this.preparation.revalidateAccepted(sql,principal,execution)
    return {execution,principal}
  }
}
