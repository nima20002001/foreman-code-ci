import { isDeepStrictEqual } from 'node:util'
import { JobInputStageRequestSchema, JobInputDeliveryAckRequestSchema, JobInputDeliveryStatusRequestSchema } from '@foreman-code/contracts/job-inputs'
import { VerifiedTransferReceiptSchema, type TransferIntent } from '@foreman-code/contracts/byte-transfer'
import type { DeviceExtensionRegistration } from '../../devices/deviceApplicationChannel.js'
import type { ImmutableTransferSource } from '../../byte-transfer/sender.js'
import { DomainError } from '../../errors.js'
import type { CanonicalJobInputs } from './service.js'
import { CanonicalJobInputRsyncSource } from './rsync.js'
import { outputTransferContext } from '../jobs/workerProtocol.js'

export interface MainJobInputRsyncPorts {
  stage(intent: TransferIntent, source: ImmutableTransferSource, signal: AbortSignal): Promise<unknown>
  acknowledge(intent: TransferIntent, signal: AbortSignal): Promise<void>
}
/** The original canonical admission and authenticated frame remain the authority.
 * Delivery status is read-only; it never recursively coordinates backend ACK. */
export function createMainJobInputRsyncExtension(
  canonical: Pick<CanonicalJobInputs, 'acceptedTransfer' | 'assertChannel' | 'authorizeTransfer' | 'acknowledgeDelivery' | 'acknowledged' | 'read'>,
  original: DeviceExtensionRegistration, rsync?: MainJobInputRsyncPorts,
): DeviceExtensionRegistration {
  return { ...original, async handle(raw, frame) {
    const method = raw && typeof raw === 'object' && 'method' in raw ? raw.method : undefined
    if (method !== 'stage' && method !== 'delivery-ack' && method !== 'delivery-status') return original.handle!(raw, frame)
    if (frame.bytes !== undefined) throw new DomainError('JOB_INPUT_METADATA_INVALID', 'Input stage/ACK/status accepts only original metadata.', 400)
    const request = method === 'stage' ? JobInputStageRequestSchema.parse(raw) : method === 'delivery-ack'
      ? JobInputDeliveryAckRequestSchema.parse(raw) : JobInputDeliveryStatusRequestSchema.parse(raw)
    frame.signal.throwIfAborted()
    const { execution, transfer } = await canonical.acceptedTransfer(request.transferId), intent = transfer.intent
    if (intent.transferId !== request.transferId) throw new DomainError('JOB_INPUT_TRANSFER_CONFLICT', 'Canonical input transfer differs from the request.', 409)
    canonical.assertChannel(execution, frame.binding); frame.signal.throwIfAborted()
    if (request.method === 'delivery-status') {
      const receipt = await canonical.acknowledged(intent.transferId, frame.binding)
      canonical.assertChannel(execution, frame.binding); frame.signal.throwIfAborted()
      return { payload: receipt }
    }
    const assertCurrent = async () => {
      frame.signal.throwIfAborted(); canonical.assertChannel(execution, frame.binding)
      await canonical.authorizeTransfer(intent, outputTransferContext(frame.binding))
      canonical.assertChannel(execution, frame.binding); frame.signal.throwIfAborted()
    }
    await assertCurrent()
    if (!rsync) throw new DomainError('JOB_INPUT_RSYNC_UNAVAILABLE', 'The selected original Job input rsync composition is unavailable.', 409)
    if (request.method === 'stage') {
      const receipt = VerifiedTransferReceiptSchema.parse(await rsync.stage(intent, new CanonicalJobInputRsyncSource(canonical), frame.signal))
      if (!isDeepStrictEqual(receipt.intent, intent) || receipt.transferId !== intent.transferId || receipt.sha256 !== intent.sha256 || receipt.byteSize !== intent.byteSize)
        throw new DomainError('JOB_INPUT_TRANSFER_CONFLICT', 'Staging differs from the original canonical input admission.', 409)
      await assertCurrent(); return { payload: receipt }
    }
    const committed = await canonical.acknowledgeDelivery(intent.transferId, request.receipt, frame.binding)
    await assertCurrent()
    const saved = await canonical.acknowledged(intent.transferId, frame.binding)
    if (!isDeepStrictEqual(saved, committed)) throw new DomainError('JOB_INPUT_RECEIPT_CONFLICT', 'Persisted delivery differs from its original ACK.', 409)
    await assertCurrent()
    await rsync.acknowledge(intent, frame.signal)
    await assertCurrent(); return { payload: saved }
  } }
}
