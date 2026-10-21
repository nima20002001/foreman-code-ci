import { mkdtemp, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { openPrivateRoot } from './privateFilesystem.js'
import { syncSourceTree } from './sourceTreeSync.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('flushes an open directory after its path is renamed, including nested writes', async () => {
  const root = await mkdtemp(join(persistentFixtureRoot, 'source-sync-'))
  roots.push(root)
  const original = join(root, 'original')
  const moved = join(root, 'moved')
  await mkdir(original, { mode: 0o700 })
  const tree = await openPrivateRoot(original)
  try {
    await mkdir(join(original, 'nested'), { mode: 0o700 })
    await writeFile(join(original, 'nested/source.txt'), 'verified bytes', { mode: 0o400 })
    await rename(original, moved)
    const flushed: number[] = []
    const prototype = Object.getPrototypeOf(tree)
    const originalSync = prototype.sync
    vi.spyOn(prototype, 'sync').mockImplementation(async function (this: typeof tree) {
      await originalSync.call(this)
      flushed.push((await this.stat()).ino)
    })
    await syncSourceTree(tree, AbortSignal.timeout(5000))
    expect(flushed).toEqual(await Promise.all([
      join(moved, 'nested/source.txt'), join(moved, 'nested'), moved,
    ].map(async path => (await stat(path)).ino)))
    expect(await readFile(join(moved, 'nested/source.txt'), 'utf8')).toBe('verified bytes')
  } finally { await tree.close() }
})

it('rejects cancellation before starting a filesystem flush', async () => {
  const tree = await open(persistentFixtureRoot)
  try {
    const failure = new Error('Preparation canceled')
    await expect(syncSourceTree(tree, AbortSignal.abort(failure))).rejects.toBe(failure)
  } finally { await tree.close() }
})

it('rejects an invalid inherited directory instead of reporting a successful flush', async () => {
  const tree = await open(persistentFixtureRoot)
  await tree.close()
  await expect(syncSourceTree(tree, AbortSignal.timeout(5000)))
    .rejects.toMatchObject({ code: 'EBADF' })
})

it.each(['file', 'nested directory', 'root directory'])(
  'rejects a failed %s synchronization instead of reporting completion', async kind => {
    const root = await mkdtemp(join(persistentFixtureRoot, 'source-sync-failure-'))
    roots.push(root)
    await mkdir(join(root, 'nested'), { mode: 0o700 })
    await writeFile(join(root, 'nested/source.txt'), 'source bytes', { mode: 0o400 })
    const tree = await openPrivateRoot(root)
    const targets: Record<string, string> = {
      file: join(root, 'nested/source.txt'),
      'nested directory': join(root, 'nested'),
      'root directory': root,
    }
    const target = targets[kind]!
    const targetInode = (await stat(target)).ino
    const prototype = Object.getPrototypeOf(tree)
    const originalSync = prototype.sync
    const failure = new Error('Filesystem synchronization failed')
    vi.spyOn(prototype, 'sync').mockImplementation(async function (this: typeof tree) {
      if ((await this.stat()).ino === targetInode) throw failure
      return originalSync.call(this)
    })
    try {
      await expect(syncSourceTree(tree, AbortSignal.timeout(5000))).rejects.toBe(failure)
    } finally { await tree.close() }
  },
)
