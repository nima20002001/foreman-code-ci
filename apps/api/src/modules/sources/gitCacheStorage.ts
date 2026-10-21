import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, statfs, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { SOURCE_GIT_CACHE_LIMITS, GitCacheStorageSchema, type GitCacheStorage }
  from '@foreman-code/contracts/source-materialization'
import { DomainError } from '../errors.js'
import { anchored, identity, lockOpenFile, openPrivateRoot, withPrivateDirectoryLock } from './privateFilesystem.js'
import { measureRetainedDirectory } from './retainedDirectoryUsage.js'
import { writeSourceClaim } from './quotaClaims.js'
import { SourceError } from './manifest.js'
import type { GitProcessOptions, GitProcessResult } from './gitProcess.js'
import { awaitFetchLocks, removeAbandonedFetchArtifacts } from './gitFetchRecovery.js'

type GitRunner = (args: string[], options: GitProcessOptions) => Promise<GitProcessResult>

function commandIndex(args: string[]): number {
  let index = 0
  while (args[index]?.startsWith('-')) {
    index += ['-c', '-C', '--git-dir', '--work-tree'].includes(args[index]!) ? 2 : 1
  }
  return index
}

function fetchDestinationRefs(args: string[], index: number): string[] {
  return args.slice(index + 1).flatMap(arg => {
    const match = /^\+?[^\s:-][^\s:]*:(refs\/[^\s:*?]+)$/u.exec(arg)
    return match ? [match[1]!] : []
  })
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || !suffix.startsWith('..') && !isAbsolute(suffix)
}

async function writeStorage(root: FileHandle, storage: GitCacheStorage): Promise<void> {
  const name = `storage-${randomUUID()}.pending`
  await writeSourceClaim(root, name, JSON.stringify(GitCacheStorageSchema.parse(storage)))
  await rename(anchored(root, name), anchored(root, 'storage.json'))
  await root.sync()
}

async function measureStorage(root: FileHandle, signal?: AbortSignal): Promise<GitCacheStorage> {
  const filesystem = await identity(root)
  for (;;) {
    signal?.throwIfAborted()
    let retainedBytes: number
    try {
      retainedBytes = await measureRetainedDirectory(root, filesystem)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // Clone publication and cleanup can rename or remove staging entries outside the transfer lock.
      // Rescan the whole cache so published bytes are still counted under their new names.
      continue
    }
    const disk = await statfs(anchored(root), { bigint: true })
    return GitCacheStorageSchema.parse({ version: 1, filesystem, retainedBytes,
      reservedBytes: 0, limitBytes: Math.min(SOURCE_GIT_CACHE_LIMITS.bytes, Number(disk.blocks * disk.bsize / 4n)),
      availableBytes: Number(disk.bavail * disk.bsize), observedAt: new Date().toISOString() })
  }
}

function boundedArgs(args: string[], index: number, fetchDepth: string[]): string[] {
  const command = args[index]!
  const flags = command === 'clone'
    ? ['--no-local', '--no-checkout', '--depth=1', '--single-branch', '--no-tags']
    : ['--no-auto-maintenance', '--recurse-submodules=no',
      ...(args.slice(index + 1).includes('origin') ? fetchDepth : [])]
  // A single pack and its index fit the reserved transfer budget under the inherited per-file kernel limit.
  return ['-c', 'fetch.unpackLimit=1', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
    '-c', 'fetch.writeCommitGraph=false', '-c', 'pack.writeReverseIndex=false', '-c', 'fetch.uriprotocols=',
    ...args.slice(0, index + 1), ...flags, ...args.slice(index + 1)]
}

/** Start time of a process, so a reused process id is not mistaken for the reservation's owner. */
async function processStart(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null
    throw error
  }
}

