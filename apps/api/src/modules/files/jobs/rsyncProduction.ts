import { JobOutputStageRequestSchema, JobOutputStatusRequestSchema, JobOutputDeviceRequestSchema } from '@foreman-code/contracts/job-output-transfer'
import { VerifiedTransferReceiptSchema, type TransferIntent } from '@foreman-code/contracts/byte-transfer'
import type { DeviceExtensionRegistration } from '../../devices/deviceApplicationChannel.js'
import { DomainError } from '../../errors.js'
import { DeviceApplicationError } from '../../devices/deviceApplicationChannel.js'
import { isDeepStrictEqual } from 'node:util'
import type { PostgresJobOutputAdmission } from './outputAdmission.js'
import type { JobOutputRsyncLifecycle } from './rsyncLifecycle.js'
import { outputTransferContext } from './workerProtocol.js'
import { throwJobOutputTransferError } from './outputChannel.js'

export interface MainJobOutputRsyncPorts {
  stage(intent:TransferIntent,signal:AbortSignal):Promise<unknown>
  acknowledge(intent:TransferIntent,signal:AbortSignal):Promise<void>
}
/** Existing Job channel and admission are the authority; no peer intent or ACK flag. */
export function createMainJobOutputRsyncExtension(admission:Pick<PostgresJobOutputAdmission,'onAuthenticatedChannel'|'intentForTransfer'|'authorizeTransfer'|'requireAdmission'>,
  lifecycle:Pick<JobOutputRsyncLifecycle,'acknowledged'>,original:DeviceExtensionRegistration,rsync?:MainJobOutputRsyncPorts):DeviceExtensionRegistration {
  return {...original,async handle(raw,frame){
    const method=raw&&typeof raw==='object'&&'method' in raw?raw.method:undefined
    if(method==='job-output-publish'&&rsync)return admission.onAuthenticatedChannel(frame.binding,async()=>{
      const request=JobOutputDeviceRequestSchema.parse(raw)
      if(request.method!=='job-output-publish')throw new Error('Original output publication is required')
      if(frame.bytes!==undefined)throw new DomainError('JOB_OUTPUT_METADATA_INVALID','Publication accepts only original output metadata.',400)
      const reply=await original.handle!(raw,frame),{intent}=await admission.requireAdmission(request.input)
      await lifecycle.acknowledged(intent);frame.signal.throwIfAborted()
      // Expired canonical replay cannot revive the original staging attempt.
      if(Date.parse(intent.expiresAt)>Date.now())await rsync.acknowledge(intent,frame.signal)
      return reply
    }).catch(throwJobOutputTransferError)
    if(method!=='job-output-stage'&&method!=='job-output-status')return original.handle!(raw,frame)
    if(frame.bytes!==undefined)throw new DomainError('JOB_OUTPUT_METADATA_INVALID','Job stage/status accepts only original transfer metadata.',400)
    const request=method==='job-output-stage'?JobOutputStageRequestSchema.parse(raw):JobOutputStatusRequestSchema.parse(raw)
    return admission.onAuthenticatedChannel(frame.binding,async()=>{
      frame.signal.throwIfAborted()
      const intent=await admission.intentForTransfer(request.transferId)
      await admission.authorizeTransfer(intent,outputTransferContext(frame.binding))
      frame.signal.throwIfAborted()
      if(request.method==='job-output-stage'){
        if(!rsync)throw new DomainError('JOB_OUTPUT_RSYNC_UNAVAILABLE','The selected original Job output rsync composition is unavailable.',409)
        const receipt=VerifiedTransferReceiptSchema.parse(await rsync.stage(intent,frame.signal))
        if(receipt.transferId!==intent.transferId||receipt.sha256!==intent.sha256||receipt.byteSize!==intent.byteSize
          ||!isDeepStrictEqual(receipt.intent,intent))
          throw new DomainError('JOB_OUTPUT_TRANSFER_CONFLICT','Staging reply differs from the original output admission.',409)
        await admission.authorizeTransfer(intent,outputTransferContext(frame.binding));frame.signal.throwIfAborted()
        return {payload:receipt}
      }
      const artifact=await lifecycle.acknowledged(intent).catch(error=>{
        if(error instanceof DomainError&&error.code==='JOB_PUBLICATION_PENDING')throw new DeviceApplicationError('job-publication-pending', undefined, { cause: error })
        throw error
      })
      frame.signal.throwIfAborted();return {payload:artifact}
    }).catch(throwJobOutputTransferError)
  }}
}
