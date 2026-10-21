import { constants } from 'node:fs'
import { open, readdir, type FileHandle } from 'node:fs/promises'
import { anchored, openChildDirectory } from './privateFilesystem.js'
import { withSourceDirectoryParents } from './directoryParents.js'
import { SourceError } from './manifest.js'
import { processSourceEntries } from './entryConcurrency.js'

/** Flush files after all writes finish, then persist directory entries from children to parents. */
export async function syncSourceTree(tree: FileHandle, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await tree.stat()
  const files = new Map<string, string[]>()
  const directories: string[][] = []
  const inventory = async (directory: FileHandle, prefix: string, depth: number): Promise<void> => {
    signal.throwIfAborted()
    for (const entry of await readdir(anchored(directory), { withFileTypes: true })) {
      signal.throwIfAborted()
      const path = `${prefix}${entry.name}`
      if (entry.isDirectory()) {
        const child = await openChildDirectory(directory, entry.name)
        try { await inventory(child, `${path}/`, depth + 1) } finally { await child.close() }
        const level = directories[depth] ??= []
        level.push(path)
      } else if (entry.isFile()) {
        const group = files.get(prefix) ?? []
        group.push(path)
        files.set(prefix, group)
      } else {
        throw new SourceError('SOURCE_TREE_INVALID', 'Source synchronization requires private regular files.')
      }
    }
  }
  await inventory(tree, '', 0)
  await withSourceDirectoryParents(tree, false, async parentForPath => {
    await processSourceEntries([...files.values()], async paths => {
      const parent = await parentForPath(paths[0]!)
      try {
        for (const path of paths) {
          signal.throwIfAborted()
          const file = await open(anchored(parent, path.slice(path.lastIndexOf('/') + 1)),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOATIME)
          try {
            const stat = await file.stat()
            if (!stat.isFile() || stat.nlink !== 1) {
              throw new SourceError('SOURCE_TREE_INVALID', 'Source synchronization requires unlinked regular files.')
            }
            await file.sync()
          } finally { await file.close() }
        }
      } finally { await parent.close() }
    }, signal)
    for (const level of directories.reverse()) {
      await processSourceEntries(level, async path => {
        signal.throwIfAborted()
        const directory = await parentForPath(`${path}/entry`)
        try { await directory.sync() } finally { await directory.close() }
      }, signal)
    }
  })
  signal.throwIfAborted()
  await tree.sync()
  signal.throwIfAborted()
}
