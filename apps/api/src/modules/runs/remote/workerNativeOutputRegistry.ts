import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, unlink, type FileHandle } from 'node:fs/promises'
import { CodexHarnessConfigurationSchema, type CodexHarnessConfiguration } from '@foreman-code/contracts'
import { AgentFilePublishInputSchema, TemporaryFileScopeSchema, MAX_FILE_BYTES,
  type TemporaryFileScope, type AgentFilePublishInput, type AgentFilePublishResult } from '@foreman-code/contracts/files'
import { BYTE_TRANSFER_POLICY } from '@foreman-code/contracts/byte-transfer'
import { WorkerNativeOutputCommandSchema, WorkerNativeOutputReplySchema, MAX_NATIVE_OUTPUT_APPEND_BYTES,
  type WorkerNativeOutputCommand, type WorkerNativeOutputReply } from '@foreman-code/contracts/worker-native-output'
import { anchored, identity, openPrivateRoot } from '../../sources/privateFilesystem.js'
import { DomainError } from '../../errors.js'
import { captureWorkerNativeArtifactCallback, type WorkerNativeArtifactCallback,
  type WorkerNativeArtifactSnapshot, type WorkerNativeArtifactSource } from './workerNativeArtifactSender.js'

export interface WorkerNativeOutputAuthority {
  /** HRT checks original Main mutation/publication grants and records audit facts.
   * A valid App lease alone is insufficient. No default authorization exists. */
  assertCurrent(operation: WorkerNativeOutputCommand['operation'], signal?: AbortSignal): Promise<void>
}
export interface WorkerNativeOutputCallback extends WorkerNativeArtifactCallback {
  /** Bound to the actual qualified original provider session/turn/callback.
   * Must withdraw at terminal/stop and reject foreign or conflicting callbacks. */
  assertCurrent(signal?: AbortSignal): void | Promise<void>
}
export interface WorkerNativeOutputReservation {
  assertCurrent(signal?: AbortSignal): Promise<void>
  /** Idempotent for this reservation, including lost-ACK retry. Release only
   * after positive cleanup; uncertain leftover files retain quota. */
  release(): Promise<void>
}
export interface WorkerNativeOutputStorage {
  rootDirectory: string
  /** Actual enforced native sandbox protects this canonical private root from
   * every native writer. openPrivateRoot/0700 alone does NOT establish this. */
  assertProtected(signal?: AbortSignal): Promise<void>
  reserve(input: { artifactId: string; maxDiskBytes: number; maxSnapshotBytes: number; maxCommandRecords: number },
    signal?: AbortSignal): Promise<WorkerNativeOutputReservation>
}
export interface WorkerNativeOutputPorts {
  configuration: CodexHarnessConfiguration
  /** Original Main conversation/execution scope; never supplied by native args. */
  scope: TemporaryFileScope
  authority: WorkerNativeOutputAuthority
  callback: WorkerNativeOutputCallback
  storage: WorkerNativeOutputStorage
  publisher: { publish(input: AgentFilePublishInput, callback: WorkerNativeArtifactCallback, signal?: AbortSignal): Promise<AgentFilePublishResult> }
}
type Entry = {
  filename: string; mediaType: AgentFilePublishInput['mediaType']; byteSize: number; stamp: string
  writer?: FileHandle; snapshot?: Buffer; sha256?: string; failed?: boolean
  readers: Set<FileHandle>; allocated: boolean; unlinked?: boolean
  reservation: WorkerNativeOutputReservation; publication?: AgentFilePublishInput
}
type Command = { digest: string; pending?: Promise<WorkerNativeOutputReply>; reply?: WorkerNativeOutputReply }
const denied = () => new DomainError('WORKER_NATIVE_OUTPUT_UNAVAILABLE', 'Qualified original worker output authority is unavailable.', 403)
const conflict = () => new DomainError('WORKER_NATIVE_OUTPUT_CONFLICT', 'The original worker output registration or command changed.', 409)
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
async function fileStamp(handle: FileHandle): Promise<string> {
  const stat = await handle.stat({ bigint: true })
  if (!stat.isFile() || stat.nlink !== 1n || (stat.mode & 0o077n) !== 0n || stat.uid !== BigInt(process.getuid!())
    || stat.size > BigInt(MAX_FILE_BYTES)) throw conflict()
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
}

