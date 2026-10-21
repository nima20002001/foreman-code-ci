import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { mkdir, mkdtemp, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PayloadFingerprintCache } from './payloadFingerprintCache.js'
import { discoverInventoryLauncher, discoverLauncher } from './hostDiscovery.js'

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, createReadStream: vi.fn(original.createReadStream) }
})

const directories: string[] = []
afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const temporaryRoot = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(temporaryRoot, { recursive: true })
  const root = await mkdtemp(join(temporaryRoot, 'payload-fingerprint-'))
  directories.push(root)
  const path = join(root, 'payload')
  await writeFile(path, 'original', { mode: 0o700 })
  return { root, path, cache: new PayloadFingerprintCache() }
}
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex')

it('reuses the full fingerprint without rereading unchanged files, including realpath aliases', async () => {
  const { root, path, cache } = await fixture()
  expect(await cache.fingerprint(path)).toBe(digest('original'))
  const alias = join(root, 'alias')
  await symlink(path, alias)
  expect(await cache.fingerprint(alias)).toBe(digest('original'))
  expect(await cache.fingerprint(path)).toBe(digest('original'))
  expect(fs.createReadStream).toHaveBeenCalledTimes(1)
})

it('rehashes when mtime changes even if the bytes and size stay the same', async () => {
  const { path, cache } = await fixture()
  await cache.fingerprint(path)
  await utimes(path, new Date(0), new Date(1000))
  expect(await cache.fingerprint(path)).toBe(digest('original'))
  expect(fs.createReadStream).toHaveBeenCalledTimes(2)
})

it('rehashes changed size and returns the full hash of changed bytes', async () => {
  const { path, cache } = await fixture()
  await cache.fingerprint(path)
  await writeFile(path, 'larger replacement bytes')
  expect(await cache.fingerprint(path)).toBe(digest('larger replacement bytes'))
  expect(fs.createReadStream).toHaveBeenCalledTimes(2)
})

it('detects changed ctime when same-size bytes are rewritten and mtime is restored', async () => {
  const { path, cache } = await fixture()
  await utimes(path, new Date(0), new Date(1000))
  const before = await stat(path)
  await cache.fingerprint(path)
  await writeFile(path, 'modified')
  await utimes(path, before.atime, before.mtime)
  expect(await cache.fingerprint(path)).toBe(digest('modified'))
  expect(fs.createReadStream).toHaveBeenCalledTimes(2)
})

it('detects a replacement inode at the same path with the same size and mtime', async () => {
  const { root, path, cache } = await fixture()
  const replacement = join(root, 'replacement')
  await utimes(path, new Date(0), new Date(1000))
  const before = await stat(path, { bigint: true })
  await cache.fingerprint(path)
  await writeFile(replacement, 'modified')
  await utimes(replacement, new Date(0), new Date(1000))
  await rename(replacement, path)
  const after = await stat(path, { bigint: true })
  expect(after.ino).not.toBe(before.ino)
  expect(after.size).toBe(before.size)
  expect(after.mtimeNs).toBe(before.mtimeNs)
  expect(await cache.fingerprint(path)).toBe(digest('modified'))
  expect(fs.createReadStream).toHaveBeenCalledTimes(2)
})

it('rejects a file changed during hashing and does not cache its partial observation', async () => {
  const { path, cache } = await fixture()
  const read = vi.mocked(fs.createReadStream).getMockImplementation()!
  vi.mocked(fs.createReadStream).mockImplementationOnce((...args) => {
    const stream = read(...args)
    stream.once('data', () => fs.writeFileSync(path, 'changed during read'))
    return stream
  })
  await expect(cache.fingerprint(path)).rejects.toThrow('Payload changed during fingerprinting')
  expect(await cache.fingerprint(path)).toBe(digest('changed during read'))
  expect(fs.createReadStream).toHaveBeenCalledTimes(2)
})

it('rejects missing files instead of returning their cached fingerprint', async () => {
  const { path, cache } = await fixture()
  await cache.fingerprint(path)
  await rm(path)
  await expect(cache.fingerprint(path)).rejects.toThrow()
})

it('follows a retargeted symlink instead of reusing the previous target bytes', async () => {
  const { root, path, cache } = await fixture()
  const alias = join(root, 'alias')
  const replacement = join(root, 'replacement')
  await symlink(path, alias)
  expect(await cache.fingerprint(alias)).toBe(digest('original'))
  await writeFile(replacement, 'modified')
  await rm(alias)
  await symlink(replacement, alias)
  expect(await cache.fingerprint(alias)).toBe(digest('modified'))
  expect(fs.createReadStream).toHaveBeenCalledTimes(2)
})

it('rejects cancellation while checking a cached file identity', async () => {
  const { path, cache } = await fixture()
  await cache.fingerprint(path)
  const controller = new AbortController()
  const checking = cache.fingerprint(path, { signal: controller.signal })
  controller.abort(new Error('Inspection cancelled'))
  await expect(checking).rejects.toThrow('Inspection cancelled')
  expect(fs.createReadStream).toHaveBeenCalledTimes(1)
})

it('shares cached fingerprints between inventory and direct launcher discovery', async () => {
  const { root, path } = await fixture()
  const environment = { generation: '1', provenance: 'worker' as const, cwd: root, path: '/usr/bin:/bin' }
  const first = await discoverInventoryLauncher(path, environment)
  expect(first.status).toBe('installed')
  expect((await discoverInventoryLauncher(path, environment)).fingerprint).toBe(first.fingerprint)
  expect(fs.createReadStream).toHaveBeenCalledTimes(1)
  expect((await discoverLauncher(path, environment)).fingerprint).toBe(first.fingerprint)
  expect((await discoverLauncher(path, environment)).fingerprint).toBe(first.fingerprint)
  expect(fs.createReadStream).toHaveBeenCalledTimes(1)
})


it('refreshes direct launcher digests after same-size edits with preserved mtime', async () => {
  const { root, path } = await fixture()
  await utimes(path, new Date(0), new Date(1000))
  const before = await stat(path)
  const environment = { generation: '1', provenance: 'worker' as const, cwd: root, path: root }
  const first = await discoverLauncher(path, environment)
  expect(first.status).toBe('installed')
  expect(first.payloadFingerprints?.[0]?.fingerprint).toBe(digest('original'))
  expect((await discoverLauncher(path, environment)).fingerprint).toBe(first.fingerprint)
  expect(fs.createReadStream).toHaveBeenCalledTimes(1)
  await writeFile(path, 'modified')
  await utimes(path, before.atime, before.mtime)
  const changed = await discoverLauncher(path, environment)
  expect(changed.status).toBe('installed')
  expect(changed.payloadFingerprints?.[0]?.fingerprint).toBe(digest('modified'))
  expect(changed.fingerprint).not.toBe(first.fingerprint)
  expect((await discoverLauncher(path, environment)).fingerprint).toBe(changed.fingerprint)
  expect(fs.createReadStream).toHaveBeenCalledTimes(2)
})
