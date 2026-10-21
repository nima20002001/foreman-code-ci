import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { TransferIntentSchema, BYTE_TRANSFER_POLICY, RsyncControlRequestSchema,
  RsyncControlResponseSchema, RsyncWriterPrepareResponseSchema, RSYNC_STAGE_EXTENSION } from './byteTransfer.js'
import { negotiateDeviceExtensions } from './deviceApplication.js'
const intent = () => ({ version: 1, transferId: randomUUID(), mainId: randomUUID(), deviceId: randomUUID(),
  workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(),
  operationId: randomUUID(), executionId: randomUUID(), attemptId: randomUUID(), placementHash: '0'.repeat(64),
  rootId: randomUUID(), rootBindingRevision: 1, direction: 'to-main', byteClass: 'source', sha256: '0'.repeat(64),
  byteSize: 128 * 1024 * 1024, manifestDigest: '0'.repeat(64), expiresAt: new Date().toISOString(), chunkBytes: 1024 * 1024 })
describe('byte transfer v1 contract', () => {
  it('preserves Job and workflow execution IDs while rejecting paths and unbounded IDs', () => {
    for (const executionId of [randomUUID(), `execution-${randomUUID()}`]) {
      expect(TransferIntentSchema.parse({ ...intent(), executionId }).executionId).toBe(executionId)
    }
    for (const executionId of ['', '../execution', '/tmp/execution', 'x'.repeat(201)]) {
      expect(TransferIntentSchema.safeParse({ ...intent(), executionId }).success).toBe(false)
    }
  })
  it('keeps source and artifact budgets distinct and forbids arbitrary paths', () => {
    expect(TransferIntentSchema.safeParse(intent()).success).toBe(true)
    expect(TransferIntentSchema.safeParse({ ...intent(), byteClass: 'artifact' }).success).toBe(false)
    expect(TransferIntentSchema.safeParse({ ...intent(), destinationPath: '/etc/passwd' }).success).toBe(false)
  })
  it('rejects unbounded negotiation and missing attempt bindings', () => {
    expect(TransferIntentSchema.safeParse({ ...intent(), chunkBytes: BYTE_TRANSFER_POLICY.maxChunkBytes + 1 }).success).toBe(false)
    expect(TransferIntentSchema.safeParse({ ...intent(), attemptId: undefined }).success).toBe(false)
    expect(TransferIntentSchema.safeParse({ ...intent(), connectionEpoch: 1 }).success).toBe(false)
  })
})

describe('rsync staging control contract', () => {
  const transferId = randomUUID()
  const request = { kind: 'rsync-stage-v1', method: 'source-prepare', transferId }
  const receipt = { version: 1, receiptId: randomUUID(), transferId, intent: { ...intent(), transferId },
    sha256: '0'.repeat(64), byteSize: 128 * 1024 * 1024, verifiedAt: new Date().toISOString() }

  it('accepts only bounded metadata methods and rejects caller byte or authority inputs', () => {
    for (const method of RsyncControlRequestSchema.shape.method.options) {
      expect(RsyncControlRequestSchema.parse({ ...request, method })).toEqual({ ...request, method })
    }
    for (const extra of [{ intent: intent() }, { path: '/tmp/caller' }, { command: 'rsync' },
      { bytes: 'caller-bytes' }, { receipt }, { binding: {} }]) {
      expect(RsyncControlRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false)
    }
    for (const changed of [{ transferId: 'not-a-uuid' }, { kind: 'byte-transfer-v1' }, { method: 'append' }]) {
      expect(RsyncControlRequestSchema.safeParse({ ...request, ...changed }).success).toBe(false)
    }
  })

  it('requires the existing verified receipt only for receiver verification', () => {
    for (const method of RsyncControlRequestSchema.shape.method.options) {
      const response = { ...request, method }
      expect(RsyncControlResponseSchema.safeParse(response).success).toBe(method !== 'receiver-verify' && method !== 'writer-prepare')
      expect(RsyncControlResponseSchema.safeParse({ ...response, receipt }).success).toBe(method === 'receiver-verify')
    }
    expect(RsyncControlResponseSchema.safeParse({ ...request, method: 'receiver-verify', receipt: {} }).success).toBe(false)
    expect(RsyncControlResponseSchema.safeParse({ ...request, accepted: true }).success).toBe(false)
  })

  it('keeps writer admission ID-only and rejects paths and process facts in replies', () => {
    const owner = { transferId, ownerId: randomUUID(), ownerDigest: '1'.repeat(64) }
    expect(RsyncWriterPrepareResponseSchema.parse(owner)).toEqual(owner)
    const prepared = { ...request, method: 'writer-prepare', ownerId: owner.ownerId, ownerDigest: owner.ownerDigest }
    expect(RsyncControlResponseSchema.parse(prepared)).toEqual(prepared)
    for (const method of ['writer-prepare', 'writer-activate', 'writer-status', 'writer-stop']) {
      const command = { ...request, method }
      for (const extra of [{ path: '/caller' }, { nodeBinary: '/caller/node' }, { entryPoint: '/caller/cli' },
        { pid: 123 }, { startTicks: '123' }, { stopped: true }, { ownerId: owner.ownerId }]) {
        expect(RsyncControlRequestSchema.safeParse({ ...command, ...extra }).success).toBe(false)
      }
    }
    for (const extra of [{ path: '/caller' }, { pid: 123 }, { stopped: true }, { nodeBinary: '/caller/node' }]) {
      expect(RsyncWriterPrepareResponseSchema.safeParse({ ...owner, ...extra }).success).toBe(false)
      expect(RsyncControlResponseSchema.safeParse({ ...prepared, ...extra }).success).toBe(false)
      for (const method of ['writer-status', 'writer-stop']) {
        expect(RsyncControlResponseSchema.safeParse({ ...request, method, ...extra }).success).toBe(false)
      }
    }
    expect(RsyncWriterPrepareResponseSchema.safeParse({ ...owner, ownerId: '/caller' }).success).toBe(false)
    expect(RsyncWriterPrepareResponseSchema.safeParse({ ...owner, ownerDigest: 'unverified' }).success).toBe(false)
  })

  it('rejects a receipt or retained intent for another transfer', () => {
    const response = { ...request, method: 'receiver-verify', receipt }
    expect(RsyncControlResponseSchema.parse(response)).toEqual(response)
    expect(RsyncControlResponseSchema.safeParse({ ...response, receipt: { ...receipt, transferId: randomUUID() } }).success).toBe(false)
    expect(RsyncControlResponseSchema.safeParse({ ...response,
      receipt: { ...receipt, intent: { ...receipt.intent, transferId: randomUUID() } } }).success).toBe(false)
  })

  it('negotiates Main client to worker server without reusing binary carrier advertisement', () => {
    const main = { ...RSYNC_STAGE_EXTENSION, role: 'client' as const }
    const worker = { ...RSYNC_STAGE_EXTENSION, role: 'server' as const }
    expect(negotiateDeviceExtensions([main], [worker])).toEqual([{ namespace: 'rsync-stage-v1', version: 1,
      mainCanRequest: true, workerCanRequest: false, maxJsonBytes: 16384, maxBinaryBytes: 0 }])
    expect(negotiateDeviceExtensions([main], [{ ...worker, namespace: 'byte-transfer-v1' }])).toEqual([])
    expect(negotiateDeviceExtensions([main], [{ ...worker, version: 2 }])).toEqual([])
  })
})
