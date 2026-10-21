import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { jobExecution } from '../../../../test/helpers/jobFixture.js'
import type { RemoteJobDispatchIntent } from '@foreman-code/contracts/remote-job-execution'
import { JobApplicationBridge } from './jobApplicationBridge.js'
vi.mock('../../access/liveManagementPrincipal.js', () => ({ readLiveManagementPrincipal: async () => { throw new Error('starter revoked') } }))
function fixture() {
  const execution = jobExecution(), registration={workerInstallationId:randomUUID(),keyRevision:1,authorizationRevision:1}, deviceId=randomUUID()
  execution.acceptedSpec.target.hostRef={kind:'device',mainId:execution.acceptedSpec.target.mainId,deviceId}
  execution.acceptedSpec.target.registration=registration
  const binding={mainId:execution.acceptedSpec.target.mainId,deviceId,...registration,bootId:randomUUID(),connectionGeneration:1,connectionEpoch:randomUUID()}
  const intent:RemoteJobDispatchIntent={schemaVersion:1,protocolVersion:1,mainId:binding.mainId,subject:{kind:'manual-job',workspaceId:execution.workspaceId,jobExecutionId:execution.id,definitionId:execution.acceptedSpec.definitionId},executionId:execution.id,attemptId:execution.attemptId,operationId:execution.operationId,bindingHash:execution.acceptedSpec.bindingHash,inputDigest:`sha256:${execution.acceptedSpec.specDigest}`,owner:execution.owner}
  const sql={query:async (query:string)=>({rows:query.startsWith('select record,accepted_spec')?[{record:execution,accepted_spec:execution.acceptedSpec}]:query.startsWith('select intent')?[{intent}]:[{accepted_by:'revoked-starter'}]}),release:vi.fn()}
  const pool={connect:async()=>sql} as unknown as pg.Pool
  const dispatch={requireLaunch:vi.fn(),require:vi.fn(async()=>{throw new Error('cleanup is stop-only')}),requireControl:vi.fn(async()=>{}),requireEvidence:vi.fn(async()=>{}),observeReceipt:vi.fn(async()=>{})}
  const bridge=new JobApplicationBridge(pool,dispatch,{appendLog:vi.fn()},{authorizePublication:vi.fn()})
  return {bridge,intent,binding,dispatch,sql,execution}
}
describe('job application action-sensitive authority routing with memory ports',()=>{
  it('routes installed Main read/control through the same owner fence and denies another installation', async () => {
    const f = fixture()
    const connection = { kind: 'main' as const, mainId: f.execution.acceptedSpec.target.mainId,
      mainInstallationId: f.execution.acceptedSpec.target.mainId, bootId: randomUUID() }
    f.execution.acceptedSpec.target.hostRef = { kind: 'main', mainId: connection.mainId }
    f.execution.acceptedSpec.target.registration = null
    f.execution.acceptedSpec.target.mainInstallationId = connection.mainInstallationId
    const frame = { method: 'job-authorize', intent: f.intent, action: 'control' }
    expect(await f.bridge.handle(frame, connection)).toMatchObject({ authorized: true })
    expect(f.dispatch.requireControl).toHaveBeenCalledOnce()
    await expect(f.bridge.handle(frame, { ...connection, mainInstallationId: randomUUID() }))
      .rejects.toThrow('Installed Main does not own')
    expect(f.dispatch.requireControl).toHaveBeenCalledOnce()
    await expect(f.bridge.handle({ ...frame, action: 'start' }, connection)).rejects.toThrow('starter revoked')
    expect(f.dispatch.requireLaunch).not.toHaveBeenCalled()
  })
  it('cannot use an installed Main connection for a saved device target', async () => {
    const f = fixture()
    await expect(f.bridge.handle({ method: 'job-authorize', intent: f.intent, action: 'read' }, {
      kind: 'main', mainId: f.binding.mainId, mainInstallationId: f.binding.mainId, bootId: randomUUID(),
    })).rejects.toThrow('Authenticated worker does not own')
    expect(f.dispatch.requireEvidence).not.toHaveBeenCalled()
  })
  it('routes source metadata through its original read transaction before report handling', async () => {
    const f = fixture(), resolve = vi.spyOn(f.bridge, 'resolveAcceptedSource').mockRejectedValue(new Error('original source unavailable'))
    await expect(f.bridge.handle({ method: 'job-source', intent: f.intent }, f.binding)).rejects.toThrow('original source unavailable')
    expect(resolve).toHaveBeenCalledWith(f.intent, f.binding)
    expect(f.dispatch.observeReceipt).not.toHaveBeenCalled()
    expect(f.dispatch.require).not.toHaveBeenCalled()
  })
  it.each(['read','control'] as const)('uses %s cleanup fence without authenticating the revoked starter',async action=>{
    const f=fixture();expect(await f.bridge.handle({method:'job-authorize',intent:f.intent,action},f.binding)).toMatchObject({authorized:true})
    expect(action==='control'?f.dispatch.requireControl:f.dispatch.requireEvidence).toHaveBeenCalledOnce()
    expect(f.dispatch.require).not.toHaveBeenCalled();expect(f.sql.release).toHaveBeenCalledOnce()
  })
  it.each(['start','publish'] as const)('cannot borrow cleanup for %s after starter revocation',async action=>{
    const f=fixture();await expect(f.bridge.handle({method:'job-authorize',intent:f.intent,action},f.binding)).rejects.toThrow('starter revoked')
    expect(f.dispatch.requireControl).not.toHaveBeenCalled();expect(f.dispatch.requireEvidence).not.toHaveBeenCalled()
  })
})
