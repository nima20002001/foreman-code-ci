import { timeRuntimeOperation } from '../../diagnostics/runtimeTiming.js'
import { isDeepStrictEqual } from 'node:util'
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { lstatSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { constants } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { componentLogger } from '../../diagnostics/logger.js'
import { DomainError } from '../../errors.js'
import { bootIdentity, identityAlive, processIdentity, sessionAlive, type LinuxProcessIdentity } from './linuxIdentity.js'
import { cgroupBoundary, cgroupPopulated, cgroupRemoved, killCgroup, retireCgroup,
  type NativeCgroupBoundary } from './cgroupBoundary.js'
import { NATIVE_GUARDIAN_SOURCE } from './nativeGuardian.js'
import { nativeRegistryProjection, type NativeRegistrySnapshot, type NativeRegistryChange,
  type NativeLaunchObservation } from './registryObservation.js'
export type { NativeLaunchObservation, NativeRegistrySnapshot, NativeRegistryChange } from './registryObservation.js'
import { nativeAgentEnvironment } from '../secrets.js'
import { NativeProcessObservationSchema } from '@foreman-code/contracts/remote-execution-entry-closure'
import { existingPrivateDirectory, privateDirectory, readRecord, recordObject, syncDirectory, syncDirectoryAsync, writeRecord } from './storage.js'
import { archivedClosure, archivedRetirement } from './registryArchive.js'
import { prepareRegistryRetirement, pruneClosedObservation, retireRegistrations } from './registryRetirement.js'
import { registryOperation } from './registryOperations.js'
import { NativeRegistryRetention } from './nativeRetention.js'

export interface NativeProcessRecovery {
  root: string
  owner: string
  /** Write-ahead registration captured before the workflow's entered commit. */
  launchId?: string
}
// This tracks ordinary sequential subprocesses of the SAME live manager. It is
// never consulted as closure evidence and cannot be reconstructed on restart.
const consumedLaunchScopes = new WeakMap<NativeProcessRecovery, { root: string; owner: string; launchId: string }>()
const abandonedLaunchScopes = new WeakMap<NativeProcessRecovery, { root: string; owner: string; launchId: string }>()
interface LaunchRecord {
  format: 1; id: string; owner: string; boot: string; parent: LinuxProcessIdentity; controlKey: string
}
interface BirthRecord { format: 1; id: string; owner: string; boot: string; guardian: LinuxProcessIdentity; containment?: NativeCgroupBoundary }
type RegistrationClosure =
  | { kind: 'unstarted'; launch: LaunchRecord }
  | { kind: 'active'; launch: LaunchRecord; birth?: BirthRecord }

export interface NativeProcessExit { exitCode: number | null; exitSignal: NodeJS.Signals | null }
const owned = new WeakMap<ChildProcess, { scope: NativeProcessRecovery; id: string; closed?: boolean;
  exit?: NativeProcessExit; receiptError?: Error; restartDetachable?: true }>()
const closing = new Map<string, Promise<void>>()
const key = (owner: string) => createHash('sha256').update(owner).digest('hex')
const socketName = (id: string) => `\0graphql-native-${id}`

function ownerOperation(scope: NativeProcessRecovery): string {
  return JSON.stringify([resolve(scope.root), key(scope.owner)])
}

function launchRecord(value: unknown): LaunchRecord {
  const row = recordObject(value)
  const parent = recordObject(row.parent)
  if (row.format !== 1 || typeof row.id !== 'string' || !/^[0-9a-f-]{36}$/.test(row.id)
    || typeof row.owner !== 'string' || typeof row.boot !== 'string'
    || typeof row.controlKey !== 'string' || !/^[0-9a-f]{64}$/.test(row.controlKey)
    || !Number.isSafeInteger(parent.pid) || Number(parent.pid) <= 1
    || typeof parent.startTicks !== 'string' || !/^\d+$/.test(parent.startTicks)) {
    throw new Error('Invalid native launch record.')
  }
  return row as unknown as LaunchRecord
}
function birthRecord(value: unknown, launch: LaunchRecord): BirthRecord {
  const row = recordObject(value)
  const guardian = recordObject(row.guardian)
  if (row.format !== 1 || row.id !== launch.id || row.owner !== launch.owner || row.boot !== launch.boot
    || !Number.isSafeInteger(guardian.pid) || Number(guardian.pid) <= 1
    || guardian.group !== guardian.pid || guardian.session !== guardian.pid
    || typeof guardian.startTicks !== 'string' || !/^\d+$/.test(guardian.startTicks)) {
    throw new Error('Invalid native birth certificate.')
  }
  if (row.containment !== undefined) cgroupBoundary(row.containment, launch.id)
  return row as unknown as BirthRecord
}

async function stopGuardian(launch: LaunchRecord, birth: BirthRecord, signal?: AbortSignal): Promise<void> {
  return controlGuardian(launch, birth, 'stop', signal)
}

async function controlGuardian(launch: LaunchRecord, birth: BirthRecord,
  operation: 'stop' | 'detach', signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ path: socketName(launch.id) })
    let finished = false
    let buffer = ''
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      socket.destroy()
      if (error) reject(error); else resolve()
    }
    const abort = () => finish(new Error('Native recovery was canceled.', { cause: signal?.reason }))
    const timer = setTimeout(() => finish(new Error('Native guardian control timed out.')), 2_000)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { abort(); return }
    socket.on('error', finish)
    socket.once('connect', () => socket.write(JSON.stringify({
      id: launch.id, owner: launch.owner, controlKey: launch.controlKey,
      startTicks: birth.guardian.startTicks, operation,
    }) + '\n'))
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      if (Buffer.byteLength(buffer) > 4096) { finish(new Error('Invalid guardian control reply.')); return }
      if (!buffer.includes('\n')) return
      try {
        const reply = recordObject(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))))
        if (reply.id !== launch.id || reply.startTicks !== birth.guardian.startTicks || reply.accepted !== true) {
          throw new Error('The guardian did not acknowledge this exact process generation.')
        }
        finish()
      } catch (error) { finish(error instanceof Error ? error : new Error('Invalid guardian control reply.')) }
    })
    socket.once('end', () => { if (!finished) finish(new Error('Guardian disconnected before acknowledgement.')) })
  })
}

type ClosureEvidence = 'linux_boot_changed' | 'native_not_started' | 'cgroup_v2_empty' | 'cgroup_v2_removed'

