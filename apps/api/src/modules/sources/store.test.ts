import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createSourceManifest, sourceSha256 } from './manifest.js'
import { PrivateSourceSnapshotStore } from './store.js'
import { measureRetainedSourceDirectory } from './retainedDirectoryUsage.js'
import { identity, openPrivateRoot } from './privateFilesystem.js'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'

const reads = vi.hoisted(() => ({ manifest: 0 }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args)
    if (String(args[0]).endsWith('/manifest.json')) {
      handle.readFile = new Proxy(handle.readFile, {
        apply(read, receiver, options) {
          reads.manifest++
          return Reflect.apply(read, receiver, options)
        },
      })
    }
    return handle
  } }
})

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(fileCount = 40) {
  const directory = await mkdtemp('/tmp/graphql-source-store-')
  directories.push(directory)
  const bytes = Buffer.from('immutable source bytes\n')
  const entries = Array.from({ length: fileCount }, (_, index) => ({
    path: `source-${String(index).padStart(2, '0')}.txt`, kind: 'file' as const, byteSize: bytes.length,
    sha256: sourceSha256(bytes), executable: false,
  }))
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip', entries, deletions: [] })
  const store = new PrivateSourceSnapshotStore(directory)
  for (const entry of manifest.entries) await store.write(manifest.snapshotId, entry, bytes)
  await store.commit(manifest)
  reads.manifest = 0
  return { directory, bytes, manifest, store, signal: AbortSignal.timeout(5000) }
}

it('creates private snapshot storage before capture and keeps its identity on retry', async () => {
  const parent = await mkdtemp(join(persistentFixtureRoot, 'source-storage-'))
  directories.push(parent)
  const directory = join(parent, 'storage')
  const store = new PrivateSourceSnapshotStore(directory)
  const [first, concurrent] = await Promise.all([store.storageIdentity(), store.storageIdentity()])
  expect(concurrent).toEqual(first)
  expect(await store.storageIdentity()).toEqual(first)
  expect((await stat(directory)).mode & 0o777).toBe(0o700)
  const bytes = Buffer.from('captured source')
  const entry = { path: 'README.md', kind: 'file' as const, byteSize: bytes.length,
    sha256: sourceSha256(bytes), executable: false }
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip', entries: [entry], deletions: [] })
  await store.write(manifest.snapshotId, entry, bytes)
  await store.commit(manifest)
  expect(await store.manifest(manifest.snapshotId)).toEqual(manifest)
  expect(await store.read(manifest, entry, AbortSignal.timeout(5000))).toEqual(bytes)
})

it('rejects linked or nonprivate storage without changing existing permissions', async () => {
  const parent = await mkdtemp(join(persistentFixtureRoot, 'source-storage-'))
  directories.push(parent)
  const target = join(parent, 'target')
  await mkdir(target, { mode: 0o700 })
  const link = join(parent, 'storage')
  await symlink(target, link)
  await expect(new PrivateSourceSnapshotStore(link).storageIdentity())
    .rejects.toMatchObject({ code: 'SOURCE_FILESYSTEM_UNSUPPORTED' })
  await chmod(target, 0o755)
  await expect(new PrivateSourceSnapshotStore(target).storageIdentity())
    .rejects.toMatchObject({ code: 'SOURCE_ROOT_NOT_PRIVATE' })
  expect((await stat(target)).mode & 0o777).toBe(0o755)
})

