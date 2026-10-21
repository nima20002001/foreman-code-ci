import { z } from 'zod'
import { MAX_FILE_BYTES } from './files.js'
import { GraphIdSchema } from './schemaPrimitives.js'

export const BYTE_TRANSFER_POLICY = Object.freeze({
  maxChunkBytes: 1024 * 1024, maxSourceBytes: 128 * 1024 * 1024,
  maxArtifactBytes: MAX_FILE_BYTES, maxActivePerDevice: 2, maxActiveGlobal: 4,
  maxStagingBytes: 512 * 1024 * 1024, maxStagingPerDeviceBytes: 256 * 1024 * 1024, maxRecords: 4096,
  maxLifetimeMs: 60 * 60 * 1000, maxIdleMs: 5 * 60 * 1000,
  maxQueuedBytes: 4 * 1024 * 1024, maxRetries: 8,
})
const Hash = z.string().regex(/^[a-f0-9]{64}$/)
export const TransferContextSchema = z.object({
  mainId: z.uuid(), deviceId: z.uuid(), workerInstallationId: z.uuid(),
  keyRevision: z.number().int().positive(), authorizationRevision: z.number().int().positive(),
  bootId: z.uuid(), connectionEpoch: z.uuid(),
}).strict()
export type TransferContext = z.infer<typeof TransferContextSchema>
export const TransferIntentSchema = TransferContextSchema.extend({
  version: z.literal(1), transferId: z.uuid(), operationId: z.uuid(),
  executionId: GraphIdSchema, attemptId: z.uuid(), placementHash: Hash,
  rootId: z.uuid(), rootBindingRevision: z.number().int().positive(),
  direction: z.enum(['to-main', 'to-worker']), byteClass: z.enum(['artifact', 'source']),
  sha256: Hash, byteSize: z.number().int().nonnegative().max(BYTE_TRANSFER_POLICY.maxSourceBytes),
  manifestDigest: Hash, expiresAt: z.string().datetime(),
  chunkBytes: z.number().int().positive().max(BYTE_TRANSFER_POLICY.maxChunkBytes),
}).strict().refine(x => x.byteClass !== 'artifact' || x.byteSize <= MAX_FILE_BYTES,
  { message: 'Artifact exceeds its existing class budget' })
export type TransferIntent = z.infer<typeof TransferIntentSchema>
export const TransferProgressSchema = z.object({
  version: z.literal(1), transferId: z.uuid(),
  state: z.enum(['allocated', 'transferring', 'verified', 'cancelled']),
  receivedInMemoryBytes: z.number().int().nonnegative(), durableOffset: z.number().int().nonnegative(),
  verifiedBytes: z.number().int().nonnegative(), updatedAt: z.string().datetime(),
}).strict()
export type TransferProgress = z.infer<typeof TransferProgressSchema>
export const VerifiedTransferReceiptSchema = z.object({
  version: z.literal(1), receiptId: z.uuid(), transferId: z.uuid(), intent: TransferIntentSchema,
  sha256: Hash, byteSize: z.number().int().nonnegative(), verifiedAt: z.string().datetime(),
}).strict()
export type VerifiedTransferReceipt = z.infer<typeof VerifiedTransferReceiptSchema>

/** Metadata only on the existing authenticated W07 connection. Advertise only
 * when genuine authorized staging ports are configured; this grants no authority. */
export const RSYNC_STAGE_EXTENSION = Object.freeze({
  namespace: 'rsync-stage-v1', version: 1 as const, maxJsonBytes: 16384, maxBinaryBytes: 0,
})
/** Authenticated Worker-to-Main lookup of original persisted transfer membership.
 * The domain authority must authorize the caller before returning TransferIntent. */
export const RsyncTransferAuthorizeRequestSchema = z.object({
  kind: z.literal('rsync-stage-v1'), method: z.literal('transfer-authorize'), transferId: z.uuid(),
}).strict()

export const RsyncControlRequestSchema = z.object({
  kind: z.literal('rsync-stage-v1'),
  method: z.enum(['source-prepare', 'source-verify', 'source-close', 'receiver-prepare',
    'receiver-verify', 'receiver-interrupt', 'acknowledge',
    'writer-prepare', 'writer-activate', 'writer-status', 'writer-stop']),
  transferId: z.uuid(),
}).strict()
export type RsyncControlRequest = z.infer<typeof RsyncControlRequestSchema>
const RsyncWriterPrepareRequestSchema = RsyncControlRequestSchema.extend({ method: z.literal('writer-prepare') }).strict()
/** Original server owner reference only; installation and process facts stay local. */
export const RsyncWriterPrepareResponseSchema = z.object({ transferId: z.uuid(), ownerId: z.uuid(), ownerDigest: Hash }).strict()
export const RsyncControlResponseSchema = z.discriminatedUnion('method', [
  RsyncControlRequestSchema.extend({ method: z.literal('receiver-verify'), receipt: VerifiedTransferReceiptSchema }),
  RsyncWriterPrepareRequestSchema.extend({ ownerId: z.uuid(), ownerDigest: Hash }).strict(),
  RsyncControlRequestSchema.extend({ method: z.enum(['source-prepare', 'source-verify', 'source-close',
    'receiver-prepare', 'receiver-interrupt', 'acknowledge', 'writer-activate', 'writer-status', 'writer-stop']) }),
]).refine(value => value.method !== 'receiver-verify'
  || (value.receipt.transferId === value.transferId && value.receipt.intent.transferId === value.transferId),
{ message: 'Verified receipt must identify the same admitted transfer' })

export interface ByteTransferPort {
  start(intent: TransferIntent, context: TransferContext, signal?: AbortSignal): Promise<TransferProgress>
  status(id: string, context: TransferContext, signal?: AbortSignal): Promise<TransferProgress>
  append(id: string, context: TransferContext, chunk: { offset: number; sha256: string; bytes: Uint8Array }, signal?: AbortSignal): Promise<TransferProgress>
  finish(id: string, context: TransferContext, signal?: AbortSignal): Promise<VerifiedTransferReceipt>
  cancel(id: string, context: TransferContext, signal?: AbortSignal): Promise<TransferProgress>
}
