import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, readdir, rm, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { DomainError } from '../errors.js'
import { browserInputHash, sameBrowserSnapshot } from './identity.js'
import type { BrowserSnapshotIdentity } from './types.js'

/** Private paired connection facts, supplied by the existing installation owner. Never a new grant. */
export interface BrowserInstallationBinding { computerId: string; installationId: string; connectionId: string }
export interface BrowserPairingAuthority {
  current(computerId: string): Promise<BrowserInstallationBinding>
  assertCurrent(binding: BrowserInstallationBinding): Promise<void>
  wrappingKey(binding: BrowserInstallationBinding): Promise<Uint8Array>
  assertInstallation(computerId: string, installationId: string): Promise<void>
}
interface KeyRecord {
  keyId: string; profileId: string; publishedRevision: number; operationId: string; keyBase64: string
  source: BrowserInstallationBinding; snapshot: BrowserSnapshotIdentity | null; createdAt: string; stateHash: string
}
export interface BrowserPrivateKeyEnvelope {
  keyId: string; profileId: string; publishedRevision: number; operationId: string
  source: BrowserInstallationBinding; recipient: BrowserInstallationBinding
  snapshot: BrowserSnapshotIdentity | null; encrypted: Uint8Array
  stateHash: string
}

/** Main owns fresh per-publication keys and their durable same-operation identity. */
export class BrowserSnapshotKeyStore {
  private readonly pending = new Map<string, Promise<unknown>>()
  constructor(private readonly directory: string, readonly authority: BrowserPairingAuthority) {}

