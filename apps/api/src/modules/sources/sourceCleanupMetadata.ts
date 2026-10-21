import { constants } from 'node:fs'
import { open, unlink, type FileHandle } from 'node:fs/promises'
import { anchored } from './privateFilesystem.js'
import { SourceError } from './manifest.js'

export async function readCleanupRecord(directory: FileHandle, name: string, signal: AbortSignal,
  maximumBytes = 16384): Promise<unknown | null> {
  signal.throwIfAborted()
  let file: FileHandle
  try {
    file = await open(anchored(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1
      || stat.mode & 0o077 || stat.size > maximumBytes) {
      throw new SourceError('SOURCE_CLAIM_INVALID', 'Source cleanup metadata is not a private bounded record.')
    }
    return JSON.parse(await file.readFile({ encoding: 'utf8', signal })) as unknown
  } finally {
    await file.close()
  }
}

/** The caller holds the root lock and has verified the closed initializer's durable owner. */
export async function removeIncompleteCleanupRecord(directory: FileHandle, name: string,
  signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  let file: FileHandle
  try {
    file = await open(anchored(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1
      || stat.mode & 0o077 || stat.size > 16384) {
      throw new SourceError('SOURCE_CLAIM_INVALID', 'Incomplete cleanup metadata is not a private bounded record.')
    }
    signal.throwIfAborted()
    await unlink(anchored(directory, name))
  } finally {
    await file.close()
  }
}
