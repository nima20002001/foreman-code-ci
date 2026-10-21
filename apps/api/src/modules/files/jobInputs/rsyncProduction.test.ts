import { randomUUID, createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { DeviceExtensionContext, DeviceExtensionRegistration } from '../../devices/deviceApplicationChannel.js'
import { TransferIntentSchema, type VerifiedTransferReceipt } from '@foreman-code/contracts/byte-transfer'
import { JobInputAdmissionSchema, JobInputDeliveryReceiptSchema, type JobInputDeliveryReceipt } from '@foreman-code/contracts/job-inputs'
import { jobExecution } from '../../../../test/helpers/jobFixture.js'
import { makeManifest } from './manifest.js'
import { createMainJobInputRsyncExtension } from './rsyncProduction.js'
import { transferContextForBinding } from '../../byte-transfer/carrier.js'

function fixture() {
  const execution = jobExecution(), binding = { mainId: execution.acceptedSpec.target.mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1 }
  execution.id = randomUUID(); execution.attemptId = randomUUID()
  const manifest = makeManifest(execution, [])
  const intent = TransferIntentSchema.parse({ ...transferContextForBinding(binding), version: 1, transferId: randomUUID(), operationId: randomUUID(),
    executionId: execution.id, attemptId: execution.attemptId, placementHash: execution.acceptedSpec.bindingHash, rootId: randomUUID(), rootBindingRevision: 1,
    direction: 'to-worker', byteClass: 'artifact', sha256: manifest.manifestSha256, byteSize: manifest.manifestByteSize,
    manifestDigest: manifest.manifestSha256, chunkBytes: 8192, expiresAt: new Date(Date.now() + 60000).toISOString() })
  const admission = JobInputAdmissionSchema.parse({ version: 1, manifest, principalId: 'actor', principalGrantsDigest: '1'.repeat(64),
    issuedAt: new Date().toISOString(), transfers: [{ relativePath: 'manifest.json', intent }] })
  const delivered = JobInputDeliveryReceiptSchema.parse({ version: 1, recipient: manifest.recipient, bindingId: manifest.bindingId,
    inputSnapshotDigest: manifest.inputSnapshotDigest, manifestSha256: manifest.manifestSha256, manifestByteSize: manifest.manifestByteSize,
    directory: { relativePath: '.graphql-job-inputs', device: '1', inode: '2', mountId: '3' }, readonlyMountRequired: true,
    files: [{ relativePath: 'manifest.json', sha256: manifest.manifestSha256, byteSize: manifest.manifestByteSize },
      { relativePath: 'workflow-input.json', sha256: createHash('sha256').update('null').digest('hex'), byteSize: 4 }] })
  const verified: VerifiedTransferReceipt = { version: 1, receiptId: randomUUID(), transferId: intent.transferId, intent,
    sha256: intent.sha256, byteSize: intent.byteSize, verifiedAt: new Date().toISOString() }
  const order: string[] = [], frame: DeviceExtensionContext = { binding, signal: new AbortController().signal }
  let saved: JobInputDeliveryReceipt | undefined
  const canonical = { acceptedTransfer: vi.fn(async () => ({ execution, admission, transfer: admission.transfers[0]! })),
    assertChannel: vi.fn(), authorizeTransfer: vi.fn(async () => {}), read: vi.fn(async () => Buffer.alloc(0)),
    acknowledgeDelivery: vi.fn(async (_id: string, receipt: JobInputDeliveryReceipt) => { order.push('persist'); saved = receipt; return receipt }),
    acknowledged: vi.fn(async () => { order.push('readback'); if (!saved) throw new Error('Original delivery pending'); return saved }) }
  const original: DeviceExtensionRegistration = { namespace: 'job-inputs-v1', version: 1, role: 'server', maxJsonBytes: 1048576, maxBinaryBytes: 8192,
    handle: vi.fn(async () => ({ payload: { original: true } })) }
  const rsync = { stage: vi.fn(async () => verified), acknowledge: vi.fn(async () => { order.push('backend-ack') }) }
  const extension = createMainJobInputRsyncExtension(canonical, original, rsync)
  return { intent, delivered, verified, frame, canonical, original, rsync, extension, order }
}
describe('Main canonical Job-input rsync composition', () => {
  it('stages only the original admitted input and rejects a substituted canonical receipt', async () => {
    const f = fixture(), request = { method: 'stage', transferId: f.intent.transferId }
    expect(await f.extension.handle!(request, f.frame)).toEqual({ payload: f.verified })
    expect(f.rsync.stage).toHaveBeenCalledWith(f.intent, expect.anything(), f.frame.signal)
    expect(f.original.handle).not.toHaveBeenCalled()
    f.rsync.stage.mockResolvedValueOnce({ ...f.verified, intent: { ...f.intent, attemptId: randomUUID() } })
    await expect(f.extension.handle!(request, f.frame)).rejects.toMatchObject({ code: 'JOB_INPUT_TRANSFER_CONFLICT' })
  })
  it('persists detached delivery and reads it back before coordinating backend ACK', async () => {
    const f = fixture(), request = { method: 'delivery-ack', transferId: f.intent.transferId, receipt: f.delivered }
    expect(await f.extension.handle!(request, f.frame)).toEqual({ payload: f.delivered })
    expect(f.order).toEqual(['persist', 'readback', 'backend-ack'])
    f.order.splice(0)
    expect(await f.extension.handle!({ method: 'delivery-status', transferId: f.intent.transferId }, f.frame)).toEqual({ payload: f.delivered })
    expect(f.order).toEqual(['readback']); expect(f.rsync.acknowledge).toHaveBeenCalledTimes(1)
  })
  it('retains the persisted ACK when backend closure is unconfirmed and retries the same receipt', async () => {
    const f = fixture(), request = { method: 'delivery-ack', transferId: f.intent.transferId, receipt: f.delivered }
    f.rsync.acknowledge.mockRejectedValueOnce(new Error('Original remote closure unavailable'))
    await expect(f.extension.handle!(request, f.frame)).rejects.toThrow('Original remote closure unavailable')
    expect(await f.extension.handle!({ method: 'delivery-status', transferId: f.intent.transferId }, f.frame)).toEqual({ payload: f.delivered })
    await expect(f.extension.handle!(request, f.frame)).resolves.toEqual({ payload: f.delivered })
  })
  it('never substitutes authorization readback for a persisted detached-delivery ACK', async () => {
    const f = fixture()
    await expect(f.extension.handle!({ method: 'delivery-status', transferId: f.intent.transferId }, f.frame)).rejects.toThrow('Original delivery pending')
    expect(f.rsync.stage).not.toHaveBeenCalled(); expect(f.rsync.acknowledge).not.toHaveBeenCalled()
  })
  it('preserves denied/stale caller and metadata-only guards before any backend IO', async () => {
    const f = fixture(), request = { method: 'stage', transferId: f.intent.transferId }
    f.canonical.authorizeTransfer.mockRejectedValueOnce(new Error('Denied original input caller'))
    await expect(f.extension.handle!(request, f.frame)).rejects.toThrow('Denied original input caller')
    f.canonical.assertChannel.mockImplementationOnce(() => { throw new Error('Stale original channel') })
    await expect(f.extension.handle!(request, f.frame)).rejects.toThrow('Stale original channel')
    await expect(f.extension.handle!({ ...request, intent: f.intent }, f.frame)).rejects.toThrow()
    await expect(f.extension.handle!(request, { ...f.frame, bytes: new Uint8Array([1]) })).rejects.toThrow()
    expect(f.rsync.stage).not.toHaveBeenCalled()
  })
  it('rejects conflicting persisted delivery before releasing backend holds', async () => {
    const f = fixture()
    f.canonical.acknowledged.mockResolvedValueOnce({ ...f.delivered, manifestByteSize: f.delivered.manifestByteSize + 1 })
    await expect(f.extension.handle!({ method: 'delivery-ack', transferId: f.intent.transferId, receipt: f.delivered }, f.frame)).rejects.toMatchObject({ code: 'JOB_INPUT_RECEIPT_CONFLICT' })
    expect(f.rsync.acknowledge).not.toHaveBeenCalled()
  })
  it('keeps the byte-input handler and read-only status available without selected rsync', async () => {
    const f = fixture(), extension = createMainJobInputRsyncExtension(f.canonical, f.original)
    expect(await extension.handle!({ method: 'bind' }, f.frame)).toEqual({ payload: { original: true } })
    await expect(extension.handle!({ method: 'stage', transferId: f.intent.transferId }, f.frame)).rejects.toMatchObject({ code: 'JOB_INPUT_RSYNC_UNAVAILABLE' })
    await expect(extension.handle!({ method: 'delivery-status', transferId: f.intent.transferId }, f.frame)).rejects.toThrow('Original delivery pending')
  })
})
