import { createHash, randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { ByteTransferPort, TransferContext, TransferIntent, TransferProgress, VerifiedTransferReceipt } from '@foreman-code/contracts/byte-transfer'
import { ResumableByteTransferSender } from './sender.js'
import { deferred } from '../../../test/helpers/deferred.js'
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
it('resumes the same immutable intent after lost chunk/final ACK and keeps reads bounded', async () => {
  const bytes = Buffer.from('abcdefgh'), contexts: TransferContext[] = []
  const context = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1,
    authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID() }
  const intent: TransferIntent = { ...context, version: 1, transferId: randomUUID(), operationId: randomUUID(), executionId: randomUUID(),
    attemptId: randomUUID(), placementHash: hash(bytes), rootId: randomUUID(), rootBindingRevision: 1, direction: 'to-main',
    byteClass: 'source', sha256: hash(bytes), byteSize: bytes.length, manifestDigest: hash(bytes), chunkBytes: 4,
    expiresAt: new Date(Date.now() + 60_000).toISOString() }
  const replacementEpoch = randomUUID()
  let offset = 0, lostChunk = true, lostFinal = true, starts = 0
  const progress = (): TransferProgress => ({ version: 1, transferId: intent.transferId, state: 'transferring',
    receivedInMemoryBytes: 0, durableOffset: offset, verifiedBytes: 0, updatedAt: new Date().toISOString() })
  const receipt: VerifiedTransferReceipt = { version: 1, receiptId: randomUUID(), transferId: intent.transferId, intent,
    sha256: intent.sha256, byteSize: bytes.length, verifiedAt: new Date().toISOString() }
  const receiver: ByteTransferPort = {
    start: async same => { expect(same).toEqual(intent); starts++; return progress() }, status: async () => progress(),
    append: async (_, current, chunk) => {
      contexts.push(current); expect(chunk.offset).toBe(offset); expect(chunk.bytes.byteLength).toBeLessThanOrEqual(4)
      offset += chunk.bytes.byteLength
      if (lostChunk) { lostChunk = false; throw new Error('carrier-interrupted') }
      return progress()
    }, finish: async () => { if (lostFinal) { lostFinal = false; throw new Error('carrier-interrupted') }; return receipt },
    cancel: async () => progress(),
  }
  const sender = new ResumableByteTransferSender(receiver, { read: async (_, at, length) => bytes.subarray(at, at + length) },
    { current: async () => ({ ...context, connectionEpoch: contexts.length ? replacementEpoch : context.connectionEpoch }), retryable: error => (error as Error).message === 'carrier-interrupted' })
  expect(await sender.send(intent)).toEqual(receipt); expect(starts).toBe(1); expect(offset).toBe(8)
  expect(contexts.map(c => c.connectionEpoch)).toEqual([context.connectionEpoch, replacementEpoch])
})


it('cancels and joins a pending range before reporting deadline failure', async () => {
  const bytes = Buffer.from('range')
  const context = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID() }
  const intent: TransferIntent = { ...context, version: 1, transferId: randomUUID(), operationId: randomUUID(),
    executionId: randomUUID(), attemptId: randomUUID(), placementHash: hash(bytes), rootId: randomUUID(),
    rootBindingRevision: 1, direction: 'to-main', byteClass: 'artifact', sha256: hash(bytes), byteSize: bytes.length,
    manifestDigest: hash(bytes), chunkBytes: bytes.length, expiresAt: new Date(Date.now() + 60000).toISOString() }
  const progress: TransferProgress = { version: 1, transferId: intent.transferId, state: 'transferring',
    durableOffset: 0, verifiedBytes: 0, receivedInMemoryBytes: 0, updatedAt: new Date().toISOString() }
  let closed = false
  const cleaningUp = deferred()
  const finishCleanup = deferred()
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const receiver: ByteTransferPort = {
    start: async () => progress, status: async () => progress, cancel: async () => progress,
    append: async (_id, _context, _chunk, signal) => {
      if (!signal) throw new Error('Bounded range signal required')
      entered()
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      cleaningUp.resolve()
      await finishCleanup.promise
      closed = true
      signal.throwIfAborted()
      return progress
    },
    finish: async () => { throw new Error('Cancelled bytes must not be finalized') },
  }
  const sender = new ResumableByteTransferSender(receiver, { read: async () => bytes },
    { current: async () => context, retryable: () => true })
  const controller = new AbortController()
  const pending = sender.send(intent, controller.signal)
  await started
  const rejected = expect(pending).rejects.toThrow('Original publication deadline')
  let settled = false
  void pending.then(() => { settled = true }, () => { settled = true })
  controller.abort(new Error('Original publication deadline'))
  try {
    await cleaningUp.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
  } finally {
    finishCleanup.resolve()
    await rejected
  }
  expect(closed).toBe(true)
})
