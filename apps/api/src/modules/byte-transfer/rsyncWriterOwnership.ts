import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import type { FileHandle } from 'node:fs/promises'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { z } from 'zod'
import { BYTE_TRANSFER_POLICY as POLICY, TransferIntentSchema, type TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { DeviceSessionBindingSchema, type DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { bootIdentity, identityAlive, processIdentity } from '../harnesses/recovery/linuxIdentity.js'
import { cgroupPopulated } from '../harnesses/recovery/cgroupBoundary.js'
import { NativeProcessRegistry, spawnNativeProcess, nativeProcessExit,
  type NativeProcessRecovery } from '../harnesses/recovery/processRegistry.js'
import { privateDirectory, readRecord, syncDirectory, writeRecord } from '../harnesses/recovery/storage.js'

const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const Identity = z.object({ pid: z.number().int().min(2), startTicks: z.string().regex(/^\d+$/) }).strict()
const Root = z.object({ device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/) }).strict()
const Binary = z.object({ executable: z.string().regex(/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/), sha256: Hash, commandDigest: Hash.optional() }).strict()
const Owner = z.object({ version: z.literal(1), ownerId: z.uuid(), intent: TransferIntentSchema,
  binding: DeviceSessionBindingSchema, hostBootId: z.uuid(), issuer: Identity, root: Root,
  role: z.enum(['rsync-client', 'rsync-server', 'snapshot', 'receiver', 'source-materializer']), binary: Binary.optional() }).strict()
const Reference = z.object({ transferId: z.uuid(), ownerId: z.uuid(), ownerDigest: Hash }).strict()
const Claim = Reference.extend({ version: z.literal(1), mode: z.enum(['cancelled', 'process']),
  hostBootId: z.uuid(), parent: Identity }).strict()
const Launch = Reference.extend({ version: z.literal(1), launchId: z.uuid() }).strict()
const Closed = Reference.extend({ version: z.literal(1), evidence: z.enum(['access-drained', 'access-process-gone',
  'host-boot-changed', 'never-dispatched', 'rsync-process-closed']), launchId: z.uuid().optional() }).strict()
const Revoked = Reference.extend({ version: z.literal(1) }).strict()
const Waiting = Reference.extend({ version: z.literal(1), nonce: z.uuid(), hostBootId: z.uuid(), process: Identity }).strict()
const Grant = Waiting.extend({ issuer: Identity, binding: DeviceSessionBindingSchema,
  grantedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative() }).strict()
const Lock = Reference.extend({ version: z.literal(1), root: Root, lock: Root }).strict()
const Cleanup = z.object({ version: z.literal(1), sequence: z.number().int().min(1).max(POLICY.maxRecords),
  intent: TransferIntentSchema, root: Root, hostBootId: z.uuid(), issuer: Identity }).strict()
const CleanupProof = z.object({ version: z.literal(1), transferId: z.uuid(), sequence: z.number().int().min(1), ownerDigest: Hash,
  evidence: z.enum(['access-drained', 'access-process-gone', 'host-boot-changed']) }).strict()
const CleanupLock = CleanupProof.omit({ evidence: true }).extend({ root: Root, lock: Root }).strict()
export type RsyncOwnerReference = z.infer<typeof Reference>
export interface RsyncProcessLaunch extends RsyncOwnerReference { ownership: RsyncWriterOwnership }
export interface RsyncRemoteWriter extends RsyncOwnerReference { nodeBinary: string; entryPoint: string }
export interface RsyncAccessLease {
  readonly reference: RsyncOwnerReference
  readonly signal: AbortSignal
  run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T>
  attach(handle: FileHandle): void
  captureLock(): void
  close(signal?: AbortSignal): Promise<void>
}
export interface RsyncStoreOwnership {
  access(intent: TransferIntent, role: 'snapshot' | 'receiver'): RsyncAccessLease
  processesQuiescent(intent: TransferIntent, signal: AbortSignal, requireProcess?: boolean): Promise<void>
  quiescent(intent: TransferIntent, signal: AbortSignal): Promise<void>
  assertLock(intent: TransferIntent): void
  captureRetirementLock(intent: TransferIntent): void
  captureRetirementHandle(intent: TransferIntent, handle: FileHandle): void
  retire<T>(intent: TransferIntent, work: () => Promise<T>): Promise<T>
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const self = () => {
  const found = processIdentity(process.pid)
  if (!found) throw new Error('Rsync owner process identity unavailable')
  return Identity.parse({ pid: found.pid, startTicks: found.startTicks })
}
/** Bounds the caller's wait only. The admitted physical work remains tracked and cannot
 * become closure evidence until it actually settles and its descriptors are closed. */
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {}
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new Error('Rsync drain interrupted'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  try { return await Promise.race([work, cancelled]) }
  finally { signal.removeEventListener('abort', abort) }
}
const certificate = (path: string) => {
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077n) || stat.uid !== BigInt(process.getuid!())) throw new Error('Unsafe rsync ownership directory')
  return { device: stat.dev.toString(), inode: stat.ino.toString() }
}

/** Metadata only, under the installed private staging root. Quota remains the existing supervisor.
 * A new generic kernel registration is created for THIS actual rsync process tree; an unrelated
 * native Job/container close is never accepted as byte-writer closure. No timer or recovery spawn. */
