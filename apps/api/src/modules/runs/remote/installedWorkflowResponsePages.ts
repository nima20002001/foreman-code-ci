import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { DEVICE_APPLICATION_JSON_BYTES } from '@foreman-code/contracts/device-application'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DispatchIntent, AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { RemoteReceiptPageSchema, type RemoteReceiptPage,
  type RemoteExecutionRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import { createJsonContinuationPager, readJsonContinuation } from './jsonContinuation.js'
import { DomainError } from '../../errors.js'

type Response = Record<string, unknown>
type Continuation = Extract<RemoteExecutionRpcRequest, { method: 'receipt-continuation' }>
type TransferRequest = Pick<Continuation, 'transferId' | 'receiptSequence' | 'metadata'>
const retainedBytesLimit = 32 * 1024 * 1024
const retentionMs = 120_000

function knownStatus(raw: unknown): Response | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Response
  if (value.status === 'known') return value
  if (value.status && typeof value.status === 'object' && (value.status as Response).status === 'known') {
    return value.status as Response
  }
  return undefined
}

function replaceReceipt(raw: unknown, receipt: unknown): unknown {
  const value = raw as Response
  if (value.status === 'known') return { ...value, receipt }
  return { ...value, status: { ...value.status as Response, receipt } }
}

/** Retains immutable receipt bytes so continuation reads cannot replay a native command. */
export class InstalledWorkflowResponsePages {
  private readonly transfers = new Map<string, {
    bytes: Buffer
    page: ReturnType<typeof createJsonContinuationPager>
    intent: DispatchIntent
    placement: AcceptedNodePlacement
    binding: DeviceSessionBinding
    sequence: number
    expiresAt: number
  }>()
  private retainedBytes = 0

  private remove(id: string) {
    const retained = this.transfers.get(id)
    if (!retained) return
    this.retainedBytes -= retained.bytes.byteLength
    this.transfers.delete(id)
  }

  page(raw: unknown, frame: RemoteExecutionRpcRequest, binding: Readonly<DeviceSessionBinding>): unknown {
    if (raw === undefined || Buffer.byteLength(JSON.stringify(raw)) <= DEVICE_APPLICATION_JSON_BYTES) return raw
    const status = knownStatus(raw)
    if (!status) return raw
    const receipt = RemoteOperationReceiptSchema.parse(status.receipt)
    if (!isDeepStrictEqual(receipt.intent, frame.intent)) throw new Error('Receipt transfer owner changed')
    const bytes = Buffer.from(JSON.stringify(receipt))
    const pager = createJsonContinuationPager(bytes)
    const metadata = pager()
    for (const [id, transfer] of this.transfers) if (transfer.expiresAt <= Date.now()) this.remove(id)
    // Least recently read first: a transfer that is still being read stays retained.
    while (this.retainedBytes + bytes.byteLength > retainedBytesLimit || this.transfers.size >= 128) {
      this.remove(this.transfers.keys().next().value!)
    }
    const transferId = randomUUID()
    this.transfers.set(transferId, { bytes, page: pager,
      intent: structuredClone(frame.intent), placement: structuredClone(frame.placement),
      binding: structuredClone(binding), sequence: receipt.sequence, expiresAt: Date.now() + retentionMs })
    this.retainedBytes += bytes.byteLength
    const page = RemoteReceiptPageSchema.parse({ kind: 'receipt-page', transferId,
      receiptSequence: receipt.sequence, metadata })
    return replaceReceipt(raw, page)
  }

  read(frame: Continuation, binding: Readonly<DeviceSessionBinding>): RemoteReceiptPage {
    const retained = this.transfers.get(frame.transferId)
    if (!retained || retained.expiresAt <= Date.now()) {
      throw new DomainError('transfer-expired', 'Receipt transfer owner or revision changed: snapshot expired.', 409)
    }
    if (!isDeepStrictEqual(retained.binding, binding) || !isDeepStrictEqual(retained.intent, frame.intent)
      || !isDeepStrictEqual(retained.placement, frame.placement) || retained.sequence !== frame.receiptSequence) {
      throw new DomainError('conflict', 'Receipt transfer owner or revision changed', 409)
    }
    const metadata = retained.page(frame.metadata)
    // A served page is reader progress: renew the retention and evict idle transfers before this one.
    retained.expiresAt = Date.now() + retentionMs
    this.transfers.delete(frame.transferId)
    this.transfers.set(frame.transferId, retained)
    return RemoteReceiptPageSchema.parse({ kind: 'receipt-page', transferId: frame.transferId,
      receiptSequence: retained.sequence, metadata })
  }

  clear() {
    this.transfers.clear()
    this.retainedBytes = 0
  }
}

export async function readRemoteReceiptResponse(raw: unknown, intent: DispatchIntent,
  read: (request: TransferRequest) => Promise<unknown>, signal?: AbortSignal): Promise<unknown> {
  const status = knownStatus(raw)
  const parsed = RemoteReceiptPageSchema.safeParse(status?.receipt)
  if (!parsed.success) return raw
  const first = parsed.data
  const receipt = RemoteOperationReceiptSchema.parse(await readJsonContinuation(first.metadata, async metadata => {
    const next = RemoteReceiptPageSchema.parse(await read({ transferId: first.transferId,
      receiptSequence: first.receiptSequence, metadata }))
    if (next.transferId !== first.transferId || next.receiptSequence !== first.receiptSequence) {
      throw new Error('Receipt transfer revision changed')
    }
    return next.metadata
  }, signal))
  if (receipt.sequence !== first.receiptSequence || !isDeepStrictEqual(receipt.intent, intent)) {
    throw new Error('Receipt transfer binding changed')
  }
  return replaceReceipt(raw, receipt)
}
