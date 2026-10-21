import { constants, type Dir } from 'node:fs'
import { lstat, open, opendir, rmdir, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

import { cleanupBatchSize, type FileCleanupBytes } from './repository.js'

const storageKeyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_ALLOCATION_ENTRIES = 64
const areas = ['objects', 'staging'] as const
function hasCode(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === code
}
/** FileByteStorage satisfies this seam; its initialization enforces the private app-managed root. */
interface ManagedStorage { readonly root: string; initialize(): Promise<void> }

export class ManagedFileCleanupBytes implements FileCleanupBytes {
  private directory: Dir | undefined
  private area = 0
  constructor(private readonly storage: ManagedStorage) {}

  private async privateDirectory(path: string): Promise<void> {
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)
      || (process.getuid && stat.uid !== process.getuid())) throw new Error('Cleanup requires a private, owned managed directory.')
  }
  private async sync(path: string): Promise<void> {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await handle.sync() } finally { await handle.close() }
  }

  /** Bounded across BOTH directories, including invalid/unmapped names. A new pass opens fresh
   * directory handles; entries skipped by concurrent readdir/unlink are recovered on a later pass. */
  async scan(limit: number): Promise<{ keys: string[]; exhausted: boolean }> {
    cleanupBatchSize(limit)
    await this.storage.initialize()
    const keys = new Set<string>()
    try {
      for (let visited = 0; visited < limit;) {
        if (!this.directory) {
          const path = join(this.storage.root, areas[this.area]!)
          await this.privateDirectory(path)
          this.directory = await opendir(path)
        }
        const entry = await this.directory.read()
        if (!entry) {
          await this.directory.close(); this.directory = undefined
          this.area++
          if (this.area === areas.length) { this.area = 0; return { keys: [...keys], exhausted: true } }
          continue
        }
        visited++
        if (storageKeyPattern.test(entry.name)) keys.add(entry.name)
      }
      return { keys: [...keys], exhausted: false }
    } catch (error) { await this.close(); throw error }
  }

  /** Called ONLY behind PostgresFileCleanupRepository.remove's fresh guard. Unlink never
   * truncates an inode: admitted downloads and other object hard links remain intact.
   * No recursive removal, filenames, globbing or arbitrary host paths are accepted. */
  async remove(storageKey: string): Promise<boolean> {
    if (!storageKeyPattern.test(storageKey)) throw new Error('Invalid internal cleanup storage key.')
    await this.storage.initialize()
    const objects = join(this.storage.root, 'objects'), staging = join(this.storage.root, 'staging')
    await this.privateDirectory(objects); await this.privateDirectory(staging)
    await unlink(join(objects, storageKey)).catch((error: unknown) => { if (!hasCode(error, 'ENOENT')) throw error })
    await this.sync(objects)
    const allocation = join(staging, storageKey)
    try { await this.privateDirectory(allocation) } catch (error) { if (hasCode(error, 'ENOENT')) return true; throw error }
    let handle: FileHandle | undefined, directory: Dir | undefined
    try {
      handle = await open(allocation, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      directory = await opendir(allocation)
      for (let count = 0; count < MAX_ALLOCATION_ENTRIES; count++) {
        const entry = await directory.read()
        if (!entry) break
        if (entry.name !== 'verified' && !(entry.name.endsWith('.part') && storageKeyPattern.test(entry.name.slice(0, -5)))) {
          throw new Error('Unexpected entry in a managed allocation directory; refusing recursive cleanup.')
        }
        // unlink removes a leaf symlink itself, never its target; subdirectories fail closed.
        await unlink(join(allocation, entry.name)).catch((error: unknown) => { if (!hasCode(error, 'ENOENT')) throw error })
      }
      await handle.sync()
    } catch (error) {
      // Cancellation/another sweeper may already have removed this directory. All deletions are idempotent.
      if (!hasCode(error, 'ENOENT')) throw error
    } finally {
      try { await directory?.close() } finally { await handle?.close() }
    }
    let complete = true
    await rmdir(allocation).catch((error: unknown) => {
      if (hasCode(error, 'ENOTEMPTY') || hasCode(error, 'EEXIST')) complete = false
      else if (!hasCode(error, 'ENOENT')) throw error
    })
    await this.sync(staging)
    return complete
  }

  async close(): Promise<void> {
    const directory = this.directory
    this.directory = undefined; this.area = 0
    await directory?.close()
  }
}