export class RsyncWriterOwnership {
  private readonly root: string
  private readonly journal: string
  private readonly rootIdentity: z.infer<typeof Root>
  private readonly processes: NativeProcessRegistry
  private readonly accesses = new Map<string, RsyncAccessLease>()
  private draining = false
  private readonly stopping = new Set<string>()
  private readonly cleanups = new Map<string, { row: z.infer<typeof Cleanup>; work: Promise<unknown>; handles: Set<FileHandle>; settled: boolean }>()
  private readonly drainedCleanups = new Set<string>()
  constructor(root: string, private readonly current: (deviceId: string) => Readonly<DeviceSessionBinding> | undefined) {
    if (process.platform !== 'linux') throw new Error('Rsync writer ownership requires Linux')
    this.root = privateDirectory(resolve(root)); this.rootIdentity = certificate(this.root)
    this.journal = privateDirectory(join(this.root, '.rsync-writers'))
    this.processes = new NativeProcessRegistry(join(this.journal, '.processes'))
  }
  private directory(intent: TransferIntent) { return join(this.journal, intent.transferId) }
  private pin() {
    if (!isDeepStrictEqual(certificate(this.root), this.rootIdentity)) throw new Error('Rsync ownership root changed')
    privateDirectory(this.root); privateDirectory(this.journal)
  }
  assertRoot(root: string) {
    this.pin()
    if (resolve(root) !== this.root) throw new Error('Rsync ownership differs from the installed staging root')
  }
  private original(input: TransferIntent): TransferIntent {
    this.pin()
    const i = TransferIntentSchema.parse(input), raw = readRecord(join(this.directory(i), 'intent.json'))
    if (!raw || !isDeepStrictEqual(TransferIntentSchema.parse(raw), i)) throw new Error('Original rsync owner intent unavailable or changed')
    privateDirectory(this.directory(i))
    return i
  }
  private admissible(i: TransferIntent) {
    if (this.draining || this.stopping.has(i.transferId) || Date.now() >= Date.parse(i.expiresAt) || Date.parse(i.expiresAt) - Date.now() > POLICY.maxLifetimeMs
      || readRecord(join(this.directory(i), 'retiring.json')) !== undefined) throw new Error('Rsync writer admission is closed')
  }
  private binding(i: TransferIntent, input: Readonly<DeviceSessionBinding>) {
    const b = DeviceSessionBindingSchema.parse(input)
    if (!isDeepStrictEqual(this.current(i.deviceId), b)) throw new Error('Rsync writer binding is not current')
    for (const key of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const) {
      if (b[key] !== i[key]) throw new Error('Rsync writer principal differs from original transfer')
    }
    return b
  }
  private read(reference: RsyncOwnerReference) {
    this.pin()
    const ref = Reference.parse({ transferId: reference.transferId, ownerId: reference.ownerId, ownerDigest: reference.ownerDigest })
    const directory = join(this.journal, ref.transferId)
    const i = this.original(TransferIntentSchema.parse(readRecord(join(directory, 'intent.json'))))
    const row = Owner.parse(readRecord(join(directory, `${ref.ownerId}.owner`)))
    if (row.ownerId !== ref.ownerId || i.transferId !== ref.transferId || digest(row) !== ref.ownerDigest
      || !isDeepStrictEqual(row.intent, i) || !isDeepStrictEqual(row.root, this.rootIdentity)) throw new Error('Rsync owner identity conflicts')
    return { row, ref, path: join(directory, ref.ownerId) }
  }

