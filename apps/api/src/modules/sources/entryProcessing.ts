import type { SourceEntry } from '@foreman-code/contracts/source-materialization'
import type { FileHandle } from 'node:fs/promises'
import { entryParent } from './privateFilesystem.js'
import { SOURCE_LIMITS, SourceError, sourcePath } from './manifest.js'
import { syncSourceTree } from './sourceTreeSync.js'
import { withSourceDirectoryParents } from './directoryParents.js'
import type { SourceFileWriter } from './sourceFileWriter.js'

import { processSourceEntries } from './entryConcurrency.js'
export { processSourceEntries } from './entryConcurrency.js'

/** Each worker retains one qualified parent and processes one file at a time. */
export async function processSourceDirectories(
  tree: FileHandle,
  entries: readonly SourceEntry[],
  work: (parent: FileHandle, entries: readonly SourceEntry[]) => Promise<void>,
  options: { create?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  const directories = new Map<string, SourceEntry[]>()
  for (const entry of entries) {
    const directory = entry.path.slice(0, entry.path.lastIndexOf('/') + 1)
    const group = directories.get(directory) ?? []
    group.push(entry)
    directories.set(directory, group)
  }
  await withSourceDirectoryParents(tree, options.create ?? false, async parentForPath => {
    await processSourceEntries([...directories.values()], async group => {
      const parent = await parentForPath(group[0]!.path)
      try {
        await work(parent, group)
      } finally { await parent.close() }
    }, options.signal)
  })
  if (options.create) await syncSourceTree(tree, options.signal ?? AbortSignal.timeout(SOURCE_LIMITS.preparationMs))
}

/** Git emits files in tree order; parents remain open until their last write is joined. */
export async function withSourceTreeWriter<Result>(
  tree: FileHandle,
  paths: readonly string[],
  work: (write: (entry: SourceEntry, bytes: Uint8Array) => Promise<void>) => Promise<Result>,
  writer: Pick<SourceFileWriter, 'write' | 'finish'>,
  signal: AbortSignal,
): Promise<Result> {
  const expected = new Set(paths.map(sourcePath))
  const directories = new Map<string, {
    remaining: number
    parent?: Promise<FileHandle>
    opened?: FileHandle
  }>()
  for (const path of expected) {
    const name = path.slice(0, path.lastIndexOf('/') + 1)
    const directory = directories.get(name) ?? { remaining: 0 }
    directory.remaining++
    directories.set(name, directory)
  }
  let outcome: { result: Result } | { error: unknown }
  try {
    const result = await work(async (entry, bytes) => {
      signal.throwIfAborted()
      if (!expected.delete(entry.path)) throw new SourceError('SOURCE_PATH_INVALID', 'Unexpected source write.')
      const name = entry.path.slice(0, entry.path.lastIndexOf('/') + 1)
      const directory = directories.get(name)!
      directory.parent ??= entryParent(tree, entry.path, true).then(value => {
        directory.opened = value.parent
        return value.parent
      })
      const parent = await directory.parent
      try {
        await writer.write(parent, entry, bytes)
      } finally {
        if (--directory.remaining === 0) {
          delete directory.parent
          delete directory.opened
          await parent.close()
        }
      }
    })
    signal.throwIfAborted()
    if (expected.size) throw new SourceError('SOURCE_TREE_INVALID', 'Source writes are incomplete.')
    outcome = { result }
  } catch (error) {
    outcome = { error }
  }
  // The capture joins its writers before returning, including on cancellation.
  const closed = await Promise.allSettled([...directories.values()].map(async directory => {
    if (directory.opened) await directory.opened.close()
  }))
  if ('error' in outcome) throw outcome.error
  const failures = closed.filter(result => result.status === 'rejected')
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Source directory closure failed.')
  await writer.finish()
  return outcome.result
}
