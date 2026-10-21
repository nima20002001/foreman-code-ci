import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { JobInputAdmissionSchema, type JobInputDeliveryReceipt } from '@foreman-code/contracts/job-inputs'
import { CanonicalJobInputRsyncSource } from './rsync.js'
import { CanonicalJobInputs } from './service.js'
import { inputHash, makeManifest, recipient } from './manifest.js'
import { outputTransferContext } from '../jobs/outputAdmission.js'
import { jobExecution } from '../../../../test/helpers/jobFixture.js'

function fixture() {
  const execution=jobExecution(),binding={mainId:randomUUID(),deviceId:randomUUID(),workerInstallationId:randomUUID(),keyRevision:1,authorizationRevision:1,bootId:randomUUID(),connectionEpoch:randomUUID(),connectionGeneration:1}
  execution.id=randomUUID();execution.attemptId=randomUUID()
  execution.acceptedSpec.target={...execution.acceptedSpec.target,mainId:binding.mainId,hostRef:{kind:'device',mainId:binding.mainId,deviceId:binding.deviceId},registration:{workerInstallationId:binding.workerInstallationId,keyRevision:1,authorizationRevision:1}}
  const manifest=makeManifest(execution,[]),grants=[{actions:['job_artifacts:read'],scope:{workspaceIds:[execution.workspaceId]}}]
  const admission=JobInputAdmissionSchema.parse({version:1,manifest,principalId:'original-recipient',principalGrantsDigest:inputHash(grants),issuedAt:new Date().toISOString(),transfers:[{relativePath:'manifest.json',intent:{version:1,...outputTransferContext(binding),transferId:randomUUID(),operationId:randomUUID(),executionId:execution.id,attemptId:execution.attemptId,placementHash:execution.acceptedSpec.bindingHash,rootId:randomUUID(),rootBindingRevision:1,direction:'to-worker',byteClass:'artifact',sha256:manifest.manifestSha256,byteSize:manifest.manifestByteSize,manifestDigest:manifest.manifestSha256,expiresAt:new Date(Date.now()+60000).toISOString(),chunkBytes:8192}}]})
  const transfer=admission.transfers[0]!,accepted={execution,admission,transfer}
  const receipt:JobInputDeliveryReceipt={version:1,recipient:recipient(execution),bindingId:manifest.bindingId,inputSnapshotDigest:manifest.inputSnapshotDigest,manifestSha256:manifest.manifestSha256,manifestByteSize:manifest.manifestByteSize,directory:{relativePath:'.graphql-job-inputs',device:'1',inode:'2',mountId:'3'},files:[{relativePath:'manifest.json',sha256:manifest.manifestSha256,byteSize:manifest.manifestByteSize},{relativePath:'workflow-input.json',sha256:createHash('sha256').update('null').digest('hex'),byteSize:4}],readonlyMountRequired:true}
  const commands=new Map<string,{principal_id:string;input_hash:string;target_key:string;result:unknown}>()
  const query=vi.fn(async(text:string,args:unknown[]=[])=>{
    if(text.includes('insert into management_command_receipts'))commands.set(String(args[2]),{principal_id:String(args[0]),input_hash:String(args[4]),target_key:String(args[3]),result:JSON.parse(String(args[5]))})
    if(text.includes('where principal_id = any'))return {rows:commands.has(String(args[2]))?[commands.get(String(args[2]))!]:[]}
    if(text.includes("operation='job.inputs.delivery.ack'"))return {rows:commands.has(String(args[1]))?[{result:commands.get(String(args[1]))!.result}]:[]}
    return {rows:[]}
  })
  const pool={query,connect:async()=>({query,release:()=>{}})} as unknown as pg.Pool
  const authority={recipient:vi.fn(async()=>({principal:{id:admission.principalId,grants}})),recheck:vi.fn(async()=>{})}
  const service=new CanonicalJobInputs(pool,authority as never,{} as never,{currentBinding:()=>binding})
  vi.spyOn(service,'acceptedTransfer').mockResolvedValue(accepted)
  vi.spyOn(service,'recheck').mockResolvedValue(undefined)
  vi.spyOn(service as unknown as {device:()=>Promise<void>},'device').mockResolvedValue(undefined)
  return {accepted,service,binding,receipt,commands,authority,query}
}
describe('canonical Job rsync input source and delivery ACK',()=>{
  it('requires one exact transfer inside one original bind receipt',async()=>{
    const f=fixture(),id=f.accepted.transfer.intent.transferId
    vi.mocked(f.service.acceptedTransfer).mockRestore()
    vi.spyOn(f.service,'execution').mockResolvedValue(f.accepted.execution)
    const record={result:f.accepted.admission,command_id:`job-input:${inputHash(recipient(f.accepted.execution))}`}
    f.query.mockResolvedValue({rows:[record]})
    expect(await f.service.acceptedTransfer(id)).toEqual(f.accepted)
    f.query.mockResolvedValue({rows:[]})
    await expect(f.service.acceptedTransfer(id)).rejects.toMatchObject({code:'JOB_INPUT_NOT_ADMITTED'})
    f.query.mockResolvedValue({rows:[record,record]})
    await expect(f.service.acceptedTransfer(id)).rejects.toMatchObject({code:'JOB_INPUT_NOT_ADMITTED'})
    f.query.mockResolvedValue({rows:[{...record,result:{...f.accepted.admission,transfers:[f.accepted.transfer,f.accepted.transfer]}}]})
    await expect(f.service.acceptedTransfer(id)).rejects.toMatchObject({code:'JOB_INPUT_NOT_ADMITTED'})
  })
  it('reads the exact original canonical entry and propagates revoked pins without fallback',async()=>{
    const f=fixture(),read=vi.fn(async()=>Buffer.from('range')),source=new CanonicalJobInputRsyncSource({acceptedTransfer:async()=>f.accepted,read})
    expect(await source.intentForTransfer(f.accepted.transfer.intent.transferId)).toEqual(f.accepted.transfer.intent)
    expect(await source.read(f.accepted.transfer.intent,0,5)).toEqual(Buffer.from('range'))
    expect(read).toHaveBeenCalledWith(f.accepted.execution,f.accepted.admission,'manifest.json',0,5)
    await expect(source.read({...f.accepted.transfer.intent,sha256:'0'.repeat(64)},0,5)).rejects.toMatchObject({code:'JOB_INPUT_TRANSFER_DENIED'})
    read.mockRejectedValueOnce(new Error('revoked pin'));await expect(source.read(f.accepted.transfer.intent,0,5)).rejects.toThrow('revoked pin')
  })
  it('persists original recipient receipt idempotently, then reads the durable ACK',async()=>{
    const f=fixture(),id=f.accepted.transfer.intent.transferId
    await expect(f.service.acknowledged(id,f.binding)).rejects.toMatchObject({code:'JOB_INPUT_DELIVERY_PENDING'})
    expect(await f.service.acknowledgeDelivery(id,f.receipt,f.binding)).toEqual(f.receipt)
    expect(await f.service.acknowledgeDelivery(id,f.receipt,f.binding)).toEqual(f.receipt)
    expect(f.commands.size).toBe(1);expect(await f.service.acknowledged(id,f.binding)).toEqual(f.receipt)
    expect([...f.commands.values()][0]?.principal_id).toBe('original-recipient')
    await expect(f.service.acknowledgeDelivery(id,{...f.receipt,directory:{...f.receipt.directory,inode:'4'}},f.binding)).rejects.toMatchObject({code:'COMMAND_ID_CONFLICT'})
  })
  it('denies altered recipient, incomplete files, stale channel and revoked original grants',async()=>{
    const f=fixture(),id=f.accepted.transfer.intent.transferId
    for(const receipt of [{...f.receipt,recipient:{...f.receipt.recipient,specDigest:'0'.repeat(64)}},{...f.receipt,files:[]},{...f.receipt,inputSnapshotDigest:'0'.repeat(64)}])
      await expect(f.service.acknowledgeDelivery(id,receipt,f.binding)).rejects.toMatchObject({code:'JOB_INPUT_RECEIPT_CONFLICT'})
    await expect(f.service.acknowledgeDelivery(id,f.receipt,{...f.binding,connectionEpoch:randomUUID()})).rejects.toMatchObject({code:'JOB_INPUT_CONNECTION_STALE'})
    f.authority.recipient.mockResolvedValue({principal:{id:'original-recipient',grants:[]}})
    await expect(f.service.acknowledgeDelivery(id,f.receipt,f.binding)).rejects.toMatchObject({code:'JOB_INPUT_AUTHORITY_CHANGED'})
    expect(f.commands.size).toBe(0)
  })
})
