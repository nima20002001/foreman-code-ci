import { basename, dirname, join } from 'node:path'
import { existingPrivateDirectory, readRecord } from './storage.js'

export function archivedRetirement(root: string, ownerKey: string): unknown | undefined {
  const archive = join(root, 'closed')
  if (!existingPrivateDirectory(archive)) return undefined
  return readRecord(join(archive, `${ownerKey}.json`))
}

export function archivedClosure(directory: string, id: string): unknown | undefined {
  const local = join(directory, 'closed')
  if (existingPrivateDirectory(local)) {
    const record = readRecord(join(local, `${id}.json`))
    if (record !== undefined) return record
  }
  const archive = join(dirname(directory), 'closed')
  if (!existingPrivateDirectory(archive)) return undefined
  return readRecord(join(archive, `${basename(directory)}-${id}.json`))
}
