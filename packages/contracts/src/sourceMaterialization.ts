import { AgentBranchPrefixSchema } from './worktreeSettings.js'
import { z } from 'zod'
import { IdSchema } from './schemaPrimitives.js'

/** Shared Git objects have their own filesystem budget, independent of approved source roots. */
export const SOURCE_GIT_CACHE_LIMITS = Object.freeze({
  bytes: 64 * 2 ** 30,
  maximumFileBytes: 256 * 2 ** 20,
  transferBytes: 1024 * 2 ** 20,
  diskMarginBytes: 2 ** 30,
})
/** Tracked files one approved source snapshot may hold; the manifest's 2 MiB metadata budget still applies. */
export const SOURCE_ENTRY_LIMIT = 8192
export const SOURCE_MANIFEST_MAX_BYTES = 2 * 1024 * 1024
/** Space for the receipt, root binding and optional snapshot reference in addition to a full manifest. */
export const SOURCE_MATERIALIZATION_RECORD_MAX_BYTES = SOURCE_MANIFEST_MAX_BYTES + 64 * 1024
export const SourceHashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const SourceEntrySchema = z.object({
  path: z.string().min(1).max(1024), kind: z.literal('file'),
  byteSize: z.number().int().nonnegative().max(16 * 1024 * 1024),
  sha256: SourceHashSchema, executable: z.boolean(),
}).strict()
const SourceGitMetadataSchema = z.object({
  byteSize: z.number().int().positive().max(16 * 1024 * 1024), sha256: SourceHashSchema,
}).strict()
export const SourceManifestSchema = z.object({
  version: z.literal(1), snapshotId: z.uuid(), approvedSourceId: z.uuid(),
  capturePolicy: z.enum(['git-tree-v1', 'exclusive-explicit-bytes-v1']),
  executablePolicy: z.enum(['strip', 'preserve-approved']),
  git: z.object({ commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    tree: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), objectFormat: z.enum(['sha1', 'sha256']),
    repository: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/).optional(),
    metadata: SourceGitMetadataSchema.optional() }).strict().optional(),
  entries: z.array(SourceEntrySchema).max(SOURCE_ENTRY_LIMIT),
  deletions: z.array(z.string().min(1).max(1024)).max(SOURCE_ENTRY_LIMIT),
  overlayBaseDigest: SourceHashSchema.optional(),
  totalEntries: z.number().int().nonnegative().max(SOURCE_ENTRY_LIMIT),
  totalBytes: z.number().int().nonnegative().max(128 * 1024 * 1024),
  manifestDigest: SourceHashSchema,
}).strict()
export type SourceEntry = z.infer<typeof SourceEntrySchema>
export type SourceManifest = z.infer<typeof SourceManifestSchema>

