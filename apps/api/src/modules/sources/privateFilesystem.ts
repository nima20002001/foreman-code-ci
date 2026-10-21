import { constants, readFileSync, type BigIntStats } from 'node:fs'
import { spawn } from 'node:child_process'
import { open, mkdir, lstat, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { SourceError } from './manifest.js'
import { DomainError } from '../errors.js'

export const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
export function anchored(handle: FileHandle, name = ''): string { return `/proc/self/fd/${handle.fd}${name ? `/${name}` : ''}` }

/** The inherited open file description keeps the lock after flock exits, until its final holder closes. */
export async function lockOpenFile(file: FileHandle,
  options: { nonBlocking?: boolean; signal?: AbortSignal | undefined } = {}): Promise<boolean> {
  options.signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/flock', ['--exclusive', ...(options.nonBlocking ? ['--nonblock'] : []), '3'], {
      stdio: ['ignore', 'ignore', 'ignore', file.fd],
      ...(options.signal ? { signal: options.signal } : {}),
    })
    let failure: Error | undefined
    child.once('error', error => { failure = error })
    child.once('close', code => {
      if (options.signal?.aborted) reject(options.signal.reason)
      else if (failure) reject(failure)
      else if (code === 0) resolve(true)
      else if (options.nonBlocking && code === 1) resolve(false)
      else reject(new SourceError('SOURCE_CLAIM_LOCK_FAILED', 'Source ownership serialization failed.'))
    })
  })
}

/** Lock the pinned directory inode across processes, until the guard closes. */
export async function withPrivateDirectoryLock<T>(root: FileHandle, work: (guard: FileHandle) => Promise<T>,
  options: { nonBlocking?: boolean; signal?: AbortSignal | undefined } = {}): Promise<T> {
  const guard = await open(anchored(root), constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    if (!await lockOpenFile(guard, options)) {
      throw new SourceError('SOURCE_CLAIM_LOCK_FAILED', 'Source ownership serialization failed.')
    }
    options.signal?.throwIfAborted()
    return await work(guard)
  } finally { await guard.close() }
}
// An open handle pins its device, inode and mount until it closes. Ownership
// and permissions are deliberately checked afresh by each directory guard.
const identities = new WeakMap<FileHandle, Promise<{ device: string; inode: string; mountId: string }>>()
async function readIdentity(handle: FileHandle, checkedStat?: BigIntStats): Promise<{ device: string; inode: string; mountId: string }> {
  // procfs is bounded kernel metadata, not source/disk bytes. Read it without
  // four thread-pool round trips for every freshly opened directory handle.
  const info = readFileSync(`/proc/self/fdinfo/${handle.fd}`, 'utf8'), stat = checkedStat ?? await handle.stat({ bigint: true })
  const mountId = /^mnt_id:\s*(\d+)$/m.exec(info)?.[1]
  if (!mountId) throw new DomainError('SOURCE_FILESYSTEM_UNSUPPORTED', 'Linux mount identity cannot be qualified.', 422)
  return Object.freeze({ device: stat.dev.toString(), inode: stat.ino.toString(), mountId })
}
function cachedIdentity(handle: FileHandle, checkedStat?: BigIntStats): Promise<{ device: string; inode: string; mountId: string }> {
  if (handle.fd < 0) return readIdentity(handle)
  let pending = identities.get(handle)
  if (!pending) { pending = readIdentity(handle, checkedStat); identities.set(handle, pending) }
  return pending
}
export function identity(handle: FileHandle): Promise<{ device: string; inode: string; mountId: string }> { return cachedIdentity(handle) }

type DirectoryIdentity = Awaited<ReturnType<typeof identity>>
interface RootValidation {
  ancestors: Array<{ path: string; metadata: string }>
  identity: DirectoryIdentity
}
const validatedRoots = new Map<string, RootValidation>()
function directoryMetadata(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.uid, stat.mode].join(':')
}
async function reopenValidatedRoot(path: string, key: string): Promise<FileHandle | null> {
  const cached = validatedRoots.get(key)
  if (!cached) return null
  try {
    const ancestors = await Promise.all(cached.ancestors.map(entry => lstat(entry.path, { bigint: true })))
    if (ancestors.some((stat, index) => !stat.isDirectory()
      || directoryMetadata(stat) !== cached.ancestors[index]!.metadata)) {
      validatedRoots.delete(key)
      return null
    }
    const root = await open(path, directoryFlags)
    try {
      const stat = await root.stat({ bigint: true })
      const current = await cachedIdentity(root, stat)
      if (directoryMetadata(stat) === cached.ancestors.at(-1)!.metadata
        && JSON.stringify(current) === JSON.stringify(cached.identity)) return root
    } catch (error) {
      await root.close()
      throw error
    }
    await root.close()
    validatedRoots.delete(key)
    return null
  } catch (error) {
    validatedRoots.delete(key)
    throw error
  }
}
/** Linux procfs anchors every operation to an open directory, including ancestors.
 * The app-private root must exclude other principals; same-UID hostile processes
 * are outside this filesystem qualification, not secured by leaf O_NOFOLLOW.
 */