function removedCgroupClosed(directory: string, launch: LaunchRecord, birth: BirthRecord): boolean {
  if (!birth.containment || identityAlive(launch.parent) || identityAlive(birth.guardian)
    || sessionAlive(birth.guardian.session) || !cgroupRemoved(birth.containment)) return false
  const provider = readRecord(join(directory, 'provider.json'))
  const exit = readRecord(join(directory, 'provider-exit.json'))
  if (provider === undefined) return exit === undefined
  const processRecord = recordObject(provider)
  if (processRecord.format !== 1 || processRecord.id !== launch.id || processRecord.owner !== launch.owner
    || processRecord.boot !== launch.boot || !isDeepStrictEqual(processRecord.guardian, birth.guardian)) return false
  if (processRecord.provider !== undefined) {
    const native = recordObject(processRecord.provider)
    if (!Number.isSafeInteger(native.pid) || Number(native.pid) <= 1
      || typeof native.startTicks !== 'string' || !/^\d+$/.test(native.startTicks)
      || identityAlive({ pid: Number(native.pid), startTicks: native.startTicks })) return false
  }
  // A service-wide kill can prevent receipt publication; qualified kernel removal still proves closure.
  if (exit === undefined) return true
  const result = recordObject(exit)
  if (result.format !== 1 || result.id !== launch.id || result.owner !== launch.owner
    || result.boot !== launch.boot || !isDeepStrictEqual(processRecord.provider, result.provider)) return false
  const normalExit = Number.isInteger(result.code) && Number(result.code) >= 0 && Number(result.code) <= 255
    && result.signal === null
  const signaledExit = result.code === null && typeof result.signal === 'string'
    && Object.hasOwn(constants.signals, result.signal)
  return normalExit || signaledExit
}

function observeCgroupClosure(directory: string, launch: LaunchRecord, birth: BirthRecord): ClosureEvidence | undefined {
  if (!birth.containment) return undefined
  try {
    if (!cgroupPopulated(birth.containment)) return 'cgroup_v2_empty'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT'
      || !removedCgroupClosed(directory, launch, birth)) throw error
    return 'cgroup_v2_removed'
  }
  return undefined
}

function closedRecord(directory: string, launch: LaunchRecord): boolean {
  const value = readRecord(join(directory, 'closed.json'))
  if (value === undefined) return false
  const row = recordObject(value)
  if (row.id !== launch.id || row.owner !== launch.owner) throw new Error('Native close evidence owner mismatch.')
  // Version 1 used session absence, which does not cover detached descendants.
  // Requalify legacy records below; never promote their old marker into proof.
  if (row.format === 1) return false
  if (row.format !== 2 || row.boot !== launch.boot
    || !['linux_boot_changed', 'native_not_started', 'cgroup_v2_empty', 'native_exit_removed_cgroup',
      'cgroup_v2_removed'].includes(String(row.evidence))) {
    throw new Error('Invalid native closure evidence.')
  }
  return true
}

function retiredOwner(directory: string, owner: string, id?: string): boolean {
  if (id && closedObservation(directory, owner, id)) return true
  const value = readRecord(join(directory, 'retired.json')) ?? archivedRetirement(dirname(directory), basename(directory))
  if (value === undefined) return false
  const row = recordObject(value)
  if (row.format !== 2 || row.owner !== owner || typeof row.id !== 'string' || !/^[0-9a-f-]{36}$/.test(row.id)) {
    throw new Error('Invalid native retirement receipt.')
  }
  return id === undefined || row.id === id
}

function closedObservation(directory: string, owner: string, id: string): NativeLaunchObservation | undefined {
  let raw = readRecord(join(directory, `closed-${id}.json`)) ?? archivedClosure(directory, id)
  if (raw === undefined) {
    const retired = readRecord(join(directory, 'retired.json'))
      ?? archivedRetirement(dirname(directory), basename(directory))
    if (retired !== undefined) {
      const receipt = recordObject(retired)
      if (receipt.format !== 2 || receipt.owner !== owner) throw new Error('Invalid native retirement receipt.')
      if (receipt.id === id) raw = receipt.observation
    }
  }
  if (raw === undefined) return undefined
  const observation = NativeProcessObservationSchema.parse(raw)
  if (observation.owner !== owner || observation.launchId !== id || observation.lifecycle !== 'closed'
    || !observation.closureEvidence) throw new Error('Invalid original native close observation.')
  return Object.freeze(raw as NativeLaunchObservation)
}

async function retireRegistration(directory: string, launch: LaunchRecord,
  batch?: Map<string, NativeLaunchObservation>): Promise<void> {
  if (!closedRecord(directory, launch)) throw new Error('Unconfirmed native registrations cannot be retired.')
  const ownerDirectory = dirname(directory)
  const observation = nativeRegistryProjection(dirname(ownerDirectory)).retirementObservation(directory)
  if (!observation || observation.lifecycle !== 'closed') throw new Error('Native closure observation is unavailable.')
  const hasLiveProcess = launch.boot === bootIdentity()
    && [observation.guardian, observation.provider].some(process => process && identityAlive(process))
  // Qualified empty containment proves tree closure even if a process lookup still reports the guardian.
  if (hasLiveProcess && (observation.closureEvidence !== 'cgroup_v2_empty'
    || !observation.boundary || cgroupPopulated(observation.boundary))) {
    throw new Error('Native registration still has a live process; retirement is unconfirmed.')
  }
  const rawBirth = readRecord(join(directory, 'birth.json'))
  if (launch.boot === bootIdentity()) {
    let boundary = rawBirth === undefined ? undefined : birthRecord(rawBirth, launch).containment
    const reserved = readRecord(join(directory, 'containment.json'))
    if (reserved !== undefined) {
      const row = recordObject(reserved)
      if (row.format !== 1 || row.id !== launch.id || row.owner !== launch.owner || row.boot !== launch.boot) {
        throw new Error('Native cgroup reservation owner mismatch.')
      }
      const registered = cgroupBoundary(row.boundary, launch.id)
      if (boundary && (boundary.path !== registered.path || boundary.device !== registered.device || boundary.inode !== registered.inode)) {
        throw new Error('Conflicting native cgroup certificates.')
      }
      boundary = registered
    }
    if (boundary) retireCgroup(boundary)
  }
  publishRetirement(directory)
  if (batch) batch.set(launch.id, observation)
  else await retireRegistrations(ownerDirectory, new Map([[launch.id, observation]]))
}

