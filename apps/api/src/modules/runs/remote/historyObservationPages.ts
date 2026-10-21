import { isDeepStrictEqual } from 'node:util'
import type { AcceptedNodePlacement, DispatchIntent } from '@foreman-code/contracts/node-placement'
import { RemoteHistoryReceiptIdentitySchema,
  type RemoteExecutionRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import { RemoteOperationStatusSchema } from '@foreman-code/contracts/remote-execution'
import type { DeviceHistoryPage } from '@foreman-code/contracts/device-application'
import { readNativeHistoryMetadata } from './nativeHistoryPage.js'
import { DomainError } from '../../errors.js'

type HistoryRequest = Extract<RemoteExecutionRpcRequest, { method: 'history' }>
type Observation = {
  intent: DispatchIntent
  placement: AcceptedNodePlacement
  page: DeviceHistoryPage
  receiptIdentity: ReturnType<typeof RemoteHistoryReceiptIdentitySchema.parse>
  correlationId: string | undefined
}

/** Metadata pages continue the first observation instead of reading native history again. */
export class HistoryObservationPages {
  private readonly observations = new Map<string, Observation>()

  private key(intent: DispatchIntent, sequence: number, digest: string, afterSequence: number) {
    return JSON.stringify([intent.operationId, sequence, digest, afterSequence])
  }

  remember<T extends { page: DeviceHistoryPage; status: unknown; history: { correlationId?: string } }>(reply: T,
    intent: DispatchIntent, placement: AcceptedNodePlacement) {
    if (!reply.page.metadata) return reply
    const status = RemoteOperationStatusSchema.parse(reply.status)
    if (status.status !== 'known') throw new Error('Original history receipt is unavailable')
    const key = this.key(intent, status.receipt.sequence, reply.page.metadata.digest, reply.page.nextAfterSequence)
    if (!this.observations.has(key) && this.observations.size >= 64) {
      this.observations.delete(this.observations.keys().next().value!)
    }
    this.observations.set(key, {
      intent: structuredClone(intent), placement: structuredClone(placement), page: structuredClone(reply.page),
      receiptIdentity: RemoteHistoryReceiptIdentitySchema.parse(status.receipt),
      correlationId: reply.history.correlationId,
    })
    return reply
  }

  read(frame: HistoryRequest) {
    if (!frame.metadata || frame.receiptSequence === undefined) {
      throw new DomainError('conflict', 'Native history continuation requires its original receipt sequence.', 409)
    }
    const key = this.key(frame.intent, frame.receiptSequence, frame.metadata.digest, frame.afterSequence ?? -1)
    const original = this.observations.get(key)
    if (!original) {
      throw new DomainError('transfer-expired', 'Native history observation is no longer retained.', 409)
    }
    if (!isDeepStrictEqual(original.intent, frame.intent) || !isDeepStrictEqual(original.placement, frame.placement)
      || original.correlationId !== frame.correlationId || original.page.nextAfterSequence !== frame.afterSequence) {
      throw new DomainError('conflict', 'Native history observation owner or cursor changed.', 409)
    }
    const metadata = readNativeHistoryMetadata(frame.metadata)
    this.observations.delete(key)
    this.observations.set(key, original)
    return { receiptIdentity: original.receiptIdentity, page: { ...original.page, metadata } }
  }
}
