import { randomUUID, createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, lstat, copyFile, readdir } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join, basename } from 'node:path'
import { DomainError } from '../errors.js'
import { browserInputHash } from '../browser-profiles/identity.js'
import { atomicBrowserPrivateJson } from './journal.js'

export interface BrowserFileMetadata {
  id: string; name: string; mimeType: string; byteLength: number; receivedBytes: number
  state: 'uploading' | 'ready' | 'attached' | 'canceled' | 'failed'
  sha256: string | null
  purpose: 'upload' | 'download'
}
interface OwnedBrowserFile { metadata: BrowserFileMetadata; sessionId: string; tabId: string; browserGeneration: number; chunks: Record<string, string>; attachmentCommandId?: string }
export interface BrowserFileOwner { sessionId: string; tabId: string; browserGeneration: number }

/** Session-owned byte staging. Raw paths never enter readback; the native adapter receives them privately. */
function unsafeFilenameCharacter(character: string): boolean {
  return character.charCodeAt(0) < 32 || character === '\\' || character === '/'
}

function downloadName(filename: string): string {
  return Array.from(basename(filename)).map(character => unsafeFilenameCharacter(character) ? '_' : character)
    .join('').slice(0, 255) || 'download'
}

export class BrowserFileStore {
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly sessionActivity = new Map<string, Set<Promise<unknown>>>()
  private readonly closedSessions = new Set<string>()
  constructor(private readonly root: string, private readonly assertOwner: (owner: BrowserFileOwner, mutate: boolean) => Promise<void>) {}
  private directory(id: string) { return join(this.root, browserInputHash(id)) }

  private duringSession<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const active = this.sessionActivity.get(sessionId) ?? new Set<Promise<unknown>>()
    const task = (async () => {
      let closed = this.closedSessions.has(sessionId)
      if (!closed) {
        try { await lstat(join(this.root, 'closed-sessions', `${browserInputHash(sessionId)}.json`)); closed = true } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      if (closed || this.closedSessions.has(sessionId)) throw new DomainError('BROWSER_FILE_SESSION_CLOSED', 'This browser session no longer accepts new files.', 409)
      return work()
    })().finally(() => { active.delete(task); if (!active.size) this.sessionActivity.delete(sessionId) })
    active.add(task); this.sessionActivity.set(sessionId, active); return task
  }

  private canceledDownload(owner: BrowserFileOwner, nativeId: string): BrowserFileMetadata {
    return { id: browserInputHash({ sessionId: owner.sessionId, nativeId }), name: 'download', mimeType: 'application/octet-stream',
      byteLength: 0, receivedBytes: 0, state: 'canceled', sha256: null, purpose: 'download' }
  }

