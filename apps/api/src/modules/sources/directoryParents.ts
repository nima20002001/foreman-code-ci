import type { FileHandle } from 'node:fs/promises'
import { entryParent, openChildDirectory } from './privateFilesystem.js'

/** Reuse up to 128 pinned ancestors within one joined tree operation. Leaf handles remain caller-owned. */
export async function withSourceDirectoryParents<Result>(tree: FileHandle, create: boolean,
  work: (parent: (path: string) => Promise<FileHandle>) => Promise<Result>): Promise<Result> {
  const ancestors = new Map<string, Promise<FileHandle>>()
  const parent = async (path: string): Promise<FileHandle> => {
    const components = path.split('/')
    components.pop()
    if (!components.length) return (await entryParent(tree, path, create)).parent
    let directory = tree
    let prefix = ''
    for (let index = 0; index < components.length - 1; index++) {
      const component = components[index]!
      prefix += `${component}/`
      let opened = ancestors.get(prefix)
      if (!opened) {
        if (ancestors.size >= 128) {
          return (await entryParent(directory, path.slice(prefix.length - component.length - 1), create)).parent
        }
        opened = openChildDirectory(directory, component, create)
        ancestors.set(prefix, opened)
      }
      directory = await opened
    }
    return openChildDirectory(directory, components.at(-1)!, create)
  }
  let outcome: { result: Result } | { error: unknown }
  try {
    outcome = { result: await work(parent) }
  } catch (error) {
    outcome = { error }
  }
  const opened = await Promise.allSettled(ancestors.values())
  const closed = await Promise.allSettled(opened.map(async result => {
    if (result.status === 'fulfilled') await result.value.close()
  }))
  if ('error' in outcome) throw outcome.error
  const failures = closed.filter(result => result.status === 'rejected')
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Source parent closure failed.')
  return outcome.result
}