async function confirmClosed(directory: string, launch: LaunchRecord, evidence: ClosureEvidence,
  batch?: Map<string, NativeLaunchObservation>): Promise<void> {
  writeRecord(join(directory, 'closed.json'), { format: 2, id: launch.id, owner: launch.owner, boot: launch.boot,
    observedAt: new Date().toISOString(), evidence })
  await retireRegistration(directory, launch, batch)
}

function unstartedGuardianAlive(directory: string, launch: LaunchRecord): boolean {
  if (launch.boot !== bootIdentity()) return false
  const guardian = nativeRegistryProjection(dirname(dirname(directory))).retirementObservation(directory)?.guardian
  return !!guardian && identityAlive(guardian)
}

/** Compact proven closures BEFORE enforcing the unresolved-work bound. */
async function inventory(directory: string, owner: string): Promise<string[]> {
  return nativeRegistryProjection(dirname(directory)).retirementBatch(async () => {
    const ids: string[] = []
    const closures = new Map<string, NativeLaunchObservation>()
    try {
      for (const id of readdirSync(directory)) {
        if (id === 'retired.json') { retiredOwner(directory, owner); continue }
        const closed = /^closed-([0-9a-f-]{36})\.json$/.exec(id)
        if (closed) { pruneClosedObservation(directory, closed[1]!); continue }
        if (id === 'closed') { privateDirectory(join(directory, id)); continue }
        if (/^\.retired-[0-9a-f-]{36}$/.test(id)) {
          privateDirectory(join(directory, id))
          rmSync(join(directory, id), { recursive: true })
          syncDirectory(directory)
          continue
        }
        // storage.writeRecord may leave a private temporary receipt after a crash.
        // It is not a registration or closure proof; a live writer may still own it.
        if (/^\.pending-[0-9a-f-]{36}$/.test(id)) continue
        if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Unexpected native process inventory entry.')
        const path = privateDirectory(join(directory, id))
        const launch = launchRecord(readRecord(join(path, 'intent.json')))
        if (launch.owner !== owner || launch.id !== id) throw new Error('Native owner inventory mismatch.')
        const alreadyClosed = closedRecord(path, launch)
        const notStarted = readRecord(join(path, 'not-started.json'))
        if (alreadyClosed && (notStarted === undefined || readRecord(join(path, 'birth.json')) !== undefined
          || !unstartedGuardianAlive(path, launch))) {
          await retireRegistration(path, launch, closures)
          continue
        }
        if (launch.boot !== bootIdentity()) { await confirmClosed(path, launch, 'linux_boot_changed', closures); continue }
        if (notStarted !== undefined) {
          const row = recordObject(notStarted)
          if (row.id !== id || row.owner !== owner || readRecord(join(path, 'birth.json')) !== undefined) {
            throw new Error('Conflicting native startup evidence.')
          }
          if (!unstartedGuardianAlive(path, launch)) {
            if (alreadyClosed) await retireRegistration(path, launch, closures)
            else await confirmClosed(path, launch, 'native_not_started', closures)
            continue
          }
        }
        ids.push(id)
        if (ids.length > 10_000) throw new Error('Native recovery inventory exceeds its unresolved-work scan limit.')
      }
      return ids
    } finally { await retireRegistrations(directory, closures) }
  })
}

