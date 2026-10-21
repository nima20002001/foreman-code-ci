import { z } from 'zod'
import { NativeSessionReferenceSchema } from './index.js'
import { DispatchIntentSchema } from './nodePlacement.js'
import { IdSchema } from './schemaPrimitives.js'
import { SourceHashSchema, MaterializationReceiptSchema, SourceWorktreeRequestSchema, RootBindingSchema } from './sourceMaterialization.js'
import { SourceRootRecordSchema, SourceMaterializationRecordSchema, SourcePinSchema, SourceCwdAttestationSchema, SourcePreparationClosureSchema } from './sourceAdmission.js'
import { TransferIntentSchema } from './byteTransfer.js'
import { RootFilesystemIdentitySchema } from './workspaceRootPolicies.js'
export { SOURCE_MATERIALIZATION_RECORD_MAX_BYTES } from './sourceMaterialization.js'
// Capacity probes and closure requests share the channel with bounded source preparations.
export const SOURCE_OPERATION_EXTENSION = { namespace: 'source-operations-v1', version: 1, maxJsonBytes: 1048576, maxBinaryBytes: 0, maxPending: 64 } as const
export const SourceOperationAttemptSchema = z.object({ placementHash: SourceHashSchema, executionId: IdSchema, attemptId: IdSchema,
  keyRevision: z.number().int().positive().nullable(), authorizationRevision: z.number().int().positive().nullable() }).strict()
/** Written before secondary source bytes; the placement hash identifies the accepted operation. */
export const SecondarySourceAllocationSchema = z.object({
  version: z.literal(1),
  id: z.uuid(),
  materializationId: z.uuid(),
  binding: RootBindingSchema,
  attempt: SourceOperationAttemptSchema,
  kind: z.enum(['shared', 'worktree']),
  state: z.enum(['preparing', 'reclaimed']),
  filesystem: RootFilesystemIdentitySchema.optional(),
  worktree: MaterializationReceiptSchema.shape.worktree.optional(),
}).strict()
export type SecondarySourceAllocation = z.infer<typeof SecondarySourceAllocationSchema>
export const SourcePreparationIdentitySchema = z.object({ operationId: IdSchema, ownerPrincipalId: IdSchema, expiresAt: z.string().datetime() }).strict()
export const SourceStorageCapacitySchema = z.object({
  filesystem: RootFilesystemIdentitySchema,
  totalBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  availableBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cpuCount: z.number().int().positive(),
  availableMemoryBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  observedAt: z.string().datetime(),
}).strict().refine(value => value.availableBytes <= value.totalBytes, 'Free space cannot exceed the filesystem')
export type SourceStorageCapacity = z.infer<typeof SourceStorageCapacitySchema>
/** The approved snapshot's commit on GitHub; the computer fetches it there and verifies it against the exact pin. */
export const SourceGitHubReferenceSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/),
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  executablePolicy: z.enum(['strip', 'preserve-approved']) }).strict()
export const SourceFilesystemOperationSchema = z.discriminatedUnion('operation', [
  z.object({ version: z.literal(1), operation: z.literal('sources.capacity'), identity: SourcePreparationIdentitySchema,
    root: SourceRootRecordSchema, attempt: SourceOperationAttemptSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('sources.prepare'), identity: SourcePreparationIdentitySchema,
    root: SourceRootRecordSchema, attempt: SourceOperationAttemptSchema, github: SourceGitHubReferenceSchema,
    worktree: SourceWorktreeRequestSchema.optional(), retainedReceipt: MaterializationReceiptSchema.optional() }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('sources.verify'), record: SourceMaterializationRecordSchema,
    relativeCwd: z.string().max(1024).default('') }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('sources.private-repository'), record: SourceMaterializationRecordSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('sources.release'), record: SourceMaterializationRecordSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('sources.reconcile-preparation'), reconciliationId: z.uuid() }).strict(),
])
export type SourceFilesystemOperation = z.infer<typeof SourceFilesystemOperationSchema>
export const SourceOperationRequestSchema = z.union([SourceFilesystemOperationSchema,
  z.object({ version: z.literal(1), operation: z.literal('sources.authorize'), request: SourceFilesystemOperationSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('sources.transfer-authorize'), transferId: z.uuid() }).strict()])
/** Existing authenticated source channel; Main resolves the original admission.
 * A status request never supplies an intent, materialization or ACK assertion. */
export const SourceTransferStatusRequestSchema = z.object({ version: z.literal(1),
  operation: z.literal('sources.transfer-status'), transferId: z.uuid() }).strict()
export const SourceTransferStatusResponseSchema = z.object({ version: z.literal(1),
  operation: z.literal('sources.transfer-status'), intent: TransferIntentSchema,
  record: SourceMaterializationRecordSchema }).strict().refine(({ intent, record }) => {
  const receipt = record.receipt, binding = receipt.binding
  return intent.direction === 'to-worker' && intent.byteClass === 'source' && record.state !== 'uncertain'
    && record.operationId === intent.operationId && record.sourceBindingHash === intent.placementHash
    && receipt.executionId === intent.executionId && receipt.attemptId === intent.attemptId
    && receipt.placementHash === intent.placementHash && receipt.keyRevision === intent.keyRevision
    && receipt.authorizationRevision === intent.authorizationRevision && binding.mainId === intent.mainId
    && binding.deviceId === intent.deviceId && binding.workerInstallationId === intent.workerInstallationId
    && binding.rootId === intent.rootId && binding.bindingRevision === intent.rootBindingRevision
    && binding.manifestDigest === intent.manifestDigest && receipt.verifiedManifestDigest === intent.manifestDigest
}, { message: 'Committed materialization must identify the original source transfer' })
/** Trusted Main readback of an entered, currently owned native lifetime. A
 * filesystem request never supplies this evidence or selects mutable mode. */