  private serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve(), task = previous.then(work, work)
    this.tails.set(key, task)
    void task.finally(() => { if (this.tails.get(key) === task) this.tails.delete(key) })
      .catch(() => { /* ignore: the returned operation reports the failure. */ })
    return task
  }

  private async save(value: OwnedBrowserFile): Promise<void> {
    const directory = this.directory(value.metadata.id), temporary = join(directory, `.${randomUUID()}.tmp`)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new DomainError('BROWSER_STORAGE_INVALID', 'Browser file storage is not private.', 503)
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
    await rename(temporary, join(directory, 'metadata.json'))
    const parent = await open(directory, 'r')
    try { await parent.sync() } finally { await parent.close() }
  }

  private async owned(fileId: string, sessionId: string): Promise<OwnedBrowserFile> {
    let value: OwnedBrowserFile
    try { value = JSON.parse(await readFile(join(this.directory(fileId), 'metadata.json'), 'utf8')) as OwnedBrowserFile } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DomainError('NOT_FOUND', 'Browser file not found.', 404, undefined, { cause: error })
      throw error
    }
    if (value.sessionId !== sessionId) throw new DomainError('BROWSER_FILE_SCOPE', 'This file belongs to a different browser session.', 403)
    return value
  }

  async begin(input: BrowserFileOwner & { name: string; mimeType: string; byteLength: number; commandId: string }): Promise<BrowserFileMetadata> {
    return this.duringSession(input.sessionId, () => this.beginOpen(input))
  }

  private async beginOpen(input: BrowserFileOwner & { name: string; mimeType: string; byteLength: number; commandId: string }): Promise<BrowserFileMetadata> {
    await this.assertOwner(input, true)
    if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0 || !input.name.trim()
      || input.name.length > 255 || basename(input.name) !== input.name || Array.from(input.name).some(unsafeFilenameCharacter)) {
      throw new DomainError('BROWSER_FILE_INVALID', 'Choose a file with a valid name and length.', 400)
    }
    const id = browserInputHash({ sessionId: input.sessionId, commandId: input.commandId })
    return this.serialize(id, async () => {
      try {
        const existing = await this.owned(id, input.sessionId)
        if (existing.tabId !== input.tabId || existing.browserGeneration !== input.browserGeneration
          || existing.metadata.name !== input.name || existing.metadata.byteLength !== input.byteLength || existing.metadata.mimeType !== input.mimeType) {
          throw new DomainError('COMMAND_ID_CONFLICT', 'This upload command ID belongs to a different file.', 409)
        }
        if (existing.metadata.state === 'uploading' && existing.metadata.receivedBytes === 0) {
          const handle = await open(join(this.directory(id), 'bytes'), 'a', 0o600); await handle.close()
        }
        return existing.metadata
      } catch (error) { if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND') throw error }
      const metadata: BrowserFileMetadata = { id, name: input.name, mimeType: input.mimeType, byteLength: input.byteLength,
        receivedBytes: 0, state: 'uploading', sha256: null, purpose: 'upload' }
      await this.save({ metadata, sessionId: input.sessionId, tabId: input.tabId, browserGeneration: input.browserGeneration, chunks: {} })
      const bytes = await open(join(this.directory(id), 'bytes'), 'a', 0o600); await bytes.close()
      return metadata
    })
  }

  async write(input: { fileId: string; sessionId: string; offset: number; bytes: Uint8Array }): Promise<BrowserFileMetadata> {
    return this.serialize(input.fileId, async () => {
      const owned = await this.owned(input.fileId, input.sessionId)
      await this.assertOwner(owned, true)
      if (owned.metadata.state !== 'uploading' || !Number.isSafeInteger(input.offset) || input.offset < 0
        || input.bytes.length === 0 || input.bytes.length > 262_144 || input.offset + input.bytes.length > owned.metadata.byteLength
        || input.bytes.length !== 262_144 && input.offset + input.bytes.length !== owned.metadata.byteLength) {
        throw new DomainError('BROWSER_FILE_CHUNK_INVALID', 'The upload chunk does not match this file.', 400)
      }
      const digest = createHash('sha256').update(input.bytes).digest('hex')
      if (owned.chunks[String(input.offset)]) {
        if (owned.chunks[String(input.offset)] !== digest) throw new DomainError('BROWSER_FILE_CHUNK_CONFLICT', 'This upload offset already contains different bytes.', 409)
        return owned.metadata
      }
      if (input.offset !== owned.metadata.receivedBytes) throw new DomainError('BROWSER_FILE_OFFSET', 'Upload chunks must arrive in order.', 409)
      const handle = await open(join(this.directory(input.fileId), 'bytes'), 'r+')
      try {
        let written = 0
        while (written < input.bytes.length) {
          const result = await handle.write(input.bytes, written, input.bytes.length - written, input.offset + written)
          if (!result.bytesWritten) throw new DomainError('BROWSER_STORAGE_WRITE', 'The browser upload could not be written.', 503)
          written += result.bytesWritten
        }
        await handle.sync()
      } finally { await handle.close() }
      owned.metadata.receivedBytes += input.bytes.length; owned.chunks[String(input.offset)] = digest
      await this.save(owned); return owned.metadata
    })
  }

  async finish(fileId: string, sessionId: string): Promise<BrowserFileMetadata> {
    return this.serialize(fileId, async () => {
      const owned = await this.owned(fileId, sessionId); await this.assertOwner(owned, true)
      if (owned.metadata.state === 'ready' || owned.metadata.state === 'attached') return owned.metadata
      if (owned.metadata.state !== 'uploading' || owned.metadata.receivedBytes !== owned.metadata.byteLength) {
        throw new DomainError('BROWSER_FILE_INCOMPLETE', 'The file upload is not complete.', 409)
      }
      const path = join(this.directory(fileId), 'bytes'), info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size !== owned.metadata.byteLength) throw new DomainError('BROWSER_FILE_INCOMPLETE', 'The uploaded bytes do not match the declared file length.', 409)
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(path)) hash.update(chunk)
      owned.metadata.sha256 = hash.digest('hex'); owned.metadata.state = 'ready'
      await this.save(owned); return owned.metadata
    })
  }

  async attach(fileId: string, owner: BrowserFileOwner, commandId: string, attach: (privatePath: string) => Promise<void>): Promise<BrowserFileMetadata> {
    return this.serialize(fileId, async () => {
      const owned = await this.owned(fileId, owner.sessionId); await this.assertOwner(owner, true)
      if (owned.tabId !== owner.tabId || owned.browserGeneration !== owner.browserGeneration) {
        throw new DomainError('BROWSER_FILE_SCOPE', 'This upload belongs to a different browser tab or generation.', 403)
      }
      if (owned.attachmentCommandId === commandId && owned.metadata.state === 'attached') return owned.metadata
      if (owned.attachmentCommandId === commandId && owned.metadata.state === 'failed') {
        throw new DomainError('BROWSER_RESULT_UNKNOWN', 'File attachment may already have happened. Review the page before choosing another file.', 409)
      }
      if (owned.metadata.state !== 'ready' || owned.metadata.purpose !== 'upload') throw new DomainError('BROWSER_FILE_NOT_READY', 'This file is not ready to attach.', 409)
      // A lost native reply is unknown; never automatically attach again.
      owned.metadata.state = 'failed'; owned.attachmentCommandId = commandId; await this.save(owned)
      await attach(join(this.directory(fileId), 'bytes'))
      owned.metadata.state = 'attached'; await this.save(owned); return owned.metadata
    })
  }

  async read(fileId: string, sessionId: string, offset: number, length: number): Promise<Uint8Array> {
    return this.serialize(fileId, () => this.readOwned(fileId, sessionId, offset, length))
  }

  private async readOwned(fileId: string, sessionId: string, offset: number, length: number): Promise<Uint8Array> {
    const owned = await this.owned(fileId, sessionId); await this.assertOwner(owned, false)
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 262_144
      || !['ready', 'attached'].includes(owned.metadata.state)) throw new DomainError('BROWSER_FILE_RANGE', 'Invalid browser file byte range.', 400)
    const handle = await open(join(this.directory(fileId), 'bytes'), 'r')
    try {
      const bytes = Buffer.alloc(Math.min(length, Math.max(0, owned.metadata.byteLength - offset)))
      const result = await handle.read(bytes, 0, bytes.length, offset)
      return bytes.subarray(0, result.bytesRead)
    } finally { await handle.close() }
  }

  async cancel(fileId: string, sessionId: string): Promise<BrowserFileMetadata> {
    return this.serialize(fileId, async () => {
      const owned = await this.owned(fileId, sessionId); await this.assertOwner(owned, false)
      owned.metadata.state = 'canceled'; await this.save(owned)
      await rm(join(this.directory(fileId), 'bytes'), { force: true })
      return owned.metadata
    })
  }

  async metadata(fileId: string, sessionId: string): Promise<BrowserFileMetadata> {
    const owned = await this.owned(fileId, sessionId); await this.assertOwner(owned, false)
    return structuredClone(owned.metadata)
  }

  async list(sessionId: string, includeCanceled = false): Promise<BrowserFileMetadata[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const result: BrowserFileMetadata[] = []
    for (const name of await readdir(this.root)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue
      let value: OwnedBrowserFile
      try { value = JSON.parse(await readFile(join(this.root, name, 'metadata.json'), 'utf8')) as OwnedBrowserFile } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (value.sessionId === sessionId && (includeCanceled || value.metadata.state !== 'canceled')) result.push(value.metadata)
    }
    return result
  }

  async trackDownload(owner: BrowserFileOwner, nativeId: string, filename: string, byteLength: number,
    receivedBytes: number, failed: boolean): Promise<BrowserFileMetadata> {
    try { return await this.duringSession(owner.sessionId, () => this.trackOpenDownload(owner, nativeId, filename, byteLength, receivedBytes, failed)) } catch (error) {
      if (error instanceof DomainError && error.code === 'BROWSER_FILE_SESSION_CLOSED') return this.canceledDownload(owner, nativeId)
      throw error
    }
  }

  private async trackOpenDownload(owner: BrowserFileOwner, nativeId: string, filename: string, byteLength: number,
    receivedBytes: number, failed: boolean): Promise<BrowserFileMetadata> {
    const id = browserInputHash({ sessionId: owner.sessionId, nativeId })
    return this.serialize(id, async () => {
      let previous: OwnedBrowserFile | undefined
      try { previous = await this.owned(id, owner.sessionId) } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND') throw error
      }
      if (previous && ['ready', 'canceled', 'failed'].includes(previous.metadata.state)) return previous.metadata
      const metadata: BrowserFileMetadata = { id, name: downloadName(filename),
        mimeType: 'application/octet-stream', byteLength: Math.max(0, byteLength), receivedBytes: Math.max(0, receivedBytes),
        state: failed ? 'failed' : 'uploading', sha256: null, purpose: 'download' }
      await this.save({ ...owner, metadata, chunks: {} }); return metadata
    })
  }

  async adoptDownload(owner: BrowserFileOwner, nativeId: string, privatePath: string, filename: string, byteLength: number): Promise<BrowserFileMetadata> {
    try { return await this.duringSession(owner.sessionId, () => this.adoptOpenDownload(owner, nativeId, privatePath, filename, byteLength)) } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'BROWSER_FILE_SESSION_CLOSED') throw error
      await rm(privatePath, { force: true }); return this.canceledDownload(owner, nativeId)
    }
  }

  private async adoptOpenDownload(owner: BrowserFileOwner, nativeId: string, privatePath: string, filename: string, byteLength: number): Promise<BrowserFileMetadata> {
    const id = browserInputHash({ sessionId: owner.sessionId, nativeId }), name = downloadName(filename)
    return this.serialize(id, async () => {
      try {
        const previous = (await this.owned(id, owner.sessionId)).metadata
        if (previous.state === 'ready') { await rm(privatePath, { force: true }); return previous }
        if (previous.state === 'canceled' || previous.state === 'failed') { await rm(privatePath, { force: true }); return previous }
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND') throw error
      }
      const info = await lstat(privatePath)
      if (!info.isFile() || info.isSymbolicLink() || info.size !== byteLength) throw new DomainError('BROWSER_DOWNLOAD_UNCONFIRMED', 'The downloaded file has not settled.', 409)
      await mkdir(this.directory(id), { recursive: true, mode: 0o700 })
      const path = join(this.directory(id), 'bytes')
      await copyFile(privatePath, path)
      const handle = await open(path, 'r+'); await handle.chmod(0o600)
      try { await handle.sync() } finally { await handle.close() }
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(path)) hash.update(chunk)
      const metadata: BrowserFileMetadata = { id, name, mimeType: 'application/octet-stream', byteLength,
        receivedBytes: byteLength, state: 'ready', purpose: 'download', sha256: hash.digest('hex') }
      await this.save({ ...owner, metadata, chunks: {} })
      await rm(privatePath, { force: true })
      return metadata
    })
  }

  async closeSession(sessionId: string, removeDownloads = false): Promise<void> {
    this.closedSessions.add(sessionId)
    await atomicBrowserPrivateJson(join(this.root, 'closed-sessions'), `${browserInputHash(sessionId)}.json`, { closed: true })
    // Drain admissions that began before the fence; later native events cannot resurrect staging.
    await Promise.allSettled([...(this.sessionActivity.get(sessionId) ?? [])])
    for (const file of await this.list(sessionId, true)) {
      if (removeDownloads || file.purpose === 'upload' || file.state !== 'ready') await this.cancel(file.id, sessionId)
    }
  }
}
