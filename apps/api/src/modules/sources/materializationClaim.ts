import { constants } from 'node:fs'
import { open, readdir, rename, type FileHandle } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { scheduler } from 'node:timers/promises'
import { SOURCE_MATERIALIZATION_RECORD_MAX_BYTES, MaterializationReceiptSchema, sourceMaterializationComponents, type MaterializationReceipt, type RootBinding,
  type SourceManifest, type SourceProjectQuotaSlot } from '@foreman-code/contracts/source-materialization'
import type { JobVerificationQuotaPool } from '@foreman-code/contracts/job-verification-runtime'
import type { JobQuotaReader } from '../jobs/quotaOwnership.js'
import { processSourceDirectories } from './entryProcessing.js'
import { sourceMaterializationClaimName, writeSourceClaim } from './quotaClaims.js'
import { SourceError, sourcePath, verifySourceManifest } from './manifest.js'
import { anchored, identity, openChildDirectory, openPrivateRoot, withPrivateDirectoryLock } from './privateFilesystem.js'
import type { MaterializationAttempt } from './ports.js'
import { verifySourceEntry } from './verifySourceEntry.js'
import { readCleanupRecord } from './sourceCleanupMetadata.js'

const equal = isDeepStrictEqual
/** Preserve the claim API while sharing Main's joined directory-lock implementation. */
export async function withClaimLock<T>(root: FileHandle, work: () => Promise<T>,
  options: { nonBlocking?: boolean; signal?: AbortSignal | undefined } = {}): Promise<T> {
  return withPrivateDirectoryLock(root, async () => {
    options.signal?.throwIfAborted()
    const result = await work()
    options.signal?.throwIfAborted()
    return result
  }, options)
}
export async function materializationDirectory(root: FileHandle, receipt: Pick<MaterializationReceipt, 'materializationId' | 'quota'>): Promise<FileHandle> {
  let directory = root
  try {
    for (const part of sourceMaterializationComponents(receipt)) {
      const child = await openChildDirectory(directory, part)
      if (directory !== root) await directory.close()
      directory = child
    }
    return directory
  } catch (error) {
    if (directory !== root) await directory.close()
    throw error
  }
}
export type SourceQuotaPool = { pool: JobVerificationQuotaPool; read?: JobQuotaReader }
export async function verifyMaterializedSourceTree(tree: FileHandle, manifest: SourceManifest, signal?: AbortSignal,
  options: { snapshotBytes?: true } = {}): Promise<void> {
  const expected = new Set(manifest.entries.map((entry) => entry.path))
  const directories = new Set<string>()
  for (const entry of manifest.entries) {
    const parts = entry.path.split('/')
    for (let depth = 1; depth < parts.length; depth++) directories.add(parts.slice(0, depth).join('/'))
  }
  const walk = async (directory: FileHandle, prefix: string): Promise<void> => {
    for (const item of await readdir(anchored(directory), { withFileTypes: true })) {
      signal?.throwIfAborted()
      const path = prefix ? `${prefix}/${item.name}` : item.name
      sourcePath(path)
      if (item.isDirectory()) {
        if (!directories.has(path)) throw new SourceError('SOURCE_TREE_EXTRA', 'Unexpected materialization directory.')
        const child = await openChildDirectory(directory, item.name)
        try { await walk(child, path) } finally { await child.close() }
      } else if (!item.isFile() || !expected.has(path)) throw new SourceError('SOURCE_TREE_EXTRA', 'Unexpected materialization entry.')
    }
  }
  await walk(tree, '')
  await processSourceDirectories(tree, manifest.entries, async (parent, entries) => {
    for (const entry of entries) {
      signal?.throwIfAborted()
      verifySourceEntry(parent, entry, options)
      await scheduler.yield()
    }
  }, signal ? { signal } : {})
}

