import { jobLifecycleSignal } from '../../jobs/lifecycle.js'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { JobOutputPublicationInputSchema, type JobOutputPublicationInput } from '@foreman-code/contracts/job-output-transfer'
import { BYTE_TRANSFER_POLICY, TransferIntentSchema, type TransferIntent } from '@foreman-code/contracts/byte-transfer'
import type { JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import type { ImmutableTransferSource } from '../../byte-transfer/sender.js'
import { DomainError } from '../../errors.js'
import type { RemoteOperationJournal } from './operationJournal.js'

export interface RetainedJobOutputRsyncRecord {
  intent:TransferIntent
  input:JobOutputPublicationInput
  operationId:string
  specDigest:string
  closureEvidenceDigest:string
}
/** HRT mounts the existing immutable store and original quota hold. retain must durably
 * fsync the exact record-to-sealed-reader correlation before returning; resolve recovers
 * only that record. No current project path may be opened, no new admission/expiry issued. */
export interface RetainedJobOutputRsyncStore {
  retain(record:RetainedJobOutputRsyncRecord,capturedBytes:Uint8Array,signal:AbortSignal):Promise<void>
  resolve(transferId:string,signal:AbortSignal):Promise<{record:RetainedJobOutputRsyncRecord;source:ImmutableTransferSource}>
}
/** Registers already captured closed Job bytes, then serves only their original admission. */
export class JobOutputRsyncSource {
  constructor(private readonly journal:Pick<RemoteOperationJournal,'jobStatus'>,private readonly retained:RetainedJobOutputRsyncStore) {}
  private async closed(record:RetainedJobOutputRsyncRecord) {
    const status=await this.journal.jobStatus(record.operationId)
    if(status.status!=='known')throw new DomainError('JOB_OUTPUT_CLOSURE_MISSING','The original worker closure journal is unavailable.',409)
    const receipt=status.receipt,execution=receipt.execution,input=record.input,intent=record.intent
    if(receipt.phase!=='confirmed_terminal'||!receipt.entryAttempted||!receipt.native||!receipt.terminal?.processStopped
      ||receipt.terminal.closureEvidenceDigest!==record.closureEvidenceDigest||receipt.intent.operationId!==record.operationId
      ||execution.operationId!==record.operationId||execution.id!==input.executionId||execution.workspaceId!==input.workspaceId
      ||receipt.intent.executionId!==execution.id||receipt.intent.attemptId!==execution.attemptId
      ||execution.attemptId!==input.attemptId||!isDeepStrictEqual(execution.owner,input.owner)||!isDeepStrictEqual(receipt.intent.owner,input.owner)
      ||execution.acceptedSpec.specDigest!==record.specDigest||receipt.intent.bindingHash!==execution.acceptedSpec.bindingHash
      ||intent.executionId!==input.executionId||intent.attemptId!==input.attemptId||intent.direction!=='to-main'||intent.byteClass!=='artifact'
      ||intent.placementHash!==execution.acceptedSpec.bindingHash||intent.manifestDigest!==execution.acceptedSpec.outputSpecDigest
      ||intent.sha256!==input.sha256||intent.byteSize!==input.byteSize||execution.acceptedSpec.target.hostRef.kind!=='device'
      ||intent.mainId!==execution.acceptedSpec.target.mainId||intent.deviceId!==execution.acceptedSpec.target.hostRef.deviceId
      ||intent.workerInstallationId!==execution.acceptedSpec.target.registration?.workerInstallationId
      ||intent.keyRevision!==execution.acceptedSpec.target.registration?.keyRevision
      ||intent.authorizationRevision!==execution.acceptedSpec.target.registration?.authorizationRevision
      ||input.byteSize>execution.acceptedSpec.policy.maxOutputBytes
      ||!execution.acceptedSpec.outputs.some(output=>output.path===input.path&&output.mediaType===input.mediaType))
      throw new DomainError('JOB_OUTPUT_CLOSURE_CONFLICT','Sealed bytes do not belong to the original accepted closed Job.',409)
    return execution
  }
  async register(execution:JobExecutionRecord,rawInput:JobOutputPublicationInput,rawIntent:TransferIntent,capturedBytes:Uint8Array,signal:AbortSignal):Promise<void> {
    signal.throwIfAborted()
    const input=JobOutputPublicationInputSchema.parse(rawInput),intent=TransferIntentSchema.parse(rawIntent)
    const status=await this.journal.jobStatus(execution.operationId)
    if(status.status!=='known'||!status.receipt.terminal)throw new DomainError('JOB_OUTPUT_CLOSURE_MISSING','The original closed output journal is unavailable.',409)
    const record={intent,input,operationId:execution.operationId,specDigest:execution.acceptedSpec.specDigest,closureEvidenceDigest:status.receipt.terminal.closureEvidenceDigest}
    const original=await this.closed(record)
    if(!isDeepStrictEqual(original,execution))throw new DomainError('JOB_OUTPUT_CLOSURE_CONFLICT','Caller execution differs from original journal closure.',409)
    const bytes=Buffer.from(capturedBytes)
    if(bytes.length!==input.byteSize||createHash('sha256').update(bytes).digest('hex')!==input.sha256)
      throw new DomainError('JOB_OUTPUT_HASH_CONFLICT','Captured immutable bytes differ from original admission.',410)
    await this.retained.retain(record,bytes,signal)
    signal.throwIfAborted()
  }
  async resolveSource(intent:TransferIntent,signal:AbortSignal):Promise<ImmutableTransferSource> {
    signal.throwIfAborted()
    const {record,source}=await this.retained.resolve(intent.transferId,signal)
    if(!isDeepStrictEqual(record.intent,intent))throw new DomainError('JOB_OUTPUT_TRANSFER_CONFLICT','Source lookup cannot replace the original admission.',403)
    const execution = await this.closed(record)
    const lifetime = jobLifecycleSignal(execution, 'publication')
    lifetime.throwIfAborted()
    return {read:async(accepted,offset,length,bounded)=>{
      const readSignal = AbortSignal.any([signal, lifetime, ...(bounded ? [bounded] : [])])
      readSignal.throwIfAborted()
      if(!isDeepStrictEqual(accepted,intent)||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)
        ||length<1||length>BYTE_TRANSFER_POLICY.maxChunkBytes||offset+length>intent.byteSize)throw new DomainError('JOB_OUTPUT_TRANSFER_CONFLICT','Sealed output range differs from its original admission.',403)
      await this.closed(record)
      const bytes=await source.read(accepted,offset,length,readSignal)
      if(bytes.length!==length)throw new DomainError('JOB_OUTPUT_HASH_CONFLICT','Retained sealed output range is incomplete.',410)
      readSignal.throwIfAborted()
      return bytes
    }}
  }
}
