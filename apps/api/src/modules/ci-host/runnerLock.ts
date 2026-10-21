import { open, type FileHandle } from 'node:fs/promises'
import { directoryFlags, withPrivateDirectoryLock } from '../sources/privateFilesystem.js'
import { SourceError } from '../sources/manifest.js'

/** Native entry and reconciliation share a kernel lock, including across Worker restarts. */
export async function withHostCiRunLock<T>(directory: string, work: (guard: FileHandle) => Promise<T>,
  options: { nonBlocking?: boolean; signal?: AbortSignal | undefined } = {}): Promise<T | undefined> {
  const handle = await open(directory, directoryFlags)
  try {
    return await withPrivateDirectoryLock(handle, work, options)
  } catch (error) {
    if (options.nonBlocking && error instanceof SourceError && error.code === 'SOURCE_CLAIM_LOCK_FAILED') {
      // A live preparation or launch owns the directory; its cancellation marker remains pending.
      return undefined
    }
    throw error
  } finally {
    await handle.close()
  }
}
