import { lstat, readdir, rm } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { withHostCiRunLock } from './runnerLock.js'
import { ciRepositoryStorageEntries, reclaimCiRepositoryStorage } from './repositoryStorage.js'
import { pnpmFetchRecord } from './warmSetup.js'

export const CI_HOST_CACHE_BUDGET_BYTES = 3 * 2 ** 30
interface CacheEntry { path: string; bytes: number; usedAt: number; repository: string; repositoryStorage?: true }

async function directories(path: string) {
  try { return await readdir(path, { withFileTypes: true }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function cacheEntries(path: string, repository: string): Promise<CacheEntry[]> {
  const entries: CacheEntry[] = []
  for (const child of await directories(path)) {
    if (child.isSymbolicLink() || child.name === 'locks' || child.name.endsWith('.lock')) continue
    const childPath = join(path, child.name)
    if (child.isDirectory()) {
      const contents = await cacheEntries(childPath, repository)
      // A contracts snapshot is restored as a whole; partial eviction would make it invalid.
      if (path.endsWith(`${sep}contracts`)) {
        entries.push({ path: childPath, repository, bytes: contents.reduce((sum, entry) => sum + entry.bytes, 0),
          usedAt: contents.reduce((latest, entry) => Math.max(latest, entry.usedAt), 0) })
      } else {
        for (const entry of contents) entries.push(entry)
      }
    } else if (child.isFile()) {
      const info = await lstat(childPath).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (!info) continue
      entries.push({ path: childPath, repository, bytes: info.size, usedAt: Math.max(info.atimeMs, info.mtimeMs) })
    }
  }
  return entries
}

async function cacheUsedSinceScan(entry: CacheEntry): Promise<boolean> {
  const info = await lstat(entry.path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (!info) return false
  if (info.isDirectory()) {
    const contents = await cacheEntries(entry.path, entry.repository)
    return contents.some(file => file.usedAt > entry.usedAt)
  }
  return Math.max(info.atimeMs, info.mtimeMs) > entry.usedAt
}

/** Refillable caches, clones and idle slot checkouts share one budget; active repositories keep their storage. */
export async function sweepHostCiCache(root: string, options: {
  activeRepositories: () => ReadonlySet<string>
  budgetBytes?: number
}): Promise<string[]> {
  const cache = join(root, 'cache')
  const entries: CacheEntry[] = []
  for (const owner of await directories(cache)) {
    if (!owner.isDirectory()) continue
    const ownerPath = join(cache, owner.name)
    for (const repository of await directories(ownerPath)) {
      if (!repository.isDirectory()) continue
      const path = join(ownerPath, repository.name)
      for (const entry of await cacheEntries(path, relative(cache, path).split(sep).join('/'))) {
        entries.push(entry)
      }
    }
  }
  entries.push(...await ciRepositoryStorageEntries(root))
  let bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  const budget = options.budgetBytes ?? CI_HOST_CACHE_BUDGET_BYTES
  const removed: string[] = []
  entries.sort((left, right) => left.usedAt - right.usedAt || left.path.localeCompare(right.path))
  const pending = entries.filter(entry => !options.activeRepositories().has(entry.repository))
  let cursor = 0
  while (bytes > budget && cursor < pending.length) {
    const batches = new Map<string, CacheEntry[]>()
    let plannedBytes = bytes
    while (plannedBytes > budget && cursor < pending.length) {
      const entry = pending[cursor++]!
      const batch = batches.get(entry.repository) ?? []
      batch.push(entry)
      batches.set(entry.repository, batch)
      plannedBytes -= entry.bytes
    }
    for (const [repository, batch] of batches) {
      for (const entry of batch.filter(entry => entry.repositoryStorage)) {
        const paths = await reclaimCiRepositoryStorage(root, entry, options.activeRepositories)
        if (paths) {
          bytes -= entry.bytes
          removed.push(...paths)
        }
      }
      const cacheBatch = batch.filter(entry => !entry.repositoryStorage)
      if (!cacheBatch.length) continue
      const repositoryCache = join(cache, ...repository.split('/'))
      await withHostCiRunLock(repositoryCache, async () => {
        if (options.activeRepositories().has(repository)) return
        let prefetchInvalidated = false
        for (const entry of cacheBatch) {
          if (await cacheUsedSinceScan(entry)) continue
          if (!prefetchInvalidated && ['pnpm-store', 'pnpm-metadata']
            .some(directory => entry.path.startsWith(join(repositoryCache, directory) + sep))) {
            await rm(pnpmFetchRecord(repositoryCache), { force: true })
            prefetchInvalidated = true
          }
          await rm(entry.path, { recursive: true, force: true })
          bytes -= entry.bytes
          removed.push(entry.path)
        }
      }, { nonBlocking: true })
    }
  }
  return removed
}
