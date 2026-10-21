import { isRecord } from '../../../shared/records.js'
import { open, rename, unlink } from 'node:fs/promises'
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, type Stats } from 'node:fs'
import { basename, dirname, join, parse, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

const recordListeners = new Map<string, Set<(path: string) => void>>()

/** In-process invalidation follows the durable write, before its caller can read. */
export function observeRecordWrites(root: string, listener: (path: string) => void): void {
  const absolute = resolve(root)
  let listeners = recordListeners.get(absolute)
  if (!listeners) {
    listeners = new Set()
    recordListeners.set(absolute, listeners)
  }
  listeners.add(listener)
}

function recordWritten(path: string): void {
  const absolute = resolve(path)
  for (let directory = dirname(absolute);;) {
    for (const listener of recordListeners.get(directory) ?? []) listener(absolute)
    const parent = dirname(directory)
    if (parent === directory) return
    directory = parent
  }
}

/** Validate existing storage without creating it or changing its permissions. */
export function existingPrivateDirectory(path: string): boolean {
  const absolute = resolve(path)
  let current = parse(absolute).root
  let stat
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    try { stat = lstatSync(current) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe native observation directory.')
  }
  stat ??= lstatSync(absolute)
  if ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('Nonprivate native observation directory.')
  }
  return true
}

/** These records are backend state, never Agent workspace files or native tool inputs. */
export function privateDirectory(path: string): string {
  const absolute = resolve(path)
  let current = parse(absolute).root
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    try { mkdirSync(current, { mode: 0o700 }); syncDirectory(dirname(current)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const stat = lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Recovery storage cannot contain a symlink or non-directory.')
  }
  const stat = lstatSync(absolute)
  if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('Recovery storage must be owned by this service user and private (0700).')
  }
  return absolute
}

function safeRecordLinks(path: string, fd: number, stat: Stats): boolean {
  if (stat.nlink === 1) return true
  if (stat.nlink !== 2) return false
  const directory = dirname(path)
  if (!existingPrivateDirectory(directory)) return false
  for (const name of readdirSync(directory)) {
    if (name === basename(path) || !/^\.pending-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(name)) continue
    let pending
    try {
      pending = lstatSync(join(directory, name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    // Publishers fsync and close the complete file before linking it into place.
    // Scheduling delays or a crash before unlink do not make that record unsafe.
    if (pending.isFile() && pending.nlink === 2 && pending.dev === stat.dev && pending.ino === stat.ino) return true
  }
  // The publisher can remove its temporary name while the directory is scanned.
  return fstatSync(fd).nlink === 1
}

export function readRecord(path: string): unknown | undefined {
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 64 * 1024 || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid()) || !safeRecordLinks(path, fd, stat)) {
      throw new Error('Unsafe or oversized recovery record.')
    }
    return JSON.parse(readFileSync(fd, 'utf8')) as unknown
  } finally { closeSync(fd) }
}

export function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

/** fsync the data AND containing directory; an existing immutable record is never overwritten. */
export function writeRecord(path: string, value: unknown, immutable = false): void {
  const directory = privateDirectory(dirname(path))
  const temporary = join(directory, `.pending-${randomUUID()}`)
  const data = JSON.stringify(value)
  if (Buffer.byteLength(data) > 64 * 1024) throw new Error('Recovery record exceeds its size limit.')
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, data); fsyncSync(fd) } finally { closeSync(fd) }
  let failure: unknown
  try {
    if (immutable) linkSync(temporary, path)
    else renameSync(temporary, path)
  } catch (error) { failure = error }
  try { unlinkSync(temporary) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && failure === undefined) failure = error
  }
  if (failure !== undefined) throw failure
  syncDirectory(directory)
  recordWritten(path)
}

/** Bound open descriptors and group sync requests so the journal can commit them together. */
export async function storageBatch<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  for (let offset = 0; offset < items.length; offset += 64) {
    const results = await Promise.allSettled(items.slice(offset, offset + 64).map(work))
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
    if (failures.length) throw new AggregateError(failures, 'Recovery storage batch failed.')
  }
}

export async function syncDirectoryAsync(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

/** Commit file contents before publishing names, then commit names before notifying readers. */
export async function writeRecordBatch(directory: string, records: ReadonlyMap<string, unknown>): Promise<void> {
  if (!records.size) return
  const parent = privateDirectory(directory)
  const pending = [...records].map(([name, value]) => {
    if (basename(name) !== name) throw new Error('Recovery batch records must share one directory.')
    const data = JSON.stringify(value)
    if (Buffer.byteLength(data) > 64 * 1024) throw new Error('Recovery record exceeds its size limit.')
    return { temporary: join(parent, `.pending-${randomUUID()}`), path: join(parent, name), data }
  })
  try {
    // Stage all data before issuing grouped fsyncs; serial write/fsync pairs force a journal wait per record.
    await storageBatch(pending, async ({ temporary, data }) => {
      const handle = await open(temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      try { await handle.writeFile(data) } finally { await handle.close() }
    })
    await storageBatch(pending, async ({ temporary }) => {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_NOFOLLOW)
      try { await handle.sync() } finally { await handle.close() }
    })
    await storageBatch(pending, async ({ temporary, path }) => { await rename(temporary, path) })
    await syncDirectoryAsync(parent)
    for (const { path } of pending) recordWritten(path)
  } catch (error) {
    try {
      await storageBatch(pending, async ({ temporary }) => {
        try { await unlink(temporary) } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError
        }
      })
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Recovery publication and temporary cleanup failed.', { cause: cleanupError })
    }
    throw error
  }
}

export function recordObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Malformed recovery record.')
  return value as Record<string, unknown>
}
