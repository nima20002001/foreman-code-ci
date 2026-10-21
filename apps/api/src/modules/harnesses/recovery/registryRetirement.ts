import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { NativeProcessObservationSchema } from '@foreman-code/contracts/remote-execution-entry-closure'
import { registryOperation } from './registryOperations.js'
import { bootIdentity, identityAlive } from './linuxIdentity.js'
import { nativeRegistryProjection, type NativeLaunchObservation } from './registryObservation.js'
import { existingPrivateDirectory, privateDirectory, readRecord, recordObject, syncDirectory,
  writeRecord, writeRecordBatch, storageBatch, syncDirectoryAsync } from './storage.js'

/** Preserve every closure before committing a batch of registration removals. */
export async function retireRegistrations(directory: string, observations: ReadonlyMap<string, NativeLaunchObservation>): Promise<void> {
  const records = new Map<string, unknown>()
  let last: NativeLaunchObservation | undefined
  for (const [id, observation] of observations) {
    records.set(`closed-${id}.json`, observation)
    last = observation
  }
  if (!last) return
  // The owner summary needs only the final closure; exact retries use the individual receipts.
  records.set('retired.json', { format: 2, owner: last.owner, id: last.launchId, observation: last })
  await writeRecordBatch(directory, records)
  const ids = [...observations.keys()]
  await storageBatch(ids, async id => {
    await rename(join(directory, id), join(directory, `.retired-${id}`))
  })
  await syncDirectoryAsync(directory)
  // Durable tombstones commit removal before deletion; interrupted GC cannot resurrect a registration.
  await storageBatch(ids, async id => { await rm(join(directory, `.retired-${id}`), { recursive: true }) })
  await syncDirectoryAsync(directory)
}

// Keep fresh closure certificates in place for in-flight recovery and retries.
const closureRetentionMs = 24 * 60 * 60 * 1000
/** When each root's last maintenance sweep finished. */
const sweptRoots = new Map<string, number>()

