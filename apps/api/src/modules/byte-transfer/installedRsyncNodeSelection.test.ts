import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { readProtectedInstalledRsyncWriterSelection } from './installedRsyncSelection.js'

const reviewedNodeBytes = 124_827_920
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function digest(path: string) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path, { highWaterMark: 65536 })) hash.update(bytes)
  return hash.digest('hex')
}
async function sparseFile(path: string, size: number) {
  const file = await open(path, 'w', 0o700)
  try { await file.truncate(size) } finally { await file.close() }
  await chmod(path, 0o500)
}
async function fixture(size = reviewedNodeBytes) {
  const root = await mkdtemp(join(persistentFixtureRoot, 'rsync-node-pin-')); roots.push(root)
  const binary = join(root, '.local/share/graphql-tools/rsync/3.5.1/bin/rsync')
  await mkdir(dirname(binary), { recursive: true, mode: 0o700 }); await writeFile(binary, 'rsync pin', { mode: 0o500 })
  const node = join(root, 'node'), entryPoint = join(root, 'rsync-writer.mjs'), path = join(root, 'rsync-selection.json')
  await sparseFile(node, size); await writeFile(entryPoint, 'writer pin', { mode: 0o400 })
  const registration = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1,
    authorizationRevision: 1, publicKeyFingerprint: 'a'.repeat(64), status: 'paired', scopes: ['connect', 'heartbeat'] }
  const selected = { formatVersion: 1, backend: 'rsync', registration, consentRevision: 1,
    endpoint: { user: 'worker', host: '100.64.1.1', localRoot: join(root, 'main-stage'), remoteRoot: join(root, 'worker-stage') },
    localBinary: { path: binary, version: '3.5.1', sha256: await digest(binary) },
    remoteBinary: { path: binary, version: '3.5.1', sha256: await digest(binary) },
    nodeBinary: { path: node, sha256: size <= 128 * 1024 * 1024 ? await digest(node) : 'a'.repeat(64) },
    entryPoint: { path: entryPoint, sha256: await digest(entryPoint) },
    sourceProvenance: { sourceSha256: 'b'.repeat(64), releaseSignerFingerprint: 'A'.repeat(40) } }
  const save = () => writeFile(path, JSON.stringify(selected), { mode: 0o600 })
  await save()
  return { node, binary, entryPoint, selected, save, read: () => readProtectedInstalledRsyncWriterSelection(path, registration, AbortSignal.timeout(10_000)) }
}
it('accepts the reviewed Node file size through the real protected loader with bounded hashing memory', async () => {
  const f = await fixture(), allocations = vi.spyOn(Buffer, 'alloc')
  expect(await f.read()).toMatchObject({ nodeBinary: f.node, entryPoint: f.entryPoint })
  expect(allocations.mock.calls.every(([size]) => size <= 1024 * 1024)).toBe(true)
})
it('still rejects a changed digest for the reviewed-size Node pin', async () => {
  const f = await fixture(); f.selected.nodeBinary.sha256 = 'f'.repeat(64); await f.save()
  await expect(f.read()).rejects.toThrow('changed before verification')
})
it('rejects a Node file above the separate bounded allowance', async () => {
  const f = await fixture(128 * 1024 * 1024 + 1)
  await expect(f.read()).rejects.toThrow('protected executable')
})
it.each(['rsync', 'writer'] as const)('keeps the 64 MiB bound for %s files', async kind => {
  const f = await fixture(16), path = kind === 'rsync' ? f.binary : f.entryPoint
  await chmod(path, 0o700); await sparseFile(path, 64 * 1024 * 1024 + 1)
  await expect(f.read()).rejects.toThrow('protected executable')
})