it('rejects a linked parent before creating missing snapshot storage', async () => {
  const parent = await mkdtemp(join(persistentFixtureRoot, 'source-storage-'))
  directories.push(parent)
  const target = join(parent, 'target')
  await mkdir(target, { mode: 0o700 })
  const link = join(parent, 'linked-parent')
  await symlink(target, link)
  await expect(new PrivateSourceSnapshotStore(join(link, 'storage')).storageIdentity())
    .rejects.toMatchObject({ code: 'SOURCE_FILESYSTEM_UNSUPPORTED' })
  await expect(lstat(join(target, 'storage'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reads a stable manifest once while verifying every file in repeated source transfers', async () => {
  // A few files prove per-file verification with one manifest parse; 40 files made
  // ~3000 filesystem round trips that exceeded the unit budget under CI load.
  const f = await fixture(4)
  for (let transfer = 0; transfer < 2; transfer++) {
    for (const entry of f.manifest.entries) {
      expect(await f.store.read(f.manifest, entry, f.signal)).toEqual(f.bytes)
    }
  }
  expect(reads.manifest).toBe(1)
})

it('measures retained capture files without changing or deleting them', async () => {
  const f = await fixture()
  const before = await f.store.manifest(f.manifest.snapshotId)
  const bytes = await f.store.retainedCaptureBytes(f.manifest.snapshotId)
  expect(bytes).toBeGreaterThanOrEqual(40 * 4096)
  expect(bytes).toBeLessThan(1024 * 1024)
  expect(await f.store.manifest(f.manifest.snapshotId)).toEqual(before)
  expect(await f.store.read(f.manifest, f.manifest.entries[0]!, f.signal)).toEqual(f.bytes)
  expect(await f.store.retainedCaptureBytes(randomUUID())).toBe(0)
})

it('removes committed source bytes and can retry an already removed snapshot', async () => {
  const f = await fixture()
  await f.store.read(f.manifest, f.manifest.entries[0]!, f.signal)
  await f.store.remove(f.manifest.snapshotId)
  expect(await f.store.retainedCaptureBytes(f.manifest.snapshotId)).toBe(0)
  await expect(f.store.manifest(f.manifest.snapshotId)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(f.store.read(f.manifest, f.manifest.entries[0]!, f.signal))
    .rejects.toMatchObject({ code: 'ENOENT' })
  await f.store.remove(f.manifest.snapshotId)
})

it('refuses snapshot cleanup through a link and preserves the linked bytes', async () => {
  const f = await fixture()
  const outside = join(f.directory, 'outside.txt')
  await writeFile(outside, 'outside bytes')
  await symlink(outside, join(f.directory, f.manifest.snapshotId, 'external'))
  await expect(f.store.remove(f.manifest.snapshotId)).rejects.toMatchObject({ code: 'SOURCE_BYTES_INVALID' })
  expect(await readFile(outside, 'utf8')).toBe('outside bytes')
})

it('refuses to follow a link while measuring quarantined capture bytes', async () => {
  const f = await fixture()
  const snapshot = join(f.directory, f.manifest.snapshotId)
  const beforeBytes = await f.store.retainedCaptureBytes(f.manifest.snapshotId)
  const before = await lstat(snapshot)
  const path = join(snapshot, 'external')
  await symlink('/missing/source-dependency', path)
  const [after, link] = await Promise.all([lstat(snapshot), lstat(path)])
  const directoryGrowth = Math.max(4096, after.blocks * 512) - Math.max(4096, before.blocks * 512)
  expect(await f.store.retainedCaptureBytes(f.manifest.snapshotId))
    .toBe(beforeBytes + directoryGrowth + Math.max(4096, link.size, link.blocks * 512))
})

it('requires the original root identity before measuring closed execution storage', async () => {
  const f = await fixture()
  const root = await openPrivateRoot(f.directory)
  const filesystem = await identity(root)
  await root.close()
  const measured = await measureRetainedSourceDirectory(f.directory, f.manifest.snapshotId, filesystem)
  expect(measured).toBeGreaterThanOrEqual(40 * 4096)
  await expect(measureRetainedSourceDirectory(f.directory, f.manifest.snapshotId, {
    ...filesystem, inode: String(BigInt(filesystem.inode) + 1n),
  })).rejects.toMatchObject({ code: 'SOURCE_ROOT_CHANGED' })
})

it('counts ordinary Git file and directory modes under a private materialization', async () => {
  const f = await fixture()
  await chmod(join(f.directory, f.manifest.snapshotId, 'bytes', f.manifest.entries[0]!.path), 0o664)
  await chmod(join(f.directory, f.manifest.snapshotId, 'bytes'), 0o775)
  expect(await f.store.retainedCaptureBytes(f.manifest.snapshotId)).toBeGreaterThan(40 * 4096)
  await chmod(join(f.directory, f.manifest.snapshotId), 0o770)
  await expect(f.store.retainedCaptureBytes(f.manifest.snapshotId))
    .rejects.toMatchObject({ code: 'SOURCE_DIRECTORY_NOT_PRIVATE' })
})

it.each(['replace', 'overwrite'] as const)('rejects a changed manifest after %s even when its size and modification time match', async method => {
  const f = await fixture()
  const entry = f.manifest.entries[0]!
  await f.store.read(f.manifest, entry, f.signal)
  const path = join(f.directory, f.manifest.snapshotId, 'manifest.json')
  const before = await stat(path)
  const changed = (await readFile(path, 'utf8')).replace(f.manifest.approvedSourceId, randomUUID())
  if (method === 'replace') {
    await writeFile(`${path}.replacement`, changed, { mode: 0o400 })
    await rename(`${path}.replacement`, path)
  } else {
    await chmod(path, 0o600)
    await writeFile(path, changed)
  }
  await utimes(path, before.atime, before.mtime)
  expect((await stat(path)).size).toBe(before.size)
  await expect(f.store.read(f.manifest, entry, f.signal)).rejects.toThrow()
  expect(reads.manifest).toBe(2)
})

it('still rejects changed source bytes after the manifest has been cached', async () => {
  const f = await fixture()
  const entry = f.manifest.entries[0]!
  await f.store.read(f.manifest, entry, f.signal)
  const path = join(f.directory, f.manifest.snapshotId, 'bytes', entry.path)
  await chmod(path, 0o600)
  await writeFile(path, Buffer.alloc(f.bytes.length, 120))
  await expect(f.store.read(f.manifest, entry, f.signal)).rejects.toMatchObject({ code: 'SOURCE_BYTES_INVALID' })
  expect(reads.manifest).toBe(1)
})


it('retains pinned Git metadata and rejects mismatched or altered object bytes', async () => {
  const directory = await mkdtemp('/tmp/graphql-source-objects-')
  directories.push(directory)
  const store = new PrivateSourceSnapshotStore(directory)
  const bytes = Buffer.from('approved commit and tree metadata')
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'git-tree-v1', executablePolicy: 'strip', entries: [], deletions: [],
    git: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), objectFormat: 'sha1', repository: 'octo/site',
      metadata: { byteSize: bytes.length, sha256: sourceSha256(bytes) } } })
  await store.writeGitMetadata(manifest.snapshotId, bytes)
  await store.commit(manifest)
  const signal = AbortSignal.timeout(5000)
  expect(await store.readGitMetadata(manifest, signal)).toEqual(bytes)
  await expect(store.readGitMetadata({ ...manifest, approvedSourceId: randomUUID() }, signal))
    .rejects.toMatchObject({ code: 'SOURCE_PIN_CONFLICT' })
  const path = join(directory, manifest.snapshotId, 'git-objects.json')
  await chmod(path, 0o600)
  await writeFile(path, Buffer.alloc(bytes.length, 120))
  await expect(store.readGitMetadata(manifest, signal)).rejects.toMatchObject({ code: 'SOURCE_BYTES_INVALID' })
})