/** Backend-owned registry. An empty registry is NOT evidence about pre-upgrade processes. */
export class NativeProcessRegistry {
  private readonly retention: NativeRegistryRetention
  private readonly preparation: Promise<void>
  constructor(private readonly root: string) {
    this.retention = new NativeRegistryRetention(root)
    this.preparation = process.platform === 'linux'
      ? registryOperation(`maintenance:${resolve(root)}`, () => prepareRegistryRetirement(resolve(root), async (directory, batch) => {
        const intent = readRecord(join(directory, 'intent.json'))
        if (intent === undefined && !existingPrivateDirectory(directory)) return
        const launch = launchRecord(intent)
        if (launch.id !== basename(directory) || key(launch.owner) !== basename(dirname(directory))) {
          throw new Error('Native owner inventory mismatch.')
        }
        if (!closedRecord(directory, launch)) return
        const observation = nativeRegistryProjection(resolve(root)).retirementObservation(directory)
        if (launch.boot === bootIdentity()
          && [observation?.guardian, observation?.provider].some(process => process && identityAlive(process))) return
        await retireRegistration(directory, launch, batch)
      })) : Promise.resolve()
    void this.preparation.catch(error => {
      harnessLog.warn({ err: error }, 'Native registry maintenance failed')
    })
  }
  ready(): Promise<void> { return this.preparation }
  snapshot(): NativeRegistrySnapshot { return nativeRegistryProjection(this.root).snapshot() }
  pruneSettled(isSettled: (owner: string) => Promise<boolean>, now = Date.now()): Promise<number> {
    return this.retention.prune(isSettled, now)
  }
  closeRetention(): void { this.retention.close() }
  revision(): string { return nativeRegistryProjection(this.root).revision() }
  changes(afterRevision: string, signal: AbortSignal): AsyncIterable<NativeRegistryChange> {
    return nativeRegistryProjection(this.root).changes(afterRevision, signal)
  }
  scope(owner: string): NativeProcessRecovery {
    if (!owner.trim() || owner.length > 4096) throw new Error('Invalid process owner.')
    return { root: this.root, owner }
  }
  closedRegistration(owner: string, launchId?: string): NativeLaunchObservation | undefined {
    const scope = this.scope(owner)
    if (launchId === undefined) {
      const directory = join(scope.root, key(owner))
      const raw = readRecord(join(directory, 'retired.json')) ?? archivedRetirement(scope.root, key(owner))
      if (raw === undefined) return undefined
      const row = recordObject(raw)
      if (row.format !== 2 || row.owner !== owner || typeof row.id !== 'string') throw new Error('Invalid native retirement receipt.')
      launchId = row.id
    }
    if (!/^[0-9a-f-]{36}$/.test(launchId)) throw new Error('Invalid native registration.')
    return closedObservation(join(scope.root, key(owner)), owner, launchId)
  }
  /** Allocate before authorizing native submission, not at child_process.spawn.
   * A dead original parent plus this durable intent and no dispatch is positive
   * native_not_started evidence. A missing directory still proves nothing. */
  async reserveLaunch(owner: string): Promise<NativeProcessRecovery> {
    const scope = this.scope(owner)
    if (process.platform !== 'linux') return scope
    await this.preparation
    try {
      return await registryOperation(ownerOperation(scope), async () => ({ ...scope, launchId: (await reserveProcess(scope)).id }))
    } catch (error) {
      const storageError = error as NodeJS.ErrnoException
      if (storageError.code !== 'ENOSPC' && storageError.code !== 'EDQUOT'
        && storageError.errno !== -constants.errno.ENOSPC! && storageError.errno !== -constants.errno.EDQUOT!) throw error
      const failure = new DomainError('HARNESS_RECOVERY_STORAGE_FULL',
        'Native harness storage is full on this computer. Free space in its configured managed storage and retry.', 503)
      failure.cause = error
      throw failure
    }
  }
  /** The original live parent may abandon an exact, never-dispatched reservation
   * only after its caller revokes future IO and joins admitted tasks. Publication
   * is synchronous up to the ordinary closure path, so no launch can interleave. */
  async abandonReservedLaunch(scope: NativeProcessRecovery): Promise<boolean> {
    if (process.platform !== 'linux' || resolve(scope.root) !== resolve(this.root)
      || !scope.launchId || !/^[0-9a-f-]{36}$/.test(scope.launchId)) throw new Error('Invalid native launch abandonment scope.')
    const abandoned = abandonedLaunchScopes.get(scope)
    if (abandoned) {
      if (abandoned.root !== resolve(scope.root) || abandoned.owner !== scope.owner || abandoned.launchId !== scope.launchId) {
        throw new Error('The abandoned native launch scope was modified.')
      }
      await this.closeRegistration(scope, scope.launchId)
      return true
    }
    const consumed = consumedLaunchScopes.get(scope)
    if (consumed) {
      if (consumed.root !== resolve(scope.root) || consumed.owner !== scope.owner || consumed.launchId !== scope.launchId) {
        throw new Error('The entered native launch scope was modified.')
      }
      // Positive in-memory dispatch observation refuses no-start publication.
      // It is never closure evidence; the factory must still close the owner.
      return false
    }
    const directory = join(privateDirectory(scope.root), key(scope.owner), scope.launchId)
    const launch = launchRecord(readRecord(join(directory, 'intent.json')))
    const parent = processIdentity(process.pid)
    if (launch.id !== scope.launchId || launch.owner !== scope.owner || launch.boot !== bootIdentity()
      || !parent || launch.parent.pid !== parent.pid || launch.parent.startTicks !== parent.startTicks) {
      throw new Error('Only the exact original parent can abandon this native launch reservation.')
    }
    for (const name of ['claimed.json', 'dispatched.json', 'birth.json', 'containment.json', 'closed.json']) {
      if (readRecord(join(directory, name)) !== undefined) return false
    }
    const previous = readRecord(join(directory, 'not-started.json'))
    if (previous !== undefined) {
      const row = recordObject(previous)
      if (row.id !== launch.id || row.owner !== launch.owner) throw new Error('Conflicting native startup evidence.')
    } else writeRecord(join(directory, 'not-started.json'), { id: launch.id, owner: launch.owner }, true)
    await this.closeRegistration(scope, launch.id)
    abandonedLaunchScopes.set(scope, { root: resolve(scope.root), owner: scope.owner, launchId: scope.launchId })
    return true
  }
  async closeOwner(owner: string, signal?: AbortSignal): Promise<boolean> {
    if (process.platform !== 'linux') return false
    await this.preparation
    const root = privateDirectory(this.root)
    const directory = join(root, key(owner))
    const registrations = await registryOperation(ownerOperation({ root, owner }), async () => {
      try { lstatSync(directory) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
      privateDirectory(directory)
      return inventory(directory, owner)
    })
    if (!registrations.length) return retiredOwner(directory, owner)
    const failures: unknown[] = []
    for (const id of registrations) {
      try { await this.closeRegistration({ root, owner }, id, signal) } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Native process closure remains unconfirmed.')
    return true
  }
  closeRegistration(scope: NativeProcessRecovery, id: string, signal?: AbortSignal): Promise<void> {
    const identity = JSON.stringify([resolve(scope.root), scope.owner, id])
    const previous = closing.get(identity)
    if (previous) return previous
    const attempt = timeRuntimeOperation('harness', 'process.close',
      async () => {
        await this.preparation
        await this.closeRegistered(scope, id, signal)
      }, { ownerId: scope.owner })
    closing.set(identity, attempt)
    void attempt.finally(() => { if (closing.get(identity) === attempt) closing.delete(identity) }).catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
    return attempt
  }

  private async closeRegistered(scope: NativeProcessRecovery, id: string, signal?: AbortSignal): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid process registration.')
    const observe = () => registryOperation(ownerOperation(scope), () => this.closeRegistrationStep(scope, id, signal))
    let observation = await observe()
    const end = Date.now() + 5_000
    const forceAt = Date.now() + 1_000
    let requested = false
    let forced = false
    while (observation) {
      signal?.throwIfAborted()
      const { launch } = observation
      if (observation.kind === 'active' && observation.birth) {
        const birth = observation.birth
        if (birth.containment && !forced && (Date.now() >= forceAt || !identityAlive(birth.guardian))) {
          killCgroup(birth.containment)
          forced = true
        }
        if (!requested && identityAlive(birth.guardian)) {
          try { await stopGuardian(launch, birth, signal); requested = true } catch (error) {
            if (signal?.aborted) throw error
            // Guardian can exit between lookup and connect. Observe again; never signal a stored PID.
          }
        }
      }
      // Keep storage mutations serialized, but let admissions inspect and reject live work while exit is pending.
      await delay(25, undefined, signal ? { signal } : {})
      if (Date.now() >= end) {
        if (observation.kind === 'unstarted') {
          throw new Error('Native registration still has a live process; retirement is unconfirmed.')
        }
        throw new Error('Native closure is unconfirmed. No PID-only termination or replacement process was attempted.')
      }
      observation = await observe()
    }
  }

  private async closeRegistrationStep(scope: NativeProcessRecovery, id: string,
    signal?: AbortSignal): Promise<RegistrationClosure | undefined> {
    signal?.throwIfAborted()
    const directory = join(privateDirectory(scope.root), key(scope.owner), id)
    // A retry after the GC rename must use the exact durable retirement receipt,
    // never infer closure merely because this registration is missing.
    try { lstatSync(directory) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT'
        || !retiredOwner(dirname(directory), scope.owner, id)) throw error
      const tombstone = join(dirname(directory), `.retired-${id}`)
      try { lstatSync(tombstone) } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return
        throw missing
      }
      privateDirectory(tombstone)
      rmSync(tombstone, { recursive: true })
      await syncDirectoryAsync(dirname(directory))
      return
    }
    privateDirectory(directory)
    const launch = launchRecord(readRecord(join(directory, 'intent.json')))
    if (launch.owner !== scope.owner || launch.id !== id) throw new Error('Native process owner mismatch.')
    const alreadyClosed = closedRecord(directory, launch)
    const neverStarted = readRecord(join(directory, 'not-started.json'))
    if (neverStarted !== undefined) {
      const record = recordObject(neverStarted)
      if (record.id !== id || record.owner !== scope.owner || readRecord(join(directory, 'birth.json')) !== undefined) {
        throw new Error('Conflicting native startup evidence.')
      }
      if (unstartedGuardianAlive(directory, launch)) return { kind: 'unstarted', launch }
      if (alreadyClosed) await retireRegistration(directory, launch)
      else await confirmClosed(directory, launch, 'native_not_started')
      return
    }
    if (alreadyClosed) { await retireRegistration(directory, launch); return }
    if (launch.boot !== bootIdentity()) { await confirmClosed(directory, launch, 'linux_boot_changed'); return }
    const rawBirth = readRecord(join(directory, 'birth.json'))
    if (rawBirth === undefined) {
      const dispatched = readRecord(join(directory, 'dispatched.json'))
      if (dispatched === undefined) {
        if (!identityAlive(launch.parent)) { await confirmClosed(directory, launch, 'native_not_started'); return }
      } else {
        const record = recordObject(dispatched)
        const guardian = recordObject(record.guardian)
        if (record.id !== id || !Number.isSafeInteger(guardian.pid) || Number(guardian.pid) <= 1
          || typeof guardian.startTicks !== 'string' || !/^\d+$/.test(guardian.startTicks)) throw new Error('Invalid guardian dispatch record.')
        if (!identityAlive({ pid: Number(guardian.pid), startTicks: guardian.startTicks })
          && readRecord(join(directory, 'birth.json')) === undefined) {
          await confirmClosed(directory, launch, 'native_not_started')
          return
        }
      }
      return { kind: 'active', launch }
    }
    const birth = birthRecord(rawBirth, launch)
    const evidence = observeCgroupClosure(directory, launch, birth)
    if (evidence) { await confirmClosed(directory, launch, evidence); return }
    return { kind: 'active', launch, birth }
  }
}

