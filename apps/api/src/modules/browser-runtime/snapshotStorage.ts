import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, lstat, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { BrowserProfileSnapshotManifestSchema } from '@foreman-code/contracts/browser-profiles'
import { DomainError } from '../errors.js'
import { browserInputHash, browserOrigin, sameBrowserSnapshot } from '../browser-profiles/identity.js'
import type { BrowserProfileSnapshotManifest, BrowserSnapshotTransfer, BrowserSnapshotIdentity } from '../browser-profiles/types.js'
import { assertBrowserGenerationStopped, syncBrowserProfileTree } from './profileCheckpoint.js'

/** This is private portable storage, not an API/domain schema. Secret values never leave encrypted byte paths. */
export interface BrowserPortableState {
  cookies: Record<string, unknown>[]
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>
  unsupportedState: Array<{ origin: string; reason: string }>
}

export function assertPortableBrowserCookies(cookies: readonly Record<string, unknown>[]): void {
  if (cookies.some(cookie => cookie.partitionKey || cookie.partitionKeyOpaque)) {
    throw new DomainError('SNAPSHOT_COOKIE_UNSUPPORTED',
      'Partitioned cookies cannot be synced with this profile format. Sign in locally on the destination.', 422)
  }
}
interface ProfileDiskRecord { revision: number; deleted: boolean; generation: number; origins: string[]; applied: BrowserProfileSnapshotManifest | null }
interface ExportReceipt { operationId: string; inputHash: string; manifest: BrowserProfileSnapshotManifest; encrypted?: string; stateHash: string; sourceInstallationId: string }
export interface BrowserSnapshotKeyMaterial { key: Uint8Array; keyId: string; sourceInstallationId: string; sourceOperationId: string; stateHash: string }

export interface BrowserSnapshotStorageOptions {
  root: string
  computerId: string
  installationId: string
  /** The existing paired-computer secret owner supplies the profile key. Never store keys in inventory/receipts. */
  exportKey(profileId: string, publishedRevision: number, operationId: string, stateHash: string): Promise<BrowserSnapshotKeyMaterial>
  snapshotKey(transfer: BrowserSnapshotTransfer): Promise<BrowserSnapshotKeyMaterial>
  busy(profileId: string): boolean
  maintenance<T>(profileId: string, work: () => Promise<T>): Promise<T>
  closeProfile(profileId: string): Promise<void>
  exportState(profileId: string, origins: readonly string[]): Promise<BrowserPortableState>
  importState(profileId: string, directory: string, generation: number, state: BrowserPortableState): Promise<void>
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
    || process.getuid && info.uid !== process.getuid()) throw new DomainError('BROWSER_STORAGE_INVALID', 'Browser storage must be private and owned by this host.', 503)
}

async function writePrivate(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  await rename(temporary, path)
  const directory = await open(dirname(path), 'r')
  try { await directory.sync() } finally { await directory.close() }
}

