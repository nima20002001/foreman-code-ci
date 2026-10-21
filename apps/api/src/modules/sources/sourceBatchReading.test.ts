import { randomUUID } from 'node:crypto'
import { chmod, link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { RootBinding } from '@foreman-code/contracts/source-materialization'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { createSourceManifest, sourceSha256 } from './manifest.js'
import { PrivateSourceSnapshotStore } from './store.js'
import { PrivateSourceMaterializer } from './materialization.js'
import { identity, openPrivateRoot } from './privateFilesystem.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(persistentFixtureRoot, 'source-batch-'))
  roots.push(root)
  const store = new PrivateSourceSnapshotStore(root)
  const bytes = Buffer.from('approved source\n')
  const manifest = createSourceManifest({
    version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip', deletions: [],
    entries: Array.from({ length: 12 }, (_, index) => ({
      path: `src/file-${String(index).padStart(2, '0')}.txt`, kind: 'file' as const,
      byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false,
    })),
  })
  for (const entry of manifest.entries) await store.write(manifest.snapshotId, entry, bytes)
  await store.commit(manifest)
  const read = async () => {
    const contents: Uint8Array[] = []
    await store.readEntries(manifest, manifest.entries, AbortSignal.timeout(5000), async (_entry, content) => {
      contents.push(content)
    })
    return contents
  }
  return { root, store, bytes, manifest, read }
}

it('materializes batches with isolated attempt receipts and rechecks authorization and bytes on reuse', async () => {
  const f = await fixture()
  const root = await mkdtemp(join(persistentFixtureRoot, 'source-destination-'))
  roots.push(root)
  const handle = await openPrivateRoot(root)
  const filesystem = await identity(handle)
  await handle.close()
  const binding: RootBinding = {
    version: 1, mainId: randomUUID(), deviceId: null, workerInstallationId: null,
    workspaceId: randomUUID(), rootId: randomUUID(), bindingRevision: 1, locationRevision: 1,
    canonicalPath: root, filesystem, accessMode: 'read-only',
    snapshotId: f.manifest.snapshotId, manifestDigest: f.manifest.manifestDigest,
  }
  const attempt = () => ({ placementHash: 'a'.repeat(64), executionId: randomUUID(), attemptId: randomUUID(),
    keyRevision: null, authorizationRevision: null })
  const singleRead = vi.spyOn(f.store, 'read')
  const batchRead = vi.spyOn(f.store, 'readEntries')
  const authorize = vi.fn(async () => {})
  const materializer = new PrivateSourceMaterializer({
    read: f.store.read.bind(f.store), readEntries: f.store.readEntries.bind(f.store),
  }, authorize)
  const firstAttempt = attempt()
  const receipt = await materializer.prepare({ manifest: f.manifest, binding, attempt: firstAttempt })
  expect(batchRead).toHaveBeenCalled()
  expect(singleRead).not.toHaveBeenCalled()
  const tree = await materializer.resolve(receipt, { binding, attempt: firstAttempt })
  for (const entry of f.manifest.entries) expect(await readFile(join(tree, entry.path))).toEqual(f.bytes)
  const other = await materializer.prepare({ manifest: f.manifest, binding, attempt: attempt() })
  expect(other.materializationId).not.toBe(receipt.materializationId)
  expect(other.executionId).not.toBe(receipt.executionId)
  await expect(materializer.resolve(receipt, { binding, attempt: attempt() }))
    .rejects.toMatchObject({ code: 'SOURCE_RECEIPT_CONFLICT' })
  authorize.mockRejectedValueOnce(new Error('Authorization revoked'))
  await expect(materializer.resolve(receipt, { binding, attempt: firstAttempt }))
    .rejects.toThrow('Authorization revoked')
  const path = join(tree, f.manifest.entries[0]!.path)
  await chmod(path, 0o600)
  await writeFile(path, Buffer.alloc(f.bytes.length, 'x'))
  await chmod(path, 0o400)
  await expect(materializer.resolve(receipt, { binding, attempt: firstAttempt }))
    .rejects.toMatchObject({ code: 'SOURCE_BYTES_INVALID' })
})