export async function archiveMaterializationClaim(receipt: MaterializationReceipt,
  options: { filesystem: RootBinding['filesystem']; verifyOriginalSource?: true; signal?: AbortSignal },
  reconcile: () => Promise<'released' | 'owned' | 'uncertain'>): Promise<void> {
  const signal = options.signal
  signal?.throwIfAborted()
  MaterializationReceiptSchema.parse(receipt)
  if (await reconcile() !== 'released') throw new SourceError('SOURCE_ROOT_OWNED', 'Execution ownership is not reconciled.')
  signal?.throwIfAborted()
  const binding = receipt.binding, root = await openPrivateRoot(binding.canonicalPath)
  try {
    signal?.throwIfAborted()
    if (!equal(await identity(root), options.filesystem)) throw new SourceError('SOURCE_ROOT_CHANGED', 'Destination root changed.')
    signal?.throwIfAborted()
    await withClaimLock(root, async () => {
      if (await reconcile() !== 'released') throw new SourceError('SOURCE_ROOT_OWNED', 'Execution ownership is not reconciled.')
      signal?.throwIfAborted()
      const name = sourceMaterializationClaimName(binding, { ...receipt }, receipt.quota, receipt.claimScope)
      const releasedName = receipt.quota ? `released-binding-${receipt.materializationId}.json` : 'released-claim.json'
      const directory = await materializationDirectory(root, receipt)
      // Controller claims stay in their original project; ext4 forbids cross-project rename.
      const releaseDirectory = receipt.quota ? root : directory
      const validateClaim = async (lock: FileHandle): Promise<void> => {
        signal?.throwIfAborted()
        const stat = await lock.stat()
        signal?.throwIfAborted()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384) throw new SourceError('SOURCE_CLAIM_INVALID', 'Invalid binding claim.')
        const claim = JSON.parse(await lock.readFile(signal ? { encoding: 'utf8', signal } : 'utf8')) as { version: number; materializationId: string; binding: RootBinding; attempt: MaterializationAttempt; quota?: SourceProjectQuotaSlot }
        signal?.throwIfAborted()
        validateClaimOwner(claim, receipt)
      }
      try {
        signal?.throwIfAborted()
        // The archived claim identifies the exact original owner; the immutable
        // activation record binds replay to every fact of the original receipt.
        const record = await open(anchored(directory, 'receipt.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          signal?.throwIfAborted()
          const stat = await record.stat()
          signal?.throwIfAborted()
          if (!stat.isFile() || stat.nlink !== 1 || stat.size > SOURCE_MATERIALIZATION_RECORD_MAX_BYTES) throw new SourceError('SOURCE_RECEIPT_INVALID', 'Invalid receipt record.')
          const stored = JSON.parse(await record.readFile(signal ? { encoding: 'utf8', signal } : 'utf8')) as { receipt: unknown; manifest: unknown }
          signal?.throwIfAborted()
          if (!equal(stored.receipt, receipt)) {
            throw new SourceError('SOURCE_RECEIPT_CONFLICT', 'Release does not match the exact original materialization receipt.')
          }
          if (options.verifyOriginalSource) {
            const manifest = verifySourceManifest(stored.manifest)
            if (manifest.manifestDigest !== receipt.verifiedManifestDigest || manifest.snapshotId !== binding.snapshotId
              || manifest.totalEntries !== receipt.verifiedEntries || manifest.totalBytes !== receipt.verifiedBytes) {
              throw new SourceError('SOURCE_RECEIPT_CONFLICT', 'The original verified source manifest changed.')
            }
            const tree = await openChildDirectory(directory, 'tree')
            try {
              const expected = { ...receipt.localTreeIdentity, device: options.filesystem.device,
                mountId: options.filesystem.mountId }
              if (!equal(await identity(tree), expected)) throw new SourceError('SOURCE_ROOT_CHANGED', 'The original source tree inode changed.')
              signal?.throwIfAborted()
              await verifyMaterializedSourceTree(tree, manifest, signal)
            } finally { await tree.close() }
          }
        } finally { await record.close() }
        signal?.throwIfAborted()
        const released = await open(anchored(releaseDirectory, releasedName), constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
          throw error
        })
        if (released) {
          if (await reconcile() !== 'released') throw new SourceError('SOURCE_ROOT_OWNED', 'Execution ownership is not reconciled.')
          try {
            await validateClaim(released)
            signal?.throwIfAborted()
            await released.sync()
            signal?.throwIfAborted()
          } finally { await released.close() }
          // Finish durability after a crash/lost ACK during the original rename.
          // Never inspect or delete a successor claim on this replay branch.
          await directory.sync()
          signal?.throwIfAborted()
          await root.sync()
          signal?.throwIfAborted()
          return
        }
        signal?.throwIfAborted()
        const lock = await open(anchored(root, name), constants.O_RDONLY | constants.O_NOFOLLOW)
          .catch(async (error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            await restoreReleasedPreparationClaim(root, releaseDirectory, releasedName, receipt, reconcile, signal)
            return null
          })
        if (!lock) return
        try {
          await validateClaim(lock)
          signal?.throwIfAborted()
          const current = await open(anchored(root, name), constants.O_RDONLY | constants.O_NOFOLLOW)
          try {
            if (!equal(await identity(current), await identity(lock))) throw new SourceError('SOURCE_CLAIM_CONFLICT', 'The validated destination claim was replaced.')
          } finally { await current.close() }
          // Atomically remove active ownership AND preserve its original claim.
          // Absence alone is never accepted as evidence that release completed.
          if (await reconcile() !== 'released') throw new SourceError('SOURCE_ROOT_OWNED', 'Execution ownership is not reconciled.')
          signal?.throwIfAborted()
          await rename(anchored(root, name), anchored(releaseDirectory, releasedName))
          signal?.throwIfAborted()
          await lock.sync()
          signal?.throwIfAborted()
          await directory.sync()
          signal?.throwIfAborted()
          await root.sync()
          signal?.throwIfAborted()
        } finally { await lock.close() }
      } finally { await directory.close() }
    }, { signal })
  } finally { await root.close() }
}

