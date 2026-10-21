import { describe,expect,it,vi } from 'vitest'
import type pg from 'pg'
import { RemoteJobDispatchIntentSchema } from '@foreman-code/contracts/remote-job-execution'
import { PostgresJobDispatch } from '../src/modules/jobs/dispatch.js'
import { randomUUID } from 'node:crypto'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { JobRunCleanupSchema } from '@foreman-code/contracts/job-run-cleanup'
import { requireCleanupPins,readRunJobCleanup } from '../src/modules/jobs/runCleanup.js'
import type { JobSql } from '../src/modules/jobs/repository.js'
import { jobExecution } from './helpers/jobFixture.js'
function fixture() {
  const generated=makeCurrentWorkflowFixture(randomUUID()),run={...generated.run,authorizationPrincipalId:'actual-run-actor',executionLocation:{runnerId:'local',rootPath:'/fixture',locationRevision:1,identityHash:'sha256:'+'1'.repeat(64)}},execution=jobExecution()
  execution.workspaceId=run.workspaceId;execution.workflow={workflowId:run.workflowId,runId:run.id,nodeId:'job-node',nodeExecutionId:execution.id}
  const cleanup=JobRunCleanupSchema.parse({schemaVersion:1,id:randomUUID(),commandId:randomUUID(),workspaceId:run.workspaceId,workflowId:run.workflowId,workflowVersionId:run.workflowVersionId,runId:run.id,nodeId:execution.workflow.nodeId,nodeExecutionId:execution.workflow.nodeExecutionId,executionId:execution.id,attemptId:execution.attemptId,operationId:execution.operationId,bindingHash:execution.acceptedSpec.bindingHash,jobOwner:execution.owner,runOwner:{ownerId:'42',fence:'123'},reason:'run-failure',cleanupRequestedAt:'2026-10-01T00:00:00.000Z',requestedAt:'2026-10-01T00:00:01.000Z'})
  const query=vi.fn(async(text:string)=>({rows:text.includes('from job_dispatch_intents')?[{cancel_cleanup:cleanup,cancel_command_id:cleanup.commandId}]:text.includes('from runs r')?[{record:run,requested_at:new Date(cleanup.cleanupRequestedAt)}]:text.includes('from workflow_job_executions')?[{run_id:run.id,node_execution_id:execution.id,job_execution_id:execution.id,reference:{kind:'job',workspaceId:run.workspaceId,workflowId:run.workflowId,workflowVersionId:cleanup.workflowVersionId,runId:run.id,nodeId:cleanup.nodeId,nodeExecutionId:cleanup.nodeExecutionId,jobExecutionId:execution.id,occurrenceId:null,occurrenceIndex:0}}]:[],rowCount:1,command:'SELECT',oid:0,fields:[]}))
  return {run,execution,cleanup,query,sql:{query:query as JobSql['query']}}
}
describe('committed stop-only job Run cleanup',()=>{
  it('reads original committed cleanup after the owner session ends without borrowing starter grants',async()=>{
    const f=fixture();expect(await readRunJobCleanup(f.sql,f.execution)).toEqual(f.cleanup)
    expect(f.query.mock.calls.some(([sql])=>sql.includes('management_principals')||sql.includes('pg_stat_activity'))).toBe(false)
  })
  it.each(['attemptId','operationId','bindingHash'] as const)('rejects a switched accepted %s',field=>{
    const f=fixture();expect(()=>requireCleanupPins(f.execution,{...f.cleanup,[field]:'other'})).toThrowError(expect.objectContaining({code:'JOB_CLEANUP_PIN_CONFLICT'}))
  })
  it('does not authorize a manual job using another Run cleanup receipt',()=>{
    const f=fixture();f.execution.workflow=null
    expect(()=>requireCleanupPins(f.execution,f.cleanup)).toThrowError(expect.objectContaining({code:'JOB_CLEANUP_PIN_CONFLICT'}))
  })
  it('rejects changing the immutable accepted Run version during reconciliation',async()=>{
    const f=fixture();f.run.workflowVersionId=randomUUID()
    await expect(readRunJobCleanup(f.sql,f.execution)).rejects.toMatchObject({code:'JOB_CLEANUP_PIN_CONFLICT'})
  })
  it('rejects a switched original stop command',async()=>{
    const f=fixture();f.query.mockImplementation(async text=>({rows:text.includes('from job_dispatch_intents')?[{cancel_cleanup:f.cleanup,cancel_command_id:'switched-command'}]:[{record:f.run,requested_at:new Date(f.cleanup.cleanupRequestedAt)}],rowCount:1,command:'SELECT',oid:0,fields:[]}))
    await expect(readRunJobCleanup(f.sql,f.execution)).rejects.toMatchObject({code:'JOB_CLEANUP_PIN_CONFLICT'})
  })
  it('grants only existing-owner stop/evidence while denying fresh entry and publication',async()=>{
    const f=fixture(),intent=RemoteJobDispatchIntentSchema.parse({schemaVersion:1,protocolVersion:1,mainId:f.execution.acceptedSpec.target.mainId,subject:{kind:'workflow-node',workspaceId:f.execution.workspaceId,...f.execution.workflow},executionId:f.execution.id,attemptId:f.execution.attemptId,operationId:f.execution.operationId,bindingHash:f.execution.acceptedSpec.bindingHash,inputDigest:`sha256:${f.execution.acceptedSpec.specDigest}`,owner:f.execution.owner})
    const read=f.query.getMockImplementation()!
    const query=vi.fn(async(text:string)=>text.startsWith('select intent,owner_id')?{rows:[{intent,owner_id:'42',owner_fence:'123'}],rowCount:1,command:'SELECT',oid:0,fields:[]}:text.includes('from pg_stat_activity')?{rows:[{live:true}],rowCount:1,command:'SELECT',oid:0,fields:[]}:read(text))
    const sql={query:query as JobSql['query']},host={revalidate:vi.fn(),authorizeControl:vi.fn(),observe:vi.fn()}
    const dispatch=new PostgresJobDispatch({} as pg.Pool,{deliver:vi.fn(),reconcile:vi.fn(),control:vi.fn()},host),fence={attemptId:f.execution.attemptId,owner:f.execution.owner}
    await dispatch.requireControl(sql,f.execution,fence);await dispatch.requireEvidence(sql,f.execution,fence)
    await expect(dispatch.require(sql,f.execution,fence)).rejects.toMatchObject({code:'JOB_CLEANUP_ONLY'})
    expect(host.revalidate).not.toHaveBeenCalled();expect(host.authorizeControl).not.toHaveBeenCalled()
    expect(query.mock.calls.some(([text])=>text.includes('management_principals'))).toBe(false)
  })

})