/** Preserve the Git cache's public error code for flock failures. */
async function lockTransfer(file: FileHandle, options: { nonBlocking?: boolean } = {}): Promise<boolean> {
  try {
    return await lockOpenFile(file, options)
  } catch (error) {
    if (error instanceof SourceError && error.code === 'SOURCE_CLAIM_LOCK_FAILED') {
      throw new DomainError('SOURCE_GIT_CACHE_INVALID', 'Git transfer ownership locking failed.', 409, undefined,
        { cause: error })
    }
    throw error
  }
}

type TransferOwner = { pid?: unknown; started?: unknown; lifetimeLock?: unknown; staging?: unknown; fetch?: unknown }

async function removeAbandonedStaging(root: FileHandle, owner: TransferOwner): Promise<void> {
  if (owner.staging === undefined) return
  const cache = await realpath(anchored(root))
  if (typeof owner.staging !== 'string' || owner.staging === cache || !inside(cache, owner.staging)) {
    throw new DomainError('SOURCE_GIT_CACHE_INVALID', 'Git transfer staging is outside its cache.', 409)
  }
  await rm(owner.staging, { recursive: true, force: true })
}

/** The storage lock is held; only closed transfers can lose their charge or abandoned staging. */
async function liveReservations(root: FileHandle): Promise<number> {
  let live = 0
  for (const name of await readdir(anchored(root))) {
    if (!/^transfer-.+\.(?:reservation|staging)$/u.test(name)) continue
    const file = await open(anchored(root, name), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      let owner: TransferOwner = {}
      try { owner = JSON.parse(await file.readFile('utf8')) as TransferOwner }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        // An interrupted write cannot have launched a Git child.
      }
      const running = typeof owner.pid === 'number' && await processStart(owner.pid) === owner.started
      const active = owner.lifetimeLock === true
        ? running || !await lockTransfer(file, { nonBlocking: true })
        : running
      if (active && name.endsWith('.staging')) {
        // Completed clones keep recovery records until publication or removal; their writers no longer reserve bytes.
        if (typeof owner.staging !== 'string') {
          throw new DomainError('SOURCE_GIT_CACHE_INVALID', 'Git clone staging is unavailable.', 409)
        }
        try { await lstat(owner.staging) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          await rm(anchored(root, name), { force: true })
        }
      } else if (active) live++
      else if (owner.fetch === undefined) {
        await removeAbandonedStaging(root, owner)
        await rm(anchored(root, name), { force: true })
      }
    } finally { await file.close() }
  }
  return live
}

/** The storage lock is held while recovering and reserving this transfer's footprint. */
async function reserveTransfer(root: FileHandle, signal: AbortSignal,
  paths: { staging?: string; fetch?: string }): Promise<{ name: string; guard: FileHandle }> {
  const name = `transfer-${randomUUID()}.reservation`
  const reservedBytes = SOURCE_GIT_CACHE_LIMITS.transferBytes
  const active = await liveReservations(root) * reservedBytes
  const measured = await measureStorage(root, signal)
  const margin = Math.max(SOURCE_GIT_CACHE_LIMITS.diskMarginBytes, Math.ceil(measured.availableBytes * 0.1))
  await writeStorage(root, { ...measured, reservedBytes: active })
  if (measured.retainedBytes + active + reservedBytes > measured.limitBytes
    || active + reservedBytes + margin > measured.availableBytes) {
    throw new DomainError('SOURCE_GIT_CACHE_CAPACITY',
      'The Git cache has insufficient storage for this transfer. Free cache filesystem space, then retry.',
      409, { retryable: true, newCommandRequired: false, storage: measured, reservedBytes })
  }
  // A fetch record is charged only while its lock is held, so one awaiting recovery outlives its API process.
  const owner = paths.fetch ? {} : { pid: process.pid, started: await processStart(process.pid) }
  await writeSourceClaim(root, name, JSON.stringify({ ...owner, lifetimeLock: true, ...paths }))
  const guard = await open(anchored(root, name), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    await lockTransfer(guard)
    await writeStorage(root, { ...measured, reservedBytes: active + reservedBytes })
    return { name, guard }
  } catch (error) {
    await guard.close()
    throw error
  }
}