/** Tool-created files only. One turn owns this registry. All operations serialize
 * before mutation; frozen bytes never reopen for write or choose a new path.
 * Mandatory HRT ports qualify security, callback identity and aggregate budgets. */
export class WorkerNativeOutputRegistry implements WorkerNativeArtifactSource {
  private readonly entries = new Map<string, Entry>()
  private readonly commands = new Map<string, Command>()
  private readonly stop = new AbortController()
  private queuedBytes = 0
  private tail: Promise<unknown> = Promise.resolve()
  private closing: Promise<void> | undefined
  private retired = false
  private readonly reads = new Set<Promise<unknown>>()
  private readonly inspections = new Set<FileHandle>()
  private readonly pin: WorkerNativeArtifactCallback
  private constructor(private readonly ports: WorkerNativeOutputPorts, private readonly root: FileHandle,
    private readonly rootIdentity: string, private readonly scope: TemporaryFileScope) {
    this.pin = captureWorkerNativeArtifactCallback(ports.callback)
  }
  static async open(ports: WorkerNativeOutputPorts): Promise<WorkerNativeOutputRegistry> {
    if (CodexHarnessConfigurationSchema.parse(ports.configuration).sandbox !== 'workspace-write') throw denied()
    await ports.callback.assertCurrent(); await ports.authority.assertCurrent('create'); await ports.storage.assertProtected()
    const root = await openPrivateRoot(ports.storage.rootDirectory)
    try {
      const registry = new WorkerNativeOutputRegistry(ports, root, JSON.stringify(await identity(root)), TemporaryFileScopeSchema.parse(ports.scope))
      await registry.check('create'); return registry
    } catch (error) { await root.close(); throw error }
  }
  private signal(signal?: AbortSignal) { return signal ? AbortSignal.any([signal, this.stop.signal]) : this.stop.signal }
  private async check(operation: WorkerNativeOutputCommand['operation'], signal?: AbortSignal, entry?: Entry, call?: WorkerNativeArtifactCallback) {
    const bounded = this.signal(signal); bounded.throwIfAborted()
    // Every Main-backed check is a read: the original callbacks and each guard are verified together,
    // bracketed by the callbacks, so one operation costs a handful of Main round trips, not dozens.
    const current = async () => {
      bounded.throwIfAborted()
      await Promise.all([this.pin.assertCurrent(bounded), call?.assertCurrent(bounded)]); bounded.throwIfAborted()
    }
    const rootIdentityCurrent = async () => {
      const root = await openPrivateRoot(this.ports.storage.rootDirectory)
      this.inspections.add(root)
      try { if (JSON.stringify(await identity(root)) !== this.rootIdentity) throw conflict() }
      finally { await root.close(); this.inspections.delete(root) }
    }
    await current()
    await Promise.all([this.ports.authority.assertCurrent(operation, bounded), this.ports.storage.assertProtected(bounded),
      entry?.reservation.assertCurrent(bounded), rootIdentityCurrent()])
    await current()
  }
  private entry(id: string): Entry {
    const entry = this.entries.get(id)
    if (!entry || entry.failed) throw conflict()
    return entry
  }
  private async sameFile(id: string, entry: Entry) {
    const handle = await open(anchored(this.root, id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    entry.readers.add(handle)
    try { if (await fileStamp(handle) !== entry.stamp || (entry.writer && await fileStamp(entry.writer) !== entry.stamp)) throw conflict() }
    finally { await handle.close(); entry.readers.delete(handle) }
  }
  async dispatch(raw: WorkerNativeOutputCommand, callback: WorkerNativeOutputCallback, signal?: AbortSignal): Promise<WorkerNativeOutputReply> {
    const call = captureWorkerNativeArtifactCallback(callback)
    const command = WorkerNativeOutputCommandSchema.parse(raw)
    const id = command.operation === 'publish' ? command.publication.commandId : command.commandId
    const commandDigest = digest(JSON.stringify(command))
    this.signal(signal).throwIfAborted()
    let record = this.commands.get(id)
    if (record && record.digest !== commandDigest) throw conflict()
    const recheck = async (reply: WorkerNativeOutputReply) => {
      const artifactId = reply.operation === 'publish'
        ? (command as Extract<WorkerNativeOutputCommand, { operation: 'publish' }>).publication.artifactId : reply.artifactId
      await this.check(command.operation, signal, this.entry(artifactId), call)
      return structuredClone(reply)
    }
    if (record?.reply) return recheck(record.reply)
    if (record?.pending) return recheck(await record.pending)
    if (!record) {
      if (this.commands.size >= BYTE_TRANSFER_POLICY.maxRecords) throw denied()
      record = { digest: commandDigest }; this.commands.set(id, record)
    }
    const retained = record
    const queuedBytes = Buffer.byteLength(JSON.stringify(command))
    if (this.queuedBytes + queuedBytes > BYTE_TRANSFER_POLICY.maxQueuedBytes) throw denied()
    this.queuedBytes += queuedBytes
    const pending = this.tail.then(async () => {
      await this.check(command.operation, signal, undefined, call)
      const reply = WorkerNativeOutputReplySchema.parse(await this.execute(command, call, this.signal(signal)))
      retained.reply = reply
      return recheck(reply)
    })
    retained.pending = pending
    this.tail = pending.catch(() => { /* ignore: the previous caller receives its failure; the queue must still admit the next operation. */ }) // Queue continues; original caller receives every failure.
    try { return await pending } finally { delete retained.pending; this.queuedBytes -= queuedBytes }
  }
  private async execute(command: WorkerNativeOutputCommand, call: WorkerNativeArtifactCallback, signal: AbortSignal): Promise<WorkerNativeOutputReply> {
    if (command.operation === 'create') {
      const artifactId = randomUUID()
      const reservation = await this.ports.storage.reserve({ artifactId, maxDiskBytes: MAX_FILE_BYTES,
        maxSnapshotBytes: MAX_FILE_BYTES, maxCommandRecords: BYTE_TRANSFER_POLICY.maxRecords }, signal)
      const entry: Entry = { filename: command.filename, mediaType: command.mediaType, byteSize: 0,
        stamp: '', reservation, readers: new Set(), allocated: false, failed: true }
      this.entries.set(artifactId, entry)
      try {
        await this.check('create', signal, entry, call)
        entry.writer = await open(anchored(this.root, artifactId), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        entry.allocated = true
        entry.stamp = await fileStamp(entry.writer)
        await this.check('create', signal, entry, call)
        delete entry.failed
        return { operation: 'create', artifactId, byteSize: 0 }
      } catch (error) {
        try {
          await this.retire(artifactId, entry)
        } catch (cleanup) { throw new AggregateError([error, cleanup], 'Worker output creation cleanup failed', { cause: cleanup }) }
        throw error
      }
    }
    const id = command.operation === 'publish' ? command.publication.artifactId : command.artifactId
    const entry = this.entry(id)
    await this.check(command.operation, signal, entry, call)
    if (command.operation === 'publish') {
      const publication = AgentFilePublishInputSchema.parse({ ...command.publication, scope: this.scope })
      if (publication.filename !== entry.filename || publication.mediaType !== entry.mediaType
        || !entry.snapshot || (entry.publication && JSON.stringify(entry.publication) !== JSON.stringify(publication))) throw conflict()
      entry.publication = publication
      const result = await this.ports.publisher.publish(publication, call, signal)
      await this.check('publish', signal, entry, call)
      return { operation: 'publish', result }
    }
    if (command.operation === 'seal' && entry.snapshot) return { operation: 'seal', artifactId: id, sha256: entry.sha256!, byteSize: entry.byteSize }
    if (!entry.writer) throw conflict()
    await this.sameFile(id, entry)
    await this.check(command.operation, signal, entry, call)
    const bytes = command.operation === 'append' ? Buffer.from(command.contentBase64, 'base64') : undefined
    if (command.operation === 'append' && (command.offset !== entry.byteSize || entry.byteSize + bytes!.length > MAX_FILE_BYTES)) throw conflict()
    try {
      if (command.operation === 'append') {
        for (let offset = 0; offset < bytes!.length;) {
          const written = await entry.writer.write(bytes!, offset, bytes!.length - offset, entry.byteSize + offset)
          if (!written.bytesWritten) throw conflict()
          offset += written.bytesWritten; await this.check('append', signal, entry, call)
        }
        entry.byteSize += bytes!.length; entry.stamp = await fileStamp(entry.writer)
        await this.check('append', signal, entry, call); await this.sameFile(id, entry)
        return { operation: 'append', artifactId: id, byteSize: entry.byteSize }
      }
      await entry.writer.sync(); await this.check('seal', signal, entry, call)
      await entry.writer.close(); delete entry.writer
      const reader = await open(anchored(this.root, id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      entry.readers.add(reader)
      let snapshot: Buffer
      try {
        if (await fileStamp(reader) !== entry.stamp) throw conflict()
        snapshot = Buffer.alloc(entry.byteSize)
        for (let offset = 0; offset < snapshot.length;) {
          const { bytesRead } = await reader.read(snapshot, offset, Math.min(MAX_NATIVE_OUTPUT_APPEND_BYTES, snapshot.length - offset), offset)
          if (!bytesRead) throw conflict()
          offset += bytesRead; await this.check('seal', signal, entry, call)
        }
        if (await fileStamp(reader) !== entry.stamp) throw conflict()
      } finally { await reader.close(); entry.readers.delete(reader) }
      await this.check('seal', signal, entry, call)
      entry.snapshot = snapshot; entry.sha256 = digest(snapshot)
      return { operation: 'seal', artifactId: id, sha256: entry.sha256, byteSize: entry.byteSize }
    } catch (error) { entry.failed = true; throw error }
  }
  private async readOperation<T>(action: () => Promise<T>): Promise<T> {
    this.stop.signal.throwIfAborted()
    const pending = Promise.resolve().then(action)
    this.reads.add(pending)
    try { return await pending } finally { this.reads.delete(pending) }
  }
  async sealed(publication: AgentFilePublishInput, callback: WorkerNativeArtifactCallback, signal?: AbortSignal): Promise<WorkerNativeArtifactSnapshot> {
    const call = captureWorkerNativeArtifactCallback(callback)
    return this.readOperation(async () => {
      publication = AgentFilePublishInputSchema.parse(publication)
      const entry = this.entry(publication.artifactId)
      await this.check('publish', signal, entry, call)
      if (!entry.snapshot || !entry.publication || JSON.stringify(entry.publication) !== JSON.stringify(publication)) throw conflict()
      const check = async (bounded?: AbortSignal) => { await this.check('publish', bounded, entry, call); if (this.entry(publication.artifactId) !== entry) throw conflict() }
      return { sha256: entry.sha256!, byteSize: entry.byteSize, assertCurrent: bounded => this.readOperation(() => check(bounded)),
        read: (offset, length, bounded) => this.readOperation(async () => {
          await check(bounded)
          const snapshot = entry.snapshot
          if (!snapshot) throw conflict()
          if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
            || length > BYTE_TRANSFER_POLICY.maxChunkBytes || offset + length > snapshot.length) throw conflict()
          return Buffer.from(snapshot.subarray(offset, offset + length))
        }) }
    })
  }
  private async retire(id: string, entry: Entry) {
    if (entry.writer) { await entry.writer.close(); delete entry.writer }
    for (const reader of entry.readers) { await reader.close(); entry.readers.delete(reader) }
    if (entry.allocated && !entry.unlinked) {
      try { await unlink(anchored(this.root, id)) }
      catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error }
      entry.unlinked = true
    }
    delete entry.snapshot
    await entry.reservation.release()
    this.entries.delete(id)
  }
  /** Fence synchronously, then drain and release only this registry's resources. */
  withdraw(): Promise<void> {
    this.stop.abort(denied())
    if (this.retired) return Promise.resolve()
    return this.closing ??= (async () => {
      await this.tail
      await Promise.allSettled([...this.reads])
      this.commands.clear()
      const inspected = await Promise.allSettled([...this.inspections].map(async handle => { await handle.close(); this.inspections.delete(handle) }))
      const results = await Promise.allSettled([...this.entries].map(([id, entry]) => this.retire(id, entry)))
      const errors = [...inspected, ...results].filter(result => result.status === 'rejected').map(result => result.reason)
      if (errors.length) throw new AggregateError(errors, 'Worker output cleanup failed')
      await this.root.close(); this.retired = true
    })().finally(() => { this.closing = undefined })
  }
}
