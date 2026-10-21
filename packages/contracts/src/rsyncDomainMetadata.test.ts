import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SourceTransferStatusRequestSchema, SourceTransferStatusResponseSchema } from './sourceOperations.js'
import { JobInputStageRequestSchema, JobInputDeliveryAckRequestSchema, JobInputDeliveryStatusRequestSchema } from './jobInputs.js'
import { JobOutputStageRequestSchema, JobOutputStatusRequestSchema } from './jobOutputTransfer.js'

const hash = '1'.repeat(64)
const transferId = randomUUID()
const sourceStatus = () => {
  const intent = { version: 1, transferId, mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(), operationId: randomUUID(),
    executionId: randomUUID(), attemptId: randomUUID(), placementHash: hash, rootId: randomUUID(), rootBindingRevision: 1,
    direction: 'to-worker', byteClass: 'source', sha256: hash, byteSize: 128, manifestDigest: hash,
    expiresAt: new Date().toISOString(), chunkBytes: 8192 }
  const record = { operationId: intent.operationId, rootPolicyId: randomUUID(), rootPolicyRevision: '1',
    reservationId: randomUUID(), sourceBindingHash: hash, finalDispatchBindingHash: null, state: 'prepared', receipt: {
      version: 1, materializationId: randomUUID(), binding: { version: 1, mainId: intent.mainId, deviceId: intent.deviceId,
        workerInstallationId: intent.workerInstallationId, workspaceId: randomUUID(), rootId: intent.rootId, bindingRevision: 1,
        locationRevision: 1, canonicalPath: '/owned/source', filesystem: { device: '1', inode: '2', mountId: '3' },
        accessMode: 'read-only', snapshotId: randomUUID(), manifestDigest: hash }, placementHash: hash,
      executionId: intent.executionId, attemptId: intent.attemptId, keyRevision: 1, authorizationRevision: 1,
      verifiedManifestDigest: hash, verifiedEntries: 1, verifiedBytes: 64, verifiedAt: new Date().toISOString(),
      localTreeIdentity: { device: '1', inode: '4', mountId: '3' } } }
  return { version: 1, operation: 'sources.transfer-status', intent, record }
}
const deliveryReceipt = () => ({ version: 1, recipient: { workspaceId: randomUUID(), executionId: randomUUID(),
  attemptId: randomUUID(), operationId: randomUUID(), owner: { grantId: randomUUID(), epoch: '1' }, bindingHash: hash,
  specDigest: hash, materializationId: randomUUID(), materializationDigest: hash }, bindingId: hash,
  inputSnapshotDigest: hash, manifestSha256: hash, manifestByteSize: 128,
  directory: { relativePath: '.graphql-job-inputs', device: '1', inode: '2', mountId: '3' },
  files: [{ relativePath: 'manifest.json', sha256: hash, byteSize: 128 }], readonlyMountRequired: true })

describe('original domain rsync metadata', () => {
  it('accepts ID-only staging and status requests on the existing domains', () => {
    expect(SourceTransferStatusRequestSchema.parse({ version: 1, operation: 'sources.transfer-status', transferId })).toBeDefined()
    for (const [schema, method] of [[JobInputStageRequestSchema, 'stage'], [JobOutputStageRequestSchema, 'job-output-stage'],
      [JobOutputStatusRequestSchema, 'job-output-status'], [JobInputDeliveryStatusRequestSchema, 'delivery-status']] as const) {
      expect(schema.parse({ method, transferId })).toEqual({ method, transferId })
      expect(schema.safeParse({ method, transferId: 'not-an-original-id' }).success).toBe(false)
      for (const extra of [{ intent: {} }, { path: '/caller' }, { published: true }, { binding: {} }, { executionId: randomUUID() }]) {
        expect(schema.safeParse({ method, transferId, ...extra }).success).toBe(false)
      }
    }
    expect(SourceTransferStatusRequestSchema.safeParse({ version: 1, operation: 'sources.transfer-status', transferId, record: {} }).success).toBe(false)
  })

  it('requires the original detached input receipt, without caller ACK flags or paths', () => {
    const request = { method: 'delivery-ack', transferId, receipt: deliveryReceipt() }
    expect(JobInputDeliveryAckRequestSchema.parse(request)).toEqual(request)
    for (const extra of [{ published: true }, { acknowledged: true }, { executionId: randomUUID() }]) {
      expect(JobInputDeliveryAckRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false)
    }
    expect(JobInputDeliveryAckRequestSchema.safeParse({ ...request, receipt: undefined }).success).toBe(false)
    expect(JobInputDeliveryAckRequestSchema.safeParse({ ...request, receipt: { ...request.receipt, readonlyMountRequired: false } }).success).toBe(false)
    expect(JobInputDeliveryAckRequestSchema.safeParse({ ...request, receipt: { ...request.receipt,
      files: [{ ...request.receipt.files[0]!, relativePath: '../caller' }] } }).success).toBe(false)
  })

  it('binds committed Source readback to its original operation, attempt, root and manifest', () => {
    const response = sourceStatus()
    expect(SourceTransferStatusResponseSchema.parse(response)).toEqual(response)
    for (const changed of [{ operationId: randomUUID() }, { sourceBindingHash: '2'.repeat(64) }, { state: 'uncertain' }]) {
      expect(SourceTransferStatusResponseSchema.safeParse({ ...response, record: { ...response.record, ...changed } }).success).toBe(false)
    }
    for (const changed of [{ executionId: randomUUID() }, { attemptId: randomUUID() }, { authorizationRevision: 2 },
      { verifiedManifestDigest: '2'.repeat(64) }, { binding: { ...response.record.receipt.binding, rootId: randomUUID() } }]) {
      expect(SourceTransferStatusResponseSchema.safeParse({ ...response,
        record: { ...response.record, receipt: { ...response.record.receipt, ...changed } } }).success).toBe(false)
    }
    expect(SourceTransferStatusResponseSchema.safeParse({ ...response, record: null }).success).toBe(false)
    expect(SourceTransferStatusResponseSchema.safeParse({ ...response, acknowledged: true }).success).toBe(false)
  })
})
