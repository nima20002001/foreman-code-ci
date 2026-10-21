import { lstat, open, readdir, type FileHandle } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { SourceManifestSchema, type RootBinding, type MaterializationReceipt } from '@foreman-code/contracts/source-materialization'
import { anchored, directoryFlags, identity, openChildDirectory, openPrivateRoot } from './privateFilesystem.js'
import type { RetainedSourceFootprint } from '@foreman-code/contracts/source-operations'
import { SOURCE_LIMITS, SourceError } from './manifest.js'

/** Measures retained bytes only after the caller has confirmed the original writer is closed. */
export async function measureRetainedSourceDirectory(
  canonicalRoot: string, directoryId: string, expectedRoot?: RootBinding['filesystem'],
): Promise<number> {
  return measureSourceDirectory(canonicalRoot, directoryId, expectedRoot, new Set())
}

async function measureSourceDirectory(
  canonicalRoot: string, directoryId: string, expectedRoot: RootBinding['filesystem'] | undefined,
  countedInodes: Set<string>,
): Promise<number> {
  SourceManifestSchema.shape.snapshotId.parse(directoryId)
  const root = await openPrivateRoot(canonicalRoot)
  const rootFilesystem = await identity(root)
  let snapshot: FileHandle
  try {
    if (expectedRoot && !isDeepStrictEqual(rootFilesystem, expectedRoot)) {
      throw new SourceError('SOURCE_ROOT_CHANGED', 'Retained source storage identity changed.')
    }
    snapshot = await openChildDirectory(root, directoryId)
  } catch (error) {
    await root.close()
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  try {
    return await measureRetainedDirectory(snapshot, rootFilesystem, countedInodes,
      { depth: 34, entries: SOURCE_LIMITS.entries * 34 + 16 })
  } finally {
    await snapshot.close()
    await root.close()
  }
}

/** Count allocated bytes without following symlinks or crossing the pinned filesystem. Entries are measured by a
 * bounded pool: when other file work saturates the libuv pool, one queued round trip per entry in sequence turns a
 * cache scan held under the Git transfer lock into tens of seconds. Depth-first order keeps few directories open. */
export async function measureRetainedDirectory(root: FileHandle, rootFilesystem: RootBinding['filesystem'],
  countedInodes = new Set<string>(), limits = { depth: 64, entries: 300_000 }): Promise<number> {
  type Directory = { handle: FileHandle; depth: number; references: number }
  const queue: { parent: Directory; name: string }[] = []
  const waiting: (() => void)[] = []
  let entries = 0
  let bytes = 0
  let active = 0
  let failure: { error: unknown } | undefined
  const release = async (directory: Directory) => {
    if (--directory.references === 0 && directory.handle !== root) await directory.handle.close()
  }
  const list = async (directory: Directory) => {
    try {
      if (directory.depth > limits.depth) {
        throw new SourceError('SOURCE_CAPACITY', 'Retained source directory depth exceeds its bound.')
      }
      // Read before adding: `bytes += await ...` would add to a total that concurrent visits have since changed.
      const own = Math.max(4096, Number((await directory.handle.stat()).blocks) * 512)
      bytes += own
      const names = await readdir(anchored(directory.handle))
      entries += names.length
      if (entries > limits.entries) {
        throw new SourceError('SOURCE_CAPACITY', 'Retained source entry count exceeds its bound.')
      }
      directory.references += names.length
      for (const name of names) queue.push({ parent: directory, name })
    } finally {
      await release(directory)
    }
  }
  const visit = async (parent: Directory, name: string) => {
    const path = anchored(parent.handle, name)
    const stat = await lstat(path, { bigint: true })
    if (stat.uid !== BigInt(process.getuid?.() ?? -1)) {
      throw new SourceError('SOURCE_BYTES_INVALID', 'Retained source ownership changed.')
    }
    if (stat.isDirectory()) {
      const handle = await open(path, directoryFlags)
      try {
        if ((await handle.stat()).uid !== process.getuid?.()) {
          throw new SourceError('SOURCE_BYTES_INVALID', 'Retained source ownership changed.')
        }
        const filesystem = await identity(handle)
        if (filesystem.device !== rootFilesystem.device || filesystem.mountId !== rootFilesystem.mountId) {
          throw new SourceError('SOURCE_MOUNT_CHANGED', 'Retained source cannot cross a filesystem or mount boundary.')
        }
      } catch (error) {
        await handle.close()
        throw error
      }
      // The private materialization parent also contains ordinary Git directory modes.
      await list({ handle, depth: parent.depth + 1, references: 1 })
      return
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new SourceError('SOURCE_BYTES_INVALID', 'Retained source contains an unsupported file.')
    }
    const inode = `${stat.dev}:${stat.ino}`
    if (countedInodes.has(inode)) return
    countedInodes.add(inode)
    bytes += Math.max(4096, Number(stat.size), Number(stat.blocks) * 512)
  }
  const work = async () => {
    for (;;) {
      const next = failure ? undefined : queue.pop()
      if (!next) {
        if (!active || failure) return
        await new Promise<void>(resolve => waiting.push(resolve))
        continue
      }
      active++
      try { await visit(next.parent, next.name) }
      catch (error) { failure ??= { error } }
      finally {
        active--
        await release(next.parent)
        for (const wake of waiting.splice(0)) wake()
      }
    }
  }
  await list({ handle: root, depth: 0, references: 1 })
  await Promise.all(Array.from({ length: 32 }, work))
  // After a failure, close the directories whose entries were never visited.
  for (const { parent } of queue.splice(0)) await release(parent)
  if (failure) throw failure.error
  return bytes
}

export async function measureRetainedMaterializationFootprint(
  receipt: MaterializationReceipt,
): Promise<RetainedSourceFootprint> {
  if (receipt.quota) return { retainedBytes: 0 }
  const binding = receipt.binding
  const countedInodes = new Set<string>()
  // Charge cross-tree hard links to the shared tree so its other references can release their own copies.
  const working = receipt.sharedTree ? await measureSourceDirectory(
    binding.canonicalPath, receipt.sharedTree.id, binding.filesystem, countedInodes,
  ) : 0
  const reference = await measureSourceDirectory(
    binding.canonicalPath, receipt.materializationId, binding.filesystem, countedInodes,
  )
  return { retainedBytes: reference + working,
    ...(receipt.sharedTree ? { sharedTree: { id: receipt.sharedTree.id, bytes: working } } : {}) }
}

export async function measureRetainedMaterialization(receipt: MaterializationReceipt): Promise<number> {
  return (await measureRetainedMaterializationFootprint(receipt)).retainedBytes
}