/** A fresh manager cannot overlap an older, still-running native process for this owner. */
async function assertOwnerIdle(directory: string, owner: string): Promise<void> {
  const boot = bootIdentity()
  const ids = await inventory(directory, owner)
  for (const id of ids) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Unexpected native process inventory entry.')
    const previous = privateDirectory(join(directory, id))
    const intent = launchRecord(readRecord(join(previous, 'intent.json')))
    if (intent.owner !== owner || intent.id !== id) throw new Error('Native owner inventory mismatch.')
    if (intent.boot !== boot) { await confirmClosed(previous, intent, 'linux_boot_changed'); continue }
    const notStarted = readRecord(join(previous, 'not-started.json'))
    if (notStarted !== undefined) {
      const record = recordObject(notStarted)
      if (record.id !== id || record.owner !== owner || readRecord(join(previous, 'birth.json')) !== undefined) {
        throw new Error('Conflicting native startup evidence.')
      }
      if (!unstartedGuardianAlive(previous, intent)) {
        await confirmClosed(previous, intent, 'native_not_started')
        continue
      }
    }
    const rawBirth = readRecord(join(previous, 'birth.json'))
    if (rawBirth !== undefined) {
      const evidence = observeCgroupClosure(previous, intent, birthRecord(rawBirth, intent))
      if (evidence) { await confirmClosed(previous, intent, evidence); continue }
    } else {
      const rawDispatch = readRecord(join(previous, 'dispatched.json'))
      if (rawDispatch === undefined) {
        if (!identityAlive(intent.parent)) { await confirmClosed(previous, intent, 'native_not_started'); continue }
      } else {
        const dispatched = recordObject(rawDispatch)
        const guardian = recordObject(dispatched.guardian)
        if (dispatched.id !== id || !Number.isSafeInteger(guardian.pid) || Number(guardian.pid) <= 1
          || typeof guardian.startTicks !== 'string' || !/^\d+$/.test(guardian.startTicks)) throw new Error('Invalid guardian dispatch record.')
        if (!identityAlive({ pid: Number(guardian.pid), startTicks: guardian.startTicks })
          && readRecord(join(previous, 'birth.json')) === undefined) {
          await confirmClosed(previous, intent, 'native_not_started'); continue
        }
      }
    }
    throw new Error('An earlier native process is still active or unconfirmed; recover it before starting another.')
  }
}

/** Publish a complete intent atomically. A crash before the rename cannot leave
 * a half-registration in the unresolved inventory. No executable is dispatched. */
async function reserveProcess(scope: NativeProcessRecovery): Promise<LaunchRecord> {
  const ownerDirectory = privateDirectory(join(privateDirectory(scope.root), key(scope.owner)))
  await assertOwnerIdle(ownerDirectory, scope.owner)
  const parent = processIdentity(process.pid)
  if (!parent) throw new Error('Cannot identify the launching API process.')
  const id = randomUUID()
  const launch: LaunchRecord = { format: 1, id, owner: scope.owner, boot: bootIdentity(), parent,
    controlKey: randomBytes(32).toString('hex') }
  const temporary = join(ownerDirectory, `.pending-${id}`)
  const directory = join(ownerDirectory, id)
  let published = false
  try {
    privateDirectory(temporary)
    writeRecord(join(temporary, 'intent.json'), launch, true)
    renameSync(temporary, directory)
    published = true
    syncDirectory(ownerDirectory)
  } catch (error) {
    // No guardian can dispatch until the reservation has been returned.
    try {
      rmSync(published ? directory : temporary, { recursive: true, force: true })
      syncDirectory(ownerDirectory)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Native launch reservation publication and rollback failed.',
        { cause: cleanupError })
    }
    throw error
  }
  publishObservation(directory)
  return launch
}

