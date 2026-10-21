import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BrowserProfileSnapshotManifestSchema } from '@foreman-code/contracts/browser-profiles'
import { BrowserSnapshotStorage, type BrowserPortableState } from './snapshotStorage.js'

const directories: string[] = []
afterEach(async () => { for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture(state: BrowserPortableState) {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(parent, 'snapshot-storage-'))
  directories.push(root)
  const closeProfile = vi.fn(async () => undefined)
  const storage = new BrowserSnapshotStorage({ root, computerId: 'source', installationId: 'installation',
    exportKey: async (_profile, _revision, operationId, stateHash) => ({ key: Buffer.alloc(32, 1),
      keyId: 'key', sourceInstallationId: 'installation', sourceOperationId: operationId, stateHash }),
    snapshotKey: async () => { throw new Error('Unexpected import') }, busy: () => false,
    maintenance: async (_profile, work) => work(), closeProfile,
    exportState: async () => state, importState: async () => { throw new Error('Unexpected import') } })
  await storage.create('profile', 1)
  return { storage, closeProfile }
}

it('publishes unsupported origin metadata even when localStorage capture failed for that origin', async () => {
  const unsupportedState = [{ origin: 'https://unavailable.test', reason: 'Storage capture unavailable.' }]
  const f = await fixture({ cookies: [], origins: [], unsupportedState })
  const transfer = await f.storage.export('profile', 1, 'export')
  expect(BrowserProfileSnapshotManifestSchema.parse(transfer.manifest)).toMatchObject({
    origins: ['https://unavailable.test'], unsupportedState })
  expect((await f.storage.bytes(transfer)).byteLength).toBe(transfer.manifest.byteLength)
})

it('rejects unsupported partitioned cookie formats with a terminal domain error before publication', async () => {
  const f = await fixture({ cookies: [{ name: 'partitioned', value: 'secret', domain: 'fixture.test',
    partitionKey: { topLevelSite: 'https://top.test', hasCrossSiteAncestor: true } }], origins: [], unsupportedState: [] })
  await expect(f.storage.export('profile', 1, 'export')).rejects.toMatchObject({ code: 'SNAPSHOT_COOKIE_UNSUPPORTED', status: 422 })
})

it('retires the temporary browser process after export before releasing profile maintenance', async () => {
  const f = await fixture({ cookies: [], origins: [], unsupportedState: [] })
  await f.storage.export('profile', 1, 'export')
  expect(f.closeProfile).toHaveBeenCalledExactlyOnceWith('profile')
})
