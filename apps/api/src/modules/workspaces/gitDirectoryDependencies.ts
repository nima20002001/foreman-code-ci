import { lstat, readFile, readlink, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { logIgnoredError } from '../diagnostics/ignoredError.js'

type DirectoryDiscovery =
  | { status: 'complete'; paths: string[] }
  | { status: 'incomplete'; paths: string[]; error: unknown }

function missingMetadata(error: unknown): undefined {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
  throw error
}

/** Missing metadata still names a dependency; resolve its existing ancestors and symlink targets. */
async function canonicalDependencyPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    missingMetadata(error)
  }
  const parent = dirname(path)
  const details = await lstat(path).catch(missingMetadata)
  if (details?.isSymbolicLink()) {
    return canonicalDependencyPath(resolve(parent, await readlink(path)))
  }
  return join(await canonicalDependencyPath(parent), basename(path))
}

async function collectGitDirectories(root: string, dependencies: Set<string>): Promise<void> {
  let directory = root
  for (;;) {
    const marker = join(directory, '.git')
    const details = await lstat(marker).catch(missingMetadata)
    if (details) {
      dependencies.add(marker)
      dependencies.add(await canonicalDependencyPath(marker))
      const target = details.isSymbolicLink() ? await stat(marker).catch(missingMetadata) : details
      let gitDirectory = marker
      if (target?.isFile()) {
        const content = await readFile(marker, 'utf8')
        if (!content.startsWith('gitdir: ') || !content.slice(8).trimEnd()) {
          throw new Error('The worktree Git directory reference is invalid.')
        }
        gitDirectory = resolve(directory, content.slice(8).trimEnd())
      }
      dependencies.add(gitDirectory)
      gitDirectory = await canonicalDependencyPath(gitDirectory)
      dependencies.add(gitDirectory)
      const common = await readFile(join(gitDirectory, 'commondir'), 'utf8').catch(missingMetadata)
      if (common !== undefined) {
        if (!common.trimEnd()) throw new Error('The worktree Git common-directory reference is empty.')
        const commonDirectory = resolve(gitDirectory, common.trimEnd())
        dependencies.add(commonDirectory)
        dependencies.add(await canonicalDependencyPath(commonDirectory))
      }
      return
    }
    const parent = dirname(directory)
    if (parent === directory) return
    directory = parent
  }
}

async function discoverGitDirectories(path: string): Promise<DirectoryDiscovery> {
  const dependencies = new Set([path, resolve(path)])
  try {
    const root = await canonicalDependencyPath(resolve(path))
    dependencies.add(root)
    await collectGitDirectories(root, dependencies)
    return { status: 'complete', paths: [...dependencies] }
  } catch (error) {
    // A damaged reference must retain the paths found before discovery failed.
    return { status: 'incomplete', paths: [...dependencies], error }
  }
}

/** Git metadata paths remain protected even when Git cannot open the repository. */
export async function withGitDirectoryDependencies(paths: string[]): Promise<string[]> {
  const dependencies = new Set(paths.filter(Boolean))
  for (const path of [...dependencies]) {
    const discovery = await discoverGitDirectories(path)
    for (const directory of discovery.paths) dependencies.add(directory)
    if (discovery.status === 'incomplete') {
      logIgnoredError('lifecycle', 'discover retained Git directory dependencies', discovery.error,
        { path, retainedPaths: discovery.paths })
    }
  }
  return [...dependencies]
}
