import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { TransferIntentSchema, TransferContextSchema } from '@foreman-code/contracts/byte-transfer'
import type { DeviceExtensionContext, DeviceExtensionRegistration } from '../../devices/deviceApplicationChannel.js'
import { DomainError } from '../../errors.js'
import { TransferExpiredError } from '../../byte-transfer/service.js'
import type { PostgresJobOutputAdmission } from './outputAdmission.js'
import { createMainJobOutputRsyncExtension } from './rsyncProduction.js'

// Authority ports are contract fixtures; these checks perform no DB/native qualification.
function fixture(){
  const context=TransferContextSchema.parse({mainId:randomUUID(),deviceId:randomUUID(),workerInstallationId:randomUUID(),keyRevision:1,authorizationRevision:1,bootId:randomUUID(),connectionEpoch:randomUUID()})
  const intent=TransferIntentSchema.parse({version:1,...context,transferId:randomUUID(),operationId:randomUUID(),executionId:randomUUID(),attemptId:randomUUID(),
    placementHash:'a'.repeat(64),rootId:randomUUID(),rootBindingRevision:1,direction:'to-main',byteClass:'artifact',sha256:'b'.repeat(64),byteSize:2,manifestDigest:'c'.repeat(64),expiresAt:new Date(Date.now()+60000).toISOString(),chunkBytes:8192})
  const frame={binding:{...context,connectionGeneration:1},signal:new AbortController().signal} as unknown as DeviceExtensionContext
  const receipt={version:1,receiptId:randomUUID(),transferId:intent.transferId,intent,sha256:intent.sha256,byteSize:2,verifiedAt:new Date().toISOString()}
  const order:string[]=[],artifact={executionId:intent.executionId,path:'result.json',state:'available'}
  const original={namespace:'byte-transfer-v1',version:1,role:'server',maxJsonBytes:16384,maxBinaryBytes:8192,handle:vi.fn(async()=>{order.push('publish');return {payload:artifact}})} as DeviceExtensionRegistration
  const authorizeTransfer=vi.fn(async()=>{}),intentForTransfer=vi.fn(async()=>intent),requireAdmission=vi.fn(async()=>({intent}))
  const admission={onAuthenticatedChannel:async(_binding:unknown,perform:()=>Promise<unknown>)=>perform(),authorizeTransfer,intentForTransfer,requireAdmission} as unknown as Pick<PostgresJobOutputAdmission,'onAuthenticatedChannel'|'authorizeTransfer'|'intentForTransfer'|'requireAdmission'>
  const lifecycle={acknowledged:vi.fn(async()=>{order.push('readback');return artifact})} as unknown as Parameters<typeof createMainJobOutputRsyncExtension>[1]
  const rsync={stage:vi.fn(async()=>receipt),acknowledge:vi.fn(async()=>{order.push('retire')})}
  return {intent,frame,receipt,original,admission,lifecycle,rsync,order,authorizeTransfer,extension:createMainJobOutputRsyncExtension(admission,lifecycle,original,rsync)}
}
describe('original Main Job output rsync carrier composition',()=>{
  it('reports expired output admission and idle transfer as permanent failures while preserving transport errors', async () => {
    const f = fixture()
    const request = { method: 'job-output-stage', transferId: f.intent.transferId }
    f.authorizeTransfer.mockRejectedValueOnce(new DomainError('FILE_EXPIRED', 'Original output admission expired.', 410))
    await expect(f.extension.handle!(request, f.frame)).rejects.toMatchObject({ code: 'job-output-expired' })
    f.rsync.stage.mockRejectedValueOnce(new TransferExpiredError('Transfer expired'))
    await expect(f.extension.handle!(request, f.frame)).rejects.toMatchObject({ code: 'job-output-expired' })
    f.rsync.stage.mockRejectedValueOnce(new Error('Connection lost'))
    await expect(f.extension.handle!(request, f.frame)).rejects.toThrow('Connection lost')
  })
  it('stages only the admitted intent with actual authenticated frame and bounded receipt',async()=>{
    const f=fixture()
    await expect(f.extension.handle!({method:'job-output-stage',transferId:f.intent.transferId},f.frame)).resolves.toEqual({payload:f.receipt})
    expect(f.rsync.stage).toHaveBeenCalledExactlyOnceWith(f.intent,f.frame.signal)
    expect(f.authorizeTransfer).toHaveBeenCalledTimes(2)
    expect(f.original.handle).not.toHaveBeenCalled()
    f.rsync.stage.mockResolvedValueOnce({...f.receipt,intent:{...f.intent,attemptId:randomUUID()}})
    await expect(f.extension.handle!({method:'job-output-stage',transferId:f.intent.transferId},f.frame)).rejects.toMatchObject({code:'JOB_OUTPUT_TRANSFER_CONFLICT'})
  })
  it('preserves denial and rejects binary payloads and peer authority fields before staging',async()=>{
    const f=fixture(),request={method:'job-output-stage',transferId:f.intent.transferId}
    f.authorizeTransfer.mockRejectedValueOnce(new Error('Original caller denied'))
    await expect(f.extension.handle!(request,f.frame)).rejects.toThrow('Original caller denied')
    await expect(f.extension.handle!(request,{...f.frame,bytes:new Uint8Array([1])})).rejects.toThrow()
    await expect(f.extension.handle!({...request,intent:f.intent},f.frame)).rejects.toThrow()
    expect(f.rsync.stage).not.toHaveBeenCalled()
    await expect(createMainJobOutputRsyncExtension(f.admission,f.lifecycle,f.original).handle!(request,f.frame)).rejects.toMatchObject({code:'JOB_OUTPUT_RSYNC_UNAVAILABLE'})
  })
  it('distinguishes actual canonical pending from revoked authority and retries publication retirement',async()=>{
    const f=fixture(),request={method:'job-output-status',transferId:f.intent.transferId}
    vi.mocked(f.lifecycle.acknowledged).mockRejectedValueOnce(new DomainError('JOB_PUBLICATION_PENDING','Original allocation pending.',409))
    await expect(f.extension.handle!(request,f.frame)).rejects.toMatchObject({code:'job-publication-pending'})
    vi.mocked(f.lifecycle.acknowledged).mockRejectedValueOnce(new DomainError('JOB_OUTPUT_TRANSFER_CONFLICT','Original owner denied.',403))
    await expect(f.extension.handle!(request,f.frame)).rejects.toMatchObject({code:'JOB_OUTPUT_TRANSFER_CONFLICT'})
    const input={workspaceId:'workspace',executionId:f.intent.executionId,attemptId:f.intent.attemptId,owner:{grantId:randomUUID(),epoch:'1'},commandId:randomUUID(),path:'result.json',mediaType:'application/json',sha256:f.intent.sha256,byteSize:2}
    f.rsync.acknowledge.mockRejectedValueOnce(new Error('Writer closure uncertain'))
    await expect(f.extension.handle!({method:'job-output-publish',input},f.frame)).rejects.toThrow('Writer closure uncertain')
    f.order.splice(0)
    await f.extension.handle!({method:'job-output-publish',input},f.frame)
    expect(f.order).toEqual(['publish','readback','retire'])
  })
})
