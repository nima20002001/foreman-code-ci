import { describe,expect,it,vi } from 'vitest'
import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import { makeCurrentWorkflowFixture,WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { ExclusiveGraphConnection,type GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import type { RepeatRepositoryHost } from '../src/modules/runs/repeatPostgres.js'
import { repeatDigest } from '../src/modules/runs/repeatResolution.js'
import { PostgresWorkflowJobNodeStore,type WorkflowJobStorePublication } from '../src/modules/jobs/workflowStore.js'
import { JobRepository } from '../src/modules/jobs/repository.js'
import { JobService } from '../src/modules/jobs/service.js'
import { PostgresJobDispatch } from '../src/modules/jobs/dispatch.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { jobExecution,jobSpec } from './helpers/jobFixture.js'
import type { JobExecutionRecord } from '@foreman-code/contracts/job-verification'

/** Real store/admission/repository code with explicit SQL doubles. No DB, native
 * entry, runtime qualification, or fabricated HarnessExecution occurs. */
function fixture(){
  const base=makeCurrentWorkflowFixture(randomUUID()),template=jobExecution(),spec=jobSpec(),node={kind:'job' as const,id:'build',name:'Build',jobDefinitionId:'definition-fixture',jobDefinitionRevision:1,jobDefinitionVersionId:'version-fixture'}
  const version=WorkflowVersionV3Schema.parse({...base.version,agentConfigurationVersionIds:{},entryNodeId:node.id,definition:{...base.version.definition,requiredAgentCount:0,entryNodeId:node.id,nodes:[node],edges:[],repeat:undefined,handoffs:undefined,executionPolicy:{maxParallelism:1,maxNodeExecutions:4}}})
  const savedVersion=JSON.parse(JSON.stringify(version)) as typeof version
  const run={...base.run,workflowVersionId:version.id,agentConfigurationVersionIds:{},executionState:'running' as const,authorizationPrincipalId:'actor',executionLocation:{runnerId:'local',rootPath:'/unit',locationRevision:1,identityHash:'sha256:'+'1'.repeat(64)}}
  const state={preparation:undefined as unknown,bindings:[] as unknown[],slot:undefined as {identity:unknown;execution_id:string;input_digest:string;input_json:string}|undefined,job:undefined as JobExecutionRecord|undefined,resolution:undefined as unknown,stopped:false,revoked:false,fence:'1'}
  const effects=new Map<string,string>(),definition={schemaVersion:1 as const,id:node.jobDefinitionId,workspaceId:run.workspaceId,versionId:node.jobDefinitionVersionId,revision:1,name:'Immutable build',spec,createdAt:template.createdAt,updatedAt:template.updatedAt}
  const query=vi.fn(async(text:string,values?:unknown[])=>{
    let rows:unknown[]=[]
    if(text.includes('r.record as run,v.record as version'))rows=[{run,version:savedVersion,stopped:state.stopped,cleanup:false,state:run.executionState,now:template.createdAt}]
    else if(text.startsWith('select preparation'))rows=state.preparation?[{preparation:state.preparation,bindings:state.bindings}]:[]
    else if(text.startsWith('select payload_digest'))rows=effects.has(`${values![1]}:${values![2]}`)?[{payload_digest:effects.get(`${values![1]}:${values![2]}`)}]:[]
    else if(text.startsWith('select ('))rows=[{total:state.slot?'1':'0'}]
    else if(text.startsWith('select execution_id from run_repeat_executions'))rows=state.slot?.identity?[{execution_id:state.slot.execution_id}]:[]
    else if(text.startsWith('select x.execution_id'))rows=state.slot?.identity?[state.slot]:[]
    else if(text.startsWith('select record from run_repeat_resolutions'))rows=state.resolution?[{record:state.resolution}]:[]
    else if(text.startsWith('select record,accepted_spec from job_executions'))rows=state.job?[{record:state.job,accepted_spec:state.job.acceptedSpec}]:[]
    if(text.startsWith('insert into run_repeat_slots'))state.slot={execution_id:'',identity:undefined,input_json:values![4] as string,input_digest:values![5] as string}
    if(text.startsWith('insert into workflow_job_preparations')){state.preparation=JSON.parse(values![2] as string);state.bindings=JSON.parse(values![3] as string)}
    if(text.startsWith('insert into job_executions'))state.job=JSON.parse(values![5] as string)
    if(text.startsWith('insert into run_repeat_executions')){state.slot!.execution_id=values![0] as string;state.slot!.identity=JSON.parse(values![4] as string)}
    if(text.startsWith('insert into run_repeat_effects'))effects.set(`${values![1]}:${values![2]}`,values![3] as string)
    if(text.startsWith('insert into run_repeat_resolutions'))state.resolution=JSON.parse(values![5] as string)
    return {rows,rowCount:text.startsWith('insert')||text.startsWith('update')?1:rows.length,command:'SELECT',oid:0,fields:[]}
  })
  const connection=new ExclusiveGraphConnection({query} as unknown as pg.Client,()=>{if(state.fence==='lost')throw new DomainError('RUN_OWNERSHIP_LOST','SQL double owner lost.',409)}),owner={runId:run.id,assertOwned:()=>{},oneShotConnection:()=>connection,readOneShotFence:async()=>({ownerId:'41',fence:state.fence})} as unknown as RunOwnership
  const assertAuthority=vi.fn(async()=>{if(state.revoked)throw new DomainError('AUTH_REVOKED','Original Run authority revoked.',403)})
  const host={openLocked:async()=>({run,assertAuthorityLocked:assertAuthority})} as unknown as RepeatRepositoryHost
  const dispatch=new PostgresJobDispatch({} as pg.Pool,{deliver:vi.fn(),reconcile:vi.fn(),control:vi.fn()},{revalidate:vi.fn(),authorizeControl:vi.fn(),observe:vi.fn()})
  const adopt=vi.fn(async()=>{expect(state.job).toBeDefined()})
  const service=new JobService({} as pg.Pool,{} as PostgresCommandCoordinator,{preparation:{revalidateAccepted:vi.fn(),adoptFinalBinding:adopt,choices:vi.fn(),validate:vi.fn(),accept:vi.fn()},dispatch,artifacts:{list:vi.fn(),read:vi.fn()}})
  const repository=new JobRepository(),verify=vi.fn(async(_sql:GraphTransactionSql,job:JobExecutionRecord)=>{if(job.process.phase!=='terminal'||!job.process.processStopped||!job.finishedAt||job.publication!=='complete')throw new DomainError('JOB_RESULT_PENDING','No confirmed process/output settlement.',409)})
  const publication:WorkflowJobStorePublication={effect:vi.fn(async(_sql,_owner,_scope,_version,_effect,mutate,facts)=>{await mutate();await facts()}),assertReceipt:vi.fn(async()=>undefined),observe:vi.fn(async()=>undefined)}
  const store=new PostgresWorkflowJobNodeStore(owner,savedVersion,host,{admitPrepared:(sql,_ref,prep,prepared)=>service.admitPrepared(sql,{id:'actor',name:'Actor',audience:'operator',grants:[],expiresAt:'2099-01-01T00:00:00.000Z',revokedAt:null},definition,{workflowId:run.workflowId,runId:run.id,nodeId:node.id,nodeExecutionId:prep.executionId},prep.input,prepared,prep),read:sql=>repository.execution(sql,run.workspaceId,state.job!.id),artifacts:async()=>[],verifyResult:verify},publication)
  return {store,state,query,publication,adopt,assertAuthority,connection,version,run,spec,ref:{nodeId:node.id,occurrence:null},prepared:{...spec,source:{...spec.source,materializationId:randomUUID(),materializationDigest:'3'.repeat(64)}}}
}
describe('concrete workflow Job store',()=>{
  it('reserves one actual tuple, replays preparation/admission, and persists real Job/slot/input metadata',async()=>{
    const f=fixture(),first=await f.store.prepareJob(f.ref),again=await f.store.prepareJob(f.ref)
    expect(first.kind).toBe('preparation');expect(again).toEqual(first)
    if(first.kind!=='preparation')throw new Error('missing preparation')
    expect(first.preparation.inputDigest).toBe(repeatDigest(first.preparation.input,4*1024*1024))
    const admitted=await f.store.admitPreparedJob(f.ref,first.preparation,f.prepared),replay=await f.store.admitPreparedJob(f.ref,first.preparation,f.prepared)
    expect(replay).toEqual(admitted);expect(admitted.acceptedSpec.workflowInput).toEqual(first.preparation.input)
    expect(admitted.id).toBe(first.preparation.executionId);expect(admitted.operationId).toBe(first.preparation.operationId)
    expect(f.query.mock.calls.filter(([sql])=>sql.startsWith('insert into job_executions'))).toHaveLength(1)
    expect(f.query.mock.calls.filter(([sql])=>sql.startsWith('insert into job_dispatch_intents'))).toHaveLength(1)
    expect(f.state.slot!.identity).toMatchObject({kind:'job',executionId:admitted.id});expect(f.adopt).toHaveBeenCalledOnce()
    expect(await f.store.observeJobState(f.ref,admitted.id)).toEqual(admitted);expect(f.publication.observe).toHaveBeenCalledOnce()
    await expect(f.store.acceptJobTerminal(f.ref,admitted.id)).rejects.toMatchObject({code:'JOB_RESULT_PENDING'})
    await f.connection.close()
  })
  it('denies revoked Run authority and stopped parent before allocation',async()=>{
    const f=fixture();f.state.revoked=true;await expect(f.store.prepareJob(f.ref)).rejects.toMatchObject({code:'AUTH_REVOKED'})
    expect(f.query.mock.calls.some(([sql])=>sql.startsWith('insert'))).toBe(false);f.state.revoked=false;f.state.stopped=true
    await expect(f.store.prepareJob(f.ref)).rejects.toMatchObject({code:'GRAPH_STOP_CONFLICT'});await f.connection.close()
  })
  it('rejects modified frozen input before the actual admission writer',async()=>{
    const f=fixture(),first=await f.store.prepareJob(f.ref);if(first.kind!=='preparation')throw new Error('missing')
    await expect(f.store.admitPreparedJob(f.ref,{...first.preparation,input:{changed:true}},f.prepared)).rejects.toMatchObject({code:'JOB_PREPARATION_PIN_CONFLICT'})
    expect(f.state.job).toBeUndefined();await f.connection.close()
  })
  it('binds observation/terminal reads to the original actual slot execution',async()=>{
    const f=fixture();await f.store.prepareJob(f.ref)
    await expect(f.store.observeJobState(f.ref,'foreign-job')).rejects.toMatchObject({code:'JOB_WORKFLOW_PIN_CONFLICT'})
    expect(f.publication.observe).not.toHaveBeenCalled();await f.connection.close()
  })
  it('accepts the original confirmed terminal once and replays its resolution',async()=>{
    const f=fixture(),first=await f.store.prepareJob(f.ref);if(first.kind!=='preparation')throw new Error('missing')
    const job=await f.store.admitPreparedJob(f.ref,first.preparation,f.prepared)
    f.state.job={...job,process:{phase:'terminal',outcome:'succeeded',exitCode:0,signal:null,processStopped:true},finishedAt:job.updatedAt,publication:'complete'}
    const resolved=await f.store.acceptJobTerminal(f.ref,job.id),replayed=await f.store.acceptJobTerminal(f.ref,job.id)
    expect(resolved.value.execution).toMatchObject({kind:'job',executionId:job.id});expect(resolved.value.resolution).toBe('succeeded');expect(replayed).toEqual(resolved)
    expect(f.query.mock.calls.filter(([sql])=>sql.startsWith('insert into run_repeat_results'))).toHaveLength(1)
    expect(f.query.mock.calls.filter(([sql])=>sql.startsWith('insert into run_repeat_resolutions'))).toHaveLength(1)
    await f.connection.close()
  })
  it('rejects terminal or reconnect reads naming a different admitted job',async()=>{
    const f=fixture(),first=await f.store.prepareJob(f.ref);if(first.kind!=='preparation')throw new Error('missing')
    await f.store.admitPreparedJob(f.ref,first.preparation,f.prepared)
    await expect(f.store.acceptJobTerminal(f.ref,'foreign-job')).rejects.toMatchObject({code:'JOB_WORKFLOW_PIN_CONFLICT'})
    await f.connection.close()
  })

})