function existingStat(path: string) {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function directoryEntries(path: string): string[] {
  try {
    if (!existingPrivateDirectory(path)) return []
    return readdirSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Retain exact closure readback outside the hot process inventory. */
export function pruneClosedObservation(directory: string, id: string): void {
  const path = join(directory, `closed-${id}.json`)
  const stat = existingStat(path)
  if (!stat || Date.now() - stat.mtimeMs < closureRetentionMs) return
  // A crash may leave a closure certificate beside an unfinished retirement.
  if (existingStat(join(directory, id)) || existingStat(join(directory, `.retired-${id}`))) return
  const raw = readRecord(path)
  if (raw === undefined) return
  const row = NativeProcessObservationSchema.parse(raw)
  if (row.launchId !== id || row.lifecycle !== 'closed' || !row.closureEvidence
    || createHash('sha256').update(row.owner).digest('hex') !== basename(directory)) {
    throw new Error('Invalid native closure archive record.')
  }
  if (row.bootId === bootIdentity() && [row.guardian, row.provider].some(process => process && identityAlive(process))) {
    return
  }
  const archive = privateDirectory(join(directory, 'closed'))
  const destination = join(archive, `${id}.json`)
  const previous = readRecord(destination)
  if (previous !== undefined && !isDeepStrictEqual(previous, raw)) {
    throw new Error('Conflicting archived native closure.')
  }
  if (previous === undefined) {
    try { writeRecord(destination, raw, true) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
        || !isDeepStrictEqual(readRecord(destination), raw)) throw error
    }
  }
  // The archive is fsynced before unlink: interruption leaves at least one certificate.
  syncDirectory(archive)
  try { unlinkSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  syncDirectory(directory)
}

function archiveRecord(destination: string, raw: unknown): void {
  const previous = readRecord(destination)
  if (previous !== undefined && !isDeepStrictEqual(previous, raw)) {
    throw new Error('Conflicting archived native closure.')
  }
  if (previous === undefined) writeRecord(destination, raw, true)
}

function pruneRetiredOwner(directory: string): void {
  const path = join(directory, 'retired.json')
  const stat = existingStat(path)
  if (!stat || Date.now() - stat.mtimeMs < closureRetentionMs) return
  const names = directoryEntries(directory)
  if (names.some(name => name !== 'retired.json' && name !== 'closed')) return
  const retired = recordObject(readRecord(path))
  // Archiving is startup housekeeping: receipts it cannot verify (older ones carry no observation) stay in place.
  const parsed = NativeProcessObservationSchema.safeParse(retired.observation)
  if (!parsed.success) return
  const observation = parsed.data
  const ownerKey = basename(directory)
  if (retired.format !== 2 || retired.owner !== observation.owner || retired.id !== observation.launchId
    || observation.lifecycle !== 'closed' || !observation.closureEvidence
    || createHash('sha256').update(observation.owner).digest('hex') !== ownerKey) return
  if (observation.bootId === bootIdentity()
    && [observation.guardian, observation.provider].some(process => process && identityAlive(process))) return
  const local = join(directory, 'closed')
  const certificates: { name: string; row: typeof observation }[] = []
  for (const name of directoryEntries(local)) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) return
    const row = NativeProcessObservationSchema.safeParse(readRecord(join(local, name)))
    if (!row.success || row.data.owner !== observation.owner || `${row.data.launchId}.json` !== name
      || row.data.lifecycle !== 'closed' || !row.data.closureEvidence) return
    certificates.push({ name, row: row.data })
  }
  if (certificates.some(({ row }) => row.bootId === bootIdentity()
    && [row.guardian, row.provider].some(process => process && identityAlive(process)))) return
  const archive = privateDirectory(join(dirname(directory), 'closed'))
  for (const { name, row } of certificates) archiveRecord(join(archive, `${ownerKey}-${name}`), row)
  // Preserve the last observation separately so owner-wide retries and telemetry survive GC.
  writeRecord(join(archive, `${ownerKey}.json`), retired)
  syncDirectory(archive)
  for (const { name } of certificates) unlinkSync(join(local, name))
  if (existingPrivateDirectory(local)) rmdirSync(local)
  unlinkSync(path)
  syncDirectory(directory)
  rmdirSync(directory)
  syncDirectory(dirname(directory))
}

/** Owners visited so far per root: maintenance resumes where the previous registry construction stopped. */
const retirementCursors = new Map<string, string>()
/** Each registry construction spends at most this long on maintenance, so a large backlog never blocks startup. */
export const REGISTRY_RETIREMENT_BUDGET_MS = 100

/** Owners keep aging while the API runs, so a finished sweep starts again after this interval. */
const REGISTRY_RETIREMENT_INTERVAL_MS = 60 * 60 * 1000

/** Maintenance sweeps each root in budgeted slices and repeats hourly; passive telemetry never performs GC. */
export async function prepareRegistryRetirement(root: string,
  retire: (directory: string, batch: Map<string, NativeLaunchObservation>) => Promise<void>): Promise<void> {
  const swept = sweptRoots.get(root)
  if ((swept !== undefined && Date.now() - swept < REGISTRY_RETIREMENT_INTERVAL_MS) || !existingPrivateDirectory(root)) return
  const deadline = performance.now() + REGISTRY_RETIREMENT_BUDGET_MS
  await nativeRegistryProjection(root).retirementBatch(async () => {
    const cursor = retirementCursors.get(root)
    // Archived owners leave the listing, so resume after the last visited owner name rather than an index.
    const owners = directoryEntries(root).sort().filter(name => cursor === undefined || name > cursor)
    for (const ownerKey of owners) {
      if (performance.now() > deadline) return
      retirementCursors.set(root, ownerKey)
      if (!/^[0-9a-f]{64}$/.test(ownerKey)) continue
      await registryOperation(JSON.stringify([resolve(root), ownerKey]), async () => {
        const directory = join(root, ownerKey)
        const closures = new Map<string, NativeLaunchObservation>()
        try {
          for (const name of directoryEntries(directory)) {
            const match = /^closed-([0-9a-f-]{36})\.json$/.exec(name)
            if (match) pruneClosedObservation(directory, match[1]!)
            if (/^[0-9a-f-]{36}$/.test(name)) {
              const registration = join(directory, name)
              if (!existingPrivateDirectory(registration)) continue
              const closed = existingStat(join(registration, 'closed.json'))
              if (closed && Date.now() - closed.mtimeMs >= closureRetentionMs) await retire(registration, closures)
            }
          }
        } finally { await retireRegistrations(directory, closures) }
        pruneRetiredOwner(directory)
      })
    }
    retirementCursors.delete(root)
    sweptRoots.set(root, Date.now())
  })
}
