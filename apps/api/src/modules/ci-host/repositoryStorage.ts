import { lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { withHostCiRunLock } from './runnerLock.js'

async function children(path: string) {
  try { return await readdir(path, { withFileTypes: true }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function storageUsage(path: string): Promise<{ bytes: number; usedAt: number }> {
  const info = await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (!info) return { bytes: 0, usedAt: 0 }
  if (!info.isDirectory()) return { bytes: info.size, usedAt: Math.max(info.atimeMs, info.mtimeMs) }
  let bytes = 0
  let usedAt = 0
  for (const child of await children(path)) {
    const usage = await storageUsage(join(path, child.name))
    bytes += usage.bytes
    usedAt = Math.max(usedAt, usage.usedAt)
  }
  return { bytes, usedAt }
}

async function repositoryContents(root: string, repository: string) {
  const paths: string[] = []
  for (const area of ['git', 'slots']) {
    const path = join(root, area, ...repository.split('/'))
    for (const child of await children(path)) paths.push(join(path, child.name))
  }
  return paths
}

export async function ciRepositoryStorageEntries(root: string) {
  const repositories = new Set<string>()
  for (const area of ['git', 'slots']) {
    for (const owner of await children(join(root, area))) {
      if (!owner.isDirectory()) continue
      for (const repository of await children(join(root, area, owner.name))) {
        if (repository.isDirectory()) repositories.add(`${owner.name}/${repository.name}`)
      }
    }
  }
  const entries = []
  for (const repository of repositories) {
    let bytes = 0
    let usedAt = 0
    for (const path of await repositoryContents(root, repository)) {
      const usage = await storageUsage(path)
      bytes += usage.bytes
      usedAt = Math.max(usedAt, usage.usedAt)
    }
    entries.push({ path: join(root, 'git', ...repository.split('/')), repository, bytes, usedAt,
      repositoryStorage: true as const })
  }
  return entries
}

async function repositoryHasActiveRun(root: string, repository: string) {
  for (const run of await children(join(root, 'runs'))) {
    if (!run.isDirectory()) continue
    const text = await readFile(join(root, 'runs', run.name, 'meta.json'), 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (!text) continue
    const meta = JSON.parse(text) as { repository: string; state: string }
    if (meta.repository === repository && ['starting', 'running'].includes(meta.state)) return true
  }
  return false
}

/** Slot checkouts depend on the clone's objects; reclaim both only while the whole repository is idle. */
export async function reclaimCiRepositoryStorage(root: string,
  entry: { path: string; repository: string; usedAt: number },
  activeRepositories: () => ReadonlySet<string>): Promise<string[] | undefined> {
  if (activeRepositories().has(entry.repository)) return
  const cache = join(root, 'cache', ...entry.repository.split('/'))
  await mkdir(cache, { recursive: true, mode: 0o700 })
  await mkdir(entry.path, { recursive: true, mode: 0o700 })
  return withHostCiRunLock(cache, () => withHostCiRunLock(entry.path, async () => {
    // Persisted admissions cover another runner's gap between checkout and native cache-lock acquisition.
    if (activeRepositories().has(entry.repository) || await repositoryHasActiveRun(root, entry.repository)) return
    const paths = await repositoryContents(root, entry.repository)
    for (const path of paths) {
      if ((await storageUsage(path)).usedAt > entry.usedAt) return
    }
    for (const path of paths) await rm(path, { recursive: true, force: true })
    // Keep lock directory inodes stable for waiters that opened them before this sweep.
    return paths
  }, { nonBlocking: true }), { nonBlocking: true })
}