type MaterializationClaim = {
  version: number
  materializationId: string
  binding: RootBinding
  attempt: MaterializationAttempt
  quota?: SourceProjectQuotaSlot
}

function validateClaimOwner(claim: MaterializationClaim, receipt: MaterializationReceipt): void {
  const attempt = { placementHash: receipt.placementHash, executionId: receipt.executionId,
    attemptId: receipt.attemptId, keyRevision: receipt.keyRevision, authorizationRevision: receipt.authorizationRevision }
  if (claim.version !== 1 || claim.materializationId !== receipt.materializationId
    || !equal(claim.binding, receipt.binding) || !equal(claim.attempt, attempt) || !equal(claim.quota, receipt.quota)) {
    throw new SourceError('SOURCE_CLAIM_CONFLICT', 'This receipt does not own the destination claim.')
  }
}

async function restoreReleasedPreparationClaim(root: FileHandle, directory: FileHandle, name: string,
  receipt: MaterializationReceipt, reconcile: () => Promise<'released' | 'owned' | 'uncertain'>,
  signal = AbortSignal.timeout(60_000)): Promise<void> {
  // Preparation reconciliation can archive a claim before Main receives its receipt.
  const entries = await readdir(anchored(root))
  for (const entry of entries) {
    signal.throwIfAborted()
    if (!/^closed-preparation-[a-f0-9-]{36}\.claim\.json$/.test(entry)) continue
    const claim = await readCleanupRecord(root, entry, signal) as MaterializationClaim | null
    if (claim?.materializationId !== receipt.materializationId) continue
    validateClaimOwner(claim, receipt)
    if (await reconcile() !== 'released') throw new SourceError('SOURCE_ROOT_OWNED', 'Execution closure changed.')
    signal.throwIfAborted()
    await writeSourceClaim(directory, name, JSON.stringify(claim), signal)
    await root.sync()
    return
  }
  throw new SourceError('SOURCE_CLAIM_MISSING',
    'The original source claim and its archived release record are missing; cleanup cannot confirm ownership.')
}

/** A new worker generation cannot infer closure from its empty in-memory task
 * set. Look for same-UID processes using the original private namespace, without
 * exposing argv or accepting PID/path assertions from the caller. */