export const RootBindingSchema = z.object({
  version: z.literal(1), mainId: z.uuid(), deviceId: z.uuid().nullable(), workerInstallationId: z.uuid().nullable(),
  workspaceId: IdSchema, rootId: z.uuid(), bindingRevision: z.number().int().positive(),
  locationRevision: z.number().int().positive(), canonicalPath: z.string().min(1),
  filesystem: z.object({ device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/), mountId: z.string().regex(/^\d+$/) }).strict(),
  accessMode: z.enum(['read-only', 'exclusive-write']), snapshotId: z.uuid(), manifestDigest: SourceHashSchema,
}).strict()
export type RootBinding = z.infer<typeof RootBindingSchema>
export const GitCacheStorageSchema = z.object({
  version: z.literal(1), filesystem: RootBindingSchema.shape.filesystem,
  retainedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  reservedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  limitBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  availableBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  observedAt: z.string().datetime(),
}).strict()
export type GitCacheStorage = z.infer<typeof GitCacheStorageSchema>
export const SourceProjectQuotaSlotSchema = z.object({
  namespace: z.uuid(), projectId: z.number().int().min(1).max(4294967295),
  hardLimitBytes: z.number().int().positive(), hardInodes: z.number().int().positive(),
  filesystem: RootBindingSchema.shape.filesystem,
}).strict()
export type SourceProjectQuotaSlot = z.infer<typeof SourceProjectQuotaSlotSchema>
/** An agent's own git worktree and branch of the workspace repository, created at the approved commit. */
export const SourceWorktreeRequestSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/),
  branch: AgentBranchPrefixSchema,
}).strict()
export type SourceWorktreeRequest = z.infer<typeof SourceWorktreeRequestSchema>
export const MaterializationReceiptSchema = z.object({
  version: z.literal(1), materializationId: z.uuid(), binding: RootBindingSchema,
  quota: SourceProjectQuotaSlotSchema.optional(),
  placementHash: SourceHashSchema, executionId: IdSchema, attemptId: IdSchema,
  keyRevision: z.number().int().positive().nullable(), authorizationRevision: z.number().int().positive().nullable(),
  verifiedManifestDigest: SourceHashSchema, verifiedEntries: z.number().int().nonnegative(),
  verifiedBytes: z.number().int().nonnegative(), verifiedAt: z.string().datetime(),
  claimScope: z.literal('execution').optional(),
  /** Original directory owner when a serialized node turn retains its working files. */
  retainedTree: z.object({ materializationId: z.uuid(), executionId: IdSchema }).strict().optional(),
  sharedTree: z.object({ id: z.uuid(), referenceIdentity: RootBindingSchema.shape.filesystem }).strict().optional(),
  worktree: SourceWorktreeRequestSchema.extend({
    commit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
    /** The default-branch commit used at execution start; the approved reference stays immutable. */
    startCommit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/).optional(),
  }).strict().optional(),
  localTreeIdentity: z.object({ device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/), mountId: z.string().regex(/^\d+$/) }).strict(),
}).strict().superRefine((value, context) => {
  if (value.retainedTree && (value.quota || !value.sharedTree || value.claimScope !== 'execution'
    || value.retainedTree.materializationId === value.materializationId)) {
    context.addIssue({ code: 'custom', path: ['retainedTree'],
      message: 'Retained node directories require a separate execution claim without a Job quota.' })
  }
  if (value.sharedTree && value.claimScope !== 'execution') {
    context.addIssue({ code: 'custom', path: ['sharedTree'], message: 'Shared working trees require an execution claim.' })
  }
  if (value.worktree && (!value.sharedTree || value.binding.accessMode !== 'exclusive-write')) {
    context.addIssue({ code: 'custom', path: ['worktree'], message: 'An agent worktree is a writable working tree.' })
  }
})
export type MaterializationReceipt = z.infer<typeof MaterializationReceiptSchema>

/** Main's private receipt file can reuse its retained, immutable snapshot bytes. */
export const SourceSnapshotReferenceSchema = z.object({
  canonicalStorePath: z.string().min(1), storeIdentity: RootBindingSchema.shape.filesystem,
}).strict()
export type SourceSnapshotReference = z.infer<typeof SourceSnapshotReferenceSchema>
export const SourceMaterializationFileSchema = z.object({
  receipt: MaterializationReceiptSchema, manifest: SourceManifestSchema,
  snapshotReference: SourceSnapshotReferenceSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.snapshotReference && (!value.receipt.worktree || value.receipt.binding.deviceId !== null || value.receipt.quota)) {
    context.addIssue({ code: 'custom', path: ['snapshotReference'],
      message: 'Shared snapshot references require a Main-local agent worktree without a Job quota.' })
  }
})

export function sourceMaterializationComponents(receipt: Pick<MaterializationReceipt, 'materializationId' | 'quota'>): string[] {
  return [...(receipt.quota ? [receipt.quota.namespace] : []), receipt.materializationId]
}
export function sourceMaterializationParent(receipt: MaterializationReceipt): string {
  return [receipt.binding.canonicalPath.replace(/\/$/, ''), ...sourceMaterializationComponents(receipt)].join('/')
}

/** Main asks an Agent's computer for its current files as its base commit when unchanged, or a git bundle when changed. */
export const AGENT_SNAPSHOT_NAMESPACE = 'agent-snapshot-v1'
export const AGENT_SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024
const AGENT_SNAPSHOT_BASE64_BYTES = Math.ceil(AGENT_SNAPSHOT_MAX_BYTES / 3) * 4
/** Includes the commit and JSON envelope alongside the base64 bundle. */
export const AGENT_SNAPSHOT_JSON_BYTES = AGENT_SNAPSHOT_BASE64_BYTES + 1024
export const AgentSnapshotRequestSchema = z.object({
  path: z.string().startsWith('/').max(4096),
  baseCommit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
}).strict()
export const AgentSnapshotResultSchema = z.object({
  commit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
  bundleBase64: z.string().max(AGENT_SNAPSHOT_BASE64_BYTES).nullable(),
}).strict()