it('reads every included entry and rejects changed pins before delivering bytes', async () => {
  const f = await fixture()
  expect(await f.read()).toEqual(f.manifest.entries.map(() => f.bytes))
  const consume = vi.fn(async () => {})
  await expect(f.store.readEntries({ ...f.manifest, manifestDigest: 'f'.repeat(64) }, f.manifest.entries,
    AbortSignal.timeout(5000), consume)).rejects.toMatchObject({ code: 'SOURCE_PIN_CONFLICT' })
  await expect(f.store.readEntries(f.manifest,
    [{ ...f.manifest.entries[0]!, sha256: 'f'.repeat(64) }], AbortSignal.timeout(5000), consume))
    .rejects.toMatchObject({ code: 'SOURCE_PIN_CONFLICT' })
  expect(consume).not.toHaveBeenCalled()
})

it('copies local snapshots into detached writable files with pinned bytes and private directories', async () => {
  const f = await fixture()
  const root = await mkdtemp(join(persistentFixtureRoot, 'source-copy-'))
  roots.push(root)
  const tree = await openPrivateRoot(root)
  try {
    await f.store.copyTo(f.manifest, tree, 0o600, AbortSignal.timeout(5000))
    for (const entry of f.manifest.entries) expect(await readFile(join(root, entry.path))).toEqual(f.bytes)
    await writeFile(join(root, f.manifest.entries[0]!.path), 'Agent edit')
    expect(await f.read()).toEqual(f.manifest.entries.map(() => f.bytes))
    await expect(f.store.copyTo({ ...f.manifest, manifestDigest: 'f'.repeat(64) }, tree, 0o400,
      AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'SOURCE_PIN_CONFLICT' })
  } finally { await tree.close() }
})

it.each(['bytes', 'hardlink', 'symlink'] as const)('rejects %s corruption during a bulk snapshot copy', async change => {
  const f = await fixture()
  const path = join(f.root, f.manifest.snapshotId, 'bytes', f.manifest.entries[0]!.path)
  if (change === 'bytes') {
    await chmod(path, 0o600)
    await writeFile(path, Buffer.alloc(f.bytes.length, 'x'))
  } else if (change === 'hardlink') {
    await link(path, join(f.root, 'linked-source'))
  } else {
    await rm(path)
    await symlink(join(f.root, 'outside-source'), path)
  }
  const root = await mkdtemp(join(persistentFixtureRoot, 'source-copy-corrupt-'))
  roots.push(root)
  const tree = await openPrivateRoot(root)
  try {
    await expect(f.store.copyTo(f.manifest, tree, 0o400, AbortSignal.timeout(5000)))
      .rejects.toMatchObject(change === 'symlink' ? { code: 'ELOOP' } : { code: 'SOURCE_BYTES_INVALID' })
  } finally { await tree.close() }
})

it.each(['bytes', 'hardlink', 'symlink'] as const)('rejects %s changes on a later snapshot batch', async change => {
  const f = await fixture()
  await f.read()
  const path = join(f.root, f.manifest.snapshotId, 'bytes', f.manifest.entries[0]!.path)
  if (change === 'bytes') {
    await chmod(path, 0o600)
    await writeFile(path, Buffer.alloc(f.bytes.length, 'x'))
  } else if (change === 'hardlink') {
    await link(path, join(f.root, 'linked-source'))
  } else {
    const outside = join(f.root, 'outside-source')
    await writeFile(outside, f.bytes)
    await rm(path)
    await symlink(outside, path)
  }
  await expect(f.read()).rejects.toMatchObject(change === 'symlink'
    ? { code: 'ELOOP' } : { code: 'SOURCE_BYTES_INVALID' })
})

it('stops a canceled batch before delivering another entry', async () => {
  const f = await fixture()
  const controller = new AbortController()
  const consume = vi.fn(async () => { controller.abort() })
  await expect(f.store.readEntries(f.manifest, f.manifest.entries, controller.signal, consume))
    .rejects.toMatchObject({ name: 'AbortError' })
  expect(consume).toHaveBeenCalledTimes(1)
})

it('rejects a manifest replaced during a batch before reporting completion', async () => {
  const f = await fixture()
  const path = join(f.root, f.manifest.snapshotId, 'manifest.json')
  await expect(f.store.readEntries(f.manifest, f.manifest.entries, AbortSignal.timeout(5000), async entry => {
    if (entry === f.manifest.entries[0]) {
      await chmod(path, 0o600)
      const changed = createSourceManifest({ ...f.manifest, approvedSourceId: randomUUID() })
      await writeFile(path, JSON.stringify(changed))
    }
  })).rejects.toMatchObject({ code: 'SOURCE_PIN_CONFLICT' })
})
