import { constants } from 'node:fs'
import { open, mkdir, lstat, unlink, rmdir, type FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, parse, sep } from 'node:path'
import { BYTE_TRANSFER_POLICY as POLICY, TransferIntentSchema, type TransferIntent } from '@foreman-code/contracts/byte-transfer'
import type { RsyncStoreOwnership } from './rsyncWriterOwnership.js'
import type { RsyncReceiverLease, RsyncSnapshot, RsyncStagedBytes } from './rsync.js'

export interface RsyncQuota {
  /** Existing app supervisor persists aggregate/device reservations, retries and TTL. No second ledger. */
  reserve(intent: TransferIntent): Promise<() => Promise<void>>
  /** Idempotent supervisor release after trusted retirement, including retained source/partial bytes. */
  retire(intent: TransferIntent): Promise<void>
}
async function regular(path: string, flags: number) {
  const handle = await open(path, flags | constants.O_NOFOLLOW, 0o600)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('Unsafe staging file')
    return handle
  } catch (error) { await handle.close(); throw error }
}
async function verify(handle: FileHandle, intent: TransferIntent, signal: AbortSignal) {
  const size = (await handle.stat()).size
  if (size !== intent.byteSize) throw new Error('Rsync byte length mismatch')
  const hash = createHash('sha256'), buffer = Buffer.alloc(Math.min(POLICY.maxChunkBytes, Math.max(1, size)))
  for (let offset = 0; offset < size;) {
    signal.throwIfAborted()
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset)
    if (!bytesRead) throw new Error('Missing staging bytes')
    hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead
  }
  signal.throwIfAborted()
  if (hash.digest('hex') !== intent.sha256) throw new Error('Rsync SHA-256 mismatch')
}
/** Linux app-private store. Same-uid peers must not have access to this directory.
 * Local helpers also run on the worker through its existing authenticated control port.
 * No SSH grants, daemon, canonical storage, scheduler or publication state is created. */
