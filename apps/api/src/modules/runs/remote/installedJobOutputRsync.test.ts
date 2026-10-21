import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TransferIntentSchema,TransferContextSchema } from '@foreman-code/contracts/byte-transfer'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { RemoteJobOperationReceipt } from '@foreman-code/contracts/remote-job-execution'
import type { ProductionRsyncProviders } from '../../byte-transfer/productionComposition.js'
import { ResumableByteTransferService } from '../../byte-transfer/service.js'
import { RsyncWriterOwnership } from '../../byte-transfer/rsyncWriterOwnership.js'
import { DeviceApplicationError } from '../../devices/deviceApplicationChannel.js'
import { jobExecution } from '../../../../test/helpers/jobFixture.js'
import type { RemoteOperationJournal } from './operationJournal.js'
import { createInstalledJobOutputRsync } from './installedJobOutputRsync.js'

const cleanups:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup()})
async function fixture(){
  const directory=await mkdtemp('/tmp/installed-job-rsync-');cleanups.push(()=>rm(directory,{recursive:true,force:true}))
  const stagingRoot=join(directory,'original-store');await mkdir(stagingRoot,{mode:0o700})
  let binding={mainId:randomUUID(),deviceId:randomUUID(),workerInstallationId:randomUUID(),keyRevision:1,authorizationRevision:1,bootId:randomUUID(),connectionEpoch:randomUUID(),connectionGeneration:1} as DeviceSessionBinding
  const execution=jobExecution();execution.id=randomUUID();execution.attemptId=randomUUID();execution.operationId=randomUUID();execution.owner={grantId:randomUUID(),epoch:'1'}
  execution.acceptedSpec.target={...execution.acceptedSpec.target,mainId:binding.mainId,hostRef:{kind:'device',mainId:binding.mainId,deviceId:binding.deviceId},registration:{workerInstallationId:binding.workerInstallationId,keyRevision:1,authorizationRevision:1}}
  execution.acceptedSpec.outputs=[{path:'result.json',mediaType:'application/json',required:true}]
  execution.process={phase:'terminal',outcome:'succeeded',exitCode:0,signal:null,processStopped:true};execution.finishedAt=new Date().toISOString()
  const bytes=Buffer.from('{}'),sha256=createHash('sha256').update(bytes).digest('hex')
  const context=TransferContextSchema.parse({mainId:binding.mainId,deviceId:binding.deviceId,workerInstallationId:binding.workerInstallationId,
    keyRevision:binding.keyRevision,authorizationRevision:binding.authorizationRevision,bootId:binding.bootId,connectionEpoch:binding.connectionEpoch})
  const intent=TransferIntentSchema.parse({version:1,...context,transferId:randomUUID(),operationId:randomUUID(),executionId:execution.id,attemptId:execution.attemptId,
    placementHash:execution.acceptedSpec.bindingHash,rootId:randomUUID(),rootBindingRevision:1,direction:'to-main',byteClass:'artifact',sha256,byteSize:2,manifestDigest:execution.acceptedSpec.outputSpecDigest,expiresAt:new Date(Date.now()+60000).toISOString(),chunkBytes:8192})
  const input={workspaceId:execution.workspaceId,executionId:execution.id,attemptId:execution.attemptId,owner:execution.owner,commandId:randomUUID(),path:'result.json',mediaType:'application/json' as const,sha256,byteSize:2}
  // Original authority/closure/remote replies are contract fixtures, not native/SQL proof.
  const original={phase:'confirmed_terminal',entryAttempted:true,native:{containerId:'original'},terminal:{processStopped:true,finishedAt:execution.finishedAt,closureEvidenceDigest:'4'.repeat(64)},execution,
    intent:{executionId:execution.id,attemptId:execution.attemptId,operationId:execution.operationId,owner:execution.owner,bindingHash:execution.acceptedSpec.bindingHash}} as RemoteJobOperationReceipt
  const journal={jobOperations:vi.fn(async()=>[original]),jobStatus:vi.fn(async()=>({status:'known',receipt:original}))} as unknown as RemoteOperationJournal
  const authorize=vi.fn(async()=>{}),quiescent=vi.fn(async()=>{}),receiver=new ResumableByteTransferService(join(directory,'original-quota'),{authorize})
  cleanups.push(()=>receiver.close());const release=vi.spyOn(receiver,'release')
  const receipt={version:1,receiptId:randomUUID(),transferId:intent.transferId,intent,sha256,byteSize:2,verifiedAt:new Date().toISOString()}
  const artifact={executionId:execution.id,publicationId:'original-publication',fileId:'original-file',revisionId:'original-revision',path:input.path,sha256,byteSize:2,mediaType:input.mediaType,state:'available',expiresAt:new Date(Date.now()+3600000).toISOString()}
  const request=vi.fn(async(_namespace:string,payload:unknown)=>({payload:(payload as {method:string}).method==='job-output-stage'?receipt:artifact}))
  const providers={stagingRoot,receiver,accepted:{authorize},quiescent} as unknown as ProductionRsyncProviders
  const current=()=>binding
  const ownership = new RsyncWriterOwnership(stagingRoot, current)
  cleanups.push(() => ownership.drain(AbortSignal.timeout(5000)))
  const ports={providers,journal,current,request,ownership},mounted=await createInstalledJobOutputRsync(ports)
  return {directory,stagingRoot,execution,intent,input,bytes,original,receipt,artifact,request,authorize,quiescent,release,ports,mounted,context,signal:new AbortController().signal,
    rebind:()=>{binding={...binding,connectionEpoch:randomUUID(),connectionGeneration:2}}}
}
describe('installed original closed Job rsync composition, no physical acceptance',()=>{
  it('registers captured bytes before stage, recovers original reader and requires canonical readback before retirement',async()=>{
    const f=await fixture();await f.mounted.collector.register(f.execution,f.input,f.intent,f.bytes,f.signal)
    expect(f.ports.ownership.inventory()).toEqual([f.intent])
    const materializer = f.ports.ownership.access(f.intent, f.ports.current(), 'source-materializer')
    await materializer.run(async () => {
      expect(await readFile(join(f.stagingRoot, `${f.intent.transferId}.retained.bytes`))).toEqual(f.bytes)
    })
    await materializer.close()
    const recovered=await createInstalledJobOutputRsync(f.ports),reader=await recovered.resolveSource(f.intent,f.signal)
    expect(await reader.read(f.intent,0,2,f.signal)).toEqual(Buffer.from('{}'))
    await recovered.collector.stage(f.intent,f.signal)
    expect(f.request).toHaveBeenCalledWith('byte-transfer-v1',{method:'job-output-stage',transferId:f.intent.transferId},
      expect.objectContaining({signal:f.signal,timeoutMs:expect.any(Number)}))
    f.request.mockRejectedValueOnce(new DeviceApplicationError('job-publication-pending'))
    await expect(recovered.acknowledged(f.intent,f.context)).rejects.toMatchObject({code:'JOB_PUBLICATION_PENDING'})
    expect(await readFile(join(f.stagingRoot,`${f.intent.transferId}.retained.bytes`),'utf8')).toBe('{}')
    await recovered.acknowledged(f.intent,f.context);await recovered.acknowledged(f.intent,f.context)
    await expect(readFile(join(f.stagingRoot,`${f.intent.transferId}.retained.bytes`))).rejects.toMatchObject({code:'ENOENT'})
    expect(f.quiescent).toHaveBeenCalledTimes(2);expect(f.release).not.toHaveBeenCalled()
  })
  it('bounds a stage request by the original transfer lifetime and honors cancellation before dispatch', async () => {
    const f = await fixture()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.intent.expiresAt) - 45000)
    try {
      await f.mounted.collector.stage(f.intent, f.signal)
      expect(f.request).toHaveBeenCalledWith('byte-transfer-v1',
        { method: 'job-output-stage', transferId: f.intent.transferId }, { signal: f.signal, timeoutMs: 45000 })
      clock.mockReturnValue(Date.parse(f.intent.expiresAt))
      await expect(f.mounted.collector.stage(f.intent, f.signal)).rejects.toMatchObject({ code: 'JOB_OUTPUT_TRANSFER_EXPIRED' })
      f.request.mockClear()
      const aborted = new AbortController()
      aborted.abort(new Error('cancelled by owner'))
      await expect(f.mounted.collector.stage(f.intent, aborted.signal)).rejects.toThrow('cancelled by owner')
      expect(f.request).not.toHaveBeenCalled()
    } finally { clock.mockRestore() }
  })
  it('preserves revoked authority and changed native/connection/publication pins',async()=>{
    const f=await fixture()
    f.request.mockRejectedValueOnce(new DeviceApplicationError('extension-rejected'))
    await expect(f.mounted.collector.published(f.intent,f.signal)).rejects.toMatchObject({code:'extension-rejected'})
    f.request.mockResolvedValueOnce({payload:{...f.artifact,sha256:'0'.repeat(64)}})
    await expect(f.mounted.acknowledged(f.intent,f.context)).rejects.toMatchObject({code:'JOB_OUTPUT_TRANSFER_CONFLICT'})
    f.original.entryAttempted=false
    await expect(f.mounted.collector.published(f.intent,f.signal)).rejects.toMatchObject({code:'JOB_OUTPUT_CLOSURE_MISSING'})
    f.rebind();await expect(f.mounted.acknowledged(f.intent,f.context)).rejects.toMatchObject({code:'JOB_OUTPUT_CONNECTION_STALE'})
    expect(f.quiescent).not.toHaveBeenCalled();expect(f.release).not.toHaveBeenCalled()
  })
})