async function readRecord<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export class BrowserSnapshotStorage {
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly processTails = new Map<string, Promise<number>>()
  constructor(readonly options: BrowserSnapshotStorageOptions) {}
  private root(profileId: string) { return join(this.options.root, 'profiles', browserInputHash(profileId)) }

  private exclusive<T>(profileId: string, work: () => Promise<T>, maintenance = false): Promise<T> {
    const previous = this.tails.get(profileId) ?? Promise.resolve()
    const perform = () => maintenance ? this.options.maintenance(profileId, work) : work()
    const task = previous.then(perform, perform)
    this.tails.set(profileId, task)
    void task.finally(() => { if (this.tails.get(profileId) === task) this.tails.delete(profileId) })
      .catch(() => { /* ignore: the returned operation carries the failure. */ })
    return task
  }

  private async record(profileId: string): Promise<ProfileDiskRecord> {
    const value = await readRecord<ProfileDiskRecord>(join(this.root(profileId), 'profile.json'))
    if (!value || value.deleted) throw new DomainError('PROFILE_MISSING', 'This managed profile is not present on this computer.', 404)
    return value
  }

  private save(profileId: string, record: ProfileDiskRecord): Promise<void> {
    return writePrivate(join(this.root(profileId), 'profile.json'), Buffer.from(JSON.stringify({ ...record, profileId })))
  }

  async directory(profileId: string): Promise<{ directory: string; generation: number }> {
    const record = await this.record(profileId), directory = join(this.root(profileId), `generation-${record.generation}`)
    await privateDirectory(directory)
    return { directory, generation: record.generation }
  }

  allocateProcessGeneration(profileId: string): Promise<number> {
    const previous = this.processTails.get(profileId) ?? Promise.resolve(0)
    const allocate = async () => {
      const root = this.root(profileId); await privateDirectory(root)
      const path = join(root, 'process-generation.json')
      const current = await readRecord<{ generation: number }>(path)
      const generation = (current?.generation ?? 0) + 1
      if (!Number.isSafeInteger(generation) || generation < 1) throw new DomainError('BROWSER_GENERATION_INVALID', 'Browser process generation is invalid.', 503)
      await writePrivate(path, Buffer.from(JSON.stringify({ generation })))
      return generation
    }
    const task = previous.then(allocate, allocate)
    this.processTails.set(profileId, task)
    return task
  }

  async exists(profileId: string): Promise<boolean> {
    const value = await readRecord<ProfileDiskRecord>(join(this.root(profileId), 'profile.json'))
    return Boolean(value && !value.deleted)
  }

  /** Includes profiles with a process allocated before their first session could be persisted. */
  async *profileIds(): AsyncIterable<string> {
    const root = join(this.options.root, 'profiles')
    let entries: string[]
    try { entries = await readdir(root) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const name of entries) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue
      const value = await readRecord<ProfileDiskRecord & { profileId: string }>(join(root, name, 'profile.json'))
      if (value && !value.deleted && typeof value.profileId === 'string' && browserInputHash(value.profileId) === name) yield value.profileId
    }
  }

  async create(profileId: string, revision: number): Promise<void> {
    await this.exclusive(profileId, async () => {
      await privateDirectory(this.root(profileId))
      const existing = await readRecord<ProfileDiskRecord>(join(this.root(profileId), 'profile.json'))
      if (existing && existing.revision > revision) throw new DomainError('PROFILE_OPERATION_SUPERSEDED', 'A newer profile operation replaced this request.', 409)
      if (existing && existing.revision === revision && !existing.deleted) return
      if (existing?.deleted && existing.revision >= revision) throw new DomainError('PROFILE_OPERATION_SUPERSEDED', 'A newer explicit add is required after removal.', 409)
      if (existing && !existing.deleted) {
        await this.save(profileId, { ...existing, revision }); return
      }
      const generations = (await readdir(this.root(profileId))).map(name => /^generation-(\d+)$/.exec(name)).filter(value => value !== null).map(value => Number(value![1]))
      const generation = Math.max(existing?.generation ?? 0, ...generations) + 1
      if (!Number.isSafeInteger(generation)) throw new DomainError('BROWSER_GENERATION_INVALID', 'The profile generation is invalid.', 503)
      await privateDirectory(join(this.root(profileId), `generation-${generation}`))
      await this.save(profileId, { revision, deleted: false, generation, origins: [], applied: null })
    }, true)
  }

  async remove(profileId: string, revision: number): Promise<void> {
    await this.exclusive(profileId, async () => {
      await privateDirectory(this.root(profileId))
      const previous = await readRecord<ProfileDiskRecord>(join(this.root(profileId), 'profile.json'))
      if (previous && previous.revision > revision) throw new DomainError('PROFILE_OPERATION_SUPERSEDED', 'A newer profile operation replaced this request.', 409)
      this.assertIdle(profileId)
      if (previous && !previous.deleted) await this.options.closeProfile(profileId)
      // Tombstone is committed before deletion so a stale create receipt cannot resurrect this identity.
      const record: ProfileDiskRecord = { revision, deleted: true, generation: previous?.generation ?? 1, origins: [], applied: null }
      await this.save(profileId, record)
      const generations = (await readdir(this.root(profileId))).map(name => /^generation-(\d+)$/.exec(name)).filter(value => value !== null).map(value => Number(value![1]))
      for (const generation of generations) {
        if (generation > 0) {
          await assertBrowserGenerationStopped(join(this.root(profileId), `generation-${generation}`))
          await rm(join(this.root(profileId), `generation-${generation}`), { recursive: true, force: true })
        }
      }
      await rm(join(this.root(profileId), 'snapshots'), { recursive: true, force: true })
    }, true)
  }

  private assertIdle(profileId: string): void {
    if (this.options.busy(profileId)) throw new DomainError('PROFILE_BUSY', 'Close the profile’s browser sessions before replacing or exporting storage.', 409)
  }

  async noteOrigin(profileId: string, origin: string): Promise<void> {
    const normalized = browserOrigin(origin)
    await this.exclusive(profileId, async () => {
      const record = await this.record(profileId)
      if (record.origins.includes(normalized)) return
      record.origins.push(normalized); record.origins.sort(); await this.save(profileId, record)
    })
  }

  async export(profileId: string, publishedRevision: number, operationId: string): Promise<BrowserSnapshotTransfer> {
    return this.exclusive(profileId, async () => {
      const directory = join(this.root(profileId), 'snapshots'); await privateDirectory(directory)
      const receiptPath = join(directory, `${browserInputHash(operationId)}.json`)
      const inputHash = browserInputHash({ profileId, publishedRevision, operationId })
      const prior = await readRecord<ExportReceipt>(receiptPath)
      if (prior) {
        if (prior.inputHash !== inputHash) throw new DomainError('COMMAND_ID_CONFLICT', 'This export identity belongs to different input.', 409)
        if (prior.encrypted) await writePrivate(join(directory, `${prior.manifest.snapshot.sha256}.bin`), Buffer.from(prior.encrypted, 'base64'))
        else {
          try { await lstat(join(directory, `${prior.manifest.snapshot.sha256}.bin`)) } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            throw new DomainError('SNAPSHOT_RETIRED', 'The completed snapshot payload was retired. Start a new explicit sync.', 409, undefined, { cause: error })
          }
        }
        return { snapshot: prior.manifest.snapshot, manifest: prior.manifest }
      }
      const record = await this.record(profileId); this.assertIdle(profileId)
      let captured: BrowserPortableState
      try { captured = await this.options.exportState(profileId, record.origins) }
      finally { await this.options.closeProfile(profileId) }
      assertPortableBrowserCookies(captured.cookies)
      const state: BrowserPortableState = {
        cookies: [...captured.cookies].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
        origins: captured.origins.map(value => ({ origin: browserOrigin(value.origin),
          localStorage: [...value.localStorage].sort((a, b) => a.name.localeCompare(b.name)) })).sort((a, b) => a.origin.localeCompare(b.origin)),
        unsupportedState: captured.unsupportedState.map(value => ({ ...value, origin: browserOrigin(value.origin) }))
          .sort((a, b) => a.origin.localeCompare(b.origin) || a.reason.localeCompare(b.reason)),
      }
      const stateHash = browserInputHash(state), latest = await readRecord<ExportReceipt>(join(directory, 'latest-export.json'))
      this.assertIdle(profileId)
      if (latest?.encrypted && latest.stateHash === stateHash && latest.manifest.sourceComputerId === this.options.computerId
        && latest.sourceInstallationId === this.options.installationId && latest.manifest.snapshot.publishedRevision === publishedRevision - 1) {
        await writePrivate(receiptPath, Buffer.from(JSON.stringify({ ...latest, operationId, inputHash })))
        await writePrivate(join(directory, `${latest.manifest.snapshot.sha256}.bin`), Buffer.from(latest.encrypted, 'base64'))
        return { snapshot: latest.manifest.snapshot, manifest: latest.manifest }
      }
      const metadata = { profileId, publishedRevision, format: 'cookies-localstorage-v1' as const }
      const material = await this.options.exportKey(profileId, publishedRevision, operationId, stateHash)
      const key = Buffer.from(material.key)
      if (key.length !== 32 || material.stateHash !== stateHash || material.sourceOperationId !== operationId) {
        throw new DomainError('BROWSER_KEY_UNAVAILABLE', 'The publication encryption key does not match this capture.', 503)
      }
      const authenticated = { ...metadata, sourceComputerId: this.options.computerId,
        sourceInstallationId: material.sourceInstallationId, sourceOperationId: operationId, stateHash, keyId: material.keyId }
      const header = Buffer.from(canonicalJson(authenticated)), size = Buffer.alloc(4)
      size.writeUInt32BE(header.length)
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce)
      cipher.setAAD(header)
      const secretBytes = Buffer.from(canonicalJson(state))
      const encrypted = Buffer.concat([Buffer.from('FBP1'), size, header, nonce, cipher.update(secretBytes), cipher.final(), cipher.getAuthTag()])
      key.fill(0); secretBytes.fill(0)
      const sha256 = createHash('sha256').update(encrypted).digest('hex')
      const manifest = BrowserProfileSnapshotManifestSchema.parse({ snapshot: { ...metadata, sha256 },
        sourceComputerId: this.options.computerId, byteLength: encrypted.length, createdAt: new Date().toISOString(),
        origins: [...new Set([...state.origins, ...state.unsupportedState].map(value => value.origin))].sort(),
        unsupportedState: state.unsupportedState })
      // The receipt durably owns its ciphertext before a transport can observe that identity.
      const receipt: ExportReceipt = { operationId, inputHash, manifest, encrypted: encrypted.toString('base64'), stateHash, sourceInstallationId: material.sourceInstallationId }
      await writePrivate(receiptPath, Buffer.from(JSON.stringify(receipt)))
      await writePrivate(join(directory, `${sha256}.bin`), encrypted)
      await writePrivate(join(directory, 'latest-export.json'), Buffer.from(JSON.stringify(receipt)))
      return { snapshot: manifest.snapshot, manifest }
    }, true)
  }

  async bytes(transfer: BrowserSnapshotTransfer): Promise<Uint8Array> {
    const bytes = await readFile(join(this.root(transfer.snapshot.profileId), 'snapshots', `${transfer.snapshot.sha256}.bin`))
    this.verify(transfer, bytes)
    return bytes
  }

  async snapshotPath(transfer: BrowserSnapshotTransfer): Promise<string> {
    BrowserProfileSnapshotManifestSchema.parse(transfer.manifest)
    if (!sameBrowserSnapshot(transfer.snapshot, transfer.manifest.snapshot)) throw new DomainError('SNAPSHOT_MISMATCH', 'Invalid snapshot identity.', 409)
    return join(this.root(transfer.snapshot.profileId), 'snapshots', `${transfer.snapshot.sha256}.bin`)
  }

  private verify(transfer: BrowserSnapshotTransfer, bytes: Uint8Array): void {
    BrowserProfileSnapshotManifestSchema.parse(transfer.manifest)
    if (!sameBrowserSnapshot(transfer.snapshot, transfer.manifest.snapshot) || bytes.length !== transfer.manifest.byteLength
      || createHash('sha256').update(bytes).digest('hex') !== transfer.snapshot.sha256) {
      throw new DomainError('SNAPSHOT_MISMATCH', 'Browser snapshot bytes do not match the admitted identity.', 409)
    }
  }

  async receive(transfer: BrowserSnapshotTransfer, bytes: Uint8Array, revision: number): Promise<void> {
    this.verify(transfer, bytes)
    const profileId = transfer.snapshot.profileId
    await this.exclusive(profileId, async () => {
      await privateDirectory(this.root(profileId))
      const profile = await readRecord<ProfileDiskRecord>(join(this.root(profileId), 'profile.json'))
      if (profile && (profile.revision > revision || profile.deleted && profile.revision >= revision)) {
        throw new DomainError('PROFILE_OPERATION_SUPERSEDED', 'A newer profile maintenance request superseded this transfer.', 409)
      }
      const directory = join(this.root(profileId), 'snapshots'); await privateDirectory(directory)
      const desiredPath = join(directory, 'desired.json')
      const current = await readRecord<BrowserProfileSnapshotManifest>(desiredPath)
      const currentIntent = await readRecord<{ revision: number }>(join(directory, 'intent.json'))
      if ((currentIntent?.revision ?? 0) > revision) throw new DomainError('PROFILE_OPERATION_SUPERSEDED', 'A newer explicit profile request superseded this transfer.', 409)
      if (current && current.snapshot.publishedRevision > transfer.snapshot.publishedRevision) {
        throw new DomainError('SNAPSHOT_SUPERSEDED', 'A newer browser snapshot is already pending on this computer.', 409)
      }
      if (current?.snapshot.publishedRevision === transfer.snapshot.publishedRevision && !sameBrowserSnapshot(current.snapshot, transfer.snapshot)) {
        throw new DomainError('SNAPSHOT_MISMATCH', 'This published revision has different immutable bytes.', 409)
      }
      await writePrivate(join(directory, `${transfer.snapshot.sha256}.bin`), bytes)
      await writePrivate(join(directory, `${transfer.snapshot.sha256}.manifest.json`), Buffer.from(JSON.stringify(transfer.manifest)))
      await writePrivate(desiredPath, Buffer.from(JSON.stringify(transfer.manifest)))
      await writePrivate(join(directory, 'intent.json'), Buffer.from(JSON.stringify({ revision, snapshot: transfer.snapshot })))
    })
  }

  async prune(profileId: string, retained: readonly BrowserSnapshotIdentity[], operations: readonly string[]): Promise<void> {
    await this.exclusive(profileId, async () => {
      const directory = join(this.root(profileId), 'snapshots')
      try { await lstat(directory) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      const keep = new Set(retained.map(value => value.sha256)), manifests: BrowserProfileSnapshotManifest[] = []
      const profile = await readRecord<ProfileDiskRecord>(join(this.root(profileId), 'profile.json'))
      if (profile?.applied) keep.add(profile.applied.snapshot.sha256)
      const desired = await readRecord<BrowserProfileSnapshotManifest>(join(directory, 'desired.json'))
      if (desired) keep.add(desired.snapshot.sha256)
      const latest = await readRecord<ExportReceipt>(join(directory, 'latest-export.json'))
      if (latest) keep.add(latest.manifest.snapshot.sha256)
      const receipts: Array<{ path: string; receipt: ExportReceipt; modified: number }> = []
      for (const name of await readdir(directory)) {
        if (/^[a-f0-9]{64}\.manifest\.json$/.test(name)) {
          const manifest = await readRecord<BrowserProfileSnapshotManifest>(join(directory, name)); if (manifest) manifests.push(manifest)
        } else if (/^[a-f0-9]{64}\.json$/.test(name)) {
          const path = join(directory, name), receipt = await readRecord<ExportReceipt>(path)
          if (receipt?.manifest) { receipts.push({ path, receipt, modified: (await lstat(path)).mtimeMs }); manifests.push(receipt.manifest) }
        }
      }
      const versions = [...new Map(manifests.map(value => [value.snapshot.sha256, value])).values()]
        .sort((a, b) => b.snapshot.publishedRevision - a.snapshot.publishedRevision)
      for (const value of versions.slice(0, 2)) keep.add(value.snapshot.sha256)
      receipts.sort((a, b) => b.modified - a.modified)
      for (const [index, value] of receipts.entries()) {
        if (index < 2 || operations.includes(value.receipt.operationId)) { keep.add(value.receipt.manifest.snapshot.sha256); continue }
        if (value.receipt.encrypted) {
          const { encrypted: ciphertext, ...compact } = value.receipt
          void ciphertext
          await writePrivate(value.path, Buffer.from(JSON.stringify(compact)))
        }
      }
      for (const name of await readdir(directory)) {
        const match = /^([a-f0-9]{64})\.(?:bin|manifest\.json)$/.exec(name)
        if (match && !keep.has(match[1]!)) await rm(join(directory, name), { force: true })
      }
    })
  }

  async apply(transfer: BrowserSnapshotTransfer, revision: number): Promise<void> {
    const profileId = transfer.snapshot.profileId
    await this.exclusive(profileId, async () => {
      const root = this.root(profileId), previous = await readRecord<ProfileDiskRecord>(join(root, 'profile.json'))
      if (previous && (previous.revision > revision || previous.deleted && previous.revision >= revision)) {
        throw new DomainError('PROFILE_OPERATION_SUPERSEDED', 'A newer profile maintenance request superseded this apply.', 409)
      }
      const desired = await readRecord<BrowserProfileSnapshotManifest>(join(root, 'snapshots', 'desired.json'))
      const intent = await readRecord<{ revision: number }>(join(root, 'snapshots', 'intent.json'))
      if (!desired || intent?.revision !== revision || !sameBrowserSnapshot(desired.snapshot, transfer.snapshot)
        || (previous?.applied?.snapshot.publishedRevision ?? 0) > transfer.snapshot.publishedRevision) {
        throw new DomainError('SNAPSHOT_SUPERSEDED', 'A newer snapshot superseded this apply.', 409)
      }
      if (sameBrowserSnapshot(previous?.applied?.snapshot ?? null, transfer.snapshot) && previous?.revision === revision) return
      this.assertIdle(profileId)
      if (previous && !previous.deleted) await this.options.closeProfile(profileId)
      const bytes = Buffer.from(await this.bytes(transfer)), material = await this.options.snapshotKey(transfer)
      const key = Buffer.from(material.key)
      if (key.length !== 32 || bytes.length < 36 || bytes.subarray(0, 4).toString() !== 'FBP1') throw new DomainError('BROWSER_KEY_UNAVAILABLE', 'The snapshot encryption key or envelope is unavailable.', 503)
      const headerLength = bytes.readUInt32BE(4)
      if (headerLength > 16_384 || headerLength + 36 > bytes.length) throw new DomainError('SNAPSHOT_MISMATCH', 'Invalid authenticated snapshot envelope.', 409)
      const header = bytes.subarray(8, 8 + headerLength), payload = bytes.subarray(8 + headerLength)
      const metadata = JSON.parse(header.toString('utf8')) as Record<string, unknown>
      if (metadata.profileId !== profileId || metadata.publishedRevision !== transfer.snapshot.publishedRevision
        || metadata.format !== transfer.snapshot.format || metadata.sourceComputerId !== transfer.manifest.sourceComputerId
        || metadata.sourceInstallationId !== material.sourceInstallationId || metadata.sourceOperationId !== material.sourceOperationId
        || metadata.stateHash !== material.stateHash || metadata.keyId !== material.keyId) {
        throw new DomainError('SNAPSHOT_MISMATCH', 'The snapshot key and authenticated content identity differ.', 409)
      }
      const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12))
      decipher.setAAD(header); decipher.setAuthTag(payload.subarray(-16))
      let state: BrowserPortableState
      try {
        const plaintext = Buffer.concat([decipher.update(payload.subarray(12, -16)), decipher.final()])
        try { state = JSON.parse(plaintext.toString('utf8')) as BrowserPortableState } finally { plaintext.fill(0) }
      } finally { key.fill(0) }
      if (browserInputHash(state) !== material.stateHash) throw new DomainError('SNAPSHOT_MISMATCH', 'The canonical portable state hash does not match.', 409)
      const generation = (previous?.generation ?? 0) + 1, directory = join(root, `generation-${generation}`)
      // A failed import never changes the active generation pointer. Rebuild only its private staging generation.
      await assertBrowserGenerationStopped(directory)
      await rm(directory, { recursive: true, force: true }); await privateDirectory(directory)
      try {
        await this.options.importState(profileId, directory, generation, state)
        await syncBrowserProfileTree(directory)
        this.assertIdle(profileId)
        await this.save(profileId, { revision, deleted: false, generation,
          origins: transfer.manifest.origins, applied: transfer.manifest })
      } catch (error) {
        await assertBrowserGenerationStopped(directory)
        await rm(directory, { recursive: true, force: true }); throw error
      }
      if (generation > 2) {
        await assertBrowserGenerationStopped(join(root, `generation-${generation - 2}`))
        await rm(join(root, `generation-${generation - 2}`), { recursive: true, force: true })
      }
    }, true)
  }
}
