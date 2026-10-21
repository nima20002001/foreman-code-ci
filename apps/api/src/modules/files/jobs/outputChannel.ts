import { TransferContextSchema, TransferIntentSchema, TransferProgressSchema, VerifiedTransferReceiptSchema, type ByteTransferPort, type TransferContext, type TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { JobArtifactSchema } from '@foreman-code/contracts/jobs'
import { JobOutputDeviceRequestSchema, type JobOutputPublicationInput } from '@foreman-code/contracts/job-output-transfer'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceExtensionRegistration } from '../../devices/deviceApplicationChannel.js'
import { DeviceApplicationError } from '../../devices/deviceApplicationError.js'
import { TransferExpiredError, type ResumableByteTransferService } from '../../byte-transfer/service.js'
import type { CanonicalJobArtifactPort } from './port.js'
import type { PostgresJobOutputAdmission } from './outputAdmission.js'
import { JOB_OUTPUT_NAMESPACE, outputTransferContext } from './workerProtocol.js'
import { DomainError } from '../../errors.js'

export function throwJobOutputTransferError(error: unknown): never {
  if (error instanceof TransferExpiredError || error instanceof DomainError && error.code === 'FILE_EXPIRED') {
    throw new DeviceApplicationError('job-output-expired')
  }
  throw error
}

/** Main handler only accepts metadata/assertions. Intent IDs/roots/context come from its durable ledger. */
export function jobOutputDeviceExtension(admission: PostgresJobOutputAdmission, artifacts: CanonicalJobArtifactPort,
  receiver: ResumableByteTransferService): DeviceExtensionRegistration {
  return { namespace: JOB_OUTPUT_NAMESPACE, version: 1, role: 'server', maxJsonBytes: 16384, maxBinaryBytes: 8192,
    handle: async (raw, channel) => admission.onAuthenticatedChannel(channel.binding,async()=>{
      channel.signal.throwIfAborted()
      const request=JobOutputDeviceRequestSchema.parse(raw)
      if(request.method==='job-output-admit')return {payload:await admission.admit(request.input,'device')}
      if(request.method==='job-output-publish'){await admission.requireAdmission(request.input);return {payload:(await artifacts.publishAccepted(request.input,'device')).artifact}}
      const intent=await admission.intentForTransfer(request.transferId),context=outputTransferContext(channel.binding)
      await admission.authorizeTransfer(intent,context)
      let payload
      if(request.method==='start')payload=await receiver.start(intent,context,channel.signal)
      else if(request.method==='status')payload=await receiver.status(intent.transferId,context,channel.signal)
      else if(request.method==='finish')payload=await receiver.finish(intent.transferId,context,channel.signal)
      else if(request.method==='cancel')payload=await receiver.cancel(intent.transferId,context,channel.signal)
      else if(request.method==='append') {
        if(!channel.bytes || channel.bytes.byteLength!==request.byteLength)throw new DomainError('JOB_OUTPUT_CHUNK_INVALID','The bounded binary chunk does not match its metadata.',400)
        payload=await receiver.append(intent.transferId,context,{offset:request.offset,sha256:request.sha256,bytes:channel.bytes},channel.signal)
      }
      channel.signal.throwIfAborted();return {payload}
    }).catch(throwJobOutputTransferError) }
}
export interface WorkerJobOutputChannel {
  request(namespace: 'byte-transfer-v1', payload: unknown, options?: {signal?:AbortSignal;bytes?:Uint8Array}): Promise<{payload:unknown}>
}
/** Existing W07 authenticated application channel, not another listener/connection manager. */
export class WorkerJobOutputApplication {
  constructor(private readonly channel: WorkerJobOutputChannel) {}
  async admit(input: JobOutputPublicationInput, signal?: AbortSignal): Promise<TransferIntent> {
    return TransferIntentSchema.parse((await this.channel.request(JOB_OUTPUT_NAMESPACE,{method:'job-output-admit',input}, signal ? { signal } : {})).payload)
  }
  async publish(input: JobOutputPublicationInput, signal?: AbortSignal) {
    return JobArtifactSchema.parse((await this.channel.request(JOB_OUTPUT_NAMESPACE,{method:'job-output-publish',input}, signal ? { signal } : {})).payload)
  }
}
export class WorkerJobOutputReceiver implements ByteTransferPort {
  constructor(private readonly channel: WorkerJobOutputChannel) {}
  async start(intent: TransferIntent, context: TransferContext, signal?: AbortSignal) {
    TransferContextSchema.parse(context)
    return TransferProgressSchema.parse((await this.channel.request(JOB_OUTPUT_NAMESPACE,{method:'start',transferId:TransferIntentSchema.parse(intent).transferId}, signal ? { signal } : {})).payload)
  }
  async status(id: string, context: TransferContext, signal?: AbortSignal) {TransferContextSchema.parse(context);return TransferProgressSchema.parse((await this.channel.request(JOB_OUTPUT_NAMESPACE,{method:'status',transferId:id}, signal ? { signal } : {})).payload)}
  async append(id: string, context: TransferContext, chunk: {offset:number;sha256:string;bytes:Uint8Array}, signal?: AbortSignal) {
    TransferContextSchema.parse(context)
    return TransferProgressSchema.parse((await this.channel.request(JOB_OUTPUT_NAMESPACE,{method:'append',transferId:id,offset:chunk.offset,sha256:chunk.sha256,byteLength:chunk.bytes.length},{bytes:chunk.bytes, ...(signal ? { signal } : {})})).payload)
  }
  async finish(id: string, context: TransferContext, signal?: AbortSignal) {TransferContextSchema.parse(context);return VerifiedTransferReceiptSchema.parse((await this.channel.request(JOB_OUTPUT_NAMESPACE,{method:'finish',transferId:id}, signal ? { signal } : {})).payload)}
  async cancel(id: string, context: TransferContext, signal?: AbortSignal) {TransferContextSchema.parse(context);return TransferProgressSchema.parse((await this.channel.request(JOB_OUTPUT_NAMESPACE,{method:'cancel',transferId:id}, signal ? { signal } : {})).payload)}
}
/** The sender consumes only a real current W07 binding, including its monotonic generation. */
export function workerOutputContext(binding: Readonly<DeviceSessionBinding>) {return TransferContextSchema.parse(outputTransferContext(binding))}
