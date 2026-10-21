import { createHash } from 'node:crypto'
import { BYTE_TRANSFER_POLICY, TransferProgressSchema, TransferIntentSchema, VerifiedTransferReceiptSchema,
  type ByteTransferPort, type TransferContext, type TransferIntent, type VerifiedTransferReceipt } from '@foreman-code/contracts/byte-transfer'

/** A/C supply only an already sealed immutable source/output snapshot, never a live work-file path. */
export interface ImmutableTransferSource {
  read(intent: TransferIntent, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>
}
export interface TransferSenderConnection {
  /** W07 owns reconnect/backoff. This resolves to the newly authenticated connection context. */
  current(signal?: AbortSignal): Promise<TransferContext>
  /** Only interrupted/lost-ACK carrier failures; never authorization, quota or integrity errors. */
  retryable(error: unknown): boolean
}
/** Sequential bounded sender over the sole W07 carrier, with receiver-authoritative recovery. */
export class ResumableByteTransferSender {
  constructor(private readonly receiver: ByteTransferPort, private readonly source: ImmutableTransferSource,
    private readonly connection: TransferSenderConnection) {}

  async send(input: TransferIntent, signal?: AbortSignal): Promise<VerifiedTransferReceipt> {
    const intent = TransferIntentSchema.parse(input)
    let retries = 0
    const check = () => { signal?.throwIfAborted(); if (Date.now() >= Date.parse(intent.expiresAt)) throw new Error('Transfer sender expired') }
    const wait = async <T>(action: (bounded: AbortSignal) => Promise<T>): Promise<T> => {
      check()
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      let abort = () => {}
      const interrupted = new Promise<never>((_, reject) => {
        abort = () => { controller.abort(signal?.reason); reject(signal?.reason ?? new Error('Transfer sender aborted')) }
        signal?.addEventListener('abort', abort, { once: true })
        timer = setTimeout(() => {
          const error = new Error('Transfer sender deadline exceeded')
          controller.abort(error); reject(error)
        }, Math.min(BYTE_TRANSFER_POLICY.maxIdleMs, Date.parse(intent.expiresAt) - Date.now()))
      })
      const work = action(controller.signal)
      try { return await Promise.race([work, interrupted]) }
      finally {
        controller.abort(new Error('Transfer range closed'))
        await Promise.allSettled([work])
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
    }
    const retry = (error: unknown) => {
      check()
      if (!this.connection.retryable(error) || retries++ >= BYTE_TRANSFER_POLICY.maxRetries) throw error
    }
    const recover = async () => {
      for (;;) {
        check()
        try {
          const progress = TransferProgressSchema.parse(await wait(async bounded => this.receiver.status(intent.transferId, await this.connection.current(bounded), bounded)))
          if (progress.transferId !== intent.transferId || progress.durableOffset > intent.byteSize || progress.state === 'cancelled') throw new Error('Invalid receiver progress')
          return progress
        }
        catch (error) { retry(error) }
      }
    }
    for (;;) {
      check()
      try { await wait(async bounded => this.receiver.start(intent, await this.connection.current(bounded), bounded)); break }
      catch (error) { retry(error) }
    }
    let progress = await recover()
    while (progress.durableOffset < intent.byteSize) {
      check()
      if (progress.state === 'cancelled' || progress.durableOffset < 0 || progress.durableOffset > intent.byteSize) throw new Error('Invalid receiver progress')
      const offset = progress.durableOffset, length = Math.min(intent.chunkBytes, intent.byteSize - offset)
      const inputBytes = await wait(bounded => this.source.read(intent, offset, length, bounded))
      if (inputBytes.byteLength !== length) throw new Error('Immutable source length changed')
      const bytes = Buffer.from(inputBytes)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      try {
        check()
        const ack = await wait(async bounded => this.receiver.append(intent.transferId, await this.connection.current(bounded), { offset, sha256, bytes }, bounded))
        if (ack.transferId !== intent.transferId || ack.durableOffset !== offset + length) throw new Error('Invalid receiver acknowledgment')
        progress = ack
      } catch (error) { retry(error); progress = await recover() }
    }
    for (;;) {
      check()
      try {
        const receipt = VerifiedTransferReceiptSchema.parse(await wait(async bounded => this.receiver.finish(intent.transferId, await this.connection.current(bounded), bounded)))
        if (receipt.transferId !== intent.transferId || receipt.sha256 !== intent.sha256 || receipt.byteSize !== intent.byteSize
          || JSON.stringify(receipt.intent) !== JSON.stringify(intent)) throw new Error('Verified receipt identity mismatch')
        return receipt
      } catch (error) { retry(error) }
    }
  }
}