  private async save(record: KeyRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const info = await lstat(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
      || process.getuid && info.uid !== process.getuid()) throw new DomainError('BROWSER_KEY_STORE', 'Browser snapshot key storage is not private.', 503)
    const temporary = join(this.directory, `.${randomUUID()}.tmp`), handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync() } finally { await handle.close() }
    await rename(temporary, join(this.directory, `${browserInputHash(record.operationId)}.json`))
    const parent = await open(this.directory, 'r')
    try { await parent.sync() } finally { await parent.close() }
  }

  private async read(operationId: string): Promise<KeyRecord | undefined> {
    try { return JSON.parse(await readFile(join(this.directory, `${browserInputHash(operationId)}.json`), 'utf8')) as KeyRecord } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private serial<T>(operationId: string, work: () => Promise<T>): Promise<T> {
    const prior = this.pending.get(operationId) ?? Promise.resolve(), task = prior.then(work, work)
    this.pending.set(operationId, task)
    void task.finally(() => { if (this.pending.get(operationId) === task) this.pending.delete(operationId) })
      .catch(() => { /* ignore: returned promise reports the private key operation failure. */ })
    return task
  }

  async allocate(input: { profileId: string; publishedRevision: number; operationId: string; source: BrowserInstallationBinding; stateHash: string }): Promise<string> {
    await this.authority.assertCurrent(input.source)
    return this.serial(`profile:${input.profileId}`, async () => {
      const existing = await this.read(input.operationId)
      if (existing) {
        if (existing.profileId !== input.profileId || existing.publishedRevision !== input.publishedRevision
          || existing.stateHash !== input.stateHash || existing.source.computerId !== input.source.computerId || existing.source.installationId !== input.source.installationId) {
          throw new DomainError('COMMAND_ID_CONFLICT', 'This snapshot operation belongs to a different source or publication.', 409)
        }
        return existing.keyId
      }
      const record: KeyRecord = { ...input, keyId: randomUUID(), keyBase64: randomBytes(32).toString('base64'),
        snapshot: null, createdAt: new Date().toISOString() }
      await this.save(record); return record.keyId
    })
  }

  async seal(operationId: string, snapshot: BrowserSnapshotIdentity): Promise<void> {
    await this.serial(`profile:${snapshot.profileId}`, async () => {
      const record = await this.read(operationId)
      if (!record && await this.findSnapshot(snapshot)) return
      if (!record || record.profileId !== snapshot.profileId || record.publishedRevision !== snapshot.publishedRevision
        || record.snapshot && !sameBrowserSnapshot(record.snapshot, snapshot)) {
        throw new DomainError('SNAPSHOT_MISMATCH', 'This publication key does not own the returned immutable ciphertext.', 409)
      }
      if (!record.snapshot) await this.save({ ...record, snapshot })
    })
  }

  private async findSnapshot(snapshot: BrowserSnapshotIdentity): Promise<KeyRecord | undefined> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      const record = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as KeyRecord
      if (sameBrowserSnapshot(record.snapshot, snapshot)) return record
    }
    return undefined
  }

  async snapshotEnvelope(snapshot: BrowserSnapshotIdentity, recipient: BrowserInstallationBinding): Promise<BrowserPrivateKeyEnvelope> {
    const record = await this.findSnapshot(snapshot)
    if (!record) throw new DomainError('BROWSER_KEY_UNAVAILABLE', 'This published snapshot key is unavailable.', 503)
    return this.envelope(record.operationId, recipient, snapshot)
  }

  async envelope(operationId: string, recipient: BrowserInstallationBinding, snapshot?: BrowserSnapshotIdentity): Promise<BrowserPrivateKeyEnvelope> {
    await this.authority.assertCurrent(recipient)
    const record = await this.read(operationId)
    if (!record) throw new DomainError('BROWSER_KEY_UNAVAILABLE', 'This snapshot key is unavailable.', 503)
    const source = await this.authority.current(record.source.computerId)
    if (source.installationId !== record.source.installationId) throw new DomainError('BROWSER_PAIRING_CHANGED', 'The source installation changed after this snapshot was admitted.', 403)
    await this.authority.assertInstallation(source.computerId, source.installationId)
    if (snapshot && !sameBrowserSnapshot(record.snapshot, snapshot)
      || !snapshot && browserInputHash(recipient) !== browserInputHash(source)) {
      throw new DomainError('SNAPSHOT_MISMATCH', 'This key request does not match the exact source and snapshot.', 409)
    }
    const metadata = { keyId: record.keyId, profileId: record.profileId, publishedRevision: record.publishedRevision,
      operationId, source, recipient, snapshot: record.snapshot, stateHash: record.stateHash }
    const key = Buffer.from(await this.authority.wrappingKey(recipient)), dataKey = Buffer.from(record.keyBase64, 'base64')
    if (key.length !== 32) throw new DomainError('BROWSER_KEY_UNAVAILABLE', 'The current paired connection key is unavailable.', 503)
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(Buffer.from(browserInputHash(metadata)))
    const encrypted = Buffer.concat([nonce, cipher.update(dataKey), cipher.final(), cipher.getAuthTag()])
    key.fill(0); dataKey.fill(0)
    await this.authority.assertCurrent(recipient)
    return { ...metadata, encrypted }
  }

  async prune(profileId: string, references: () => Promise<{ snapshots: readonly BrowserSnapshotIdentity[]; operations: readonly string[] }>): Promise<BrowserSnapshotIdentity[]> {
    return this.serial(`profile:${profileId}`, async () => {
      const retained = await references()
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const records: KeyRecord[] = []
      for (const name of await readdir(this.directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
        const record = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as KeyRecord
        if (record.profileId === profileId) records.push(record)
      }
      const currentAndPrevious = new Set(records.filter(value => value.snapshot).sort((a, b) => b.publishedRevision - a.publishedRevision).slice(0, 2).map(value => value.operationId))
      const kept: BrowserSnapshotIdentity[] = []
      for (const record of records) {
        const keep = currentAndPrevious.has(record.operationId) || retained.operations.includes(record.operationId)
          || record.snapshot && retained.snapshots.some(value => sameBrowserSnapshot(value, record.snapshot))
        if (keep) { if (record.snapshot) kept.push(record.snapshot); continue }
        await rm(join(this.directory, `${browserInputHash(record.operationId)}.json`), { force: true })
      }
      const parent = await open(this.directory, 'r')
      try { await parent.sync() } finally { await parent.close() }
      return kept
    })
  }

}

export async function unwrapBrowserSnapshotKey(envelope: BrowserPrivateKeyEnvelope,
  recipient: BrowserInstallationBinding, authority: BrowserPairingAuthority): Promise<Uint8Array> {
  await authority.assertCurrent(recipient); await authority.assertInstallation(envelope.source.computerId, envelope.source.installationId)
  if (browserInputHash(recipient) !== browserInputHash(envelope.recipient) || envelope.encrypted.length !== 60) {
    throw new DomainError('BROWSER_PAIRING_CHANGED', 'This key envelope belongs to another paired installation.', 403)
  }
  const { encrypted, ...metadata } = envelope, bytes = Buffer.from(encrypted), key = Buffer.from(await authority.wrappingKey(recipient))
  if (key.length !== 32) throw new DomainError('BROWSER_KEY_UNAVAILABLE', 'The current paired connection key is unavailable.', 503)
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
  decipher.setAAD(Buffer.from(browserInputHash(metadata))); decipher.setAuthTag(bytes.subarray(-16))
  try {
    const result = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()])
    await authority.assertCurrent(recipient); return result
  } finally { key.fill(0) }
}
