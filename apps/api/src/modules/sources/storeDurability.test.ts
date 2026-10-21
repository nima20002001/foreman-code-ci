import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { createSourceManifest, sourceSha256 } from './manifest.js'
import { PrivateSourceSnapshotStore } from './store.js'

const io = vi.hoisted(() => ({
  syncs: 0,
  flushes: 0,
  missingHelper: false,
  failure: undefined as Error | undefined,
  wait: undefined as Promise<void> | undefined,
  guard: undefined as import('node:fs/promises').FileHandle | undefined,
}))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const file = await actual.open(...args)
    const sync = file.sync.bind(file)
    file.sync = async () => { io.syncs++; await sync() }
    return file
  } }
})
vi.mock('./sourceTreeFlush.js', async original => {
  const actual = await original<typeof import('./sourceTreeFlush.js')>()
  return { flushSourceTree: async (...args: Parameters<typeof actual.flushSourceTree>) => {
    if (io.missingHelper) return false
    if (String(args[2].mode) === 'filesystem') {
      io.flushes++
      io.guard = args[0]
      await io.wait
      if (io.failure) throw io.failure
    }
    return actual.flushSourceTree(...args)
  } }
})

const roots: string[] = []
afterEach(async () => {
  io.syncs = 0
  io.flushes = 0
  io.missingHelper = false
  io.failure = undefined
  io.wait = undefined
  io.guard = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(count = 1) {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(await realpath(parent), 'source-durability-'))
  roots.push(root)
  const bytes = Buffer.from('captured bytes\n')
  const entries = Array.from({ length: count }, (_, index) => ({
    path: `src/nested/file-${String(index).padStart(3, '0')}.txt`, kind: 'file' as const,
    byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false,
  }))
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip', entries, deletions: [] })
  const store = new PrivateSourceSnapshotStore(root)
  const write = () => Promise.all(entries.map(entry => store.write(manifest.snapshotId, entry, bytes)))
  return { root, bytes, entries, manifest, store, write }
}

it.each([1, 40])('publishes %i files with one filesystem flush and a constant number of sync calls', async count => {
  const f = await fixture(count)
  try {
    await f.write()
    expect(io.syncs).toBe(0)
    await expect(f.store.manifest(f.manifest.snapshotId)).rejects.toMatchObject({ code: 'ENOENT' })
    await f.store.commit(f.manifest)
    expect(io.flushes).toBe(1)
    expect(io.syncs).toBeLessThanOrEqual(4)
    const reopened = new PrivateSourceSnapshotStore(f.root)
    expect(await reopened.manifest(f.manifest.snapshotId)).toEqual(f.manifest)
    for (const entry of f.entries) {
      expect(await reopened.read(f.manifest, entry, AbortSignal.timeout(5000))).toEqual(f.bytes)
    }
    await expect(io.guard!.stat()).rejects.toMatchObject({ code: 'EBADF' })
  } finally { await f.store.abort(f.manifest.snapshotId) }
})

it('keeps the manifest unpublished until the filesystem flush finishes', async () => {
  const f = await fixture()
  const blocked = deferred()
  io.wait = blocked.promise
  await f.write()
  const committing = f.store.commit(f.manifest)
  try {
    await vi.waitFor(() => expect(io.flushes).toBe(1), { timeout: 1000 })
    await expect(f.store.manifest(f.manifest.snapshotId)).rejects.toMatchObject({ code: 'ENOENT' })
    blocked.resolve()
    await committing
    expect(await f.store.manifest(f.manifest.snapshotId)).toEqual(f.manifest)
  } finally { blocked.resolve(); await committing; await f.store.abort(f.manifest.snapshotId) }
})

it('rejects a failed filesystem flush without publishing and releases its descriptor', async () => {
  const f = await fixture()
  await f.write()
  io.failure = new Error('Filesystem writeback failed')
  try {
    await expect(f.store.commit(f.manifest)).rejects.toBe(io.failure)
    await expect(f.store.manifest(f.manifest.snapshotId)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(io.guard!.stat()).rejects.toMatchObject({ code: 'EBADF' })
  } finally { await f.store.abort(f.manifest.snapshotId) }
})

it('falls back to file and directory syncs when the helper is unavailable', async () => {
  const f = await fixture(4)
  io.missingHelper = true
  await f.write()
  await f.store.commit(f.manifest)
  expect(io.flushes).toBe(0)
  expect(io.syncs).toBeGreaterThanOrEqual(f.entries.length)
  expect(await f.store.manifest(f.manifest.snapshotId)).toEqual(f.manifest)
  expect(await readFile(join(f.root, f.manifest.snapshotId, 'bytes', f.entries[0]!.path))).toEqual(f.bytes)
})
