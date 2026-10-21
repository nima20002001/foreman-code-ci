import { createHash } from 'node:crypto'
import { lstatSync, opendirSync, rmdirSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { NativeProcessObservationSchema } from '@foreman-code/contracts/remote-execution-entry-closure'
import { bootIdentity, identityAlive } from './linuxIdentity.js'
import { existingPrivateDirectory, readRecord, syncDirectory } from './storage.js'

const retentionMs = 24 * 60 * 60 * 1000
const sweepIntervalMs = 60 * 60 * 1000
const batchSize = 100
const oneShotPrefixes = new Set([
  'managed-mcp:codex', 'catalog-authentication', 'model-catalog', 'claude-metadata',
  'operator-configuration-inspection', 'native-output-qualification', 'claude-profile-version', 'claude-profile-check',
])

function* entries(directory: string): Generator<string> {
  if (!existingPrivateDirectory(directory)) return
  const handle = opendirSync(directory)
  try {
    for (let entry = handle.readSync(); entry; entry = handle.readSync()) yield entry.name
  } finally { handle.closeSync() }
}

function* certificates(root: string): Generator<{ path: string; ownerKey: string }> {
  for (const name of entries(join(root, 'closed'))) {
    const match = /^([a-f0-9]{64})(?:-[a-f0-9-]{36})?\.json$/.exec(name)
    if (match) yield { path: join(root, 'closed', name), ownerKey: match[1]! }
  }
  for (const ownerKey of entries(root)) {
    if (!/^[a-f0-9]{64}$/.test(ownerKey)) continue
    const directory = join(root, ownerKey)
    for (const name of entries(directory)) {
      if (name === 'retired.json' || /^closed-[a-f0-9-]{36}\.json$/.test(name)) {
        yield { path: join(directory, name), ownerKey }
      }
    }
    for (const name of entries(join(directory, 'closed'))) {
      if (/^[a-f0-9-]{36}\.json$/.test(name)) yield { path: join(directory, 'closed', name), ownerKey }
    }
  }
}

function removeEmpty(directory: string): void {
  try { rmdirSync(directory) } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  }
}

/** Cold cleanup advances its own cursor; drain and recovery never enumerate the archive. */
export class NativeRegistryRetention {
  private cursor: ReturnType<typeof certificates> | undefined
  private sweptAt: number | undefined
  private pending: Promise<number> | undefined

  constructor(private readonly root: string) {}

  close(): void {
    this.cursor?.return(undefined)
    this.cursor = undefined
  }

  prune(isSettled: (owner: string) => Promise<boolean>, now: number): Promise<number> {
    if (this.pending) return this.pending
    this.pending = this.sweep(isSettled, now).finally(() => { this.pending = undefined })
    return this.pending
  }

  private async sweep(isSettled: (owner: string) => Promise<boolean>, now: number): Promise<number> {
    if (this.sweptAt !== undefined && now - this.sweptAt < sweepIntervalMs) return 0
    this.cursor ??= certificates(this.root)
    let removed = 0
    const dirtyDirectories = new Set<string>()
    try {
      for (let visited = 0; visited < batchSize; visited++) {
        const next = this.cursor.next()
        if (next.done) {
          this.cursor = undefined
          this.sweptAt = now
          break
        }
        if (await this.remove(next.value, isSettled, now)) {
          removed++
          dirtyDirectories.add(dirname(next.value.path))
        }
      }
    } catch (error) {
      this.close()
      throw error
    } finally {
      // One directory sync commits the batch; interrupted cleanup can safely retry.
      for (const directory of dirtyDirectories) syncDirectory(directory)
      for (const directory of dirtyDirectories) {
        const ownerDirectory = basename(directory) === 'closed' ? dirname(directory) : directory
        if (!/^[a-f0-9]{64}$/.test(basename(ownerDirectory))) continue
        removeEmpty(join(ownerDirectory, 'closed'))
        removeEmpty(ownerDirectory)
      }
      if (dirtyDirectories.size) syncDirectory(this.root)
    }
    return removed
  }

  private async remove(candidate: { path: string; ownerKey: string },
    isSettled: (owner: string) => Promise<boolean>, now: number): Promise<boolean> {
    const { path, ownerKey } = candidate
    let before
    try { before = lstatSync(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    if (now - before.mtimeMs <= retentionMs) return false
    const raw = readRecord(path)
    const value = raw && typeof raw === 'object' && 'observation' in raw ? raw.observation : raw
    const parsed = NativeProcessObservationSchema.safeParse(value)
    if (!parsed.success) return false
    const row = parsed.data
    if (row.lifecycle !== 'closed' || !row.closureEvidence
      || createHash('sha256').update(row.owner).digest('hex') !== ownerKey) return false
    if (row.bootId === bootIdentity() && [row.guardian, row.provider].some(process => process && identityAlive(process))) {
      return false
    }
    // Confirmed-closed one-shot inspections have no workflow acknowledgement to wait for.
    const separator = row.owner.lastIndexOf(':')
    const prefix = row.owner.slice(0, separator)
    const operationId = row.owner.slice(separator + 1)
    const oneShot = oneShotPrefixes.has(prefix)
      && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(operationId)
    if (!oneShot && !await isSettled(row.owner)) return false
    const after = lstatSync(path)
    if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs) return false
    unlinkSync(path)
    return true
  }
}