  private references(i: TransferIntent): RsyncOwnerReference[] {
    const references: RsyncOwnerReference[] = []
    for (const name of readdirSync(this.directory(i))) {
      if (!name.endsWith('.owner')) continue
      const row = Owner.parse(readRecord(join(this.directory(i), name)))
      if (name !== `${row.ownerId}.owner` || !isDeepStrictEqual(row.intent, i)) throw new Error('Rsync owner inventory conflicts')
      references.push({ transferId: i.transferId, ownerId: row.ownerId, ownerDigest: digest(row) })
      if (references.length > POLICY.maxRecords) throw new Error('Rsync owner inventory exceeds policy')
    }
    return references
  }
  private prepare(input: TransferIntent, binding: Readonly<DeviceSessionBinding>, role: z.infer<typeof Owner>['role'], binary?: z.infer<typeof Binary>) {
    this.pin()
    const i = TransferIntentSchema.parse(input), b = this.binding(i, binding)
    if (this.inventory().length >= POLICY.maxRecords && !readRecord(join(this.directory(i), 'intent.json'))) throw new Error('Rsync owner inventory exceeds policy')
    this.admissible(i)
    const path = join(this.directory(i), 'intent.json'), original = readRecord(path)
    if (original === undefined) {
      if (readdirSync(this.root).some(name => name.startsWith(`${i.transferId}.`))) throw new Error('Unregistered rsync residue retains its original hold')
      privateDirectory(this.directory(i)); writeRecord(path, i, true)
    }
    else this.original(i)
    if (this.references(i).length >= POLICY.maxRecords) throw new Error('Rsync owner history exceeds policy')
    const row = Owner.parse({ version: 1, ownerId: randomUUID(), intent: i, binding: b,
      hostBootId: bootIdentity(), issuer: self(), root: this.rootIdentity, role, ...(binary ? { binary } : {}) })
    writeRecord(join(this.directory(i), `${row.ownerId}.owner`), row, true)
    return { transferId: i.transferId, ownerId: row.ownerId, ownerDigest: digest(row) }
  }
  prepareProcess(i: TransferIntent, binding: Readonly<DeviceSessionBinding>, role: 'rsync-client' | 'rsync-server', binary: z.infer<typeof Binary>): RsyncProcessLaunch {
    this.pin()
    const b = this.binding(i, binding), pin = Binary.parse(binary)
    this.admissible(i)
    if (role === 'rsync-client' && !binary.commandDigest) throw new Error('Original rsync client command pin unavailable')
    const existing = readRecord(join(this.directory(TransferIntentSchema.parse(i)), 'intent.json'))
    let prepared: RsyncOwnerReference | undefined
    if (existing !== undefined) for (const old of this.references(this.original(i))) {
      const { row, path } = this.read(old)
      if (row.role === role) {
        const closed = readRecord(`${path}.closed`)
        if (closed === undefined) {
          // Lost prepare ACK reads back the SAME reservation. A claim/launch is never replayed.
          if (row.hostBootId === bootIdentity() && isDeepStrictEqual(row.issuer, self())
            && isDeepStrictEqual(row.binding, b) && isDeepStrictEqual(row.binary, pin)
            && !this.revoked(old) && readRecord(`${path}.claim`) === undefined && readRecord(`${path}.launch`) === undefined) {
            if (prepared) throw new Error('An original rsync process owner is still active or unconfirmed')
            prepared = old
            continue
          }
          throw new Error('An original rsync process owner is still active or unconfirmed')
        }
        this.assertClosed(old, closed)
      }
    }
    if (prepared) { syncDirectory(this.directory(i)); return { ...prepared, ownership: this } }
    const ref = this.prepare(i, b, role, pin)
    this.admissible(i)
    return { ...ref, ownership: this }
  }
  private scope(reference: RsyncOwnerReference, launchId?: string): NativeProcessRecovery {
    return { root: join(this.journal, '.processes'), owner: `rsync:${reference.transferId}:${reference.ownerId}:${reference.ownerDigest}`, ...(launchId ? { launchId } : {}) }
  }
  private assertClosed(reference: RsyncOwnerReference, raw: unknown) {
    const { row, ref, path } = this.read(reference), proof = Closed.parse(raw)
    if (proof.transferId !== ref.transferId || proof.ownerId !== ref.ownerId || proof.ownerDigest !== ref.ownerDigest) throw new Error('Rsync close owner mismatch')
    if (proof.evidence === 'rsync-process-closed') {
      const launch = Launch.parse(readRecord(`${path}.launch`)), scope = this.scope(ref, launch.launchId)
      const retired = readRecord(join(scope.root, digestBytes(Buffer.from(scope.owner)), 'retired.json')) as Record<string, unknown> | undefined
      if (!row.binary || launch.transferId !== ref.transferId || launch.ownerId !== ref.ownerId || launch.ownerDigest !== ref.ownerDigest
        || proof.launchId !== launch.launchId || retired?.format !== 2 || retired.owner !== scope.owner || retired.id !== launch.launchId) throw new Error('Original rsync process retirement proof unavailable')
    } else if (proof.evidence === 'never-dispatched') {
      const claim = Claim.parse(readRecord(`${path}.claim`))
      if (!row.binary || claim.transferId !== ref.transferId || claim.ownerId !== ref.ownerId || claim.ownerDigest !== ref.ownerDigest
        || (claim.mode !== 'cancelled' && (readRecord(`${path}.launch`) !== undefined
          || (claim.hostBootId === bootIdentity() && identityAlive(claim.parent))))) throw new Error('Original rsync no-dispatch proof unavailable')
    } else if (proof.evidence === 'host-boot-changed') {
      if (row.hostBootId === bootIdentity()) throw new Error('Original rsync boot-change proof unavailable')
    } else if (row.binary) throw new Error('In-process drain cannot close an rsync subprocess')
    syncDirectory(this.directory(row.intent))
  }
  private closed(reference: RsyncOwnerReference, evidence: z.infer<typeof Closed>['evidence'], launchId?: string) {
    const { path, ref } = this.read(reference), value = { version: 1 as const, ...ref, evidence, ...(launchId ? { launchId } : {}) }
    const old = readRecord(`${path}.closed`)
    if (old !== undefined) {
      this.assertClosed(ref, old)
      return
    }
    try { writeRecord(`${path}.closed`, value, true) }
    catch (error) {
      const persisted = readRecord(`${path}.closed`)
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || persisted === undefined) throw error
      this.assertClosed(ref, persisted)
    }
  }
  private revoked(reference: RsyncOwnerReference) {
    const { path, ref } = this.read(reference), raw = readRecord(`${path}.revoked`)
    if (raw === undefined) return false
    const row = Revoked.parse(raw)
    if (!isDeepStrictEqual(row, { version: 1, ...ref })) throw new Error('Rsync writer revocation owner conflicts')
    return true
  }
  private revoke(reference: RsyncOwnerReference) {
    const { path, ref, row } = this.read(reference)
    if (!this.revoked(ref)) try { writeRecord(`${path}.revoked`, { version: 1, ...ref }, true) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !this.revoked(ref)) throw error }
    if (row.binary && readRecord(`${path}.claim`) === undefined) {
      try { writeRecord(`${path}.claim`, { version: 1, ...ref, mode: 'cancelled', hostBootId: bootIdentity(), parent: self() }, true) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
  }
  /** Existing W07 handler resolves the sole original reservation; no PID/path comes from RPC. */
  serverAdmission(input: TransferIntent, binding: Readonly<DeviceSessionBinding>): RsyncOwnerReference {
    const i = this.original(input), b = this.binding(i, binding)
    this.admissible(i)
    const pending = this.references(i).filter(ref => {
      const { row, path } = this.read(ref), closed = readRecord(`${path}.closed`)
      if (row.role !== 'rsync-server') return false
      if (closed !== undefined) { this.assertClosed(ref, closed); return false }
      return true
    })
    if (pending.length !== 1) throw new Error('Exact pending rsync server ownership unavailable')
    const ref = pending[0]!, { row, path } = this.read(ref)
    if (!row.binary || row.hostBootId !== bootIdentity() || !isDeepStrictEqual(row.issuer, self())
      || !isDeepStrictEqual(row.binding, b) || this.revoked(ref) || readRecord(`${path}.claim`) !== undefined) {
      throw new Error('Original rsync server admission is no longer current')
    }
    return ref
  }
  private waiting(reference: RsyncOwnerReference, raw: unknown) {
    const { row, ref } = this.read(reference), waiting = Waiting.parse(raw)
    if (!isDeepStrictEqual(Reference.parse({ transferId: waiting.transferId, ownerId: waiting.ownerId, ownerDigest: waiting.ownerDigest }), ref)
      || waiting.hostBootId !== row.hostBootId || waiting.hostBootId !== bootIdentity() || !identityAlive(waiting.process)) {
      throw new Error('Original rsync waiting process unavailable or changed')
    }
    return waiting
  }
  private grant(reference: RsyncOwnerReference, raw: unknown) {
    const { row, path } = this.read(reference), grant = Grant.parse(raw)
    const waiting = this.waiting(reference, readRecord(`${path}.waiting`))
    if (!isDeepStrictEqual(Waiting.parse({ version: grant.version, transferId: grant.transferId, ownerId: grant.ownerId,
      ownerDigest: grant.ownerDigest, nonce: grant.nonce, hostBootId: grant.hostBootId, process: grant.process }), waiting)
      || !isDeepStrictEqual(grant.binding, row.binding) || !isDeepStrictEqual(grant.issuer, row.issuer)
      || !identityAlive(grant.issuer) || Date.now() < grant.grantedAt || Date.now() >= grant.expiresAt
      || grant.expiresAt - grant.grantedAt > 5000 || grant.expiresAt > Date.parse(row.intent.expiresAt)) {
      throw new Error('Original rsync server grant unavailable or stale')
    }
    syncDirectory(this.directory(row.intent))
    return grant
  }
  private admissionWait(i: TransferIntent, signal: AbortSignal) {
    return AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(30_000, Date.parse(i.expiresAt) - Date.now())))])
  }
  /** Revalidate accepted authority after the actual wrapper appears, immediately before grant.
   * This read-only callback must use the existing W07 admission service, never saved placement. */
  async activateServer(reference: RsyncOwnerReference, binding: Readonly<DeviceSessionBinding>, signal: AbortSignal,
    revalidateAccepted: (intent: TransferIntent, binding: Readonly<DeviceSessionBinding>, signal: AbortSignal) => Promise<void>) {
    const { row, path, ref } = this.read(reference), wait = this.admissionWait(row.intent, signal)
    const check = () => {
      wait.throwIfAborted()
      if (!isDeepStrictEqual(this.serverAdmission(row.intent, binding), ref)) throw new Error('Original rsync server admission changed')
    }
    let waiting: z.infer<typeof Waiting>
    for (;;) {
      check()
      const raw = readRecord(`${path}.waiting`)
      if (raw !== undefined) { waiting = this.waiting(ref, raw); break }
      await delay(25, undefined, { signal: wait })
    }
    await bounded(Promise.resolve().then(() => revalidateAccepted(row.intent, row.binding, wait)), wait)
    check()
    if (!isDeepStrictEqual(this.waiting(ref, readRecord(`${path}.waiting`)), waiting)) throw new Error('Rsync waiting process changed')
    const previous = readRecord(`${path}.grant`)
    if (previous !== undefined) { this.grant(ref, previous); syncDirectory(this.directory(row.intent)); return }
    const grantedAt = Date.now(), grant = Grant.parse({ ...waiting, issuer: self(), binding: row.binding,
      grantedAt, expiresAt: Math.min(grantedAt + 5000, Date.parse(row.intent.expiresAt)) })
    try { writeRecord(`${path}.grant`, grant, true) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      this.grant(ref, readRecord(`${path}.grant`)); syncDirectory(this.directory(row.intent))
    }
  }
  /** Actual standalone wrapper writes its own Linux identity, then waits for fresh W07 authority. */
  async waitForServerGrant(reference: RsyncOwnerReference, signal: AbortSignal) {
    const { row, path, ref } = this.read(reference), wait = this.admissionWait(row.intent, signal)
    wait.throwIfAborted(); this.admissible(row.intent)
    if (row.role !== 'rsync-server' || !row.binary || row.hostBootId !== bootIdentity() || !identityAlive(row.issuer)
      || this.revoked(ref) || readRecord(`${path}.claim`) !== undefined || readRecord(`${path}.closed`) !== undefined) {
      throw new Error('Original rsync server reservation unavailable')
    }
    const raw = readRecord(`${path}.waiting`)
    if (raw !== undefined) {
      if (!isDeepStrictEqual(this.waiting(ref, raw).process, self())) throw new Error('Original rsync wrapper already owns admission')
      syncDirectory(this.directory(row.intent))
    } else writeRecord(`${path}.waiting`, { version: 1, ...ref, nonce: randomUUID(), hostBootId: bootIdentity(), process: self() }, true)
    for (;;) {
      wait.throwIfAborted(); this.admissible(row.intent)
      if (this.revoked(ref) || readRecord(`${path}.claim`) !== undefined || readRecord(`${path}.closed`) !== undefined) throw new Error('Original rsync server reservation unavailable')
      const grant = readRecord(`${path}.grant`)
      if (grant !== undefined) { this.grant(ref, grant); return }
      await delay(25, undefined, { signal: wait })
    }
  }
  /** Single-use causal handoff. Current binding, pinned binary, exact owner and write-ahead
   * native registration are all checked before sending any executable configuration. */
  spawnProcess(reference: RsyncOwnerReference, executable: string, args: string[], signal: AbortSignal): Promise<ChildProcessWithoutNullStreams> {
    return this.launch(reference, executable, args, signal, () => {
      const { row } = this.read(reference)
      this.binding(row.intent, row.binding)
    })
  }
  private async launch(reference: RsyncOwnerReference, executable: string, args: string[], signal: AbortSignal, admit: () => void): Promise<ChildProcessWithoutNullStreams> {
    const { row, path, ref } = this.read(reference)
    signal.throwIfAborted(); this.admissible(row.intent); admit()
    if (row.hostBootId !== bootIdentity() || this.revoked(ref) || readRecord(`${path}.closed`) !== undefined) throw new Error('Original rsync process owner is no longer dispatchable')
    if (!row.binary || executable !== row.binary.executable || digestBytes(readFileSync(executable)) !== row.binary.sha256
      || !['rsync-client', 'rsync-server'].includes(row.role)
      || (row.role === 'rsync-client' && row.binary.commandDigest !== rsyncArgumentDigest(args))) throw new Error('Pinned rsync owner binary differs')
    writeRecord(`${path}.claim`, { version: 1, ...ref, mode: 'process', hostBootId: bootIdentity(), parent: self() }, true)
    this.admissible(row.intent)
    if (this.revoked(ref)) throw new Error('Original rsync process owner is revoked')
    const scope = await this.processes.reserveLaunch(this.scope(ref).owner)
    writeRecord(`${path}.launch`, { version: 1, ...ref, launchId: scope.launchId }, true)
    signal.throwIfAborted(); this.admissible(row.intent); admit()
    if (this.revoked(ref)) throw new Error('Original rsync process owner is revoked')
    // scope belongs to this live launching parent. It is never reconstructed for a replacement spawn.
    return spawnNativeProcess(executable, args, { cwd: this.root, env: { PATH: '/usr/bin:/bin', LANG: 'C' }, recovery: scope })
  }
  private serverCommand(reference: RsyncOwnerReference, args: string[]) {
    const { row } = this.read(reference)
    if (row.role !== 'rsync-server' || !row.binary || args[0] !== '--server' || args.includes('--daemon')
      || args.includes('--sender') !== (row.intent.direction === 'to-main') || args.length > 64
      || args.some(value => value.includes('\0') || value.length > 4096)) throw new Error('Invalid admitted rsync server command')
    return row.binary.executable
  }
  async spawnServer(reference: RsyncOwnerReference, args: string[], signal: AbortSignal) {
    return this.spawnProcess(reference, this.serverCommand(reference, args), args, signal)
  }
  async spawnGrantedServer(reference: RsyncOwnerReference, args: string[], signal: AbortSignal) {
    return this.launch(reference, this.serverCommand(reference, args), args, signal, () => {
      const { path } = this.read(reference), grant = this.grant(reference, readRecord(`${path}.grant`))
      if (!isDeepStrictEqual(grant.process, self())) throw new Error('Only original rsync wrapper can consume its grant')
    })
  }
  serverLifetime(reference: RsyncOwnerReference, signal: AbortSignal) {
    const { row } = this.read(reference)
    return AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(POLICY.maxLifetimeMs, Date.parse(row.intent.expiresAt) - Date.now())))])
  }
  async stopServer(reference: RsyncOwnerReference, signal: AbortSignal) {
    this.revoke(reference)
    await this.quiet(reference, signal, true)
  }
  async completeProcess(reference: RsyncOwnerReference, signal: AbortSignal) {
    const { path, ref } = this.read(reference), launch = Launch.parse(readRecord(`${path}.launch`))
    if (launch.transferId !== ref.transferId || launch.ownerId !== ref.ownerId || launch.ownerDigest !== ref.ownerDigest) throw new Error('Rsync launch owner mismatch')
    await this.processes.closeRegistration(this.scope(ref, launch.launchId), launch.launchId, signal)
    this.closed(ref, 'rsync-process-closed', launch.launchId)
  }
  private async quiet(reference: RsyncOwnerReference, signal: AbortSignal, stop: boolean) {
    signal.throwIfAborted()
    const { row, ref, path } = this.read(reference), old = readRecord(`${path}.closed`)
    if (old !== undefined) {
      this.assertClosed(ref, old)
      return
    }
    if (row.hostBootId !== bootIdentity()) { this.closed(ref, 'host-boot-changed'); return }
    if (!row.binary) {
      const access = this.accesses.get(ref.ownerId)
      if (stop && access) { await access.close(signal); return }
      if (!identityAlive(row.issuer)) { this.closed(ref, 'access-process-gone'); return }
      throw new Error('Rsync byte access remains active or unconfirmed')
    }
    let rawClaim = readRecord(`${path}.claim`)
    if (rawClaim === undefined && stop) {
      try { writeRecord(`${path}.claim`, { version: 1, ...ref, mode: 'cancelled', hostBootId: bootIdentity(), parent: self() }, true) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      rawClaim = readRecord(`${path}.claim`)
    }
    if (rawClaim === undefined) throw new Error('Rsync server launch is pending or unconfirmed')
    const claim = Claim.parse(rawClaim)
    if (claim.transferId !== ref.transferId || claim.ownerId !== ref.ownerId || claim.ownerDigest !== ref.ownerDigest) throw new Error('Rsync launch claim differs')
    if (claim.mode === 'cancelled') { this.closed(ref, 'never-dispatched'); return }
    const rawLaunch = readRecord(`${path}.launch`)
    if (rawLaunch === undefined) {
      if (claim.hostBootId !== bootIdentity() || !identityAlive(claim.parent)) {
        // Executable dispatch requires launch publication. A dead claim parent cannot cross that gate.
        await this.processes.closeOwner(this.scope(ref).owner, signal)
        this.closed(ref, 'never-dispatched'); return
      }
      throw new Error('Rsync launch handoff remains unconfirmed')
    }
    const launch = Launch.parse(rawLaunch)
    if (launch.transferId !== ref.transferId || launch.ownerId !== ref.ownerId || launch.ownerDigest !== ref.ownerDigest) throw new Error('Rsync launch owner mismatch')
    if (stop && claim.hostBootId === bootIdentity() && isDeepStrictEqual(claim.parent, self())) {
      await this.processes.abandonReservedLaunch(this.scope(ref, launch.launchId))
    }
    if (!stop) {
      const observation = this.processes.snapshot().launches.find(item => item.launchId === launch.launchId)
      const registered = join(this.scope(ref).root, digestBytes(Buffer.from(this.scope(ref).owner)), launch.launchId)
      const rawIntent = readRecord(join(registered, 'intent.json'))
      // Missing registration still goes through closeRegistration's EXACT durable retirement receipt check.
      if (rawIntent !== undefined && !(observation && (observation.lifecycle === 'closed' || observation.bootId !== bootIdentity()
        || (observation.boundary && !cgroupPopulated(observation.boundary))))) throw new Error('Rsync process tree remains active or unconfirmed')
    }
    await this.completeProcess(ref, signal)
  }
  async processesQuiescent(input: TransferIntent, signal: AbortSignal, requireProcess = false) {
    const i = this.original(input), refs = this.references(i)
    if (!refs.length) throw new Error('Rsync causal ownership unavailable')
    const processes = refs.filter(ref => this.read(ref).row.binary)
    if (requireProcess && !processes.length) throw new Error('Rsync causal subprocess ownership unavailable')
    for (const ref of processes) await this.quiet(ref, signal, false)
  }
  async quiescent(input: TransferIntent, signal: AbortSignal) {
    const i = this.original(input), refs = this.references(i)
    if (!refs.length) throw new Error('Rsync causal ownership unavailable')
    for (const ref of refs) await this.quiet(ref, signal, false)
    for (const row of this.cleanupClaims(i)) {
      signal.throwIfAborted()
      const captured = this.cleanups.get(i.transferId)
      if (captured?.settled && isDeepStrictEqual(captured.row, row)) await bounded(this.finishRetirement(captured), signal)
      this.cleanupQuiet(row)
    }
    if (readdirSync(this.root).some(name => name.startsWith(`${i.transferId}.`) && name.endsWith('.input'))) throw new Error('Rsync source-materializer residue retains its original hold')
  }
  async stopProcesses(input: TransferIntent, signal: AbortSignal) {
    const i = this.original(input), refs = this.references(i).filter(ref => this.read(ref).row.binary)
    // Revoke EVERY sibling synchronously, including when the caller is already cancelled.
    for (const ref of refs) this.revoke(ref)
    const results = await Promise.allSettled(refs.map(ref => this.quiet(ref, signal, true)))
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Rsync process stop remains unconfirmed')
    await this.processesQuiescent(i, signal)
  }
  async stop(input: TransferIntent, signal: AbortSignal) {
    const i = this.original(input), refs = this.references(i)
    this.stopping.add(i.transferId)
    for (const ref of refs) this.revoke(ref)
    const tasks = refs.map(ref => {
      const access = this.accesses.get(ref.ownerId)
      return access ? access.close(signal) : this.quiet(ref, signal, true)
    })
    const cleanup = this.cleanups.get(i.transferId)
    if (cleanup) tasks.push(bounded(cleanup.work.then(() => undefined), signal))
    const results = await Promise.allSettled(tasks)
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Rsync byte ownership stop remains unconfirmed')
    await this.quiescent(i, signal)
    this.stopping.delete(i.transferId)
  }
  async drain(signal: AbortSignal) {
    this.draining = true
    const closing = Promise.allSettled([...this.accesses.values()].map(access => access.close(signal)).concat(
      [...this.cleanups.values()].map(cleanup => bounded(cleanup.work.then(() => undefined), signal))))
    // Begin all transfers before awaiting, so one stuck IO cannot leave another writer admitted.
    let transfers: Promise<void>[]
    try { transfers = this.inventory().map(i => this.stop(i, signal)) } catch (error) { transfers = [Promise.reject(error)] }
    const results = (await Promise.all([closing, Promise.allSettled(transfers)])).flat()
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Rsync byte ownership drain remains unconfirmed')
  }

  inventory(): TransferIntent[] {
    this.pin()
    const result: TransferIntent[] = []
    for (const name of readdirSync(this.journal)) {
      if (name === '.processes') continue
      if (!z.uuid().safeParse(name).success) throw new Error('Unexpected rsync owner journal entry')
      const i = TransferIntentSchema.parse(readRecord(join(this.journal, name, 'intent.json')))
      if (i.transferId !== name) throw new Error('Rsync owner journal identity conflicts')
      result.push(i)
      if (result.length > POLICY.maxRecords) throw new Error('Rsync owner inventory exceeds policy')
    }
    for (const name of readdirSync(this.root)) {
      if (!name.endsWith('.intent')) continue
      const i = TransferIntentSchema.parse(readRecord(join(this.root, name)))
      if (name !== `${i.transferId}.intent`) throw new Error('Rsync staging inventory identity conflicts')
      const existing = result.find(row => row.transferId === i.transferId)
      if (existing && !isDeepStrictEqual(existing, i)) throw new Error('Rsync staging intent differs from original owner')
      if (!existing) result.push(i) // Expose legacy expiry; quiescent still denies missing causal ownership.
      if (result.length > POLICY.maxRecords) throw new Error('Rsync owner inventory exceeds policy')
    }
    return result
  }
  expiredInventory(now = Date.now()) { return this.inventory().filter(i => Date.parse(i.expiresAt) <= now) }
  access(input: TransferIntent, binding: Readonly<DeviceSessionBinding>, role: 'snapshot' | 'receiver' | 'source-materializer'): RsyncAccessLease {
    const ref = this.prepare(input, binding, role), { row, path } = this.read(ref)
    const handles = new Set<FileHandle>(), pending = new Set<Promise<unknown>>()
    const controller = new AbortController()
    let draining: Promise<void> | undefined
    const lease: RsyncAccessLease = {
      reference: ref, signal: controller.signal,
      run: <T>(work: (signal: AbortSignal) => Promise<T>) => {
        if (controller.signal.aborted) return Promise.reject(new Error('Rsync byte access closed'))
        this.admissible(row.intent); this.binding(row.intent, row.binding)
        const task = Promise.resolve().then(() => {
          controller.signal.throwIfAborted()
          this.admissible(row.intent); this.binding(row.intent, row.binding)
          return work(controller.signal)
        })
        pending.add(task)
        void task.finally(() => pending.delete(task)).catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
        return task
      },
      attach: handle => {
        if (controller.signal.aborted && !pending.size) throw new Error('Rsync byte access closed')
        handles.add(handle)
      },
      captureLock: () => {
        if (row.role !== 'receiver') throw new Error('Only the original receiver can capture its writer lock')
        writeRecord(`${path}.lock`, { version: 1, ...ref, root: this.rootIdentity,
          lock: certificate(join(this.root, `${row.intent.transferId}.lock`)) }, true)
        // A removed lock's inode may be reused by the next receiver.
        writeRecord(join(this.directory(row.intent), 'receiver-lock.json'), ref)
      },
      close: (signal = AbortSignal.timeout(5000)) => {
        controller.abort(new Error('Rsync byte access closed'))
        if (!draining) {
          const attempt = (async () => {
            await Promise.allSettled([...pending])
            await Promise.all([...handles].map(handle => handle.close()))
            if (row.hostBootId !== bootIdentity() || !isDeepStrictEqual(row.issuer, self())) throw new Error('Only original rsync access owner can publish drain')
            this.closed(ref, 'access-drained'); this.accesses.delete(ref.ownerId)
          })()
          draining = attempt
          void attempt.catch(() => { if (draining === attempt) draining = undefined })
        }
        return bounded(draining, signal)
      },
    }

    this.accesses.set(ref.ownerId, lease)
    this.admissible(row.intent)
    return lease
  }
  assertLock(input: TransferIntent) {
    const i = this.original(input), actual = certificate(join(this.root, `${i.transferId}.lock`))
    // Retirement fences every writer. Its latest captured lock supersedes earlier
    // ownership records, including records whose removed inode was reused.
    for (const row of this.cleanupClaims(i).reverse()) {
      const raw = readRecord(`${this.cleanupPath(row)}.lock`)
      if (raw === undefined) continue
      const lock = CleanupLock.parse(raw)
      if (!isDeepStrictEqual(lock, { version: 1, transferId: i.transferId, sequence: row.sequence,
        ownerDigest: digest(row), root: this.rootIdentity, lock: actual })) {
        throw new Error('Rsync cleanup lock owner conflicts')
      }
      return
    }
    const current = readRecord(join(this.directory(i), 'receiver-lock.json'))
    const references = current === undefined ? this.references(i) : [Reference.parse(current)]
    let matches = 0
    for (const ref of references) {
      if (ref.transferId !== i.transferId) throw new Error('Rsync writer lock owner conflicts')
      const { path } = this.read(ref), raw = readRecord(`${path}.lock`)
      if (raw === undefined) continue
      const lock = Lock.parse(raw)
      if (lock.transferId !== ref.transferId || lock.ownerId !== ref.ownerId || lock.ownerDigest !== ref.ownerDigest || !isDeepStrictEqual(lock.root, this.rootIdentity)) throw new Error('Rsync writer lock owner conflicts')
      if (isDeepStrictEqual(lock.lock, actual)) matches++
    }
    if (matches !== 1) throw new Error('Exact rsync writer lock ownership unavailable')
  }
  private cleanupPath(row: z.infer<typeof Cleanup>) { return join(this.directory(row.intent), `retirement-${row.sequence}`) }
  private cleanupClaims(i: TransferIntent) {
    const result: z.infer<typeof Cleanup>[] = []
    for (let sequence = 1; sequence <= POLICY.maxRecords; sequence++) {
      const raw = readRecord(join(this.directory(i), `retirement-${sequence}.cleanup`))
      if (raw === undefined) return result
      const row = Cleanup.parse(raw)
      if (row.sequence !== sequence || !isDeepStrictEqual(row.intent, i) || !isDeepStrictEqual(row.root, this.rootIdentity)) throw new Error('Original rsync cleanup identity conflicts')
      result.push(row)
    }
    throw new Error('Rsync cleanup history exceeds policy')
  }
  private closeCleanup(row: z.infer<typeof Cleanup>, evidence: z.infer<typeof CleanupProof>['evidence']) {
    this.original(row.intent)
    const value = { version: 1 as const, transferId: row.intent.transferId, sequence: row.sequence, ownerDigest: digest(row), evidence }
    const path = `${this.cleanupPath(row)}.closed`
    try { writeRecord(path, value, true) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      this.cleanupQuiet(row)
    }
  }
  private cleanupQuiet(row: z.infer<typeof Cleanup>) {
    this.original(row.intent)
    const raw = readRecord(`${this.cleanupPath(row)}.closed`)
    if (raw !== undefined) {
      const proof = CleanupProof.parse(raw)
      if (proof.transferId !== row.intent.transferId || proof.sequence !== row.sequence || proof.ownerDigest !== digest(row)
        || (proof.evidence === 'host-boot-changed' && row.hostBootId === bootIdentity())
        || (proof.evidence === 'access-process-gone' && row.hostBootId === bootIdentity() && identityAlive(row.issuer))) throw new Error('Original rsync cleanup closure conflicts')
      syncDirectory(this.directory(row.intent)); return
    }
    if (row.hostBootId !== bootIdentity()) this.closeCleanup(row, 'host-boot-changed')
    else if (!identityAlive(row.issuer)) this.closeCleanup(row, 'access-process-gone')
    else if (isDeepStrictEqual(row.issuer, self()) && this.drainedCleanups.has(digest(row))) this.closeCleanup(row, 'access-drained')
    else throw new Error('Rsync cleanup remains active or unconfirmed')
  }
  captureRetirementLock(input: TransferIntent) {
    const i = this.original(input), cleanup = this.cleanups.get(i.transferId)
    if (!cleanup || cleanup.settled || cleanup.row.hostBootId !== bootIdentity() || !isDeepStrictEqual(cleanup.row.issuer, self())) throw new Error('Actual rsync cleanup owner unavailable')
    const row = cleanup.row
    writeRecord(`${this.cleanupPath(row)}.lock`, { version: 1, transferId: i.transferId, sequence: row.sequence,
      ownerDigest: digest(row), root: this.rootIdentity, lock: certificate(join(this.root, `${i.transferId}.lock`)) }, true)
  }
  captureRetirementHandle(input: TransferIntent, handle: FileHandle) {
    const i = this.original(input), cleanup = this.cleanups.get(i.transferId)
    if (!cleanup || cleanup.settled || cleanup.row.hostBootId !== bootIdentity() || !isDeepStrictEqual(cleanup.row.issuer, self())) throw new Error('Actual rsync cleanup owner unavailable')
    cleanup.handles.add(handle)
  }
  private async finishRetirement(cleanup: { row: z.infer<typeof Cleanup>; handles: Set<FileHandle>; settled: boolean }) {
    if (!cleanup.settled) throw new Error('Rsync cleanup remains active or unconfirmed')
    await Promise.all([...cleanup.handles].map(handle => handle.close()))
    this.drainedCleanups.add(digest(cleanup.row)); this.closeCleanup(cleanup.row, 'access-drained')
    if (this.cleanups.get(cleanup.row.intent.transferId) === cleanup) this.cleanups.delete(cleanup.row.intent.transferId)
  }
  async retire<T>(input: TransferIntent, work: () => Promise<T>): Promise<T> {
    const i = this.original(input), path = join(this.directory(i), 'retiring.json')
    if (this.draining || this.stopping.has(i.transferId)) throw new Error('Rsync cleanup admission is closed')
    const barrier = { version: 1, intent: i }, existing = readRecord(path)
    if (existing === undefined) {
      try { writeRecord(path, barrier, true) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !isDeepStrictEqual(readRecord(path), barrier)) throw error }
    } else if (!isDeepStrictEqual(existing, barrier)) throw new Error('Original rsync retirement barrier conflicts')
    syncDirectory(this.directory(i))
    await this.quiescent(i, AbortSignal.timeout(5000))
    if (this.draining || this.stopping.has(i.transferId)) throw new Error('Rsync cleanup admission is closed')
    const claims = this.cleanupClaims(i)
    // Recheck after the await. The fixed next sequence is an exclusive, single-winner CAS.
    for (const claim of claims) this.cleanupQuiet(claim)
    const row = Cleanup.parse({ version: 1, sequence: claims.length + 1,
      intent: i, root: this.rootIdentity, hostBootId: bootIdentity(), issuer: self() })
    try { writeRecord(`${this.cleanupPath(row)}.cleanup`, row, true) }
    catch (error) {
      // An interrupted original claim can be closed only by this actual call, before work starts.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && isDeepStrictEqual(readRecord(`${this.cleanupPath(row)}.cleanup`), row)) {
        this.drainedCleanups.add(digest(row)); this.closeCleanup(row, 'access-drained')
      }
      throw error
    }
    const captured = { row, work: Promise.resolve<unknown>(undefined), handles: new Set<FileHandle>(), settled: false }
    const task = Promise.resolve().then(work).finally(async () => { captured.settled = true; await this.finishRetirement(captured) })
    captured.work = task
    this.cleanups.set(i.transferId, captured)
    return task
  }
  store(): RsyncStoreOwnership {
    return { access: (i, role) => {
      const binding = this.current(i.deviceId)
      if (!binding) throw new Error('Rsync writer current binding unavailable')
      return this.access(i, binding, role)
    }, processesQuiescent: (i, s, required) => this.processesQuiescent(i, s, required), quiescent: (i, s) => this.quiescent(i, s),
    assertLock: i => this.assertLock(i), captureRetirementLock: i => this.captureRetirementLock(i),
    captureRetirementHandle: (i, handle) => this.captureRetirementHandle(i, handle), retire: (i, work) => this.retire(i, work) }
  }
}
export const rsyncArgumentDigest = (args: readonly string[]) => digest(args)
const digestBytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Standalone protected SSH wrapper. Fresh admission is granted by the live W07 service;
 * this process owns the actual server's write-ahead scope and protocol streams. */
