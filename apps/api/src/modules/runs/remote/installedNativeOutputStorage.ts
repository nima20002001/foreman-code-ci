import { constants } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { lstat, open, mkdir, rmdir, rename, readdir, type FileHandle } from 'node:fs/promises'
import { relative, isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { DeviceSessionBindingSchema, type DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { DispatchIntentSchema, type DispatchIntent } from '@foreman-code/contracts/node-placement'
import { NativeSessionReferenceSchema, type NativeSessionReference } from '@foreman-code/contracts'
import { MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import { BYTE_TRANSFER_POLICY } from '@foreman-code/contracts/byte-transfer'
import { anchored, identity, openPrivateRoot, withPrivateDirectoryLock } from '../../sources/privateFilesystem.js'
import { DomainError } from '../../errors.js'

/** Captured by the actual admitted turn, never supplied in a native command. */
export interface RemoteNativeOutputStorageOwner {
  intent: DispatchIntent
  binding: Readonly<DeviceSessionBinding>
  session: NativeSessionReference
  nativeTurnId: string
  runtimeGeneration: number
}
export interface LocalNativeOutputStorageOwner {
  kind: 'local'
  mainId: string
  executionId: string
  attemptId: string
  placementHash: string
  session: NativeSessionReference
  nativeTurnId: string
  runtimeGeneration: number
}
export type NativeOutputStorageOwner = RemoteNativeOutputStorageOwner | LocalNativeOutputStorageOwner
export interface NativeOutputStorageLimits {
  maxDiskBytes: number
  maxSnapshotBytes: number
  maxCommandRecords: number
}
/** The original durable ledger enforces these limits atomically across ALL turns,
 * instances and crash-left reservations. An in-memory counter is not this port. */
export interface NativeOutputBudgetLedger {
  reserve(input: { owner: NativeOutputStorageOwner; artifactId: string;
    limits: NativeOutputStorageLimits; requested: NativeOutputStorageLimits }, signal?: AbortSignal): Promise<{
    assertCurrent(signal?: AbortSignal): Promise<void>
    release(): Promise<void>
  }>
}
export interface NativeOutputProtection {
  /** Genuine exact-binary qualification plus actual enforced sandbox/root proof;
   * checks original session/process/generation and root identity after awaits. */
  assertProtected(owner: NativeOutputStorageOwner, signal?: AbortSignal): Promise<void>
  /** Original native writers AND snapshot readers are positively stopped. This
   * cleanup proof must still work after withdrawal/revocation, without new grants. */
  assertQuiescent(owner: NativeOutputStorageOwner, artifactId: string): Promise<void>
}
export interface InstalledNativeOutputStorageInput {
  rootDirectory: string
  owner: NativeOutputStorageOwner
  limits: NativeOutputStorageLimits
  budget: NativeOutputBudgetLedger
  protection: NativeOutputProtection
  assertCurrent(signal?: AbortSignal): Promise<void>
}
const unavailable = () => new DomainError('WORKER_NATIVE_OUTPUT_STORAGE_UNAVAILABLE',
  'Original qualified native output storage or budget is unavailable.', 409)
const Limits = z.object({ maxDiskBytes: z.number().int().positive().safe(),
  maxSnapshotBytes: z.number().int().positive().safe(), maxCommandRecords: z.number().int().positive().safe() }).strict()
const ArtifactId = z.uuid()

/** This rejects obvious writable-root overlaps; only actual native qualification
 * can establish enforcement. It never replaces protection.assertProtected. */
export function assertNativeOutputRootExcluded(root: string, writableRoots: readonly string[]): void {
  if (!isAbsolute(root) || writableRoots.some(writable => {
    if (!isAbsolute(writable)) return true
    const fromWritable = relative(writable, root), fromPrivate = relative(root, writable)
    const inside = (value: string) => value === '' || value !== '..' && !value.startsWith('../') && !isAbsolute(value)
    return inside(fromWritable) || inside(fromPrivate)
  })) throw unavailable()
}

/** No directory creation, private-root selection, qualification or budget default.
 * The returned shape is the W09 storage port, independently of producer imports. */
export async function createInstalledNativeOutputStorage(input: InstalledNativeOutputStorageInput) {
  const owner = BudgetOwner.parse(input.owner), limits = Limits.parse(input.limits)
  // The qualified Codex transport numbers its original generation from zero.
  if (!owner.nativeTurnId || !Number.isSafeInteger(owner.runtimeGeneration) || owner.runtimeGeneration < 0
    || owner.session.harness !== 'codex'
    || 'intent' in owner && owner.intent.mainId !== owner.binding.mainId) throw unavailable()
  await input.assertCurrent(); await input.protection.assertProtected(owner)
  const root = await openPrivateRoot(input.rootDirectory)
  let pinned: Awaited<ReturnType<typeof identity>>
  try { pinned = await identity(root) } finally { await root.close() }
  const checkRoot = async () => {
    const current = await openPrivateRoot(input.rootDirectory)
    try { if (!isDeepStrictEqual(await identity(current), pinned)) throw unavailable() }
    finally { await current.close() }
  }
  const assertProtected = async (signal?: AbortSignal) => {
    signal?.throwIfAborted()
    // The Main-backed checks and the local root check are independent reads; the final check closes the bracket.
    await Promise.all([input.assertCurrent(signal), input.protection.assertProtected(owner, signal), checkRoot()])
    signal?.throwIfAborted()
    await input.assertCurrent(signal); signal?.throwIfAborted()
  }
  await assertProtected()
  return {
    rootDirectory: input.rootDirectory,
    assertProtected,
    reserve: async (raw: { artifactId: string } & NativeOutputStorageLimits, signal?: AbortSignal) => {
      const artifactId = ArtifactId.parse(raw.artifactId)
      const requested = Limits.parse({ maxDiskBytes: raw.maxDiskBytes, maxSnapshotBytes: raw.maxSnapshotBytes,
        maxCommandRecords: raw.maxCommandRecords })
      if (requested.maxDiskBytes > MAX_FILE_BYTES || requested.maxSnapshotBytes > MAX_FILE_BYTES
        || requested.maxCommandRecords > BYTE_TRANSFER_POLICY.maxRecords
        || Object.keys(requested).some(key => requested[key as keyof NativeOutputStorageLimits] > limits[key as keyof NativeOutputStorageLimits])) throw unavailable()
      await assertProtected(signal)
      const reservation = await input.budget.reserve({ owner: structuredClone(owner), artifactId,
        limits: { ...limits }, requested }, signal)
      // Failed post-reservation checks retain the durable charge. No bytes are
      // exposed and no uncertain release is inferred from this request failure.
      await assertProtected(signal); await reservation.assertCurrent(signal)
      return {
        assertCurrent: async (bounded?: AbortSignal) => {
          await assertProtected(bounded); await reservation.assertCurrent(bounded)
          await assertProtected(bounded)
        },
        release: async () => {
          // Cleanup does not depend on a live mutation grant. Original positive
          // closure plus absent bytes is required, including retries after stop.
          await input.protection.assertQuiescent(owner, artifactId)
          await checkRoot()
          const directory = await openPrivateRoot(input.rootDirectory)
          try {
            if (!isDeepStrictEqual(await identity(directory), pinned)) throw unavailable()
            try { await lstat(anchored(directory, artifactId)); throw unavailable() }
            catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error }
            await input.protection.assertQuiescent(owner, artifactId)
            await checkRoot()
            await reservation.release()
          } finally { await directory.close() }
        },
      }
    },
  }
}

const RemoteBudgetOwner = z.object({ intent: DispatchIntentSchema, binding: DeviceSessionBindingSchema,
  session: NativeSessionReferenceSchema, nativeTurnId: z.string().min(1).max(500), runtimeGeneration: z.number().int().nonnegative() }).strict()
const LocalBudgetOwner = z.object({ kind: z.literal('local'), mainId: z.uuid(),
  executionId: z.string().min(1), attemptId: z.string().min(1), placementHash: z.string().regex(/^[a-f0-9]{64}$/),
  session: NativeSessionReferenceSchema, nativeTurnId: z.string().min(1).max(500),
  runtimeGeneration: z.number().int().nonnegative() }).strict()
const BudgetOwner = z.union([RemoteBudgetOwner, LocalBudgetOwner])
const BudgetRecord = z.object({ artifactId: ArtifactId, owner: BudgetOwner, requested: Limits, released: z.boolean() }).strict()
const Installation = z.union([
  DeviceSessionBindingSchema.pick({ mainId: true, deviceId: true, workerInstallationId: true }),
  z.object({ kind: z.literal('local'), mainId: z.uuid() }).strict(),
])
export type NativeOutputBudgetInstallation = z.infer<typeof Installation>
const BudgetJournal = z.object({ version: z.literal(1), installation: Installation, limits: Limits,
  records: z.array(BudgetRecord).max(BYTE_TRANSFER_POLICY.maxRecords).refine(records => new Set(records.map(record => record.artifactId)).size === records.length) }).strict()

function matchesInstallation(owner: NativeOutputStorageOwner, installation: NativeOutputBudgetInstallation): boolean {
  if ('kind' in installation) return 'kind' in owner && owner.mainId === installation.mainId
  if ('kind' in owner) return false
  return owner.intent.mainId === installation.mainId && isDeepStrictEqual({ mainId: owner.binding.mainId,
    deviceId: owner.binding.deviceId, workerInstallationId: owner.binding.workerInstallationId }, installation)
}

/** Concrete worker-private ledger. The installation supplies explicit caps and
 * an established protected root. No age/TTL reclaim, new turn rebinding or
 * in-memory aggregate counter; crash-left reservations and locks stay charged. */
export async function createNativeOutputBudgetLedger(input: {
  rootDirectory: string
  installation: z.infer<typeof Installation>
  limits: NativeOutputStorageLimits
  initializeNewStore?: true
  signal?: AbortSignal | undefined
}): Promise<NativeOutputBudgetLedger> {
  const installation = Installation.parse(input.installation), limits = Limits.parse(input.limits)
  if (limits.maxDiskBytes > BYTE_TRANSFER_POLICY.maxStagingBytes || limits.maxSnapshotBytes > BYTE_TRANSFER_POLICY.maxStagingBytes
    || limits.maxCommandRecords > BYTE_TRANSFER_POLICY.maxRecords * BYTE_TRANSFER_POLICY.maxActiveGlobal) throw unavailable()
  const initial = await openPrivateRoot(input.rootDirectory)
  let pinned: Awaited<ReturnType<typeof identity>>
  try { pinned = await identity(initial) } finally { await initial.close() }
  const locked = async <T>(operation: (root: FileHandle, files: Set<FileHandle>) => Promise<T>, signal?: AbortSignal) => {
    const root = await openPrivateRoot(input.rootDirectory)
    try {
      if (!isDeepStrictEqual(await identity(root), pinned)) throw unavailable()
      return await withPrivateDirectoryLock(root, async () => {
        const current = await openPrivateRoot(input.rootDirectory)
        try { if (!isDeepStrictEqual(await identity(current), pinned)) throw unavailable() }
        finally { await current.close() }
        const files = new Set<FileHandle>()
        let acquired = false
        try {
          // A surviving marker belongs to a crashed operation; the kernel lock only waits for live owners.
          await mkdir(anchored(root, '.native-output-budget.lock'), { mode: 0o700 })
          acquired = true
          await root.sync()
          return await operation(root, files)
        } finally {
          if (acquired && files.size === 0) {
            await rmdir(anchored(root, '.native-output-budget.lock'))
            await root.sync()
          }
        }
      }, { signal })
    } finally { await root.close() }
  }
  const close = async (file: FileHandle, files: Set<FileHandle>) => { await file.close(); files.delete(file) }
  const read = async (root: FileHandle, files: Set<FileHandle>) => {
    const file = await open(anchored(root, '.native-output-budget.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    files.add(file)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.uid !== process.getuid?.()
        || stat.size > BYTE_TRANSFER_POLICY.maxRecords * 16_384) throw unavailable()
      const envelope = z.object({ checksum: z.string().regex(/^[a-f0-9]{64}$/), payload: BudgetJournal }).strict().parse(JSON.parse(await file.readFile('utf8')))
      if (createHash('sha256').update(JSON.stringify(envelope.payload)).digest('hex') !== envelope.checksum) throw unavailable()
      const journal = envelope.payload
      if (!isDeepStrictEqual(journal.installation, installation) || !isDeepStrictEqual(journal.limits, limits)) throw unavailable()
      return journal
    } finally { await close(file, files) }
  }
  const save = async (root: FileHandle, files: Set<FileHandle>, journal: z.infer<typeof BudgetJournal>) => {
    const name = `.native-output-budget-${randomUUID()}.tmp`, payload = BudgetJournal.parse(journal)
    const encoded = JSON.stringify({ checksum: createHash('sha256').update(JSON.stringify(payload)).digest('hex'), payload })
    if (Buffer.byteLength(encoded) > BYTE_TRANSFER_POLICY.maxRecords * 16_384) throw unavailable()
    const file = await open(anchored(root, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    files.add(file)
    try { await file.writeFile(encoded); await file.sync() } finally { await close(file, files) }
    await rename(anchored(root, name), anchored(root, '.native-output-budget.json')); await root.sync()
  }
  await locked(async (root, files) => {
    try { await read(root, files) }
    catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') || !input.initializeNewStore) throw error
      const entries = await readdir(anchored(root))
      if (!isDeepStrictEqual(entries, ['.native-output-budget.lock'])) throw unavailable()
      await save(root, files, { version: 1, installation, limits, records: [] })
    }
  }, input.signal)
  return { reserve: async (raw, signal) => {
    const owner = BudgetOwner.parse(raw.owner), requested = Limits.parse(raw.requested), artifactId = ArtifactId.parse(raw.artifactId)
    if (owner.session.harness !== 'codex' || !matchesInstallation(owner, installation)
      || !isDeepStrictEqual(raw.limits, limits)) throw unavailable()
    const exact = (record: z.infer<typeof BudgetRecord> | undefined) => {
      if (!record || record.released || !isDeepStrictEqual(record.owner, owner) || !isDeepStrictEqual(record.requested, requested)) throw unavailable()
      return record
    }
    signal?.throwIfAborted()
    await locked(async (root, files) => {
      const journal = await read(root, files), existing = journal.records.find(record => record.artifactId === artifactId)
      if (existing) { exact(existing); return }
      if (journal.records.length >= BYTE_TRANSFER_POLICY.maxRecords) throw unavailable()
      for (const key of ['maxDiskBytes', 'maxSnapshotBytes', 'maxCommandRecords'] as const) {
        const reserved = journal.records.filter(record => !record.released).reduce((sum, record) => sum + record.requested[key], 0)
        if (reserved + requested[key] > limits[key]) throw unavailable()
      }
      signal?.throwIfAborted()
      journal.records.push({ artifactId, owner, requested, released: false }); await save(root, files, journal)
      signal?.throwIfAborted()
    }, signal)
    return {
      assertCurrent: async bounded => {
        bounded?.throwIfAborted()
        await locked(async (root, files) => {
          exact((await read(root, files)).records.find(record => record.artifactId === artifactId))
          bounded?.throwIfAborted()
        }, bounded)
      },
      release: async () => {
        await locked(async (root, files) => {
          const journal = await read(root, files), record = journal.records.find(record => record.artifactId === artifactId)
          if (!record || !isDeepStrictEqual(record.owner, owner) || !isDeepStrictEqual(record.requested, requested)) throw unavailable()
          if (record.released) return
          record.released = true; await save(root, files, journal)
        })
      },
    }
  } }
}
