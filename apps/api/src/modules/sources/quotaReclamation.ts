import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readdir, unlink, rmdir, rename, type FileHandle } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { MaterializationReceiptSchema, type MaterializationReceipt }
  from '@foreman-code/contracts/source-materialization'
import { archiveMaterializationClaim, withClaimLock, type SourceQuotaPool } from './materializationClaim.js'
import { anchored, identity, openChildDirectory, openPrivateRoot } from './privateFilesystem.js'
import { verifyJobQuotaOwnership } from '../jobs/quotaOwnership.js'
import { SourceError } from './manifest.js'

async function readRecord(root: FileHandle, name: string, signal: AbortSignal): Promise<unknown | null> {
  signal.throwIfAborted()
  let file: FileHandle
  try { file = await open(anchored(root, name), constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    signal.throwIfAborted()
    const stat = await file.stat()
    signal.throwIfAborted()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32768 || stat.mode & 0o077) {
      throw new SourceError('SOURCE_CLAIM_INVALID', 'Quota cleanup record is invalid.')
    }
    const bytes = await file.readFile({ encoding: 'utf8', signal })
    signal.throwIfAborted()
    return JSON.parse(bytes) as unknown
  } finally { await file.close() }
}
async function writeRecord(root: FileHandle, name: string, record: unknown, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const pending = `${name}.pending-${randomUUID()}`
  const file = await open(anchored(root, pending), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    | constants.O_NOFOLLOW, 0o600)
  let installed = false
  try {
    signal.throwIfAborted()
    await file.writeFile(JSON.stringify(record), { signal })
    signal.throwIfAborted()
    await file.sync()
    signal.throwIfAborted()
    await rename(anchored(root, pending), anchored(root, name))
    installed = true
    await root.sync()
    signal.throwIfAborted()
  } finally {
    await file.close()
    if (!installed) await unlink(anchored(root, pending))
  }
}
export async function removeSourceDirectory(parent: FileHandle, name: string,
  receipt: Pick<MaterializationReceipt, 'binding' | 'quota'>, signal: AbortSignal, privateRoot = true): Promise<void> {
  signal.throwIfAborted()
  let directory: FileHandle
  try { directory = privateRoot ? await openChildDirectory(parent, name)
    : await open(anchored(parent, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  try {
    signal.throwIfAborted()
    const metadata = await directory.stat()
    if (metadata.uid !== process.getuid!()) {
      throw new SourceError('SOURCE_DIRECTORY_NOT_PRIVATE', 'Quota workload directories must remain worker-owned.')
    }
    const filesystem = await identity(directory)
    signal.throwIfAborted()
    const expectedFilesystem = receipt.quota?.filesystem ?? receipt.binding.filesystem
    if (filesystem.device !== expectedFilesystem.device
      || filesystem.mountId !== expectedFilesystem.mountId) {
      throw new SourceError('SOURCE_MOUNT_CHANGED', 'Quota cleanup cannot cross a filesystem boundary.')
    }
    // Closure is already confirmed; release sealed input directories through the owned handle.
    if ((metadata.mode & 0o700) !== 0o700) await directory.chmod((metadata.mode & 0o777) | 0o700)
    signal.throwIfAborted()
    const entries = await readdir(anchored(directory), { withFileTypes: true })
    signal.throwIfAborted()
    for (const entry of entries) {
      signal.throwIfAborted()
      if (entry.isDirectory()) await removeSourceDirectory(directory, entry.name, receipt, signal, false)
      else await unlink(anchored(directory, entry.name))
      signal.throwIfAborted()
    }
  } finally { await directory.close() }
  signal.throwIfAborted()
  await rmdir(anchored(parent, name))
  signal.throwIfAborted()
  await parent.sync()
  signal.throwIfAborted()
}

/** Main retains the source snapshot and published artifacts before authorizing this cleanup. */
export async function reclaimMaterializationQuota(receipt: MaterializationReceipt, quotaPool: SourceQuotaPool,
  reconcile: () => Promise<'released' | 'owned' | 'uncertain'>, signal: AbortSignal,
  recovery?: { filesystem: MaterializationReceipt['binding']['filesystem']; verifyOriginalSource: true }): Promise<void> {
  MaterializationReceiptSchema.parse(receipt)
  if (!receipt.quota) throw new SourceError('SOURCE_QUOTA_MISSING', 'Per-Job quota ownership is missing.')
  const filesystem = recovery?.filesystem ?? receipt.binding.filesystem
  if (filesystem.inode !== receipt.binding.filesystem.inode) {
    throw new SourceError('SOURCE_ROOT_CHANGED', 'Original source root inode changed.')
  }
  const binding = { ...receipt.binding, filesystem }
  const slotFacts = { ...receipt.quota, filesystem: { ...receipt.quota.filesystem,
    device: filesystem.device, mountId: filesystem.mountId } }
  const observedQuota = { ...quotaPool, pool: { ...quotaPool.pool, slots: quotaPool.pool.slots.map(slot => ({ ...slot,
    filesystem: { ...slot.filesystem, device: filesystem.device, mountId: filesystem.mountId } })) } }
  signal.throwIfAborted()
  if (await reconcile() !== 'released') throw new SourceError('SOURCE_ROOT_OWNED', 'Original Job closure is unconfirmed.')
  signal.throwIfAborted()
  const root = await openPrivateRoot(receipt.binding.canonicalPath)
  const removingName = `reclaiming-${receipt.materializationId}.json`
  const completedName = `reclaimed-${receipt.materializationId}.json`
  try {
    signal.throwIfAborted()
    if (!isDeepStrictEqual(await identity(root), filesystem)) {
      throw new SourceError('SOURCE_ROOT_CHANGED', 'The original quota namespace changed.')
    }
    signal.throwIfAborted()
    const completed = await readRecord(root, completedName, signal)
    if (completed) {
      if (!isDeepStrictEqual(completed, receipt)) throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Cleanup belongs to another Job.')
      await withClaimLock(root, async () => {
        signal.throwIfAborted()
        const name = `quota-${receipt.quota!.namespace}.claim.json`
        const active = await readRecord(root, name, signal) as { materializationId: string } | null
        signal.throwIfAborted()
        if (active?.materializationId === receipt.materializationId) {
          await rename(anchored(root, name), anchored(root, `released-quota-${receipt.materializationId}.json`))
          signal.throwIfAborted()
          await root.sync()
          signal.throwIfAborted()
        }
      }, { signal })
      return
    }
    const removing = await readRecord(root, removingName, signal)
    if (removing && !isDeepStrictEqual(removing, receipt)) {
      throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Cleanup belongs to another Job.')
    }
    if (!removing) {
      await archiveMaterializationClaim(receipt, { filesystem, signal, ...(recovery ? { verifyOriginalSource: true as const } : {}) }, reconcile)
      await writeRecord(root, removingName, receipt, signal)
    }
    await withClaimLock(root, async () => {
      signal.throwIfAborted()
      if (await reconcile() !== 'released') throw new SourceError('SOURCE_ROOT_OWNED', 'Original Job closure is unconfirmed.')
      const claimName = `quota-${receipt.quota!.namespace}.claim.json`
      const claim = await readRecord(root, claimName, signal) as { materializationId: string; quota: unknown } | null
      if (!claim || claim.materializationId !== receipt.materializationId || !isDeepStrictEqual(claim.quota, receipt.quota)) {
        throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Quota cleanup does not own this slot.')
      }
      await verifyJobQuotaOwnership({ ...observedQuota, binding, slot: slotFacts, signal })
      signal.throwIfAborted()
      const slot = await openChildDirectory(root, receipt.quota!.namespace)
      try {
        await removeSourceDirectory(slot, receipt.materializationId, { binding, quota: slotFacts }, signal)
        const usage = await verifyJobQuotaOwnership({ ...observedQuota, binding, slot: slotFacts, signal })
        signal.throwIfAborted()
        const stat = await slot.stat()
        signal.throwIfAborted()
        const entries = await readdir(anchored(slot))
        signal.throwIfAborted()
        if (entries.length || usage.usedBytes > stat.blocks * 512 || usage.usedInodes > 1) {
          throw new SourceError('SOURCE_QUOTA_OWNED', 'The quota still contains Job data or an open deleted file.')
        }
        if (await reconcile() !== 'released') throw new SourceError('SOURCE_ROOT_OWNED', 'Original Job closure is unconfirmed.')
        signal.throwIfAborted()
        await writeRecord(root, completedName, receipt, signal)
        await rename(anchored(root, claimName), anchored(root, `released-quota-${receipt.materializationId}.json`))
        signal.throwIfAborted()
        await root.sync()
        signal.throwIfAborted()
      } finally { await slot.close() }
    }, { signal })
  } finally { await root.close() }
}

/** The caller holds the namespace lock and has archived the original incomplete claim. */
export async function reclaimPreparationQuota(
  claim: Pick<MaterializationReceipt, 'binding' | 'quota' | 'materializationId'>, root: FileHandle,
  quotaPool: SourceQuotaPool, closed: () => Promise<boolean>, signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  if (!claim.quota || !await closed()) throw new SourceError('SOURCE_ROOT_OWNED', 'Original preparation closure is unconfirmed.')
  signal.throwIfAborted()
  const name = `quota-${claim.quota.namespace}.claim.json`
  const releasedName = `released-quota-${claim.materializationId}.json`
  const released = await readRecord(root, releasedName, signal) as { materializationId: string; quota: unknown } | null
  if (released) {
    if (released.materializationId !== claim.materializationId || !isDeepStrictEqual(released.quota, claim.quota)) {
      throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Preparation release belongs to another quota.')
    }
    return
  }
  const active = await readRecord(root, name, signal) as { materializationId: string; quota: unknown; binding: unknown } | null
  if (!active || active.materializationId !== claim.materializationId
    || !isDeepStrictEqual(active.quota, claim.quota) || !isDeepStrictEqual(active.binding, claim.binding)) {
    throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Preparation cleanup does not own this quota.')
  }
  await verifyJobQuotaOwnership({ ...quotaPool, binding: claim.binding, slot: claim.quota, signal })
  signal.throwIfAborted()
  const slot = await openChildDirectory(root, claim.quota.namespace)
  try {
    await removeSourceDirectory(slot, claim.materializationId, claim, signal)
    const usage = await verifyJobQuotaOwnership({ ...quotaPool, binding: claim.binding, slot: claim.quota, signal })
    signal.throwIfAborted()
    const entries = await readdir(anchored(slot))
    signal.throwIfAborted()
    const stat = await slot.stat()
    signal.throwIfAborted()
    if (entries.length || usage.usedBytes > stat.blocks * 512
      || usage.usedInodes > 1 || !await closed()) {
      throw new SourceError('SOURCE_QUOTA_OWNED', 'Original preparation still owns quota storage.')
    }
    signal.throwIfAborted()
    await rename(anchored(root, name), anchored(root, releasedName))
    signal.throwIfAborted()
    await root.sync()
    signal.throwIfAborted()
  } finally { await slot.close() }
}