export async function openPrivateRoot(path: string, privateOnly = true): Promise<FileHandle> {
  if (process.platform !== 'linux' || !isAbsolute(path) || path !== await realpath(path))
    throw new DomainError('SOURCE_FILESYSTEM_UNSUPPORTED', 'An approved canonical Linux private root is required.', 422)
  const key = `${process.getuid?.()}:${privateOnly}:${path}`
  // Recheck ancestor replacement/permissions and the opened mount on every read,
  // but walk open directory handles only when their validation changes.
  const cached = await reopenValidatedRoot(path, key)
  if (cached) return cached
  const ancestors: RootValidation['ancestors'] = []
  let parentPath = '/'
  let parent = await open('/', directoryFlags)
  try {
    for (const component of path.split('/').filter(Boolean)) {
      const ancestor = await parent.stat({ bigint: true })
      ancestors.push({ path: parentPath, metadata: directoryMetadata(ancestor) })
      if ((ancestor.uid !== 0n && ancestor.uid !== BigInt(process.getuid?.() ?? -1))
        || ((ancestor.mode & 0o022n) !== 0n && (ancestor.mode & 0o1000n) === 0n))
        throw new DomainError('SOURCE_FILESYSTEM_UNSUPPORTED', 'Root ancestors must exclude replacement by other principals.', 422)
      const child = await open(anchored(parent, component), directoryFlags)
      if ((ancestor.mode & 0o022n) !== 0n && (await child.stat()).uid !== process.getuid?.()) {
        await child.close(); throw new DomainError('SOURCE_FILESYSTEM_UNSUPPORTED', 'Sticky-directory entries must be owned by this worker.', 422)
      }
      await parent.close(); parent = child
      parentPath = join(parentPath, component)
    }
    const stat = await parent.stat({ bigint: true })
    const privateMode = (stat.mode & 0o077n) === 0n && (stat.mode & 0o700n) === 0o700n
    const protectedMode = (stat.mode & 0o022n) === 0n && (stat.mode & 0o500n) === 0o500n
    if (stat.uid !== BigInt(process.getuid?.() ?? -1) || !(privateOnly ? privateMode : protectedMode))
      throw new SourceError('SOURCE_ROOT_NOT_PRIVATE', privateOnly ? 'The approved root must be owned by this worker with mode 0700.' : 'The approved base must be worker-owned and protected from other writers.')
    const current = await open(path, directoryFlags)
    try {
      const [currentIdentity, parentIdentity] = await Promise.all([identity(current), cachedIdentity(parent, stat)])
      if (JSON.stringify(currentIdentity) !== JSON.stringify(parentIdentity)) throw new SourceError('SOURCE_ROOT_CHANGED', 'Root changed during validation.')
      ancestors.push({ path, metadata: directoryMetadata(stat) })
      if (validatedRoots.size >= 128) validatedRoots.delete(validatedRoots.keys().next().value!)
      validatedRoots.set(key, { ancestors, identity: parentIdentity })
    }
    finally { await current.close() }
    return parent
  } catch (error) { await parent.close(); throw error }
}
export async function openChildDirectory(parent: FileHandle, name: string, create = false): Promise<FileHandle> {
  if (create) { try { await mkdir(anchored(parent, name), { mode: 0o700 }) } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error } }
  const child = await open(anchored(parent, name), directoryFlags)
  const stat = await child.stat({ bigint: true })
  if (stat.uid !== BigInt(process.getuid?.() ?? -1) || (stat.mode & 0o077n) !== 0n) { await child.close(); throw new SourceError('SOURCE_DIRECTORY_NOT_PRIVATE', 'Materialization parents must be private worker directories.') }
  try {
    const [parentIdentity, childIdentity] = await Promise.all([identity(parent), cachedIdentity(child, stat)])
    if (parentIdentity.device !== childIdentity.device || parentIdentity.mountId !== childIdentity.mountId)
      throw new SourceError('SOURCE_MOUNT_CHANGED', 'Source entries cannot cross a filesystem or mount boundary.')
    return child
  } catch (error) { await child.close(); throw error }
}
export async function entryParent(root: FileHandle, path: string, create: boolean): Promise<{ parent: FileHandle; leaf: string }> {
  const components = path.split('/'); const leaf = components.pop()!
  // Borrow the caller's qualified handle for the first descent instead of
  // reopening and qualifying the same inode. The returned parent is owned here.
  let parent = root
  try {
    for (const component of components) {
      const child = await openChildDirectory(parent, component, create)
      if (parent !== root) await parent.close()
      parent = child
    }
    if (parent === root) parent = await open(anchored(root), directoryFlags & ~constants.O_NOFOLLOW)
    return { parent, leaf }
  } catch (error) { if (parent !== root) await parent.close(); throw error }
}