/** Sequential subprocesses need another awaited reservation; exact entered scopes keep their original identity. */
export async function prepareNativeProcessRecovery(scope: NativeProcessRecovery): Promise<NativeProcessRecovery> {
  const consumed = consumedLaunchScopes.get(scope)
  if (consumed && (consumed.root !== resolve(scope.root) || consumed.owner !== scope.owner
    || consumed.launchId !== scope.launchId)) throw new Error('The entered native launch scope was modified.')
  if (scope.launchId && !consumed) return scope
  return new NativeProcessRegistry(scope.root).reserveLaunch(scope.owner)
}

/** A recovered/revoked scope must NEVER silently allocate a replacement launch.
 * The parent identity and immutable id fence the handoff. All operations through
 * guardian dispatch are synchronous; a live parent cannot race its own cleanup.
 * A foreign recovery process can prove no-dispatch only after that parent dies. */
function takeLaunch(scope: NativeProcessRecovery): LaunchRecord {
  const consumed = consumedLaunchScopes.get(scope)
  if (consumed && (consumed.root !== resolve(scope.root) || consumed.owner !== scope.owner || consumed.launchId !== scope.launchId)) {
    throw new Error('The entered native launch scope was modified.')
  }
  if (!scope.launchId || consumed) throw new Error('Reserve the native launch before synchronous dispatch.')
  if (!/^[0-9a-f-]{36}$/.test(scope.launchId)) throw new Error('Invalid reserved native launch.')
  const directory = join(privateDirectory(scope.root), key(scope.owner), scope.launchId)
  const launch = launchRecord(readRecord(join(directory, 'intent.json')))
  const parent = processIdentity(process.pid)
  if (launch.id !== scope.launchId || launch.owner !== scope.owner || launch.boot !== bootIdentity()
    || !parent || launch.parent.pid !== parent.pid || launch.parent.startTicks !== parent.startTicks
    || readRecord(join(directory, 'claimed.json')) !== undefined
    || readRecord(join(directory, 'dispatched.json')) !== undefined
    || readRecord(join(directory, 'birth.json')) !== undefined
    || readRecord(join(directory, 'not-started.json')) !== undefined
    || readRecord(join(directory, 'closed.json')) !== undefined) {
    throw new Error('The exact native launch reservation is no longer dispatchable.')
  }
  // Exclusive, durable single-use claim; it does not authorize native code.
  // dispatched.json still precedes sending configuration to the guardian.
  writeRecord(join(directory, 'claimed.json'), { format: 1, id: launch.id, owner: scope.owner }, true)
  return launch
}

/**
 * A Node guardian leads the process session and writes a birth certificate BEFORE
 * spawning native code. Its authenticated control socket survives API replacement.
 * Native stdin/stdout/stderr retain their original pipe semantics.
 */
/** Linux recovery scopes must be reserved asynchronously before this synchronous dispatch. */
export function spawnNativeProcess(binary: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; recovery?: NativeProcessRecovery; restartDetachable?: true
  reconnectableStdio?: true
  purpose?: 'command' | 'inspection' | 'session'
  claudeSessionScope?: import('../claudeSdk/port.js').ClaudeSessionScope
}): ChildProcessWithoutNullStreams {
  return observeNativeProcess(spawnNativeProcessUnobserved(binary, args, {
    ...options, env: nativeAgentEnvironment(binary, options.cwd, options.env),
  }), binary, options.recovery?.owner, options.purpose ?? 'process')
}

const harnessLog = componentLogger('harness')
function publishObservation(directory: string): void {
  // Telemetry never changes dispatch or closure qualification on read failure.
  try { nativeRegistryProjection(dirname(dirname(directory))).observeLaunch(directory) }
  catch (error) { harnessLog.warn({ operation: 'publish native process observation', owner: basename(directory), err: error }, 'Native observation publication unavailable') }
}
function publishRetirement(directory: string): void {
  try { nativeRegistryProjection(dirname(dirname(directory))).observeRetirement(directory) }
  catch (error) { harnessLog.warn({ operation: 'publish native process observation', owner: basename(directory), err: error }, 'Native observation publication unavailable') }
}
/** Arguments and environment can carry prompts and credentials; log only lifecycle facts. */
function observeNativeProcess(child: ChildProcessWithoutNullStreams, binary: string,
  owner: string | undefined, purpose: 'command' | 'inspection' | 'session' | 'process') {
  const facts = { binary: basename(binary), purpose, ...(owner ? { owner } : {}) }
  child.once('spawn', () => harnessLog.info({ ...facts, childPid: child.pid }, `harness ${purpose} started`))
  // No 'error' listener here: adding one would change whether an unhandled spawn error crashes the caller.
  child.once('exit', (exitCode, signal) => {
    const guardian = owned.has(child) ? { guardianExitCode: exitCode, guardianSignal: signal } : {}
    let outcome: NativeProcessExit
    try { outcome = nativeProcessExit(child, { exitCode, exitSignal: signal }) }
    catch {
      harnessLog.warn({ ...facts, childPid: child.pid, ...guardian, outcomeReceipt: 'invalid' },
        `harness ${purpose} outcome unavailable`)
      return
    }
    harnessLog[outcome.exitCode === 0 ? 'info' : 'warn']({
      ...facts, childPid: child.pid, exitCode: outcome.exitCode, signal: outcome.exitSignal, ...guardian,
    }, `harness ${purpose} exited`)
  })
  return child
}

