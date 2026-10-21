import type pg from 'pg'
import { withTransaction } from '../../infrastructure/transaction.js'
import { JobLogChunkSchema, JobProcessStateSchema, type JobLogChunk } from '@foreman-code/contracts/jobs'
import { type JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { DomainError } from '../errors.js'
import { JobRepository, sameLog, type JobSql } from './repository.js'

export interface JobWorkerFence {
  attemptId:string; owner:JobExecutionRecord['owner']
}
/** W07 authentication and W08 live ownership checks occur before every mutation. */
export interface JobWorkerAuthority {
  verifyPublication(sql:JobSql,execution:JobExecutionRecord):Promise<void>
  require(sql:JobSql,execution:JobExecutionRecord,fence:JobWorkerFence):Promise<void>
}
export class JobWorkerService {
  private readonly repository=new JobRepository()
  constructor(private readonly pool:pg.Pool,private readonly authority:JobWorkerAuthority) {}
  private async update<T>(workspaceId:string,id:string,fence:JobWorkerFence,work:(sql:pg.PoolClient,execution:JobExecutionRecord)=>Promise<T>):Promise<T> {
    return withTransaction(this.pool,async(sql)=>{
      const execution=await this.repository.execution(sql,workspaceId,id,true)
      if(execution.attemptId!==fence.attemptId||execution.owner.grantId!==fence.owner.grantId||execution.owner.epoch!==fence.owner.epoch) throw new DomainError('JOB_STALE_ATTEMPT','The job attempt or ownership fence is stale.',409)
      await this.authority.require(sql,execution,fence)
      const value=await work(sql,execution); await this.authority.require(sql,execution,fence); return value
    })
  }
  async appendLog(workspaceId:string,id:string,fence:JobWorkerFence,raw:JobLogChunk) {
    const chunk=JobLogChunkSchema.parse(raw)
    if(chunk.executionId!==id||chunk.attemptId!==fence.attemptId||Buffer.byteLength(chunk.text,'utf8')!==chunk.byteSize) throw new DomainError('JOB_LOG_INVALID','The chunk identity or UTF-8 byte count is invalid.',400)
    return this.update(workspaceId,id,fence,async(sql,execution)=>{
      const row=(await sql.query<{log_sequence:string;log_bytes:string;log_truncated:boolean}>('select log_sequence::text,log_bytes::text,log_truncated from job_executions where id=$1',[id])).rows[0]!
      const sequence=Number(row.log_sequence)
      if(chunk.sequence<=sequence) {
        const existing=(await this.repository.logs(sql,id,chunk.sequence-1,1))[0]
        if(!existing||!sameLog(existing,chunk)) throw new DomainError('JOB_LOG_CONFLICT','A log sequence already has different content.',409)
        return {persistedSequence:sequence,truncated:row.log_truncated}
      }
      if(chunk.sequence!==sequence+1) throw new DomainError('JOB_LOG_GAP','Log chunks must be persisted in sequence.',409)
      const policy=execution.acceptedSpec.policy
      if(chunk.byteSize>policy.maxLogChunkBytes) throw new DomainError('JOB_LOG_TOO_LARGE','The chunk exceeds the accepted limit.',413)
      if(Number(row.log_bytes)+chunk.byteSize>policy.maxLogBytes) {
        execution.resultIssue='log_overflow'
        await sql.query('update job_executions set log_truncated=true where id=$1',[id])
        await this.repository.putExecution(sql,execution)
        // No acknowledgment of unpersisted bytes. Worker applies the accepted stop/truncation policy.
        return {persistedSequence:sequence,truncated:true}
      }
      await sql.query('insert into job_log_chunks(execution_id,sequence,attempt_id,stream,text,byte_size,created_at) values($1,$2,$3,$4,$5,$6,$7)',[id,chunk.sequence,chunk.attemptId,chunk.stream,chunk.text,chunk.byteSize,chunk.createdAt])
      await sql.query('update job_executions set log_sequence=$2,log_bytes=log_bytes+$3 where id=$1',[id,chunk.sequence,chunk.byteSize])
      return {persistedSequence:chunk.sequence,truncated:row.log_truncated}
    })
  }
  async settleProcess(workspaceId:string,id:string,fence:JobWorkerFence,input:{process:JobExecutionRecord['process'];startedAt:string|null;finishedAt:string|null}) {
    if(input.process.outcome==='succeeded'&&input.process.exitCode!==0) throw new DomainError('JOB_RESULT_INVALID','Successful process evidence must report exit zero.',409)
    const process=JobProcessStateSchema.parse(input.process)
    if(process.phase==='terminal'&&(!process.outcome||!process.processStopped||!input.finishedAt)) throw new DomainError('JOB_TERMINAL_UNCONFIRMED','Terminal process result requires confirmed termination.',409)
    if(process.outcome==='succeeded'&&process.exitCode!==0) throw new DomainError('JOB_RESULT_INVALID','Successful process evidence must report exit zero.',409)
    return this.update(workspaceId,id,fence,async(sql,execution)=>{
      if(execution.process.phase==='terminal') {
        if(JSON.stringify(execution.process)!==JSON.stringify(process)||execution.finishedAt!==input.finishedAt) throw new DomainError('JOB_TERMINAL_CONFLICT','The observed terminal result is immutable.',409)
        return execution
      }
      const order={queued:0,preparing:1,running:2,terminal:3}
      if(order[process.phase]<order[execution.process.phase]) throw new DomainError('JOB_PHASE_CONFLICT','Process phase cannot move backward.',409)
      if(execution.startedAt!==null && execution.startedAt!==input.startedAt) throw new DomainError('JOB_PROCESS_IDENTITY_CONFLICT','The observed process start instant is immutable.',409)
      execution.process=process; execution.startedAt=input.startedAt; execution.finishedAt=input.finishedAt
      execution.lastSeenAt=new Date().toISOString(); execution.updatedAt=execution.lastSeenAt; execution.transport='connected'
      await this.repository.putExecution(sql,execution); return execution
    })
  }
  async publication(workspaceId:string,id:string,fence:JobWorkerFence,input:{state:JobExecutionRecord['publication'];issue:JobExecutionRecord['resultIssue']}) {
    return this.update(workspaceId,id,fence,async(sql,execution)=>{
      if(input.state==='complete') {
        if(execution.process.phase!=='terminal') throw new DomainError('JOB_PROCESS_NOT_TERMINAL','Output collection requires quiescent confirmed process evidence.',409)
        await this.authority.verifyPublication(sql,execution)
      }
      if(input.state==='complete'&&input.issue) throw new DomainError('JOB_OUTPUT_INCOMPLETE','Output errors cannot be complete.',409)
      if(execution.publication==='complete'&&input.state!=='expired') throw new DomainError('JOB_PUBLICATION_CONFLICT','Canonical completed publication cannot be rewritten.',409)
      execution.publication=input.state; execution.resultIssue=input.issue; execution.updatedAt=new Date().toISOString()
      await this.repository.putExecution(sql,execution); return execution
    })
  }
}