export const SourceActiveNativeSessionSchema = z.object({
  version: z.literal(1), executionId: IdSchema, runId: IdSchema, technicalAttempt: z.number().int().positive(),
  attemptId: IdSchema, operationId: IdSchema, materializationId: z.uuid(),
  sourceBindingHash: SourceHashSchema, finalDispatchBindingHash: SourceHashSchema,
  nativeSession: z.lazy(() => NativeSessionReferenceSchema), generation: z.number().int().positive(),
  cwdAttestation: SourceCwdAttestationSchema,
  entry: z.object({ sourceId: IdSchema, sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    launchDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict(),
  owner: DispatchIntentSchema.shape.owner,
  lane: z.object({ id: IdSchema, revision: z.number().int().nonnegative(),
    tokenHash: SourceHashSchema, expiresAt: z.string().datetime() }).strict(),
}).strict()
export type SourceActiveNativeSession = z.infer<typeof SourceActiveNativeSessionSchema>
export const SourceOperationOwnerSchema = z.object({ identity: SourcePreparationIdentitySchema, root: SourceRootRecordSchema,
  attempt: SourceOperationAttemptSchema, source: SourcePinSchema, record: SourceMaterializationRecordSchema.nullable(),
  retainedReceipt: MaterializationReceiptSchema.optional(), retainWorkingTree: z.literal(true).optional(),
  worktree: SourceWorktreeRequestSchema.optional(),
  preparationKind: z.literal('workflow').optional(), quotaRequired: z.literal(true).optional(),
  preparationNativeSession: z.lazy(() => NativeSessionReferenceSchema).nullable().optional(),
  physicalClosureConfirmed: z.boolean(), activeNativeSession: SourceActiveNativeSessionSchema.nullish(), preparationClosed: z.literal(true).optional() }).strict()
export type SourceOperationOwner = z.infer<typeof SourceOperationOwnerSchema>
export const SourceReservationReclamationRequestSchema = z.object({ version: z.literal(1),
  operation: z.enum(['sources.reclaim-reservation', 'sources.reclamation-authorize']),
  reservationId: z.uuid(), reclamationId: z.uuid() }).strict()
export const SourceReservationReclamationSchema = z.object({ reservationId: z.uuid(), reclamationId: z.uuid(),
  operationId: IdSchema, scopeId: z.string().min(1), expiresAt: z.string().datetime(),
  removeRetained: z.literal(true).optional(),
  roots: z.array(SourceRootRecordSchema).min(1).max(1024),
  owner: SourceOperationOwnerSchema.nullable() }).strict()
export type SourceReservationReclamation = z.infer<typeof SourceReservationReclamationSchema>
export const SourceReservationReclamationAuthorityResponseSchema = z.object({ version: z.literal(1),
  operation: z.literal('sources.reclamation-authorize'), grant: SourceReservationReclamationSchema }).strict()
export const RetainedSourceFootprintSchema = z.object({
  worktree: z.object({ state: z.enum(['removed', 'retained']), message: z.string().optional(),
    /** Distinguishes cleanup that retained files from retention for an active Run. */
    removalAttempted: z.literal(true).optional(),
    nextAttemptAt: z.string().datetime().optional() }).strict().optional(),
  retainedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sharedTree: z.object({
    id: z.uuid(),
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict().optional(),
}).strict().refine(value => !value.sharedTree || value.sharedTree.bytes <= value.retainedBytes,
  'Shared tree bytes must be included in the retained footprint')
export type RetainedSourceFootprint = z.infer<typeof RetainedSourceFootprintSchema>
export const SourceReservationReclamationResponseSchema = z.object({ version: z.literal(1),
  operation: z.literal('sources.reclaim-reservation'), reservationId: z.uuid(), reclamationId: z.uuid(),
  operationId: IdSchema, reclaimed: z.boolean(), closures: z.array(SourcePreparationClosureSchema).max(1024),
  retained: RetainedSourceFootprintSchema.optional() }).strict()
  .refine(value => value.reclaimed === !value.retained, 'Retained working trees keep their storage reservation')
const PrivateSourceRepositoryResultSchema = z.object({ workTree: z.string().startsWith('/'), gitDirectory: z.string().startsWith('/'),
  generatedCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), sourceCommit: z.string().nullable() }).strict()
export const SourceOperationResponseSchema = z.discriminatedUnion('operation', [
  z.object({ version: z.literal(1), operation: z.literal('sources.capacity'), capacity: SourceStorageCapacitySchema }).strict(),
  SourceReservationReclamationResponseSchema,
  z.object({ version: z.literal(1), operation: z.literal('sources.prepare'), receipt: MaterializationReceiptSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('sources.verify'), workTree: z.string().startsWith('/'),
    canonicalCwd: z.string().startsWith('/'), directoryIdentityHash: SourceHashSchema,
    filesystem: RootFilesystemIdentitySchema, accessMode: z.enum(['read-only', 'exclusive-write']),
    cwdAttestation: SourceCwdAttestationSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('sources.private-repository'), repository: PrivateSourceRepositoryResultSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('sources.release'), materializationId: z.uuid(),
    operationId: IdSchema, released: z.literal(true), ...RetainedSourceFootprintSchema.shape }).strict()
    .refine(value => !value.sharedTree || value.sharedTree.bytes <= value.retainedBytes,
      'Shared tree bytes must be included in the retained footprint'),
  z.object({ version: z.literal(1), operation: z.literal('sources.reconcile-preparation'), closure: SourcePreparationClosureSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('sources.authorize'), owner: SourceOperationOwnerSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('sources.transfer-authorize'), intent: TransferIntentSchema }).strict(),
])
export type SourceOperationResponse = z.infer<typeof SourceOperationResponseSchema>