function spawnNativeProcessUnobserved(binary: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; recovery?: NativeProcessRecovery; restartDetachable?: true
  reconnectableStdio?: true
  claudeSessionScope?: import('../claudeSdk/port.js').ClaudeSessionScope
}): ChildProcessWithoutNullStreams {
  if (!options.recovery || process.platform !== 'linux') return spawn(binary, args, {
    cwd: options.cwd, env: options.env, detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  const scope = options.recovery
  const launch = takeLaunch(scope)
  const { id } = launch
  const directory = join(privateDirectory(scope.root), key(scope.owner), id)
  const child = spawn(process.execPath, ['-e', NATIVE_GUARDIAN_SOURCE], {
    cwd: directory, env: {}, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  }) as ChildProcessWithoutNullStreams
  // Observe startup errors before sending configuration or exposing the child to the adapter.
  child.on('error', () => undefined)
  owned.set(child, { scope, id, ...(options.restartDetachable ? { restartDetachable: true } : {}) })
  if (scope.launchId && !consumedLaunchScopes.has(scope)) consumedLaunchScopes.set(scope,
    { root: resolve(scope.root), owner: scope.owner, launchId: scope.launchId })
  child.once('exit', () => publishObservation(directory))
  let dispatchAttempted = false
  try {
    if (!child.pid) {
      writeRecord(join(directory, 'not-started.json'), { id, owner: scope.owner }, true)
      return child // Node emits the ordinary spawn error; no native configuration was sent.
    }
    const guardian = processIdentity(child.pid)
    if (!guardian) throw new Error('Native guardian exited before registration.')
    writeRecord(join(directory, 'dispatched.json'), { format: 1, id, guardian }, true)
    publishObservation(directory)
    // Only the guardian owns this IPC channel; native stdio never carries receipts.
    // Match the immutable launch and guardian generation before accepting an outcome.
    child.on('message', (message: unknown) => {
      const registration = owned.get(child)!
      try {
        const row = recordObject(message)
        if (row.operation === 'observation') {
          if (row.id === id) publishObservation(directory)
          return
        }
        const source = recordObject(row.guardian)
        if (row.format !== 1 || row.operation !== 'native_exit' || row.id !== id
          || row.owner !== launch.owner || row.boot !== launch.boot
          || source.pid !== guardian.pid || source.startTicks !== guardian.startTicks
          || !Number.isSafeInteger(row.nativePid) || Number(row.nativePid) <= 1
          || !((Number.isInteger(row.exitCode) && Number(row.exitCode) >= 0 && Number(row.exitCode) <= 255 && row.exitSignal === null)
            || (row.exitCode === null && typeof row.exitSignal === 'string' && Object.hasOwn(constants.signals, row.exitSignal)))
          || registration.exit) throw new Error('Invalid native exit receipt for this launch.')
        registration.exit = { exitCode: row.exitCode as number | null, exitSignal: row.exitSignal as NodeJS.Signals | null }
      } catch (error) {
        registration.receiptError = error instanceof Error ? error : new Error('Invalid native exit receipt.')
      }
    })
    dispatchAttempted = true
    child.send({ operation: 'start', directory, binary, args, cwd: options.cwd, environment: options.env,
      ...(options.claudeSessionScope ? { claudeSessionScope: options.claudeSessionScope } : {}),
      reconnectableStdio: options.reconnectableStdio === true,
      restartDetachable: options.restartDetachable === true }, (error) => {
      if (error) { try { child.disconnect() } catch { /* ignore: already disconnected. */ } }
    })
  } catch (error) {
    // Until configuration dispatch the guardian has no native child. Closing IPC asks it to exit.
    try {
      if (!dispatchAttempted) writeRecord(join(directory, 'not-started.json'), { id, owner: scope.owner }, true)
    } finally { if (child.connected) child.disconnect() }
    throw error
  }
  return child
}

/** Persist the registration that owns this child, including its exact launch generation. */
export function registeredNativeProcess(child: ChildProcess): NativeProcessRecovery | undefined {
  const registration = owned.get(child)
  if (!registration) return undefined
  return { root: registration.scope.root, owner: registration.scope.owner, launchId: registration.id }
}

function restartDetachment(scope: NativeProcessRecovery, observation: NativeLaunchObservation) {
  const directory = join(scope.root, key(scope.owner), observation.launchId)
  if (!existingPrivateDirectory(directory)) return undefined
  const raw = readRecord(join(directory, 'restart-detached.json'))
  if (raw === undefined) return undefined
  const marker = recordObject(raw)
  const launch = launchRecord(readRecord(join(directory, 'intent.json')))
  const birth = birthRecord(readRecord(join(directory, 'birth.json')), launch)
  const captured = recordObject(readRecord(join(directory, 'provider.json')))
  const provider = recordObject(captured.provider)
  if (launch.id !== observation.launchId || launch.owner !== scope.owner || launch.boot !== observation.bootId
    || marker.format !== 1 || marker.id !== launch.id || marker.owner !== launch.owner || marker.boot !== launch.boot
    || typeof marker.reconnectableStdio !== 'boolean'
    || captured.format !== 1 || captured.id !== launch.id || captured.owner !== launch.owner
    || captured.boot !== launch.boot || captured.capture !== 'captured'
    || !isDeepStrictEqual(captured.guardian, birth.guardian)
    || !isDeepStrictEqual(marker.guardian, birth.guardian) || !isDeepStrictEqual(marker.provider, captured.provider)
    || !observation.guardian || !observation.provider
    || birth.guardian.pid !== observation.guardian.pid || birth.guardian.startTicks !== observation.guardian.startTicks
    || provider.pid !== observation.provider.pid || provider.startTicks !== observation.provider.startTicks) {
    throw new Error('Detached native process identity changed.')
  }
  return { launch, birth, marker }
}

/** Recorded restart detachment remains readable after the original provider exits. */
export function hasNativeRestartDetachment(scope: NativeProcessRecovery): boolean {
  const launches = new NativeProcessRegistry(scope.root).snapshot().launches.filter(launch =>
    launch.owner === scope.owner && launch.lifecycle !== 'closed'
      && (!scope.launchId || launch.launchId === scope.launchId))
  if (launches.length > 1) throw new Error('Restart-detached native owner is ambiguous.')
  const launch = launches[0]
  return launch !== undefined && restartDetachment(scope, launch) !== undefined
}

/** Original daemon identity only; a detached marker cannot authorize a new launch. */
export function readDetachedNativeProcess(scope: NativeProcessRecovery): NativeLaunchObservation | undefined {
  const launches = new NativeProcessRegistry(scope.root).snapshot().launches.filter(launch =>
    launch.owner === scope.owner && (!scope.launchId || launch.launchId === scope.launchId))
  const detached = launches.filter(launch => {
    if (!restartDetachment(scope, launch)) return false
    return launch.lifecycle === 'active' && launch.bootId === bootIdentity()
      && !!launch.guardian && identityAlive(launch.guardian) && !!launch.provider && identityAlive(launch.provider)
      && !!launch.boundary && cgroupPopulated(cgroupBoundary(launch.boundary, launch.launchId))
  })
  if (detached.length > 1) throw new Error('Detached native owner is ambiguous.')
  return detached[0]
}

function detachedStdioRegistration(scope: NativeProcessRecovery) {
  const detached = readDetachedNativeProcess(scope)
  if (!detached) return undefined
  const registration = restartDetachment(scope, detached)
  if (registration?.marker.reconnectableStdio !== true) return undefined
  return registration
}

export function hasDetachedStdioProcess(scope: NativeProcessRecovery): boolean {
  return detachedStdioRegistration(scope) !== undefined
}

/** Authenticated control stays separate from provider JSON-RPC, including after takeover. */
async function stdioControl(scope: NativeProcessRecovery, operation: 'attach' | 'environment' | 'detach',
  connectionId?: string, signal?: AbortSignal): Promise<{
    socket: Socket; reply: Record<string, unknown>; launch: LaunchRecord; birth: BirthRecord
  }> {
  const registration = detachedStdioRegistration(scope)
  if (!registration) throw new Error('The original Codex daemon is unavailable.')
  const { launch, birth } = registration
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const socket = connect({ path: socketName(launch.id) })
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => fail(new Error('Native observer control timed out.')), 2_000)
    const abort = () => fail(new Error('Native observer control canceled.', { cause: signal?.reason }))
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      socket.removeListener('data', receive)
      socket.removeListener('error', fail)
      socket.removeListener('end', ended)
    }
    const fail = (error: Error) => { cleanup(); socket.destroy(); reject(error) }
    const ended = () => fail(new Error('Native observer disconnected before acknowledgement.'))
    const receive = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf(10)
      if (end < 0) {
        if (buffer.length > 4 * 1024 * 1024) fail(new Error('Invalid native observer acknowledgement.'))
        return
      }
      try {
        const reply = recordObject(JSON.parse(buffer.subarray(0, end).toString('utf8')))
        if (reply.id !== launch.id || reply.startTicks !== birth.guardian.startTicks || reply.accepted !== true) {
          throw new Error('Native observer generation changed.')
        }
        socket.pause()
        cleanup()
        if (buffer.length > end + 1) socket.unshift(buffer.subarray(end + 1))
        resolve({ socket, reply, launch, birth })
      } catch (error) { fail(error instanceof Error ? error : new Error('Invalid native observer reply.')) }
    }
    socket.on('data', receive)
    socket.once('error', fail)
    socket.once('end', ended)
    signal?.addEventListener('abort', abort, { once: true })
    socket.once('connect', () => socket.write(JSON.stringify({ id: launch.id, owner: launch.owner,
      controlKey: launch.controlKey, startTicks: birth.guardian.startTicks, operation, connectionId }) + '\n'))
    if (signal?.aborted) abort()
  })
}