export class RsyncPrivateStore {
  constructor(readonly root: string, private readonly quota: RsyncQuota, private readonly ownership?: RsyncStoreOwnership) {}
  private owners() {
    if (!this.ownership) throw new Error('Rsync causal byte ownership unavailable')
    return this.ownership
  }
  private async directory() {
    if (!this.root.startsWith('/') || this.root.split('/').some(x => x === '..' || x === '.')) throw new Error('Unsafe staging root')
    let path = parse(this.root).root
    for (const part of this.root.slice(path.length).split(sep).filter(Boolean)) {
      path = join(path, part)
      await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
      const stat = await lstat(path)
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== process.getuid?.())
        || ((stat.mode & 0o022) && !(stat.mode & 0o1000))) throw new Error('Unsafe staging ancestor')
    }
    const stat = await lstat(this.root)
    if ((stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('Staging root must be private')
    const handle = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const pinned = await handle.stat()
    if (pinned.ino !== stat.ino || pinned.dev !== stat.dev) { await handle.close(); throw new Error('Staging root changed') }
    return handle
  }
  private async identity(directory: FileHandle, input: TransferIntent) {
    const intent = TransferIntentSchema.parse(input), path = `/proc/self/fd/${directory.fd}/${intent.transferId}.intent`
    let handle: FileHandle
    try {
      handle = await regular(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
      try { await handle.writeFile(JSON.stringify(intent)); await handle.sync(); await directory.sync() }
      finally { await handle.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      handle = await regular(path, constants.O_RDONLY)
      try {
        if ((await handle.stat()).size > 16384 || JSON.stringify(TransferIntentSchema.parse(JSON.parse(await handle.readFile('utf8')))) !== JSON.stringify(intent)) throw new Error('Transfer immutable identity conflicts', { cause: error })
      } finally { await handle.close() }
    }
    return intent
  }
  /** Copy from an already authorized source FD; verify expected hash before exposing snapshot. */
  async freeze(input: TransferIntent, source: FileHandle, signal: AbortSignal): Promise<RsyncSnapshot> {
    const intent = TransferIntentSchema.parse(input), owners = this.owners(), access = owners.access(intent, 'snapshot')
    const directory = await access.run(async () => { const handle = await this.directory(); access.attach(handle); return handle })
    const path = `/proc/self/fd/${directory.fd}/${intent.transferId}.snapshot`
    let handle: FileHandle | undefined
    try {
      await access.run(() => this.identity(directory, intent))
      await access.run(() => this.quota.reserve(intent))
      try { handle = await access.run(async () => { const file = await regular(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL); access.attach(file); return file }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        handle = await access.run(async () => { const file = await regular(path, constants.O_RDONLY); access.attach(file); return file })
        await access.run(() => verify(handle!, intent, signal))
        return { verify: bounded => access.run(() => verify(handle!, intent, bounded)), close: () => access.close() }
      }
      const buffer = Buffer.alloc(Math.min(POLICY.maxChunkBytes, Math.max(1, intent.byteSize)))
      for (let offset = 0; offset < intent.byteSize;) {
        signal.throwIfAborted()
        const { bytesRead } = await access.run(() => source.read(buffer, 0, Math.min(buffer.length, intent.byteSize - offset), offset))
        if (!bytesRead) throw new Error('Source length changed')
        let written = 0
        while (written < bytesRead) {
          const result = await access.run(() => handle!.write(buffer, written, bytesRead - written, offset + written))
          if (!result.bytesWritten) throw new Error('Snapshot write stalled')
          written += result.bytesWritten
        }
        offset += bytesRead
      }
      if ((await access.run(() => source.stat())).size !== intent.byteSize) throw new Error('Source length changed')
      await access.run(async () => { await verify(handle!, intent, signal); await handle!.chmod(0o400); await handle!.sync(); await directory.sync() })
      return { verify: bounded => access.run(() => verify(handle!, intent, bounded)), close: () => access.close() }
    } catch (error) {
      await access.close()
      // Failed snapshots remain fail-closed. Trusted cleanup after stopped-owner reconciliation can retire them.
      throw error
    }
  }
  async receive(input: TransferIntent, signal: AbortSignal): Promise<RsyncReceiverLease> {
    signal.throwIfAborted()
    const intent = TransferIntentSchema.parse(input), owners = this.owners(), access = owners.access(intent, 'receiver')
    const directory = await access.run(async () => { const handle = await this.directory(); access.attach(handle); return handle })
    const base = `/proc/self/fd/${directory.fd}/${intent.transferId}`
    let reserved: (() => Promise<void>) | undefined, locked = false
    try {
      await access.run(() => mkdir(`${base}.lock`, { mode: 0o700 })); locked = true; access.captureLock()
      await access.run(() => this.identity(directory, intent))
      const partial = `/proc/self/fd/${directory.fd}/.rsync-partial`
      await access.run(() => mkdir(partial, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error }))
      const partialStat = await access.run(() => lstat(partial))
      if (!partialStat.isDirectory() || partialStat.isSymbolicLink() || (partialStat.mode & 0o077)
        || partialStat.uid !== process.getuid?.()) throw new Error('Unsafe rsync partial directory')
      reserved = await access.run(() => this.quota.reserve(intent))
      let handle: FileHandle
      try { handle = await access.run(async () => { const file = await regular(`${base}.part`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL); access.attach(file); return file }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; handle = await access.run(async () => { const file = await regular(`${base}.part`, constants.O_RDONLY); access.attach(file); return file }) }
      await access.run(async () => { await handle.close(); await directory.sync() })
      let closed = false
      const unlock = async () => {
        try {
          await owners.processesQuiescent(intent, AbortSignal.timeout(5000))
          await access.run(async () => { owners.assertLock(intent); await rmdir(`${base}.lock`); await directory.sync() })
        } finally { await access.close() }
      }
      return {
        interrupt: async () => {
          if (closed) return
          // A revoked lease has closed its handles. Trusted retirement retains
          // responsibility for its captured lock and partial bytes.
          if (access.signal.aborted) await access.close()
          else await unlock()
          closed = true
        },
        verify: async bounded => {
          if (closed) throw new Error('Receiver lease closed')
          bounded.throwIfAborted()
          const current = await lstat(this.root), pinned = await directory.stat()
          if (current.ino !== pinned.ino || current.dev !== pinned.dev || current.isSymbolicLink()) throw new Error('Staging root changed')
          await owners.processesQuiescent(intent, bounded, true)
          const bytes = await access.run(async () => { const file = await regular(`${base}.part`, constants.O_RDONLY); access.attach(file); return file })
          try { await access.run(async () => { await verify(bytes, intent, bounded); await bytes.sync(); await directory.sync() }) }
          catch (error) { await bytes.close(); throw error }
          closed = true
          let disposed = false, released = false, closing: Promise<void> | undefined
          const staged: RsyncStagedBytes = { intent, sha256: intent.sha256, byteSize: intent.byteSize,
            read: async (offset, length, readSignal) => {
              if (disposed) throw new Error('Staging bytes closed')
              if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1
                || length > POLICY.maxChunkBytes || offset + length > intent.byteSize) throw new Error('Invalid staging read')
              await access.run(() => verify(bytes, intent, readSignal))
              const buffer = Buffer.alloc(length), result = await access.run(() => bytes.read(buffer, 0, length, offset))
              if (result.bytesRead !== length) throw new Error('Staging bytes changed')
              return buffer
            },
            close: () => {
              disposed = true
              if (released) return Promise.resolve()
              if (closing) return closing
              const attempt = (async () => {
                await access.close()
                await owners.retire(intent, async () => {
                  const cleanupDirectory = await this.directory()
                  try { owners.captureRetirementHandle(intent, cleanupDirectory) }
                  catch (error) { await cleanupDirectory.close(); throw error }
                  const cleanupBase = `/proc/self/fd/${cleanupDirectory.fd}/${intent.transferId}`
                  await unlink(`${cleanupBase}.part`).catch(error => { if (error.code !== 'ENOENT') throw error })
                  await cleanupDirectory.sync(); await reserved!()
                  try { await lstat(`${cleanupBase}.lock`); owners.assertLock(intent); await rmdir(`${cleanupBase}.lock`) }
                  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
                  await cleanupDirectory.sync()
                })
                released = true
              })()
              closing = attempt
              void attempt.catch(() => { if (closing === attempt) closing = undefined })
              return attempt
            } }
          return staged
        },
      }
    } catch (error) {
      try {
        if (locked) {
          await owners.processesQuiescent(intent, AbortSignal.timeout(5000))
          await access.run(async () => { owners.assertLock(intent); await rmdir(`${base}.lock`); await directory.sync() })
        }
        // Reservations survive failed admission/write; the existing trusted supervisor retires them.
      } finally { await access.close() }
      throw error
    }
  }
  /** Called only by the existing cleanup supervisor after writer-death/expiry or canonical acknowledgment.
   * Locks are never stolen by age. Partial reservations are released by the same quota supervisor. */
  async retire(input: TransferIntent, reason: 'acknowledged' | 'execution-closed' = 'acknowledged') {
    const intent = TransferIntentSchema.parse(input), owners = this.owners()
    return owners.retire(intent, async () => {
      const directory = await this.directory()
      try { owners.captureRetirementHandle(intent, directory) }
      catch (error) { await directory.close(); throw error }
      try {
        const base = `/proc/self/fd/${directory.fd}/${intent.transferId}`
        let original: FileHandle | undefined
        try { original = await regular(`${base}.intent`, constants.O_RDONLY) }
        catch (error) {
          // The exact owner journal/retirement barrier remains durable if a prior expired
          // cleanup deleted staging identity before the shared quota release failed.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT'
            || reason !== 'execution-closed' && Date.now() < Date.parse(intent.expiresAt)) throw error
        }
        if (original) try {
          owners.captureRetirementHandle(intent, original)
          if ((await original.stat()).size > 16384 || JSON.stringify(TransferIntentSchema.parse(JSON.parse(await original!.readFile('utf8')))) !== JSON.stringify(intent)) throw new Error('Transfer immutable identity conflicts')
        } finally { await original.close() }
        try { await lstat(`${base}.lock`); owners.assertLock(intent); await rmdir(`${base}.lock`) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        await mkdir(`${base}.lock`, { mode: 0o700 })
        owners.captureRetirementLock(intent)
        try {
          for (const suffix of ['part', 'snapshot', ...(Date.now() >= Date.parse(intent.expiresAt) ? ['intent'] : [])]) await unlink(`${base}.${suffix}`).catch(error => { if (error.code !== 'ENOENT') throw error })
          await unlink(`/proc/self/fd/${directory.fd}/.rsync-partial/${intent.transferId}.part`).catch(error => { if (error.code !== 'ENOENT') throw error })
          await directory.sync(); await this.quota.retire(intent)
        } finally { owners.assertLock(intent); await rmdir(`${base}.lock`); await directory.sync() }
      } finally { await directory.close() }
    })
  }
}
