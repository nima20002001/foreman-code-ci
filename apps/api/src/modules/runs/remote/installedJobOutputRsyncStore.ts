import { constants } from 'node:fs'
import { open, mkdir, rmdir, unlink, lstat, type FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { BYTE_TRANSFER_POLICY, TransferIntentSchema, type TransferIntent, type TransferContext } from '@foreman-code/contracts/byte-transfer'
import { JobOutputPublicationInputSchema } from '@foreman-code/contracts/job-output-transfer'
import { FileSha256Schema } from '@foreman-code/contracts/files'
import type { ResumableByteTransferService } from '../../byte-transfer/service.js'
import { anchored, identity, openPrivateRoot } from '../../sources/privateFilesystem.js'
import { DomainError } from '../../errors.js'
import type { RetainedJobOutputRsyncRecord, RetainedJobOutputRsyncStore } from './jobOutputRsyncSource.js'

const RecordSchema = z.object({ intent: TransferIntentSchema, input: JobOutputPublicationInputSchema,
  operationId: z.string().min(1), specDigest: FileSha256Schema, closureEvidenceDigest: FileSha256Schema }).strict()
const conflict = () => new DomainError('JOB_OUTPUT_RETENTION_CONFLICT', 'Original retained Job output or stopped-reader proof is unavailable.', 409)
const missing = (error: unknown) => error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
async function regular(path: string, flags: number, handles: Set<FileHandle>) {
  const file = await open(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  handles.add(file)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.uid !== process.getuid?.()) throw conflict()
    return file
  } catch (error) { await closed(file, handles); throw error }
}
async function closed(file: FileHandle, handles: Set<FileHandle>) {
  await file.close(); handles.delete(file)
}
async function verified(file: FileHandle, intent: TransferIntent, signal?: AbortSignal) {
  const before = await file.stat({ bigint: true })
  if (before.size !== BigInt(intent.byteSize)) throw conflict()
  const hash = createHash('sha256'), chunk = Buffer.alloc(Math.min(BYTE_TRANSFER_POLICY.maxChunkBytes, Math.max(1, intent.byteSize)))
  for (let offset = 0; offset < intent.byteSize;) {
    signal?.throwIfAborted()
    const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, intent.byteSize - offset), offset)
    if (!bytesRead) throw conflict()
    hash.update(chunk.subarray(0, bytesRead)); offset += bytesRead
  }
  const after = await file.stat({ bigint: true })
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs || after.nlink !== 1n || hash.digest('hex') !== intent.sha256) throw conflict()
}
export interface InstalledJobOutputRsyncStorePorts {
  /** Explicit original approved immutable-store root. Never initialized or renamed here. */
  rootDirectory: string
  /** SAME original quota journal as the rsync snapshot; source hold covers both copies. */
  quota: ResumableByteTransferService
  current(signal?: AbortSignal): Promise<TransferContext>
  authorize(intent: TransferIntent, context: TransferContext, signal?: AbortSignal): Promise<void>
  /** Actual original writer/reader closure, independent of canonical ACK. */
  quiescent(intent: TransferIntent, signal?: AbortSignal): Promise<void>
}

/** Retains closed captured bytes, not current workspace paths. Crash-left locks
 * remain charged/fail closed; this store never steals or ages out a lock. */
