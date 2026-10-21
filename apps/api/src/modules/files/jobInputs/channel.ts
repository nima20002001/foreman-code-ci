import { createHash } from 'node:crypto'
import { JobInputDeviceRequestSchema, JobInputAdmissionSchema, type JobInputAdmission } from '@foreman-code/contracts/job-inputs'
import type { JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { JobExecutionRecordSchema } from '@foreman-code/contracts/job-verification'
import { TransferProgressSchema } from '@foreman-code/contracts/byte-transfer'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceExtensionRegistration } from '../../devices/deviceApplicationChannel.js'
import { ResumableByteTransferService } from '../../byte-transfer/service.js'
import type { JobInputDeliverySource } from './delivery.js'
import type { CanonicalJobInputs } from './service.js'
import { JOB_INPUT_NAMESPACE } from './protocol.js'
import { inputHash, recipient, manifestBytes, snapshotDigest, verificationContextPin } from './manifest.js'
import { outputTransferContext } from '../jobs/workerProtocol.js'
import { DomainError } from '../../errors.js'
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
export function jobInputDeviceExtension(service:CanonicalJobInputs):DeviceExtensionRegistration {
  return {namespace:JOB_INPUT_NAMESPACE,version:1,role:'server',maxJsonBytes:1024*1024,maxBinaryBytes:8192,handle:async(raw,context)=>{
    const request=JobInputDeviceRequestSchema.parse(raw),execution=JobExecutionRecordSchema.parse(await service.execution(request.method==='bind'?request.recipient.executionId:request.executionId)),target=execution.acceptedSpec.target
    if(target.hostRef.kind!=='device'||context.binding.deviceId!==target.hostRef.deviceId||context.binding.mainId!==target.mainId||context.binding.workerInstallationId!==target.registration?.workerInstallationId||context.binding.keyRevision!==target.registration.keyRevision||context.binding.authorizationRevision!==target.registration.authorizationRevision)throw new DomainError('JOB_INPUT_DEVICE_DENIED','Authenticated input recipient does not match its actual job.',403)
    service.assertChannel(execution,context.binding);context.signal.throwIfAborted()
    if(request.method==='bind'){
      if(inputHash(recipient(execution))!==inputHash(request.recipient))throw new DomainError('JOB_INPUT_RECIPIENT_CONFLICT','Input binding cannot replace accepted spec/attempt/owner.',409)
      const admission=await service.bind(execution,request.verificationContext);service.assertChannel(execution,context.binding);context.signal.throwIfAborted();return {payload:admission}
    }
    const {admission}=await service.accepted(execution.id),transfer=admission.transfers.find(value=>value.intent.transferId===request.transferId)
    if(!transfer)throw new DomainError('JOB_INPUT_NOT_ADMITTED','Only actual main-issued input transfers may be read.',403)
    await service.authorizeTransfer(transfer.intent,outputTransferContext(context.binding))
    service.assertChannel(execution,context.binding);context.signal.throwIfAborted()
    if(request.method==='authorize')return {payload:{authorized:true,transferId:transfer.intent.transferId,bindingId:admission.manifest.bindingId}}
    const bytes=await service.read(execution,admission,transfer.relativePath,request.offset,request.length)
    service.assertChannel(execution,context.binding);context.signal.throwIfAborted();return {payload:{transferId:transfer.intent.transferId,offset:request.offset,byteSize:bytes.length,sha256:hash(bytes)},bytes}
  }}
}
export interface JobInputWorkerChannel {
 request(namespace:'job-inputs-v1',payload:unknown,options?:{signal?:AbortSignal;timeoutMs?:number}):Promise<{payload:unknown;bytes?:Uint8Array}>
 currentBinding():Readonly<DeviceSessionBinding>
}
/** Pulls actual authorized canonical ranges through existing W07; B performs durable verified staging. */
export class AuthenticatedJobInputSource implements JobInputDeliverySource {
  private readonly receiver:ResumableByteTransferService
  private readonly entries=new Map<string,{execution:JobExecutionRecord;admission:JobInputAdmission;path:string}>()
  constructor(private readonly channel:JobInputWorkerChannel,stagingRoot:string){
    this.receiver=new ResumableByteTransferService(stagingRoot,{authorize:async(intent,context)=>{
      const accepted=this.entries.get(intent.transferId)
      if(!accepted||inputHash(outputTransferContext(channel.currentBinding()))!==inputHash(context)||!accepted.admission.transfers.some(value=>inputHash(value.intent)===inputHash(intent)))throw new DomainError('JOB_INPUT_TRANSFER_DENIED','Worker cannot replace its accepted main-issued input transfer.',403)
      const answer=(await channel.request(JOB_INPUT_NAMESPACE,{method:'authorize',executionId:accepted.execution.id,transferId:intent.transferId})).payload as {authorized?:boolean;transferId?:string;bindingId?:string}
      if(answer.authorized!==true||answer.transferId!==intent.transferId||answer.bindingId!==accepted.admission.manifest.bindingId)throw new DomainError('JOB_INPUT_TRANSFER_DENIED','Main did not authorize the exact retained input.',403)
    }})
  }
  async admit(execution:JobExecutionRecord,signal:AbortSignal,verificationContext?:JobInputAdmission['manifest']['verificationContext']) {
    const admission=JobInputAdmissionSchema.parse((await this.channel.request(JOB_INPUT_NAMESPACE,{method:'bind',recipient:recipient(execution),...(verificationContext?{verificationContext}:{})},{signal})).payload)
    if(inputHash(admission.manifest.verificationContext??null)!==inputHash(verificationContext??null))throw new DomainError('JOB_INPUT_SNAPSHOT_CONFLICT','Canonical verification context differs from the protected worker input.',409)
    if(inputHash(admission.manifest.recipient)!==inputHash(recipient(execution))||admission.manifest.inputSnapshotDigest!==snapshotDigest(execution)||hash(manifestBytes(admission.manifest))!==admission.manifest.manifestSha256)throw new DomainError('JOB_INPUT_RECIPIENT_CONFLICT','Main input receipt differs from original accepted recipient/snapshot.',409)
    for(const item of admission.transfers){
      const expected=item.relativePath==='manifest.json'?{sha256:admission.manifest.manifestSha256,byteSize:admission.manifest.manifestByteSize}:item.relativePath==='verification.json'?verificationContextPin(admission.manifest):item.relativePath==='workflow-input.json'?{sha256:hash(Buffer.from(JSON.stringify(admission.manifest.workflowInput))),byteSize:Buffer.byteLength(JSON.stringify(admission.manifest.workflowInput))}:admission.manifest.entries.find(entry=>entry.relativePath===item.relativePath)?.pin
      if(!expected||item.intent.executionId!==execution.id||item.intent.attemptId!==execution.attemptId||item.intent.placementHash!==execution.acceptedSpec.bindingHash||item.intent.direction!=='to-worker'||item.intent.byteClass!=='artifact'||item.intent.sha256!==expected.sha256||item.intent.byteSize!==expected.byteSize||item.intent.manifestDigest!==admission.manifest.manifestSha256)throw new DomainError('JOB_INPUT_TRANSFER_DENIED','Main-issued transfer does not pin the accepted input object.',403)
      this.entries.set(item.intent.transferId,{execution,admission,path:item.relativePath})
      const current=outputTransferContext(this.channel.currentBinding());await this.receiver.start(item.intent,current)
      let status=TransferProgressSchema.parse(await this.receiver.status(item.intent.transferId,current))
      while(status.durableOffset<item.intent.byteSize){signal.throwIfAborted();const offset=status.durableOffset,length=Math.min(item.intent.chunkBytes,item.intent.byteSize-offset)
        const response=await this.channel.request(JOB_INPUT_NAMESPACE,{method:'range',executionId:execution.id,transferId:item.intent.transferId,offset,length},{signal}),metadata=response.payload as {transferId?:string;offset?:number;byteSize?:number;sha256?:string}
        if(!response.bytes||response.bytes.length!==length||metadata.transferId!==item.intent.transferId||metadata.offset!==offset||metadata.byteSize!==length||metadata.sha256!==hash(response.bytes))throw new DomainError('JOB_INPUT_TRANSFER_CORRUPT','Authenticated input chunk differs from accepted pins.',410)
        status=await this.receiver.append(item.intent.transferId,outputTransferContext(this.channel.currentBinding()),{offset,sha256:metadata.sha256,bytes:response.bytes})
      }
      await this.receiver.finish(item.intent.transferId,outputTransferContext(this.channel.currentBinding()))
    }
    return admission
  }
  async recheck(execution:JobExecutionRecord,admission:JobInputAdmission,signal:AbortSignal){for(const item of admission.transfers){signal.throwIfAborted();await this.receiver.status(item.intent.transferId,outputTransferContext(this.channel.currentBinding()))}if(inputHash(recipient(execution))!==inputHash(admission.manifest.recipient))throw new DomainError('JOB_INPUT_RECIPIENT_CONFLICT','Detached inputs belong to another actual job.',409)}
  async read(execution:JobExecutionRecord,admission:JobInputAdmission,path:string,offset:number,length:number,signal:AbortSignal) {
    await this.recheck(execution,admission,signal)
    const item=admission.transfers.find(value=>value.relativePath===path)
    if(!item)throw new DomainError('JOB_INPUT_NOT_ADMITTED','No original verified transfer exists for this input.',403)
    const receipt=await this.receiver.resolveVerifiedReceipt(item.intent.transferId,outputTransferContext(this.channel.currentBinding())),stream=await this.receiver.openVerified(receipt,outputTransferContext(this.channel.currentBinding()))
    const {byteRange}=await import('../tools/transfers.js')
    return byteRange(stream,offset,length)
  }
  async close(){await this.receiver.close()}
}