export async function runRsyncRemoteServer(input: { ownership: RsyncWriterOwnership; reference: RsyncOwnerReference;
  args: string[]; signal: AbortSignal }): Promise<number> {
  const signal = input.ownership.serverLifetime(input.reference, input.signal)
  let child: ChildProcessWithoutNullStreams | undefined
  const stop = () => { void input.ownership.stopServer(input.reference, AbortSignal.timeout(5000)).catch(() => process.stderr.write('Rsync writer stop unconfirmed\n')) }
  signal.addEventListener('abort', stop, { once: true })
  try {
    await input.ownership.waitForServerGrant(input.reference, signal)
    child = await input.ownership.spawnGrantedServer(input.reference, input.args, signal)
    const server = child
    const outcome = new Promise<{ exitCode: number | null; exitSignal: NodeJS.Signals | null }>((resolve, reject) => {
      server.once('error', reject); server.stdin.on('error', reject); server.once('close', (exitCode, exitSignal) => {
        try { resolve(nativeProcessExit(server, { exitCode, exitSignal })) } catch (error) { reject(error) }
      })
    })
    process.stdin.pipe(server.stdin); server.stdout.pipe(process.stdout); server.stderr.pipe(process.stderr)
    const result = await bounded(outcome, signal)
    await input.ownership.completeProcess(input.reference, AbortSignal.timeout(5000))
    signal.throwIfAborted()
    return result.exitCode ?? 1
  } finally {
    signal.removeEventListener('abort', stop)
    if (child) { process.stdin.unpipe(child.stdin); child.stdout.unpipe(process.stdout); child.stderr.unpipe(process.stderr) }
    await input.ownership.stopServer(input.reference, AbortSignal.timeout(5000))
  }
}
