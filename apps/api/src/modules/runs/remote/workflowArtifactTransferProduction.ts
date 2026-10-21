import { TransferIntentSchema } from '@foreman-code/contracts/byte-transfer'
import type { DeviceExtensionRegistration } from '../../devices/deviceApplicationChannel.js'
import { BYTE_TRANSFER_NAMESPACE } from '../../byte-transfer/carrier.js'
import { BYTE_TRANSFER_POLICY } from '@foreman-code/contracts/byte-transfer'
import { DomainError } from '../../errors.js'
import type { createWorkflowArtifactReceiver } from './workflowArtifactReceiver.js'

type Receiver = Pick<ReturnType<typeof createWorkflowArtifactReceiver>, 'extension' | 'ownsTransfer'>
/** Route by durable admitted membership, before authorization. An artifact
 * denial never falls through to the separate source-package receiver. */
export function createMainWorkflowArtifactTransferExtension(current: () => Receiver | undefined,
  source?: DeviceExtensionRegistration,job?:()=>Receiver|undefined): DeviceExtensionRegistration {
  return { namespace: BYTE_TRANSFER_NAMESPACE, version: 1, role: 'duplex', maxJsonBytes: 16384,
    maxBinaryBytes: BYTE_TRANSFER_POLICY.maxChunkBytes, async handle(raw, frame) {
      frame.signal.throwIfAborted()
      const receiver = current()
      const method=raw&&typeof raw==='object'&&'method' in raw?raw.method:undefined
      const jobReceiver=job?.()
      if(typeof method==='string'&&method.startsWith('job-output-')){
        if(!jobReceiver)throw new DomainError('JOB_OUTPUT_RECEIVER_UNAVAILABLE','The original admitted Job output receiver is not initialized.',503)
        return jobReceiver.extension.handle!(raw,frame)
      }
      if (!receiver) throw new DomainError('WORKFLOW_ARTIFACT_RECEIVER_UNAVAILABLE', 'The original Main artifact receiver is not initialized.', 503)
      const id = TransferIntentSchema.shape.transferId.parse(raw && typeof raw === 'object' && 'transferId' in raw ? raw.transferId : undefined)
      const artifact = await receiver.ownsTransfer(id)
      frame.signal.throwIfAborted()
      if (artifact) return receiver.extension.handle!(raw, frame)
      if(job){
        if(!jobReceiver)throw new DomainError('JOB_OUTPUT_RECEIVER_UNAVAILABLE','The original admitted Job output receiver is not initialized.',503)
        const owned=await jobReceiver.ownsTransfer(id);frame.signal.throwIfAborted()
        if(owned)return jobReceiver.extension.handle!(raw,frame)
      }
      if (!source?.handle) throw new DomainError('SOURCE_TRANSFER_RECEIVER_UNAVAILABLE', 'No original source-package receiver owns this transfer.', 409)
      return source.handle(raw, frame)
    } }
}