export async function createInstalledJobOutputRsyncStore(ports: InstalledJobOutputRsyncStorePorts): Promise<RetainedJobOutputRsyncStore & {
  retire(intent: TransferIntent, signal?: AbortSignal): Promise<void>
}> {
  const root = await openPrivateRoot(ports.rootDirectory)
  let pinned: Awaited<ReturnType<typeof identity>>
  try { pinned = await identity(root) } finally { await root.close() }
  const directory = async () => {
    const current = await openPrivateRoot(ports.rootDirectory)
    try { if (!isDeepStrictEqual(await identity(current), pinned)) throw conflict(); return current }
    catch (error) { await current.close(); throw error }
  }
  const authorize = async (intent: TransferIntent, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    await ports.authorize(intent, await ports.current(signal), signal)
    signal?.throwIfAborted()
  }
  const locked = async <T>(id: string, action: (directory: FileHandle, bytes: string, metadata: string, handles: Set<FileHandle>) => Promise<T>) => {
    z.uuid().parse(id)
    const dir = await directory(), lock = anchored(dir, `${id}.retained.lock`)
    let acquired = false
    const handles = new Set<FileHandle>()
    try {
      await mkdir(lock, { mode: 0o700 }); acquired = true; await dir.sync()
      return await action(dir, anchored(dir, `${id}.retained.bytes`), anchored(dir, `${id}.retained.json`), handles)
    } finally {
      try { if (acquired && handles.size === 0) { await rmdir(lock); await dir.sync() } } finally { await dir.close() }
    }
  }
  const recordAt = async (path: string, handles: Set<FileHandle>) => {
    const file = await regular(path, constants.O_RDONLY, handles)
    try { if ((await file.stat()).size > 65_536) throw conflict(); return RecordSchema.parse(JSON.parse(await file.readFile('utf8'))) }
    finally { await closed(file, handles) }
  }
  return {
    retain: async (raw, captured, signal) => {
      const record = RecordSchema.parse(raw), intent = record.intent
      if (intent.direction !== 'to-main' || intent.byteClass !== 'artifact' || record.input.sha256 !== intent.sha256
        || record.input.byteSize !== intent.byteSize || captured.byteLength !== intent.byteSize) throw conflict()
      const immutableBytes = Buffer.from(captured)
      if (createHash('sha256').update(immutableBytes).digest('hex') !== intent.sha256) throw conflict()
      await authorize(intent, signal)
      await ports.quota.reserve(intent, await ports.current(signal), { kind: 'rsync-source', byteSize: intent.byteSize * 2 })
      await locked(intent.transferId, async (dir, bytesPath, metadata, handles) => {
        await authorize(intent, signal)
        let original: RetainedJobOutputRsyncRecord | undefined
        try { original = await recordAt(metadata, handles) } catch (error) { if (!missing(error)) throw error }
        if (original && !isDeepStrictEqual(original, record)) throw conflict()
        if (!original) {
          const encoded = JSON.stringify(record)
          if (Buffer.byteLength(encoded) > 65_536) throw conflict()
          const file = await regular(metadata, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, handles)
          try { await file.writeFile(encoded); await file.sync() } finally { await closed(file, handles) }
          await dir.sync()
        }
        let bytes: FileHandle
        try { bytes = await regular(bytesPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, handles) }
        catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error
          bytes = await regular(bytesPath, constants.O_RDONLY, handles)
          try { await verified(bytes, intent, signal); await authorize(intent, signal) } finally { await closed(bytes, handles) }
          await dir.sync(); return
        }
        try { await bytes.writeFile(immutableBytes); await bytes.sync(); await verified(bytes, intent, signal) }
        finally { await closed(bytes, handles) }
        await dir.sync(); await authorize(intent, signal)
      })
    },
    resolve: async (transferId, signal) => {
      const record = await locked(transferId, async (_dir, bytesPath, metadata, handles) => {
        const original = await recordAt(metadata, handles)
        if (original.intent.transferId !== transferId) throw conflict()
        await authorize(original.intent, signal)
        const bytes = await regular(bytesPath, constants.O_RDONLY, handles)
        try { await verified(bytes, original.intent, signal) } finally { await closed(bytes, handles) }
        await authorize(original.intent, signal); return original
      })
      return { record, source: { read: async (intent, offset, length, bounded) => {
        if (!isDeepStrictEqual(intent, record.intent) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
          || offset < 0 || length < 1 || length > BYTE_TRANSFER_POLICY.maxChunkBytes || offset + length > intent.byteSize) throw conflict()
        return locked(transferId, async (_dir, bytesPath, metadata, handles) => {
          if (!isDeepStrictEqual(await recordAt(metadata, handles), record)) throw conflict()
          await authorize(intent, bounded)
          const bytes = await regular(bytesPath, constants.O_RDONLY, handles)
          try {
            await verified(bytes, intent, bounded)
            const chunk = Buffer.alloc(length), { bytesRead } = await bytes.read(chunk, 0, length, offset)
            if (bytesRead !== length) throw conflict()
            await verified(bytes, intent, bounded); await authorize(intent, bounded)
            return chunk
          } finally { await closed(bytes, handles) }
        })
      } } }
    },
    retire: async (input, signal) => {
      const intent = TransferIntentSchema.parse(input)
      await locked(intent.transferId, async (dir, bytesPath, metadata, handles) => {
        await ports.quiescent(intent, signal)
        let record: RetainedJobOutputRsyncRecord
        try { record = await recordAt(metadata, handles) }
        catch (error) {
          if (!missing(error)) throw error
          try { await lstat(bytesPath); throw conflict() } catch (absent) { if (!missing(absent)) throw absent }
          await dir.sync(); return
        }
        if (!isDeepStrictEqual(record.intent, intent)) throw conflict()
        await unlink(bytesPath).catch(error => { if (!missing(error)) throw error })
        await unlink(metadata); await dir.sync()
        // The backend still owns its snapshot copy. It alone releases the shared
        // hold after BOTH stores/readers are positively retired.
      })
    },
  }
}
