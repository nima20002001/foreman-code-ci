import { createHash, randomUUID, type Hash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, mkdir, lstat, readdir, rename, unlink, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, parse, sep } from 'node:path'
import { Readable } from 'node:stream'
import { z } from 'zod'
import { BYTE_TRANSFER_POLICY as POLICY, TransferIntentSchema, TransferContextSchema,
  TransferProgressSchema, VerifiedTransferReceiptSchema, type TransferIntent, type TransferContext,
  type TransferProgress, type VerifiedTransferReceipt, type ByteTransferPort } from '@foreman-code/contracts/byte-transfer'
import { ignoreError } from '../diagnostics/ignoredError.js'
import { CanonicalTransferOwnership } from './canonicalOwnership.js'

export type TransferOperation = 'start' | 'status' | 'append' | 'finish' | 'cancel' | 'read'
export class TransferExpiredError extends Error {}
export interface TransferAuthorization {
  /** Check current device key/revocation/connection epoch AND accepted attempt/root/placement/expiry. */
  authorize(intent: TransferIntent, context: TransferContext, operation: TransferOperation): Promise<void>
}
export type ExternalStagingKind = 'rsync-source' | 'rsync-receiver'
const ExternalKindSchema = z.enum(['rsync-source', 'rsync-receiver'])
const ExternalHoldSchema = z.object({ byteSize: z.number().int().nonnegative().max(POLICY.maxStagingBytes), released: z.boolean() }).strict()
const JournalSchema = z.object({ intent: TransferIntentSchema, progress: TransferProgressSchema,
  prefixHash: z.string().regex(/^[a-f0-9]{64}$/), receipt: VerifiedTransferReceiptSchema.optional(),
  canonical: z.boolean().optional(), canonicalReclaimed: z.boolean().optional(),
  deletionRequested: z.boolean().optional(),
  external: z.object({ 'rsync-source': ExternalHoldSchema.optional(), 'rsync-receiver': ExternalHoldSchema.optional() }).strict().optional() }).strict()
type Journal = z.infer<typeof JournalSchema>
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const emptyHash = digest(new Uint8Array())
function key(id: string) { return z.uuid().parse(id) }

/** One owner process, sequential bounded chunks, app-private journals. Never publishes files.
 * Root directory FD anchors all operations on Linux, so renamed/swapped ancestors cannot redirect writes.
 * Ownership records allow recovery only after the original process has stopped.
 */
export class ResumableByteTransferService implements ByteTransferPort {
  private directory: FileHandle | undefined
  private ownership: CanonicalTransferOwnership | undefined
  private retiredDirectory: FileHandle | undefined
  private initializing: Promise<void> | undefined
  private busy = new Set<string>()
  private allocationBusy = false
  private readers = new Set<Readable>()
  private liveHashes = new Map<string, { hash: Hash; prefixHash: string; offset: number;
    updatedAt: string; generation: string; stamp: string }>()
  constructor(private readonly root: string, private readonly authority: TransferAuthorization,
    private readonly now = () => Date.now(),
    private readonly fault?: (point: 'data-sync' | 'journal-sync' | 'directory-sync') => Promise<void>) {}