export async function detachedStdioEnvironment(scope: NativeProcessRecovery, signal?: AbortSignal) {
  if (!hasDetachedStdioProcess(scope)) return undefined
  const { socket, reply } = await stdioControl(scope, 'environment', undefined, signal)
  socket.destroy()
  const variables = recordObject(reply.variables)
  if (Object.entries(variables).some(([name, value]) =>
    !['FOREMAN_CODE_MCP_TOKEN', 'GRAPHQL_MCP_TOKEN'].includes(name) || typeof value !== 'string' || !value)) {
    throw new Error('Invalid retained native credential environment.')
  }
  const token = variables.GRAPHQL_MCP_TOKEN ?? variables.FOREMAN_CODE_MCP_TOKEN
  if (typeof token !== 'string' || !token
    || variables.GRAPHQL_MCP_TOKEN && variables.FOREMAN_CODE_MCP_TOKEN
      && variables.GRAPHQL_MCP_TOKEN !== variables.FOREMAN_CODE_MCP_TOKEN) {
    throw new Error('Retained native credential aliases do not match.')
  }
  return { GRAPHQL_MCP_TOKEN: token }
}

export async function attachDetachedStdio(scope: NativeProcessRecovery, signal?: AbortSignal) {
  const connectionId = randomUUID()
  const { socket, reply, launch, birth } = await stdioControl(scope, 'attach', connectionId, signal)
  let threadSettings: Record<string, unknown>
  try { threadSettings = recordObject(reply.threadSettings) }
  catch (error) {
    socket.destroy()
    if (!await new NativeProcessRegistry(scope.root).closeOwner(scope.owner)) {
      throw new AggregateError([error], 'Invalid observer reply and native closure remain unconfirmed.', { cause: error })
    }
    throw error
  }
  const directory = join(scope.root, key(scope.owner), launch.id)
  return { socket, threadSettings, originalProcessClosed: () => {
    return retiredOwner(dirname(directory), scope.owner, launch.id)
      || observeCgroupClosure(directory, launch, birth) !== undefined
  }, detach: async () => {
    const detached = await stdioControl(scope, 'detach', connectionId)
    detached.socket.destroy()
    socket.destroy()
  }, close: async () => {
    socket.destroy()
    if (!await new NativeProcessRegistry(scope.root).closeOwner(scope.owner)) {
      throw new Error('Original Codex daemon closure is unconfirmed.')
    }
  } }
}

/** Release the original HTTP daemon's pipes after authenticated guardian detachment. */
export async function detachRecoveredChild(child: ChildProcessWithoutNullStreams,
  signal?: AbortSignal): Promise<NativeLaunchObservation> {
  const registration = owned.get(child)
  if (!registration?.restartDetachable || registration.closed) throw new Error('Native process is not restart detachable.')
  const directory = join(privateDirectory(registration.scope.root), key(registration.scope.owner), registration.id)
  const launch = launchRecord(readRecord(join(directory, 'intent.json')))
  const birth = birthRecord(readRecord(join(directory, 'birth.json')), launch)
  await controlGuardian(launch, birth, 'detach', signal)
  const detached = readDetachedNativeProcess({ ...registration.scope, launchId: registration.id })
  if (!detached || detached.launchId !== registration.id) throw new Error('Native process detachment is unconfirmed.')
  if (child.connected) child.disconnect()
  child.stdin.destroy()
  child.stdout.destroy()
  child.stderr.destroy()
  child.unref()
  return detached
}

/** A guardian cleanup signal is not the native outcome. Missing receipts retain
 * the actual wrapper failure; retirement/empty containment never implies success. */
export function nativeProcessExit(child: ChildProcess, fallback: NativeProcessExit): NativeProcessExit {
  const registration = owned.get(child)
  if (registration?.receiptError) throw registration.receiptError
  if (registration && !registration.exit && fallback.exitCode === 0) throw new Error('Native exit receipt is missing for this launch.')
  return registration?.exit ?? fallback
}

/** Registered children MUST NOT fall through to legacy PID/group signaling. */
export async function stopRecoveredChild(child: ChildProcess): Promise<boolean> {
  const registration = owned.get(child)
  if (!registration) return false
  if (registration.closed) return true
  await new NativeProcessRegistry(registration.scope.root).closeRegistration(registration.scope, registration.id)
  registration.closed = true
  return true
}
