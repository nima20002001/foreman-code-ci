import { describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import { RemoteJobOperationReceiptSchema } from '@foreman-code/contracts/remote-job-execution'
import { DomainError } from '../src/modules/errors.js'
import { PostgresJobDispatch } from '../src/modules/jobs/dispatch.js'
import { projectJobReceiptLocked } from '../src/modules/jobs/receiptProjection.js'
import { jobExecution } from './helpers/jobFixture.js'

function fixture() {
  const execution=jobExecution(),startedAt='2026-10-01T00:00:01.000Z',finishedAt='2026-10-01T00:00:02.000Z',digest='1'.repeat(64)
  const receipt=RemoteJobOperationReceiptSchema.parse({schemaVersion:1,kind:'job',execution:structuredClone(execution),
    intent:{schemaVersion:1,protocolVersion:1,mainId:execution.acceptedSpec.target.mainId,
      subject:{kind:'manual-job',workspaceId:execution.workspaceId,jobExecutionId:execution.id,definitionId:execution.acceptedSpec.definitionId},
      executionId:execution.id,attemptId:execution.attemptId,operationId:execution.operationId,bindingHash:execution.acceptedSpec.bindingHash,
      inputDigest:`sha256:${execution.acceptedSpec.specDigest}`,owner:execution.owner},
    connection:{kind:'main',mainId:execution.acceptedSpec.target.mainId,mainInstallationId:execution.acceptedSpec.target.mainInstallationId,bootId:'11111111-1111-4111-8111-111111111111'},
    workerIncarnationId:'22222222-2222-4222-8222-222222222222',sequence:3,observedAt:finishedAt,phase:'confirmed_terminal',entryAttempted:true,stopFence:false,controls:[],
    native:{containerId:'container',supervisorIdentity:'supervisor',processIdentityDigest:digest,startedAt},
    terminal:{finishedAt,closureEvidenceDigest:digest,outcome:'build_failed',exitCode:7,signal:null,processStopped:true,resultDigest:digest,logGapPossible:false,logsTruncated:false,outputCollectionError:false,artifactDigests:[]},publication:'pending'})
  const query=vi.fn().mockResolvedValue({rows:[],rowCount:1,command:'UPDATE',oid:0,fields:[]})
  const outputs={verifyRequiredOutputs:vi.fn().mockResolvedValue(undefined)}
  return {execution,receipt,sql:{query},query,outputs}
}
describe('current Job receipt projection',()=>{
  it('records physical closure separately from pending publication',async()=>{
    const f=fixture()
    await projectJobReceiptLocked(f.sql,f.execution,f.receipt,f.outputs)
    expect(f.execution.process).toEqual({phase:'terminal',outcome:'build_failed',exitCode:7,signal:null,processStopped:true})
    expect(f.execution.startedAt).toBe(f.receipt.native?.startedAt)
    expect(f.execution.finishedAt).toBe(f.receipt.terminal?.finishedAt)
    expect(f.execution.lastSeenAt).toBe(f.receipt.observedAt)
    expect(f.execution.publication).toBe('collecting');expect(f.outputs.verifyRequiredOutputs).not.toHaveBeenCalled()
  })
  it.each(['operationId','attemptId','workspaceId','owner','inputDigest','acceptedSpec'] as const)('rejects changed immutable %s before projection',async field=>{
    const f=fixture()
    if(field==='operationId')f.receipt.intent.operationId='foreign-operation'
    if(field==='attemptId')f.receipt.execution.attemptId='foreign-attempt'
    if(field==='workspaceId')f.receipt.execution.workspaceId='foreign-workspace'
    if(field==='owner')f.receipt.intent.owner={grantId:'foreign-owner',epoch:'1'}
    if(field==='inputDigest')f.receipt.intent.inputDigest=`sha256:${'2'.repeat(64)}`
    if(field==='acceptedSpec')f.receipt.execution.acceptedSpec.argv=['foreign-command']
    await expect(projectJobReceiptLocked(f.sql,f.execution,f.receipt,f.outputs)).rejects.toMatchObject({code:field==='acceptedSpec'?'JOB_RECEIPT_SPEC_CONFLICT':'JOB_RECEIPT_PIN_CONFLICT'})
    expect(f.execution.process.phase).toBe('queued');expect(f.query).not.toHaveBeenCalled()
  })
  it('verifies canonical bytes before declaring publication complete and preserves native failure',async()=>{
    const f=fixture();f.receipt.publication='complete'
    f.outputs.verifyRequiredOutputs.mockRejectedValue(new DomainError('JOB_REQUIRED_OUTPUT_CORRUPT','Corrupt output.',409))
    await projectJobReceiptLocked(f.sql,f.execution,f.receipt,f.outputs)
    expect(f.execution.publication).toBe('failed');expect(f.execution.resultIssue).toBe('corrupt_output')
    expect(f.execution.process.outcome).toBe('build_failed');expect(f.execution.process.exitCode).toBe(7)
  })
  it('preserves the original terminal result through later publication receipts',async()=>{
    const f=fixture();await projectJobReceiptLocked(f.sql,f.execution,f.receipt,f.outputs)
    f.receipt.publication='complete';f.receipt.sequence++
    await projectJobReceiptLocked(f.sql,f.execution,f.receipt,f.outputs)
    expect(f.execution.publication).toBe('complete');expect(f.outputs.verifyRequiredOutputs).toHaveBeenCalledOnce()
    if(!f.receipt.terminal)throw new Error('Terminal fixture required')
    f.receipt.terminal.finishedAt='2026-10-01T00:00:03.000Z'
    await expect(projectJobReceiptLocked(f.sql,f.execution,f.receipt,f.outputs)).rejects.toMatchObject({code:'JOB_TERMINAL_CONFLICT'})
  })
})
describe('SQL-only accepted Job closure readback',()=>{
  async function closure() {
    const f=fixture();await projectJobReceiptLocked(f.sql,f.execution,f.receipt,f.outputs)
    const row={record:f.execution,accepted_spec:f.execution.acceptedSpec,intent:f.receipt.intent,last_receipt:f.receipt,receipt_sequence:String(f.receipt.sequence)}
    const input={workspaceId:f.execution.workspaceId,executionId:f.execution.id,attemptId:f.execution.attemptId,operationId:f.execution.operationId,bindingHash:f.execution.acceptedSpec.bindingHash,owner:f.execution.owner}
    f.query.mockImplementation(async(_text:string,values:unknown[])=>({rows:JSON.stringify(values)===JSON.stringify([input.workspaceId,input.executionId,input.attemptId,input.operationId,input.bindingHash,input.owner.grantId,input.owner.epoch])?[row]:[],rowCount:1,command:'SELECT',oid:0,fields:[]}))
    const forbidden=vi.fn().mockRejectedValue(new Error('Closure readback must stay SQL-only'))
    const dispatch=new PostgresJobDispatch(new pg.Pool(),{deliver:forbidden,reconcile:forbidden,control:forbidden},{revalidate:forbidden,authorizeControl:forbidden,observe:forbidden})
    return {...f,row,input,dispatch,forbidden}
  }
  it('reads only the exact current projected closure without runtime effects',async()=>{
    const f=await closure()
    expect(await f.dispatch.readAcceptedClosureReceipt(f.sql,f.input)).toEqual(f.receipt)
    expect(f.forbidden).not.toHaveBeenCalled()
    expect(f.query.mock.calls.at(-1)?.[0]).toContain('for share of e,d')
  })
  it.each(['workspaceId','executionId','attemptId','operationId','bindingHash'] as const)('cannot read a foreign %s',async field=>{
    const f=await closure()
    expect(await f.dispatch.readAcceptedClosureReceipt(f.sql,{...f.input,[field]:'foreign'})).toBeNull()
  })
  it.each(['grantId','epoch'] as const)('cannot read a foreign owner %s',async field=>{
    const f=await closure()
    expect(await f.dispatch.readAcceptedClosureReceipt(f.sql,{...f.input,owner:{...f.input.owner,[field]:'foreign'}})).toBeNull()
  })
  it('returns no closure for a physical receipt that main has not projected',async()=>{
    const f=await closure();f.row.record=structuredClone(f.receipt.execution)
    expect(await f.dispatch.readAcceptedClosureReceipt(f.sql,f.input)).toBeNull()
  })
  it('rejects a receipt whose stored immutable execution belongs to another owner',async()=>{
    const f=await closure();f.row.last_receipt={...f.receipt,execution:{...f.receipt.execution,owner:{grantId:'foreign-owner',epoch:'1'}}}
    await expect(f.dispatch.readAcceptedClosureReceipt(f.sql,f.input)).rejects.toMatchObject({code:'JOB_CLOSURE_EVIDENCE_CONFLICT'})
  })
})
