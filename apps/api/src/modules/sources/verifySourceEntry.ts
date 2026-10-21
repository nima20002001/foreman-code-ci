import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import type { SourceEntry } from '@foreman-code/contracts/source-materialization'
import { anchored } from './privateFilesystem.js'
import { SourceError, verifySourceBytes } from './manifest.js'

/** One manifest-limited file, without access-time writes or small-I/O thread-pool queues. */
export function verifySourceEntry(parent: FileHandle, entry: SourceEntry,
  options: { snapshotBytes?: true } = {}): void {
  const leaf = entry.path.slice(entry.path.lastIndexOf('/') + 1)
  const file = openSync(anchored(parent, leaf),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOATIME)
  try {
    const stat = fstatSync(file)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== entry.byteSize
      || (!options.snapshotBytes && !!(stat.mode & 0o111) !== entry.executable)) {
      throw new SourceError('SOURCE_TREE_INVALID', 'Source kind, size, link count or executable policy changed.')
    }
    verifySourceBytes(entry, readFileSync(file))
  } finally { closeSync(file) }
}