/** Another repository's fetch writers hold its lock for their whole lives; a free lock proves they are gone. */
async function recoverUnlockedRepository(common: string): Promise<boolean> {
  let repository: FileHandle
  try { repository = await open(common, constants.O_RDONLY | constants.O_DIRECTORY) }
  catch (error) {
    // A removed repository has no fetch artifacts left.
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return true
    throw error
  }
  try {
    return await lockTransfer(repository, { nonBlocking: true })
      && (await removeAbandonedFetchArtifacts(common)).length === 0
  } finally { await repository.close() }
}

/** The storage lock is held. Fetch records are recovered under their own repository's lock (already `held` for the
 * requesting fetch), across the whole cache because every repository shares its capacity. */
async function recoverFetches(root: FileHandle, held?: string): Promise<void> {
  for (const name of await readdir(anchored(root))) {
    if (!/^transfer-.+\.reservation$/u.test(name)) continue
    const file = await open(anchored(root, name), constants.O_RDONLY | constants.O_NOFOLLOW)
    let owner: TransferOwner
    try { owner = JSON.parse(await file.readFile('utf8')) as TransferOwner }
    catch (error) {
      // An interrupted write cannot have launched a Git child; capacity scans remove it.
      if (error instanceof SyntaxError) continue
      throw error
    } finally { await file.close() }
    const common = owner.fetch
    if (typeof common !== 'string' || !isAbsolute(common) || owner.lifetimeLock !== true) continue
    if (common === held ? (await removeAbandonedFetchArtifacts(common)).length === 0
      : await recoverUnlockedRepository(common)) {
      await rm(anchored(root, name), { force: true })
    }
  }
}

async function closeTransferWriters(root: FileHandle,
  reservation: { name: string; guard: FileHandle }): Promise<FileHandle> {
  // Open independently before dropping our inherited description, then wait outside the storage lock.
  const closed = await open(anchored(root, reservation.name), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    await reservation.guard.close()
    await lockTransfer(closed)
    return closed
  } catch (error) {
    await closed.close()
    throw error
  }
}

async function releaseTransfer(root: FileHandle, name: string,
  keep: { staging?: string | undefined; recovery?: boolean }): Promise<void> {
  if (keep.staging) {
    // Renaming preserves crash recovery while ensureClone still owns unpublished staging.
    await rename(anchored(root, name), anchored(root, name.replace(/\.reservation$/u, '.staging')))
    await root.sync()
  } else if (!keep.recovery) {
    await rm(anchored(root, name), { force: true })
  }
  const reservedBytes = await liveReservations(root) * SOURCE_GIT_CACHE_LIMITS.transferBytes
  const measured = await measureStorage(root)
  await writeStorage(root, { ...measured, reservedBytes })
}

type StorageLock = <T>(work: () => Promise<T>, options?: { signal?: AbortSignal }) => Promise<T>
interface CacheTransfer {
  root: FileHandle; cacheRoot: string; args: string[]; index: number; command: string; target: string; common: string
  createdTarget: boolean; options: GitProcessOptions; run: GitRunner; lockFd?: number
}

