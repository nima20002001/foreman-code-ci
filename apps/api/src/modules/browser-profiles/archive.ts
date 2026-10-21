import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DomainError } from '../errors.js'
import { browserInputHash, sameBrowserSnapshot } from './identity.js'
import type { BrowserSnapshotTransfer, BrowserSnapshotIdentity } from './types.js'

/** Private immutable ciphertext storage. Main never decrypts portable browser state. */
export class BrowserSnapshotArchive {
  constructor(readonly root: string) {}
  private path(transfer: BrowserSnapshotTransfer) { return join(this.root, browserInputHash(transfer.snapshot)) }

  async put(transfer: BrowserSnapshotTransfer, chunks: AsyncIterable<Uint8Array>): Promise<void> {
    if (!sameBrowserSnapshot(transfer.snapshot, transfer.manifest.snapshot)) throw new DomainError('SNAPSHOT_MISMATCH', 'Snapshot manifest identity differs.', 409)
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const rootInfo = await lstat(this.root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o077) !== 0) throw new DomainError('BROWSER_STORAGE_INVALID', 'Snapshot archive is not private.', 503)
    const temporary = `${this.path(transfer)}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx', 0o600)
    const hash = createHash('sha256'); let length = 0
    try {
      for await (const bytes of chunks) {
        if (!bytes.length || bytes.length > 262_144 || length + bytes.length > transfer.manifest.byteLength) throw new DomainError('SNAPSHOT_CHUNK_INVALID', 'Invalid snapshot transfer chunk.', 409)
        await handle.writeFile(bytes); hash.update(bytes); length += bytes.length
      }
      if (length !== transfer.manifest.byteLength || hash.digest('hex') !== transfer.snapshot.sha256) throw new DomainError('SNAPSHOT_MISMATCH', 'Snapshot ciphertext did not match its immutable identity.', 409)
      await handle.sync()
    } catch (error) { await handle.close(); await rm(temporary, { force: true }); throw error }
    await handle.close(); await rename(temporary, this.path(transfer))
    const metadataPath = `${this.path(transfer)}.${randomUUID()}.metadata.tmp`
    const metadata = await open(metadataPath, 'wx', 0o600)
    try { await metadata.writeFile(JSON.stringify(transfer)); await metadata.sync() } finally { await metadata.close() }
    await rename(metadataPath, `${this.path(transfer)}.manifest.json`)
    const parent = await open(this.root, 'r')
    try { await parent.sync() } finally { await parent.close() }
  }

  async read(transfer: BrowserSnapshotTransfer, offset: number, maxBytes = 262_144): Promise<Uint8Array> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 262_144) throw new DomainError('SNAPSHOT_RANGE_INVALID', 'Invalid snapshot byte range.', 400)
    const handle = await open(this.path(transfer), 'r')
    try {
      const buffer = Buffer.alloc(Math.min(maxBytes, Math.max(0, transfer.manifest.byteLength - offset)))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      return buffer.subarray(0, bytesRead)
    } finally { await handle.close() }
  }

  async *chunks(transfer: BrowserSnapshotTransfer): AsyncGenerator<Uint8Array> {
    let offset = 0
    while (offset < transfer.manifest.byteLength) {
      const bytes = await this.read(transfer, offset)
      if (!bytes.length) throw new DomainError('SNAPSHOT_INCOMPLETE', 'Snapshot ciphertext ended before its declared length.', 409)
      offset += bytes.length; yield bytes
    }
  }

  async bytes(transfer: BrowserSnapshotTransfer): Promise<Uint8Array> { return readFile(this.path(transfer)) }
  async remove(transfer: BrowserSnapshotTransfer): Promise<void> {
    await rm(this.path(transfer), { force: true }); await rm(`${this.path(transfer)}.manifest.json`, { force: true })
  }

  async prune(profileId: string, retained: readonly BrowserSnapshotIdentity[]): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const entries: BrowserSnapshotTransfer[] = []
    for (const name of await readdir(this.root)) {
      if (!/^[a-f0-9]{64}\.manifest\.json$/.test(name)) continue
      const transfer = JSON.parse(await readFile(join(this.root, name), 'utf8')) as BrowserSnapshotTransfer
      if (transfer.snapshot.profileId === profileId) entries.push(transfer)
    }
    entries.sort((a, b) => b.snapshot.publishedRevision - a.snapshot.publishedRevision)
    for (const transfer of entries.slice(2)) if (!retained.some(value => sameBrowserSnapshot(value, transfer.snapshot))) await this.remove(transfer)
  }
}
