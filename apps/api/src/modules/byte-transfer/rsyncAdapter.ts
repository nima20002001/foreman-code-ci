import { TransferIntentSchema, type ByteTransferPort, type TransferContext, type VerifiedTransferReceipt } from '@foreman-code/contracts/byte-transfer'
import { ResumableByteTransferSender } from './sender.js'
import type { RsyncStagedBytes } from './rsync.js'

/** Destination-local adoption through the existing verifier/journal, without another network transfer.
 * C then publishes this genuine existing verified receipt through its canonical validator/finalizer.
 * Caller retains staging until canonical acknowledgment; failure must not discard the only byte copy. */
export async function importRsyncStagedBytes(staged: RsyncStagedBytes, receiver: ByteTransferPort,
  current: (signal?: AbortSignal) => Promise<TransferContext>, signal?: AbortSignal): Promise<VerifiedTransferReceipt> {
  return new ResumableByteTransferSender(receiver, {
    read: (intent, offset, length, bounded) => {
      if (JSON.stringify(intent) !== JSON.stringify(TransferIntentSchema.parse(staged.intent))) throw new Error('Staged transfer identity changed')
      return staged.read(offset, length, bounded ?? new AbortController().signal)
    },
  }, { current, retryable: () => false }).send(staged.intent, signal)
}
