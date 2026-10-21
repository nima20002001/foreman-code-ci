import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { JobDefinition, JobExecution } from '@foreman-code/contracts/jobs'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { JobService } from '../src/modules/jobs/service.js'
import { JobSourceAttemptAuthority } from '../src/modules/jobs/sourceAuthority.js'
import { jobSpec } from './helpers/jobFixture.js'
const principal:ManagementPrincipal={id:'source-start-actor',name:'Start actor',audience:'operator',grants:[{actions:['jobs:start'],scope:{workspaceIds:['workspace-fixture']}}],expiresAt:'2099-01-01T00:00:00.000Z',revokedAt:null}
describe('actual manual job source admission',()=>{
  it('commits the real reservation before source I/O and adopts the final binding inside acceptance',async()=>{
    const definition:JobDefinition={schemaVersion:1,id:'definition',workspaceId:'workspace-fixture',versionId:'immutable-job-version',revision:1,name:'Actual job',spec:jobSpec(),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}
    let transactions=0,reservation:unknown[]|undefined,execution:JobExecution|undefined
    const query=vi.fn(async(text:string,values?:unknown[])=>{
      if(text==='begin')transactions++
      if(text==='commit'||text==='rollback')transactions--
      let rows:unknown[]=[]
      if(text.includes('select id,name,audience,grants'))rows=[{id:principal.id,name:principal.name,audience:'operator',grants:principal.grants,expires_at:new Date(principal.expiresAt),revoked_at:null,delegated_from:null}]
      if(text.includes('as queued'))rows=[{queued:false,preparing:false}]
      if(text.startsWith('select created_at from job_preparations'))rows=[{created_at:new Date()}]
      if(text.includes('select archived_at'))rows=[{archived_at:null}]
      if(text.includes('select record from job_definitions'))rows=[{record:definition}]
      if(text.startsWith('insert into job_preparations'))reservation=values
      if(text.startsWith('insert into job_executions'))execution=JSON.parse(values![5] as string)
      if(text.startsWith('select record')&&text.includes('from job_executions')&&execution)rows=[{record:execution,accepted_spec:execution.acceptedSpec}]
      return {rows,rowCount:rows.length,command:'SELECT',oid:0,fields:[]}
    })
    const pool={query,connect:async()=>({query,release:vi.fn()})} as unknown as pg.Pool
    const accept=vi.fn(async(_sql:unknown,_actor:unknown,_workspace:unknown,spec:ReturnType<typeof jobSpec>,identity:{executionId:string;attemptId:string;operationId:string})=>{
      expect(transactions).toBe(0)
      expect(reservation?.slice(0,3)).toEqual([identity.executionId,identity.attemptId,identity.operationId])
      return {...spec,source:{...spec.source,materializationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',materializationDigest:'3'.repeat(64)}}
    })
    const adoptFinalBinding=vi.fn(async()=>{expect(transactions).toBe(1);expect(execution).toBeDefined()})
    const commands={recordDenied:vi.fn(),execute:async(input:{dedicatedConnection?:boolean;authorize:(sql:unknown)=>Promise<void>;prepare:()=>Promise<void>;perform:(sql:unknown)=>Promise<unknown>})=>{
      expect(input.dedicatedConnection).toBe(true);await input.authorize({query});await input.prepare();await query('begin');const value=await input.perform({query});expect(execution).toBeDefined();await query('commit');return {value,replayed:false}
    }} as unknown as PostgresCommandCoordinator
    const service=new JobService(pool,commands,{preparation:{revalidateAccepted:vi.fn(),accept,adoptFinalBinding,validate:async()=>({valid:true,reasons:[],sideEffects:false}),choices:vi.fn()},dispatch:{accept:async(_sql,input)=>({attemptId:input.attemptId,operationId:input.operationId,owner:{grantId:'actual-job-owner',epoch:'1'}}),cancelForRunCleanup:async()=>{throw new Error('No Run cleanup in this admission fixture')},cancel:vi.fn(),wake:vi.fn(async()=>undefined)},artifacts:{read:vi.fn(),list:vi.fn()}})
    const result=await service.start(principal,'mcp','workspace-fixture',{commandId:'actual-start-command',definitionId:definition.id,expectedRevision:1})
    expect(result.acceptedSpec.workflowInput).toBeNull();expect(accept).toHaveBeenCalledOnce();expect(adoptFinalBinding).toHaveBeenCalledOnce();expect(transactions).toBe(0)
  })
  it('rejects an unallocated attempt without host or filesystem work',async()=>{
    const host=vi.fn(),query=vi.fn(async()=>({rows:[],rowCount:0,command:'SELECT',oid:0,fields:[]}))
    const authority=new JobSourceAttemptAuthority({} as pg.Pool,host)
    await expect(authority.authorize({query},principal,{workspaceId:'workspace-fixture',root:{} as never,attempt:{executionId:'unallocated',attemptId:'unallocated-attempt',placementHash:'1'.repeat(64),keyRevision:null,authorizationRevision:null},operationId:'unallocated-operation'})).rejects.toMatchObject({code:'JOB_PREPARATION_MISSING'})
    expect(host).not.toHaveBeenCalled()
  })
})
