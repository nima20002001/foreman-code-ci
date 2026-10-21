import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { RootBinding } from '@foreman-code/contracts/source-materialization'
import { persistentFixtureRoot } from './helpers/fixtureStorage.js'
import { sourceMaterializationBytes, sourceStructureBytes } from '../src/modules/sources/footprint.js'
import { createSourceManifest, sourceSha256 } from '../src/modules/sources/manifest.js'
import { PrivateSourceSnapshotStore } from '../src/modules/sources/store.js'
import { PrivateSourceMaterializer, releaseMaterializationClaim } from '../src/modules/sources/materialization.js'
import { identity, openPrivateRoot } from '../src/modules/sources/privateFilesystem.js'
import { measureRetainedMaterializationFootprint } from '../src/modules/sources/retainedDirectoryUsage.js'
import { sourceWorkingTreePath } from '../src/modules/sources/sourceTreePaths.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

it('covers the complete parent structure of a directory-heavy source through capture and closure', async () => {
  const started = performance.now()
  const directory = await mkdtemp(join(persistentFixtureRoot, 'source-footprint-'))
  directories.push(directory)
  const canonical = join(directory, 'canonical')
  const root = join(directory, 'materializations')
  await mkdir(canonical, { mode: 0o700 })
  await mkdir(root, { mode: 0o700 })
  const bytes = Buffer.from('x')
  // 1,024 unique parents still exceed the file-only allowance after the reference tree is removed.
  const paths = Array.from({ length: 64 }, (_, index) =>
    [String(index).padStart(4, '0'), ...Array.from({ length: 15 }, (_, depth) => `d${depth}`), 'file.ts'].join('/'))
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip', deletions: [],
    entries: paths.map(path => ({ path, kind: 'file', byteSize: bytes.length,
      sha256: sourceSha256(bytes), executable: false })) })
  const store = new PrivateSourceSnapshotStore(canonical)
  const captureEntries = manifest.entries.values()
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (const entry of captureEntries) await store.write(manifest.snapshotId, entry, bytes)
  }))
  await store.commit(manifest)
  expect(await store.retainedCaptureBytes(manifest.snapshotId))
    .toBeLessThanOrEqual(manifest.totalBytes + sourceStructureBytes(paths))
  const handle = await openPrivateRoot(root)
  const filesystem = await identity(handle)
  await handle.close()
  const binding: RootBinding = { version: 1, mainId: randomUUID(), deviceId: null, workerInstallationId: null,
    workspaceId: randomUUID(), rootId: randomUUID(), bindingRevision: 1, locationRevision: 1,
    canonicalPath: root, filesystem, accessMode: 'exclusive-write',
    snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }
  const attempt = { executionId: randomUUID(), attemptId: randomUUID(), placementHash: 'a'.repeat(64),
    keyRevision: null, authorizationRevision: null }
  const materializer = new PrivateSourceMaterializer(store, async () => {})
  const receipt = await materializer.prepare({ manifest, binding, attempt, sharedWritableTree: true })
  expect(await materializer.prepare({ manifest, binding, attempt, sharedWritableTree: true })).toEqual(receipt)
  await materializer.verify(receipt, { binding, attempt })
  const beforeClosure = await measureRetainedMaterializationFootprint(receipt)
  expect(beforeClosure.retainedBytes + 16 * 1024).toBeLessThanOrEqual(sourceMaterializationBytes(manifest))
  await releaseMaterializationClaim(receipt, async () => 'released')
  await expect(stat(join(root, receipt.materializationId, 'tree'))).rejects.toMatchObject({ code: 'ENOENT' })
  for (const entry of manifest.entries) {
    expect(await readFile(join(sourceWorkingTreePath(receipt), entry.path))).toEqual(bytes)
  }
  const footprint = await measureRetainedMaterializationFootprint(receipt)
  expect(footprint.retainedBytes).toBeGreaterThan(manifest.totalEntries * 8192 + 2 * 1024 * 1024)
  expect(footprint.retainedBytes + 16 * 1024).toBeLessThanOrEqual(sourceMaterializationBytes(manifest))
  expect(footprint.retainedBytes).toBeLessThan(beforeClosure.retainedBytes)
  expect(footprint.sharedTree).toEqual(beforeClosure.sharedTree)
  await expect(materializer.verify(receipt, { binding, attempt })).rejects.toMatchObject({ code: 'ENOENT' })
  await releaseMaterializationClaim(receipt, async () => 'released')
  expect(await measureRetainedMaterializationFootprint(receipt)).toEqual(footprint)
  expect(performance.now() - started).toBeLessThan(30_000)
}, 45_000)