  private async initialize() {
    this.initializing ??= (async () => {
      if (!isAbsolute(this.root)) throw new Error('Transfer root must be absolute')
      let path = parse(this.root).root
      for (const part of this.root.slice(path.length).split(sep).filter(Boolean)) {
        if (part === '.' || part === '..') throw new Error('Unsafe transfer root')
        path = join(path, part)
        await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
        const stat = await lstat(path)
        if (!stat.isDirectory() || stat.isSymbolicLink()
          || ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)
          || (stat.uid !== 0 && process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe transfer ancestor')
      }
      const stat = await lstat(this.root)
      if ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Transfer root must be private and owned')
      this.directory = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      const pinned = await this.directory.stat()
      if (pinned.dev !== stat.dev || pinned.ino !== stat.ino) {
        await this.directory.close(); this.directory = undefined; throw new Error('Transfer root changed')
      }
      this.ownership = new CanonicalTransferOwnership(this.directory)
      await this.ownership.recover()
      const archive = `/proc/self/fd/${this.directory.fd}/retired`
      await mkdir(archive, { mode: 0o700 }).catch(error => {
        if (error.code !== 'EEXIST') throw error
      })
      const retired = await open(archive, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      const retiredStat = await retired.stat()
      if ((retiredStat.mode & 0o077) || (process.getuid && retiredStat.uid !== process.getuid())) {
        await retired.close()
        throw new Error('Retired transfer directory must be private and owned')
      }
      this.retiredDirectory = retired
    })().catch(async error => {
      await this.retiredDirectory?.close()
      this.retiredDirectory = undefined
      await this.directory?.close()
      this.directory = undefined
      this.ownership = undefined
      this.initializing = undefined
      throw error
    })
    await this.initializing
  }
  private path(id: string, suffix: string) { return `/proc/self/fd/${this.directory!.fd}/${key(id)}.${suffix}` }
  private async syncDirectory() { await this.fault?.('directory-sync'); await this.directory!.sync() }
  private async regular(path: string, flags: number) {
    const handle = await open(path, flags | constants.O_NOFOLLOW, 0o600)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077)
        || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe transfer file')
      return handle
    } catch (error) { await handle.close(); throw error }
  }
  private archivePath(id: string) { return `/proc/self/fd/${this.retiredDirectory!.fd}/${key(id)}.json` }
  private async journalPath(id: string): Promise<string> {
    const archived = this.archivePath(id)
    const stat = await lstat(archived).catch(error => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    return stat ? archived : this.path(id, 'json')
  }
  private async load(id: string): Promise<Journal> {
    const handle = await this.regular(await this.journalPath(id), constants.O_RDONLY)
    try {
      if ((await handle.stat()).size > 65536) throw new Error('Oversized transfer journal')
      const envelope = z.object({ checksum: z.string().regex(/^[a-f0-9]{64}$/), payload: JournalSchema }).strict().parse(JSON.parse(await handle.readFile('utf8')))
      if (digest(Buffer.from(JSON.stringify(envelope.payload))) !== envelope.checksum) throw new Error('Corrupt transfer journal checksum')
      const record = envelope.payload
      if (record.intent.transferId !== id || record.progress.transferId !== id) throw new Error('Transfer journal identity mismatch')
      return record
    } finally { await handle.close() }
  }
  private async save(j: Journal) {
    const payload = JournalSchema.parse(j)
    const data = JSON.stringify({ checksum: digest(Buffer.from(JSON.stringify(payload))), payload })
    if (Buffer.byteLength(data) > 65536) throw new Error('Oversized transfer journal')
    const temporary = this.path(j.intent.transferId, `${randomUUID()}.tmp`)
    const handle = await this.regular(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
    try {
      try { await handle.writeFile(data); await this.fault?.('journal-sync'); await handle.sync() }
      finally { await handle.close() }
      const target = await this.journalPath(j.intent.transferId)
      await rename(temporary, target)
      if (target === this.archivePath(j.intent.transferId)) await this.retiredDirectory!.sync()
      await this.syncDirectory()
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  }
  private async authorize(j: Journal, context: TransferContext, op: TransferOperation) {
    context = TransferContextSchema.parse(context)
    for (const field of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const) {
      if (context[field] !== j.intent[field]) throw new Error('Transfer principal changed')
    }
    await this.authority.authorize(j.intent, context, op)
    if (op !== 'cancel' && (this.now() >= Date.parse(j.intent.expiresAt)
      || (j.progress.state !== 'verified' && this.now() - Date.parse(j.progress.updatedAt) >= POLICY.maxIdleMs))) {
      if (op !== 'start') { j.progress.state = 'cancelled'; await this.save(j) }
      throw new TransferExpiredError('Transfer expired')
    }
    if (j.progress.state === 'cancelled' && op !== 'cancel') throw new Error('Transfer cancelled')
  }
  private async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    await this.initialize(); key(id)
    if (this.busy.size >= POLICY.maxActiveGlobal) throw new Error('Transfer operation capacity exceeded')
    if (this.busy.has(id)) throw new Error('Transfer writer busy')
    this.busy.add(id)
    let release: (() => Promise<void>) | undefined
    try {
      release = await this.ownership!.acquire(`${id}.lock`)
      return await action()
    } catch (error) {
      this.liveHashes.delete(id)
      throw error
    } finally {
      try { await release?.() }
      finally { this.busy.delete(id) }
    }
  }
  private async allocated<T>(action: () => Promise<T>): Promise<T> {
    if (this.allocationBusy) throw new Error('Transfer allocation busy')
    this.allocationBusy = true
    let release: (() => Promise<void>) | undefined
    try {
      release = await this.ownership!.acquire('allocation.lock')
      return await action()
    } finally {
      try { await release?.() }
      finally { this.allocationBusy = false }
    }
  }
  private journal(intent: TransferIntent): Journal {
    return { intent, prefixHash: emptyHash, progress: { version: 1, transferId: intent.transferId,
      state: 'allocated', receivedInMemoryBytes: 0, durableOffset: 0, verifiedBytes: 0, updatedAt: new Date(this.now()).toISOString() } }
  }
  private sameIntent(j: Journal, intent: TransferIntent) {
    if (JSON.stringify(j.intent) !== JSON.stringify(intent)) throw new Error('Transfer immutable identity conflicts')
  }
  private async capacity(candidate: Journal, creating: boolean) {
    let names = await readdir(`/proc/self/fd/${this.directory!.fd}`)
    if (creating && names.filter(name => name.endsWith('.json')).length >= POLICY.maxActiveGlobal) {
      try { await this.archiveRetired(names) }
      catch (error) {
        if (names.filter(name => name.endsWith('.json')).length >= POLICY.maxRecords) {
          throw new Error('Transfer record quota exceeded', { cause: error })
        }
        throw error
      }
      names = await readdir(`/proc/self/fd/${this.directory!.fd}`)
    }
    if (creating && (names.length >= POLICY.maxRecords * 3 || names.filter(n => n.endsWith('.json')).length >= POLICY.maxRecords)) throw new Error('Transfer record quota exceeded')
    let bytes = 0, deviceBytes = 0, active = 0, deviceActive = 0
    const count = (j: Journal) => {
      const holds = Object.values(j.external ?? {}).filter((hold): hold is z.infer<typeof ExternalHoldSchema> => hold !== undefined && !hold.released)
      const canonical = j.canonical !== false && !j.canonicalReclaimed
      const charge = (canonical ? j.intent.byteSize : 0) + holds.reduce((sum, hold) => sum + hold.byteSize, 0)
      const pending = holds.length > 0 || canonical && !['verified', 'cancelled'].includes(j.progress.state)
      bytes += charge; if (pending) active++
      if (j.intent.deviceId === candidate.intent.deviceId) { deviceBytes += charge; if (pending) deviceActive++ }
    }
    for (const name of names.filter(n => /^[a-f0-9-]{36}\.json$/.test(n))) {
      if (name === `${candidate.intent.transferId}.json`) continue
      const id = name.slice(0, -5)
      let j = await this.load(id)
      // Finish requested deletion once readers close; expiry also permits retirement.
      if (this.reclaimable(j)) {
        try { await this.retire(id); j = await this.load(id) }
        catch (error) { if (!['Transfer writer busy', 'Transfer operation capacity exceeded'].includes((error as Error).message)) throw error }
      }
      count(j)
    }
    count(candidate)
    if (active > POLICY.maxActiveGlobal || deviceActive > POLICY.maxActivePerDevice
      || bytes > POLICY.maxStagingBytes || deviceBytes > POLICY.maxStagingPerDeviceBytes) throw new Error('Transfer staging quota exceeded')
  }
  /** Retained identities are lookup-only: they cannot regain admission capacity or bytes. */
  private async archiveRetired(names: string[]) {
    const directory = this.retiredDirectory!
    for (const name of names.filter(value => /^[a-f0-9-]{36}\.json$/.test(value))) {
      const id = name.slice(0, -5)
      if (this.busy.has(id)) continue
      await this.locked(id, async () => {
        const j = await this.load(id)
        const holds = Object.values(j.external ?? {}).some(hold => hold && !hold.released)
        if (j.progress.state !== 'cancelled' || !j.canonicalReclaimed || holds || await this.hasReaders(id)) return
        const part = await lstat(this.path(id, 'part')).catch(error => {
          if (error.code === 'ENOENT') return undefined
          throw error
        })
        if (part) return
        await rename(this.path(id, 'json'), this.archivePath(id))
        await directory.sync()
        await this.syncDirectory()
      })
    }
  }
  private async hasReaders(id: string) {
    await this.ownership!.recoverReaders(id)
    return (await readdir(`/proc/self/fd/${this.directory!.fd}`)).some(name => name.startsWith(`${id}.reader-`))
  }
  private canonical(j: Journal) {
    if (j.canonical === false) throw new Error('Canonical transfer not started')
  }
  async reserve(input: TransferIntent, context: TransferContext, allocation: { kind: ExternalStagingKind; byteSize: number }): Promise<void> {
    const intent = TransferIntentSchema.parse(input), kind = ExternalKindSchema.parse(allocation.kind)
    if (!Number.isSafeInteger(allocation.byteSize) || allocation.byteSize !== intent.byteSize * (kind === 'rsync-source' ? 2 : 3)) throw new Error('External staging footprint differs')
    return this.locked(intent.transferId, () => this.allocated(async () => {
      const existing = await this.load(intent.transferId).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
      const j = existing ?? { ...this.journal(intent), canonical: false }
      this.sameIntent(j, intent); await this.authorize(j, context, 'start')
      if (Date.parse(intent.expiresAt) - this.now() > POLICY.maxLifetimeMs) throw new Error('Transfer lifetime exceeds policy')
      if (this.now() - Date.parse(j.progress.updatedAt) >= POLICY.maxIdleMs) throw new Error('Transfer idle deadline exceeded')
      const prior = j.external?.[kind]
      if (prior) {
        if (prior.byteSize !== allocation.byteSize) throw new Error('External staging immutable footprint conflicts')
        if (prior.released) throw new Error('External staging reservation released')
        await this.authorize(j, context, 'start'); await this.syncDirectory(); await this.authorize(j, context, 'start'); return
      }
      j.external = { ...j.external, [kind]: { byteSize: allocation.byteSize, released: false } }
      await this.capacity(j, !existing); await this.authorize(j, context, 'start')
      await this.save(j); await this.authorize(j, context, 'start')
    }))
  }
  /** Supervisor-only: caller has deleted the exact private bytes and confirmed original writer/readers stopped. */
  async hasReservation(input: TransferIntent, inputKind: ExternalStagingKind): Promise<boolean> {
    const intent = TransferIntentSchema.parse(input)
    const kind = ExternalKindSchema.parse(inputKind)
    return this.locked(intent.transferId, async () => {
      const journal = await this.load(intent.transferId).catch(error => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (!journal) return false
      this.sameIntent(journal, intent)
      const hold = journal.external?.[kind]
      return !!hold && !hold.released
    })
  }

  async release(input: TransferIntent, inputKind: ExternalStagingKind): Promise<void> {
    const intent = TransferIntentSchema.parse(input), kind = ExternalKindSchema.parse(inputKind)
    return this.locked(intent.transferId, () => this.allocated(async () => {
      const j = await this.load(intent.transferId); this.sameIntent(j, intent)
      const hold = j.external?.[kind]
      if (!hold) throw new Error('External staging reservation missing')
      if (hold.released) { await this.syncDirectory(); return }
      hold.released = true; await this.save(j)
    }))
  }
  private async hashState(handle: FileHandle, size: number, signal?: AbortSignal) {
    const hash = createHash('sha256'), buffer = Buffer.alloc(Math.min(POLICY.maxChunkBytes, Math.max(size, 1)))
    let offset = 0
    while (offset < size) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset)
      if (!bytesRead) throw new Error('Missing committed transfer bytes')
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead
    }
    return hash
  }
  private async hash(handle: FileHandle, size: number, signal?: AbortSignal) {
    return (await this.hashState(handle, size, signal)).digest('hex')
  }
  private async stamp(handle: FileHandle) {
    const stat = await handle.stat({ bigint: true })
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
  }
  private async rememberHash(j: Journal, handle: FileHandle, hash: Hash, context: TransferContext) {
    const id = j.intent.transferId
    if (!this.liveHashes.has(id) && this.liveHashes.size >= POLICY.maxActiveGlobal) {
      this.liveHashes.delete(this.liveHashes.keys().next().value!)
    }
    this.liveHashes.set(id, { hash: hash.copy(), prefixHash: j.prefixHash, offset: j.progress.durableOffset,
      updatedAt: j.progress.updatedAt, generation: `${context.bootId}:${context.connectionEpoch}`,
      stamp: await this.stamp(handle) })
  }
  private async reconcile(j: Journal, handle: FileHandle, context: TransferContext, signal?: AbortSignal) {
    const size = (await handle.stat()).size
    if (size < j.progress.durableOffset) {
      throw new Error('Committed transfer bytes missing or corrupt; restart byte attempt explicitly')
    }
    const cached = this.liveHashes.get(j.intent.transferId)
    const reusable = cached && cached.offset === j.progress.durableOffset && cached.prefixHash === j.prefixHash
      && cached.updatedAt === j.progress.updatedAt && cached.generation === `${context.bootId}:${context.connectionEpoch}`
      && cached.stamp === await this.stamp(handle)
    const hash = reusable && cached ? cached.hash.copy() : await this.hashState(handle, j.progress.durableOffset, signal)
    if (hash.copy().digest('hex') !== j.prefixHash) {
      throw new Error('Committed transfer bytes missing or corrupt; restart byte attempt explicitly')
    }
    if (size > j.progress.durableOffset) {
      await handle.truncate(j.progress.durableOffset)
      await handle.sync()
    }
    return hash
  }
  async start(input: TransferIntent, context: TransferContext, signal?: AbortSignal): Promise<TransferProgress> {
    signal?.throwIfAborted()
    const intent = TransferIntentSchema.parse(input)
    context = TransferContextSchema.parse(context)
    for (const field of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const) {
      if (context[field] !== intent[field]) throw new Error('Transfer principal changed')
    }
    await this.authority.authorize(intent, context, 'start')
    if (this.now() >= Date.parse(intent.expiresAt) || Date.parse(intent.expiresAt) - this.now() > POLICY.maxLifetimeMs) throw new Error('Transfer expiry exceeds policy')
    return this.locked(intent.transferId, () => this.allocated(async () => {
      signal?.throwIfAborted()
      const existing = await this.load(intent.transferId).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
      const j = existing ?? this.journal(intent)
      this.sameIntent(j, intent); await this.authorize(j, context, 'start')
      if (Date.parse(intent.expiresAt) - this.now() > POLICY.maxLifetimeMs) throw new Error('Transfer lifetime exceeds policy')
      if (existing && existing.canonical !== false) {
        const data = await this.regular(this.path(intent.transferId, 'part'), constants.O_RDWR)
        try { await this.reconcile(existing, data, context, signal) } finally { await data.close() }
        // A visible journal may follow a rename whose directory sync failed before ACK.
        await this.syncDirectory()
        await this.authorize(existing, context, 'start'); return existing.progress
      }
      j.canonical = true; delete j.canonicalReclaimed
      await this.capacity(j, !existing)
      // A missing canonical journal has committed no bytes. Recover only this private part.
      const data = await this.regular(this.path(intent.transferId, 'part'), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR)
        .catch(error => { if (error.code === 'EEXIST') return this.regular(this.path(intent.transferId, 'part'), constants.O_RDWR); throw error })
      try { await this.reconcile(j, data, context, signal); await data.sync() } finally { await data.close() }
      await this.authorize(j, context, 'start')
      signal?.throwIfAborted()
      await this.save(j)
      return j.progress
    }))
  }
  async status(id: string, context: TransferContext, signal?: AbortSignal) {
    return this.locked(id, async () => {
      signal?.throwIfAborted()
      const j = await this.load(id); this.canonical(j); await this.authorize(j, context, 'status')
      signal?.throwIfAborted()
      const handle = await this.regular(this.path(id, 'part'), constants.O_RDWR)
      try { await this.reconcile(j, handle, context, signal) } finally { await handle.close() }
      await this.syncDirectory()
      await this.authorize(j, context, 'status')
      return j.progress
    })
  }
  async append(id: string, context: TransferContext, chunk: { offset: number; sha256: string; bytes: Uint8Array }, signal?: AbortSignal) {
    // Validate before copying or retaining network data; no queue of whole objects.
    if (!Number.isSafeInteger(chunk.offset) || chunk.offset < 0 || !chunk.bytes.byteLength
      || chunk.bytes.byteLength > POLICY.maxChunkBytes || digest(chunk.bytes) !== chunk.sha256) throw new Error('Invalid transfer chunk')
    return this.locked(id, async () => {
      signal?.throwIfAborted()
      const j = await this.load(id); this.canonical(j); await this.authorize(j, context, 'append')
      if (chunk.bytes.byteLength > j.intent.chunkBytes || chunk.offset + chunk.bytes.byteLength > j.intent.byteSize) throw new Error('Chunk exceeds allocation')
      const bytes = Buffer.from(chunk.bytes)
      if (digest(bytes) !== chunk.sha256) throw new Error('Chunk changed during authorization')
      signal?.throwIfAborted()
      const handle = await this.regular(this.path(id, 'part'), constants.O_RDWR)
      try {
        const hash = await this.reconcile(j, handle, context, signal)
        if (chunk.offset < j.progress.durableOffset) {
          if (chunk.offset + bytes.length > j.progress.durableOffset) throw new Error('Chunk offset conflict')
          const previous = Buffer.alloc(bytes.length)
          const { bytesRead } = await handle.read(previous, 0, previous.length, chunk.offset)
          if (bytesRead !== bytes.length || !previous.equals(bytes)) throw new Error('Conflicting duplicate chunk')
          await this.syncDirectory()
          await this.authorize(j, context, 'append')
          return j.progress
        }
        if (chunk.offset !== j.progress.durableOffset || j.progress.state === 'verified') throw new Error('Chunk offset conflict')
        let written = 0
        while (written < bytes.length) {
          signal?.throwIfAborted()
          const result = await handle.write(bytes, written, bytes.length - written, chunk.offset + written)
          if (!result.bytesWritten) throw new Error('Transfer write made no progress')
          written += result.bytesWritten
        }
        await this.fault?.('data-sync'); await handle.sync()
        await this.authorize(j, context, 'append')
        j.progress.durableOffset += bytes.length; j.progress.state = 'transferring'
        j.progress.updatedAt = new Date(this.now()).toISOString()
        hash.update(bytes)
        j.prefixHash = hash.copy().digest('hex')
        signal?.throwIfAborted()
        await this.save(j)
        await this.rememberHash(j, handle, hash, context)
        return j.progress
      } finally { await handle.close() }
    })
  }
  async finish(id: string, context: TransferContext, signal?: AbortSignal): Promise<VerifiedTransferReceipt> {
    return this.locked(id, async () => {
      signal?.throwIfAborted()
      const j = await this.load(id); this.canonical(j); await this.authorize(j, context, 'finish')
      signal?.throwIfAborted()
      const handle = await this.regular(this.path(id, 'part'), constants.O_RDWR)
      try {
        await this.reconcile(j, handle, context, signal)
        if (j.progress.durableOffset !== j.intent.byteSize || await this.hash(handle, j.intent.byteSize, signal) !== j.intent.sha256) throw new Error('Whole transfer integrity mismatch')
        if (j.receipt) await this.syncDirectory()
        await this.authorize(j, context, 'finish')
        if (j.receipt) return j.receipt
        j.receipt = { version: 1, receiptId: randomUUID(), transferId: id, intent: j.intent,
          sha256: j.intent.sha256, byteSize: j.intent.byteSize, verifiedAt: new Date(this.now()).toISOString() }
        this.liveHashes.delete(id)
        j.progress.state = 'verified'; j.progress.verifiedBytes = j.intent.byteSize
        signal?.throwIfAborted()
        await this.save(j); return j.receipt
      } finally { await handle.close() }
    })
  }
  async cancel(id: string, context: TransferContext, signal?: AbortSignal) {
    return this.locked(id, async () => {
      signal?.throwIfAborted()
      const j = await this.load(id)
      await this.authorize(j, context, 'cancel')
      this.liveHashes.delete(id)
      j.progress.state = 'cancelled'
      delete j.receipt
      signal?.throwIfAborted()
      await this.save(j)
      await unlink(this.path(id, 'part')).catch(error => {
        if (error.code !== 'ENOENT') throw error
      })
      await this.syncDirectory()
      if (!await this.hasReaders(id)) {
        j.canonicalReclaimed = true
        signal?.throwIfAborted()
        await this.save(j)
      }
      return j.progress
    })
  }
  /** Trusted composition only: authoritative lookup and freshly reauthorized immutable read. */
  async openVerified(receipt: VerifiedTransferReceipt, context: TransferContext): Promise<Readable> {
    return this.locked(receipt.transferId, async () => {
      if (this.readers.size >= POLICY.maxActiveGlobal) throw new Error('Transfer reader capacity exceeded')
      const j = await this.load(receipt.transferId); this.canonical(j); await this.authorize(j, context, 'read')
      if (j.progress.state !== 'verified' || JSON.stringify(j.receipt) !== JSON.stringify(receipt)) throw new Error('Unrecognized verified receipt')
      const handle = await this.regular(this.path(receipt.transferId, 'part'), constants.O_RDONLY)
      let releasePin: (() => Promise<void>) | undefined
      try {
        if ((await handle.stat()).size !== receipt.byteSize || await this.hash(handle, receipt.byteSize) !== receipt.sha256) throw new Error('Verified staging corrupted')
        await this.authorize(j, context, 'read')
        const closePin = await this.ownership!.reader(`${receipt.transferId}.reader-${randomUUID()}`)
        releasePin = closePin
        await this.syncDirectory()
        let closing: Promise<void> | undefined
        const closeReader = () => closing ??= (async () => {
          await handle.close(); await closePin(); await this.syncDirectory()
          this.readers.delete(stream)
        })()
        const load = () => this.load(receipt.transferId)
        const authorize = (current: Journal) => this.authorize(current, context, 'read')
        const stream = Readable.from((async function* () {
          let offset = 0
          try {
            while (offset < receipt.byteSize) {
              const current = await load()
              await authorize(current)
              const bytes = Buffer.alloc(Math.min(POLICY.maxChunkBytes, receipt.byteSize - offset))
              const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset)
              if (!bytesRead) throw new Error('Verified staging truncated')
              offset += bytesRead; yield bytes.subarray(0, bytesRead)
            }
          } finally { await closeReader() }
        })(), { objectMode: false, highWaterMark: POLICY.maxChunkBytes })
        this.readers.add(stream)
        stream.once('close', () => {
          void closeReader().catch(ignoreError('byte-transfer', 'close verified transfer reader', { transferId: receipt.transferId }))
        })
        return stream
      } catch (error) {
        await handle.close()
        await releasePin?.()
        throw error
      }
    })
  }
  async resolveVerifiedReceipt(id: string, context: TransferContext) {
    return this.locked(id, async () => {
      const j = await this.load(id); this.canonical(j); await this.authorize(j, context, 'read')
      if (j.progress.state !== 'verified' || !j.receipt) throw new Error('Transfer is not verified')
      await this.syncDirectory(); await this.authorize(j, context, 'read')
      return j.receipt
    })
  }
  /** Main/supervisor-only tombstone and cleanup, called after expiry or a confirmed revocation. */
  async retire(id: string): Promise<void> {
    await this.locked(id, async () => {
      const j = await this.load(id)
      this.liveHashes.delete(id)
      j.progress.state = 'cancelled'
      j.deletionRequested = true
      delete j.receipt
      await this.save(j)
      await unlink(this.path(id, 'part')).catch(error => { if (error.code !== 'ENOENT') throw error })
      await this.syncDirectory()
      if (!await this.hasReaders(id)) {
        j.canonicalReclaimed = true
        await this.save(j)
        const holds = Object.values(j.external ?? {}).some(hold => hold && !hold.released)
        if (!holds && await this.journalPath(id) !== this.archivePath(id)) {
          await rename(this.path(id, 'json'), this.archivePath(id))
          await this.retiredDirectory!.sync()
          await this.syncDirectory()
        }
      }
    })
  }
  /** Cancelled bytes stay charged until their owner confirms deletion through retire(). */
  private reclaimable(j: Journal) {
    if (j.canonical === false || j.canonicalReclaimed) return false
    if (j.deletionRequested) return true
    if (j.progress.state === 'cancelled') return false
    return this.now() >= Date.parse(j.intent.expiresAt)
      || (j.progress.state !== 'verified' && this.now() - Date.parse(j.progress.updatedAt) >= POLICY.maxIdleMs)
  }
  async cleanupExpired(limit = 64): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new Error('Cleanup limit exceeds policy')
    await this.initialize()
    let count = 0
    for (const name of await readdir(`/proc/self/fd/${this.directory!.fd}`)) {
      if (count >= limit) break
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue
      const j = await this.load(name.slice(0, -5))
      const part = await lstat(this.path(j.intent.transferId, 'part')).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
      if (!part && (j.canonical === false || j.canonicalReclaimed)) continue
      if (j.progress.state === 'cancelled' || this.now() >= Date.parse(j.intent.expiresAt)
        || (j.progress.state !== 'verified' && this.now() - Date.parse(j.progress.updatedAt) >= POLICY.maxIdleMs)) {
        await this.retire(j.intent.transferId); count++
      }
    }
    return count
  }
  async inventory(): Promise<TransferIntent[]> {
    await this.initialize()
    const names = await readdir(`/proc/self/fd/${this.directory!.fd}`)
    const records = names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name))
    if (records.length > POLICY.maxRecords) throw new Error('Transfer record quota exceeded')
    const intents: TransferIntent[] = []
    for (const name of records) intents.push((await this.load(name.slice(0, -5))).intent)
    return intents
  }
  isRuntimeQuiescent(): Promise<boolean> {
    return this.runtimeQuiescent()
  }
  /** Updates retain stopped transfer journals until Main reclaims their bytes. */
  isWorkerUpdateIdle(isStopped: (intent: TransferIntent) => Promise<boolean>): Promise<boolean> {
    return this.runtimeQuiescent(isStopped)
  }
  private async runtimeQuiescent(isStopped?: (intent: TransferIntent) => Promise<boolean>): Promise<boolean> {
    if (this.busy.size || this.readers.size || this.allocationBusy) return false
    await this.cleanupExpired()
    for (const intent of await this.inventory()) {
      const record = await this.load(intent.transferId)
      if (!['verified', 'cancelled'].includes(record.progress.state)
        && this.now() < Date.parse(intent.expiresAt)
        && (!isStopped || !await isStopped(intent))) return false
    }
    return this.busy.size === 0 && this.readers.size === 0 && !this.allocationBusy
  }
  async recoverOwnership(): Promise<void> {
    await this.initialize()
    await this.ownership!.recover()
    for (const intent of await this.inventory()) {
      const journal = await this.load(intent.transferId)
      if (journal.deletionRequested && journal.canonical !== false && !journal.canonicalReclaimed) {
        await this.retire(intent.transferId)
      }
    }
  }
  async close() {
    if (this.busy.size || this.readers.size) throw new Error('Transfer operations still active')
    this.liveHashes.clear()
    await this.retiredDirectory?.close()
    this.retiredDirectory = undefined
    await this.directory?.close()
    this.directory = undefined
    this.ownership = undefined
    this.initializing = undefined
  }
}
