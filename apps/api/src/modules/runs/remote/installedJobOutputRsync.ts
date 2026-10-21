import { jobLifecycleSignal } from '../../jobs/lifecycle.js'
import { isDeepStrictEqual } from 'node:util'
import { VerifiedTransferReceiptSchema, BYTE_TRANSFER_POLICY, type TransferIntent, type TransferContext } from '@foreman-code/contracts/byte-transfer'
import { JobArtifactSchema } from '@foreman-code/contracts/jobs'
import { JobOutputStageRequestSchema, JobOutputStatusRequestSchema } from '@foreman-code/contracts/job-output-transfer'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { InstalledRsyncProviders } from '../../byte-transfer/productionComposition.js'
import type { RsyncWriterOwnership } from '../../byte-transfer/rsyncWriterOwnership.js'
import { transferContextForBinding } from '../../byte-transfer/carrier.js'
import { DeviceApplicationError } from '../../devices/deviceApplicationChannel.js'
import { DomainError } from '../../errors.js'
import { JOB_OUTPUT_NAMESPACE } from '../../files/jobs/workerProtocol.js'
import { createInstalledJobOutputRsyncStore } from './installedJobOutputRsyncStore.js'
import { JobOutputRsyncSource } from './jobOutputRsyncSource.js'
import type { RemoteOperationJournal } from './operationJournal.js'
import type { WorkerJobOutputRsyncPort } from './workerJobOutputs.js'

/** Actual closed Job journal, original quota and current W07 carrier. */
export async function createInstalledJobOutputRsync(input:{providers:InstalledRsyncProviders;journal:RemoteOperationJournal;
  ownership: Pick<RsyncWriterOwnership, 'access'>;
  current():Readonly<DeviceSessionBinding>;
  request(namespace:string,payload:unknown,options:{signal:AbortSignal;timeoutMs?:number}):Promise<{payload:unknown;bytes?:Uint8Array}>}){
  const context=async(signal?:AbortSignal)=>{signal?.throwIfAborted();return transferContextForBinding(input.current())}
  const store=await createInstalledJobOutputRsyncStore({rootDirectory:input.providers.stagingRoot,quota:input.providers.receiver,current:context,
    authorize:async(intent,current,signal)=>{signal?.throwIfAborted();await input.providers.accepted.authorize(intent,current,'read');signal?.throwIfAborted()},
    quiescent:input.providers.quiescent})
  const source=new JobOutputRsyncSource(input.journal,store)
  const owner=async(intent:TransferIntent)=>{
    if(intent.direction!=='to-main'||intent.byteClass!=='artifact')return undefined
    const matches=(await input.journal.jobOperations()).filter(value=>value.execution.id===intent.executionId)
    if(matches.length>1)throw new DomainError('JOB_OUTPUT_CLOSURE_CONFLICT','The original Job output owner is ambiguous.',409)
    return matches[0]
  }
  const published=async(intent:TransferIntent,signal:AbortSignal)=>{
    const original=await owner(intent)
    if(!original||original.phase!=='confirmed_terminal'||!original.terminal?.processStopped||!original.native||!original.entryAttempted
      ||original.execution.attemptId!==intent.attemptId||original.execution.acceptedSpec.bindingHash!==intent.placementHash
      ||original.execution.acceptedSpec.outputSpecDigest!==intent.manifestDigest)
      throw new DomainError('JOB_OUTPUT_CLOSURE_MISSING','The exact original closed Job owner is unavailable.',409)
    let reply:{payload:unknown;bytes?:Uint8Array}
    try{reply=await input.request(JOB_OUTPUT_NAMESPACE,JobOutputStatusRequestSchema.parse({method:'job-output-status',transferId:intent.transferId}),{signal})}
    catch(error){if(error instanceof DeviceApplicationError&&error.code==='job-publication-pending')return undefined;throw error}
    if(reply.bytes!==undefined)throw new DomainError('JOB_OUTPUT_METADATA_INVALID','Canonical publication status contains no peer bytes.',400)
    const artifact=JobArtifactSchema.parse(reply.payload)
    if(artifact.executionId!==intent.executionId||artifact.sha256!==intent.sha256||artifact.byteSize!==intent.byteSize||artifact.state!=='available'
      ||!original.execution.acceptedSpec.outputs.some(value=>value.path===artifact.path&&value.mediaType===artifact.mediaType))
      throw new DomainError('JOB_OUTPUT_TRANSFER_CONFLICT','Canonical readback differs from the exact original closed Job output.',409)
    return artifact
  }
  const collector:WorkerJobOutputRsyncPort={published,register:async(execution,publication,intent,bytes,signal)=>{
    signal.throwIfAborted()
    const binding = input.current()
    await input.providers.accepted.authorize(intent, transferContextForBinding(binding), 'read')
    signal.throwIfAborted()
    const access = input.ownership.access(intent, binding, 'source-materializer')
    try {
      await access.run(ownerSignal => source.register(execution, publication, intent, bytes,
        AbortSignal.any([signal, ownerSignal])))
    } finally {
      await access.close()
    }
  },stage:async(intent,signal)=>{
    signal.throwIfAborted()
    const timeoutMs = Math.min(BYTE_TRANSFER_POLICY.maxIdleMs, Date.parse(intent.expiresAt) - Date.now())
    if (timeoutMs <= 0) throw new DomainError('JOB_OUTPUT_TRANSFER_EXPIRED', 'The original output transfer has expired.', 409)
    const reply=await input.request(JOB_OUTPUT_NAMESPACE,JobOutputStageRequestSchema.parse({method:'job-output-stage',transferId:intent.transferId}),{signal,timeoutMs})
    if(reply.bytes!==undefined)throw new DomainError('JOB_OUTPUT_METADATA_INVALID','Staging status contains no peer bytes.',400)
    const receipt=VerifiedTransferReceiptSchema.parse(reply.payload)
    if(!isDeepStrictEqual(receipt.intent,intent)||receipt.transferId!==intent.transferId||receipt.sha256!==intent.sha256||receipt.byteSize!==intent.byteSize)
      throw new DomainError('JOB_OUTPUT_TRANSFER_CONFLICT','Staging receipt differs from the original admitted output.',409)
  }}
  return {collector,owns:async(intent:TransferIntent)=>Boolean(await owner(intent)),resolveSource:(intent:TransferIntent,signal:AbortSignal)=>source.resolveSource(intent,signal),
    acknowledged:async(intent:TransferIntent,current:TransferContext)=>{
      const original = await owner(intent)
      if (!original) throw new DomainError('JOB_OUTPUT_CLOSURE_MISSING', 'Original closed output owner missing.', 409)
      const signal=jobLifecycleSignal(original.execution, 'cleanup')
      if(!isDeepStrictEqual(await context(signal),current))throw new DomainError('JOB_OUTPUT_CONNECTION_STALE','Canonical ACK requires the actual original worker frame.',403)
      if(!await published(intent,signal))throw new DomainError('JOB_PUBLICATION_PENDING','The original canonical output is not finalized.',409)
      if(!isDeepStrictEqual(await context(signal),current))throw new DomainError('JOB_OUTPUT_CONNECTION_STALE','The original publication channel changed.',403)
      await store.retire(intent,signal)
    }}
}