async function runReservedTransfer(input: CacheTransfer, lockStorage: StorageLock): Promise<GitProcessResult> {
  const { root, cacheRoot, args, index, command, target, common, createdTarget, options, run, lockFd } = input
  if (command === 'fetch') await awaitFetchLocks(common, options.signal)
  const reservation = await lockStorage(async () => {
    await recoverFetches(root, command === 'fetch' ? common : undefined)
    return reserveTransfer(root, options.signal, {
      ...(createdTarget ? { staging: target } : {}), ...(command === 'fetch' ? { fetch: common } : {}),
    })
  }, { signal: options.signal })
  let completedStaging: string | undefined
  let result: GitProcessResult | undefined
  let fetchHead = false
  try {
    const fetchDepth: string[] = []
    if (command === 'fetch' && inside(cacheRoot, common)) {
      const shallow = await run(['rev-parse', '--is-shallow-repository'], options)
      if (shallow.code !== 0) return shallow
      if (shallow.stdout.trim() === 'true') fetchDepth.push('--depth=1')
      if (!args.includes('--no-write-fetch-head')) {
        const directory = await run(['rev-parse', '--path-format=absolute', '--git-dir'], options)
        if (directory.code !== 0) return directory
        fetchHead = directory.stdout.trim() === common
      }
    }
    result = await run(boundedArgs(args, index, fetchDepth), { ...options,
      maximumFileBytes: SOURCE_GIT_CACHE_LIMITS.maximumFileBytes, transferLockFd: reservation.guard.fd,
      ...(lockFd !== undefined ? { lockFd } : {}),
    })
    if (command === 'clone' && createdTarget && result.code === 0) completedStaging = target
    return result
  } finally {
    const closed = await closeTransferWriters(root, reservation)
    try {
      const failed = !result || result.code !== 0
      // Writers have ended and the repository flock is still held; clean this interrupted fetch's locks now.
      const interrupted = result?.interrupted && { ...result.interrupted,
        destinationRefs: fetchDestinationRefs(args, index), fetchHead }
      const recovery = command === 'fetch' && failed
        && (await removeAbandonedFetchArtifacts(common, interrupted)).length > 0
      if (command === 'clone' && createdTarget && failed) await rm(target, { recursive: true, force: true })
      // A kept fetch record (never staging) reserves nothing once its writers are gone.
      if (recovery) await closed.close()
      await lockStorage(() => releaseTransfer(root, reservation.name, { staging: completedStaging, recovery }))
    } finally { await closed.close() }
  }
}

/** Reserve each transfer's maximum footprint on the cache's actual filesystem; fetches into one repository take turns. */
export async function runGitWithCacheStorage(cacheRoot: string, args: string[], options: GitProcessOptions,
  run: GitRunner): Promise<GitProcessResult> {
  const index = commandIndex(args)
  const command = args[index]
  if (command !== 'clone' && command !== 'fetch') return run(args, options)
  options.signal.throwIfAborted()
  let target: string
  let common: string
  let createdTarget = false
  if (command === 'clone') {
    target = resolve(options.cwd ?? process.cwd(), args.at(-1)!)
    common = resolve(target, '.git')
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  } else {
    const located = await run(['rev-parse', '--path-format=absolute', '--git-common-dir'], options)
    if (located.code !== 0) return located
    common = located.stdout.trim()
    if (!isAbsolute(common)) throw new DomainError('SOURCE_GIT_CACHE_INVALID', 'Git cache identity is unavailable.', 409)
    target = common
  }
  let storagePath = cacheRoot
  if (!inside(cacheRoot, target)) {
    storagePath = command === 'clone' ? dirname(target) : common
  }
  const root = await openPrivateRoot(storagePath, false)
  try {
    if (command === 'clone') {
      try { await lstat(target) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        createdTarget = true
      }
    }
    const input = { root, cacheRoot, args, index, command, target, common, createdTarget, options, run }
    if (command === 'clone') {
      return await runReservedTransfer(input, (work, lockOptions) => withPrivateDirectoryLock(root, work, lockOptions))
    }
    const repository = storagePath === common ? root : await openPrivateRoot(common, false)
    try {
      return await withPrivateDirectoryLock(repository, guard => {
        const lockStorage: StorageLock = repository === root
          ? work => work() : (work, lockOptions) => withPrivateDirectoryLock(root, work, lockOptions)
        return runReservedTransfer({ ...input, lockFd: guard.fd }, lockStorage)
      }, { signal: options.signal })
    } finally {
      if (repository !== root) await repository.close()
    }
  } finally {
    await root.close()
  }
}
