import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { ManagementPrincipalSchema } from '@foreman-code/contracts/management'
import { JobService, jobDigest } from '../src/modules/jobs/service.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { JobWorkerService } from '../src/modules/jobs/worker.js'
import { jobExecution, jobSpec } from './helpers/jobFixture.js'
const principal=ManagementPrincipalSchema.parse({id:'reader',name:'Reader',audience:'operator',grants:[{actions:['job_definitions:read'],scope:{workspaceIds:['workspace-fixture']}}],expiresAt:'2099-01-01T00:00:00.000Z',revokedAt:null})
describe('CI durable authority/result invariants',()=>{
  it('denies job start and workspace escape before source or filesystem preparation',async()=>{
    const connect=vi.fn(),recordDenied=vi.fn(),accept=vi.fn()
    const service=new JobService({connect} as unknown as pg.Pool,{recordDenied} as unknown as PostgresCommandCoordinator,{preparation:{accept} as never,dispatch:{} as never,artifacts:{} as never})
    await expect(service.start(principal,'mcp','workspace-fixture',{commandId:'command',definitionId:'definition',expectedRevision:1})).rejects.toMatchObject({code:'ACCESS_DENIED'})
    await expect(service.validate(principal,'foreign-workspace',jobSpec())).rejects.toMatchObject({code:'ACCESS_DENIED'})
    expect(connect).not.toHaveBeenCalled();expect(accept).not.toHaveBeenCalled();expect(recordDenied).toHaveBeenCalledTimes(2)
    await expect(service.enqueue(principal,'http','workspace-fixture',{
      commandId:'queued-command',definitionId:'definition',expectedRevision:1,
    })).rejects.toMatchObject({code:'ACCESS_DENIED'})
    expect(connect).not.toHaveBeenCalled();expect(accept).not.toHaveBeenCalled()
    expect(recordDenied).toHaveBeenCalledWith(principal.id,'http','jobs:start','workspace-fixture')
  })
  it('hashes accepted specifications independently of object key insertion order',()=>{
    expect(jobDigest({argv:['node','test'],source:{b:2,a:1}})).toEqual(jobDigest({source:{a:1,b:2},argv:['node','test']}))
    expect(jobDigest(['node','test'])).not.toEqual(jobDigest(['test','node']))
  })
  it('keeps cancellation receipt distinct from confirmed closure and rejects contradictory success',async()=>{
    const service=new JobWorkerService({} as pg.Pool,{} as never)
    const fence={attemptId:'attempt-fixture',owner:{grantId:'grant-fixture',epoch:'1'}}
    await expect(service.settleProcess('workspace-fixture','job-fixture',fence,{process:{phase:'terminal',outcome:'cancelled',exitCode:null,signal:'SIGTERM',processStopped:false},startedAt:null,finishedAt:'2026-10-01T00:00:01.000Z'})).rejects.toMatchObject({code:'JOB_TERMINAL_UNCONFIRMED'})
    await expect(service.settleProcess('workspace-fixture','job-fixture',fence,{process:{phase:'terminal',outcome:'succeeded',exitCode:7,signal:null,processStopped:true},startedAt:null,finishedAt:'2026-10-01T00:00:01.000Z'})).rejects.toMatchObject({code:'JOB_RESULT_INVALID'})
  })
  it('rejects UTF-8 byte mismatch before any persistence or ownership mutation',async()=>{
    const pool={connect:vi.fn()},service=new JobWorkerService(pool as unknown as pg.Pool,{} as never)
    await expect(service.appendLog('workspace-fixture','job-fixture',{attemptId:'attempt-fixture',owner:{grantId:'grant-fixture',epoch:'1'}},{executionId:'job-fixture',attemptId:'attempt-fixture',sequence:1,stream:'stdout',text:'🙂',byteSize:1,createdAt:'2026-10-01T00:00:00.000Z'})).rejects.toMatchObject({code:'JOB_LOG_INVALID'})
    expect(pool.connect).not.toHaveBeenCalled()
  })
  it('fences stale attempts before result mutation',async()=>{
    const execution=jobExecution(),query=vi.fn(async(sql:string)=>({rows:sql.startsWith('select record')?[{record:execution,accepted_spec:execution.acceptedSpec}]:[]})),release=vi.fn(),require=vi.fn()
    const service=new JobWorkerService({connect:async()=>({query,release})} as unknown as pg.Pool,{require,verifyPublication:vi.fn()})
    await expect(service.settleProcess(execution.workspaceId,execution.id,{attemptId:'stale',owner:execution.owner},{process:{phase:'running',outcome:null,exitCode:null,signal:null,processStopped:false},startedAt:execution.createdAt,finishedAt:null})).rejects.toMatchObject({code:'JOB_STALE_ATTEMPT'})
    expect(require).not.toHaveBeenCalled();expect(query.mock.calls.some(([sql])=>sql.startsWith('update'))).toBe(false)
  })
})
