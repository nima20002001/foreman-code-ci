import { createHash, randomUUID } from 'node:crypto'
import { constants, type ReadStream } from 'node:fs'
import { lstat, mkdir, open, realpath, rm, link, unlink, type FileHandle } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'

import { DomainError } from '../errors.js'
import { readFileChunks, verifyFileType, type ExpectedFileBytes } from './byteValidation.js'

export function defaultFileStorageRoot(): string {
  return join(homedir(), '.local', 'share', 'graphql', 'files')
}
function inside(parent: string, child: string): boolean {
  const suffix = relative(parent, child)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}
function missing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}
function exists(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'
}
function key(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error('Invalid internal storage key.')
  return value
}
export interface FileReadSnapshot {
  read(offset: number, length: number): Promise<Buffer>
  close(): Promise<void>
}

export interface FileUploadCandidate { storageKey: string; attemptId: string }

/** Same-volume, app-private staging and immutable objects. No request supplies a host path.
 * Database locks serialize publication/cancel, NOT slow incoming network streams. */
export class FileByteStorage {
  readonly root: string
  private initialization: Promise<void> | undefined
  private readonly verifiedRanges = new Map<string, string>()
  constructor(root: string, private readonly maxBytes: number, private readonly excludedRoots: readonly string[] = []) {
    if (!isAbsolute(root) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('File storage requires an absolute directory and a positive byte limit.')
    this.root = resolve(root)
  }
  private staging(storageKey: string) { return join(this.root, 'staging', key(storageKey)) }
  private object(storageKey: string) { return join(this.root, 'objects', key(storageKey)) }
  private candidate(value: FileUploadCandidate) { return join(this.staging(value.storageKey), `${key(value.attemptId)}.part`) }
  private verified(storageKey: string) { return join(this.staging(storageKey), 'verified') }

  async initialize(): Promise<void> {
    this.initialization ??= (async () => {
      const excluded = ['/tmp', '/var/tmp', tmpdir(), ...this.excludedRoots].map((path) => resolve(path))
      if (excluded.some((path) => inside(path, this.root) || inside(this.root, path))) {
        throw new Error('File storage must be separate from temporary, workspace, and harness directories.')
      }
      // Validate existing ancestors before mkdir can follow a configured symlink.
      let ancestor = this.root
      for (;;) {
        try {
          if (await realpath(ancestor) !== ancestor) throw new Error('File storage must not traverse symbolic links.')
          break
        } catch (error) { if (!missing(error)) throw error; ancestor = dirname(ancestor) }
      }
      await this.privateDirectory(this.root)
      if (await realpath(this.root) !== this.root) throw new Error('File storage must not traverse symbolic links.')
      for (const path of excluded) {
        const canonical = await realpath(path).catch((error: unknown) => { if (missing(error)) return path; throw error })
        if (inside(canonical, this.root) || inside(this.root, canonical)) throw new Error('File storage overlaps an excluded directory.')
      }
      await this.privateDirectory(join(this.root, 'objects'))
      await this.privateDirectory(join(this.root, 'staging'))
      await this.syncDirectory(this.root)
      await this.syncDirectory(dirname(this.root))
    })()
    return this.initialization
  }
  private async privateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)
      || (process.getuid && stat.uid !== process.getuid())) throw new Error('File storage directories must be private, owned directories, not symbolic links.')
  }
  private async syncDirectory(path: string): Promise<void> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { await handle.sync() } finally { await handle.close() }
  }
  private async openRegular(path: string): Promise<FileHandle> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      if (!(await handle.stat()).isFile()) throw new Error('Managed bytes are not a regular file.')
      return handle
    } catch (error) { await handle.close(); throw error }
  }
  private checkSize(expected: ExpectedFileBytes): void {
    if (!Number.isSafeInteger(expected.byteSize) || expected.byteSize < 0 || expected.byteSize > this.maxBytes) {
      throw new DomainError('FILE_TOO_LARGE', 'The file exceeds the permitted byte limit.', 413)
    }
  }
  private async verify(handle: FileHandle, expected: ExpectedFileBytes, type = true): Promise<void> {
    this.checkSize(expected)
    if ((await handle.stat()).size !== expected.byteSize) throw new DomainError('FILE_SIZE_MISMATCH', 'The uploaded byte count differs from its allocation.', 422)
    const hash = createHash('sha256')
    for await (const chunk of readFileChunks(handle)) hash.update(chunk)
    if (hash.digest('hex') !== expected.sha256) throw new DomainError('FILE_HASH_MISMATCH', 'The uploaded SHA-256 differs from its allocation.', 422)
    if (type) await this.verifyType(handle, expected, this.maxBytes)
  }

  protected async verifyType(handle: FileHandle, expected: ExpectedFileBytes, maxBytes: number): Promise<void> {
    if ('byteClass' in expected) throw new DomainError('FILE_BYTE_CLASS_DENIED', 'CI output requires its explicit storage capability.', 415)
    await verifyFileType(handle, expected, maxBytes)
  }

  /** A unique attempt file prevents a stale/disconnected uploader from truncating another retry. */
  async receive(storageKey: string, source: Readable, expected: ExpectedFileBytes, signal?: AbortSignal): Promise<FileUploadCandidate> {
    await this.initialize(); this.checkSize(expected)
    await this.privateDirectory(this.staging(storageKey))
    const candidate = { storageKey, attemptId: randomUUID() }
    const handle = await open(this.candidate(candidate), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    let complete = false, received = 0
    const hash = createHash('sha256')
    const interruption = () => new DomainError('FILE_UPLOAD_INTERRUPTED', 'Upload was interrupted; retry the same request.', 408)
    const checkSignal = () => { if (signal?.aborted) throw interruption() }
    const abort = () => source.destroy(interruption())
    signal?.addEventListener('abort', abort, { once: true })
    try {
      checkSignal()
      for await (const raw of source.iterator({ destroyOnReturn: false })) {
        checkSignal()
        const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array)
        received += bytes.length
        if (received > this.maxBytes) throw new DomainError('FILE_TOO_LARGE', 'The file exceeds the permitted byte limit.', 413)
        if (received > expected.byteSize) throw new DomainError('FILE_SIZE_MISMATCH', 'The upload exceeds its allocated byte count.', 422)
        hash.update(bytes)
        let offset = 0
        while (offset < bytes.length) {
          const written = await handle.write(bytes, offset, bytes.length - offset)
          if (!written.bytesWritten) throw new Error('Managed storage made no write progress.')
          offset += written.bytesWritten
        }
      }
      checkSignal()
      if (received !== expected.byteSize) throw new DomainError('FILE_SIZE_MISMATCH', 'The upload ended before its allocated byte count.', 422)
      if (hash.digest('hex') !== expected.sha256) throw new DomainError('FILE_HASH_MISMATCH', 'The uploaded SHA-256 differs from its allocation.', 422)
      await handle.sync()
      await this.verifyType(handle, expected, this.maxBytes)
      await handle.chmod(0o400); await handle.sync()
      complete = true
      return candidate
    } finally {
      signal?.removeEventListener('abort', abort)
      await handle.close()
      if (!complete) await this.discard(candidate)
    }
  }

  /** Publish verified staging without overwrite. An existing verified attempt must match these pins. */
  async stage(candidate: FileUploadCandidate, expected: ExpectedFileBytes): Promise<void> {
    await this.initialize()
    try { await link(this.candidate(candidate), this.verified(candidate.storageKey)) }
    catch (error) {
      if (!exists(error)) throw error
      const handle = await this.openRegular(this.verified(candidate.storageKey))
      try { await this.verify(handle, expected) } finally { await handle.close() }
    }
    await this.syncDirectory(this.staging(candidate.storageKey))
    await this.syncDirectory(join(this.root, 'staging'))
  }
  async discard(candidate: FileUploadCandidate): Promise<void> {
    await rm(this.candidate(candidate), { force: true })
  }

  /** Atomic, no-clobber publication. Retry repairs a crash after link/fsync but before the DB commit. */
  async finalize(storageKey: string, expected: ExpectedFileBytes): Promise<void> {
    await this.initialize()
    let existing: FileHandle | undefined
    try { existing = await this.openRegular(this.object(storageKey)) }
    catch (error) { if (!missing(error)) throw error }
    if (existing) {
      try { await this.verify(existing, expected) } finally { await existing.close() }
    } else {
      let staged: FileHandle
      try { staged = await this.openRegular(this.verified(storageKey)) }
      catch (error) { if (!missing(error)) throw error; throw new DomainError('FILE_UPLOAD_INCOMPLETE', 'Upload verified bytes before finalizing.', 409, undefined, { cause: error }) }
      try { await this.verify(staged, expected) } finally { await staged.close() }
      try { await link(this.verified(storageKey), this.object(storageKey)) }
      catch (error) {
        if (!exists(error)) throw error
        const handle = await this.openRegular(this.object(storageKey))
        try { await this.verify(handle, expected) } finally { await handle.close() }
      }
    }
    await this.syncDirectory(join(this.root, 'objects'))
    await unlink(this.verified(storageKey)).catch((error: unknown) => { if (!missing(error)) throw error })
    await this.syncDirectory(this.staging(storageKey)).catch((error: unknown) => { if (!missing(error)) throw error })
  }

  /** One verified descriptor for a bounded caller-owned read, with positioned access. */
  async openRead(storageKey: string, expected: ExpectedFileBytes): Promise<FileReadSnapshot> {
    await this.initialize()
    let handle: FileHandle
    try { handle = await this.openRegular(this.object(storageKey)) }
    catch (error) {
      if (!missing(error)) throw error
      throw new DomainError('FILE_BYTES_UNAVAILABLE', 'The pinned file bytes are unavailable.', 410, undefined, { cause: error })
    }
    try {
      const stamp = async () => {
        const stat = await handle.stat({ bigint: true })
        return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
      }
      const before = await stamp()
      await this.verify(handle, expected, false)
      if (await stamp() !== before) throw new DomainError('FILE_HASH_MISMATCH', 'The pinned file changed during verification.', 410)
      let closed = false
      const unchanged = async () => {
        if (closed || await stamp() !== before) {
          throw new DomainError('FILE_BYTES_UNAVAILABLE', 'The pinned file changed during delivery.', 410)
        }
      }
      return {
        async read(offset, length) {
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1
            || offset + length > expected.byteSize) {
            throw new DomainError('FILE_RANGE_INVALID', 'The range is outside the pinned file.', 416)
          }
          await unchanged()
          const bytes = Buffer.alloc(length)
          let received = 0
          while (received < length) {
            const result = await handle.read(bytes, received, length - received, offset + received)
            if (!result.bytesRead) throw new DomainError('FILE_BYTES_UNAVAILABLE', 'The pinned file is truncated.', 410)
            received += result.bytesRead
          }
          await unchanged()
          return bytes
        },
        async close() {
          if (closed) return
          closed = true
          await handle.close()
        },
      }
    } catch (error) { await handle.close(); throw error }
  }

  /** Ranges reuse verification while the immutable object's identity, metadata and byte pins match. */
  async download(storageKey: string, expected: ExpectedFileBytes,
    range?: { offset: number; length: number }): Promise<ReadStream> {
    await this.initialize()
    let handle: FileHandle
    try { handle = await this.openRegular(this.object(storageKey)) }
    catch (error) { if (!missing(error)) throw error; throw new DomainError('FILE_BYTES_UNAVAILABLE', 'The pinned file bytes are unavailable.', 410, undefined, { cause: error }) }
    try {
      if (!range) {
        await this.verify(handle, expected, false)
        return handle.createReadStream({ start: 0, autoClose: true })
      }
      this.checkSize(expected)
      if (!Number.isSafeInteger(range.offset) || range.offset < 0 || range.offset > expected.byteSize
        || !Number.isSafeInteger(range.length) || range.length < 1) {
        throw new DomainError('FILE_RANGE_INVALID', 'The range is outside the pinned file.', 416)
      }
      const stamp = async () => {
        const stat = await handle.stat({ bigint: true })
        return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, expected.byteSize, expected.sha256].join(':')
      }
      const before = await stamp()
      if (this.verifiedRanges.get(storageKey) !== before) {
        await this.verify(handle, expected, false)
        if (await stamp() !== before) {
          throw new DomainError('FILE_HASH_MISMATCH', 'The pinned file changed during verification.', 410)
        }
        // Keep only verification metadata, with a fixed bound and no retained descriptors or file buffers.
        if (this.verifiedRanges.size >= 128) this.verifiedRanges.delete(this.verifiedRanges.keys().next().value!)
        this.verifiedRanges.set(storageKey, before)
      }
      const length = Math.min(range.length, expected.byteSize - range.offset)
      return handle.createReadStream({ start: range.offset,
        ...(length > 0 ? { end: range.offset + length - 1 } : {}), autoClose: true })
    } catch (error) { await handle.close(); throw error }
  }
  /** Only call after canceling a pending allocation, never for an accepted ready file. */
  async removeUnsent(storageKey: string): Promise<void> {
    await this.initialize()
    await rm(this.staging(storageKey), { recursive: true, force: true })
    await rm(this.object(storageKey), { force: true })
    await this.syncDirectory(join(this.root, 'objects'))
    await this.syncDirectory(join(this.root, 'staging'))
  }
}
