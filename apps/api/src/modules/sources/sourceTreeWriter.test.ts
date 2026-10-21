import { mkdtemp, open, readFile, rm, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { withSourceTreeWriter } from './entryProcessing.js'
import { sourceSha256 } from './manifest.js'
import { anchored, openPrivateRoot } from './privateFilesystem.js'
import { syncSourceTree } from './sourceTreeSync.js'
import type { SourceFileWriter } from './sourceFileWriter.js'
import { deferred } from '../../../test/helpers/deferred.js'

function writer(tree: FileHandle, write: SourceFileWriter['write']) {
  return { write, finish: () => syncSourceTree(tree, AbortSignal.timeout(5000)) }
}

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(persistentFixtureRoot, 'source-writer-'))
  roots.push(root)
  const bytes = Buffer.from('verified source\n')
  const entries = ['src/one.txt', 'src/two.txt', 'src/nested/three.txt'].map(path => ({
    path, kind: 'file' as const, executable: false, byteSize: bytes.length, sha256: sourceSha256(bytes),
  }))
  return { root, bytes, entries, tree: await openPrivateRoot(root) }
}

it('shares a parent during overlapping writes and closes every parent after publication', async () => {
  const f = await fixture()
  const parents = new Set<FileHandle>()
  const firstParents: FileHandle[] = []
  const overlap = deferred()
  try {
    const result = await withSourceTreeWriter(f.tree, f.entries.map(entry => entry.path), async write => {
      await Promise.all(f.entries.map(entry => write(entry, f.bytes)))
      return 'complete'
    }, writer(f.tree, async (parent, entry, bytes) => {
      parents.add(parent)
      if (entry.path.startsWith('src/') && !entry.path.slice(4).includes('/')) {
        firstParents.push(parent)
        if (firstParents.length === 2) overlap.resolve()
        await overlap.promise
      }
      const file = await open(anchored(parent, entry.path.split('/').at(-1)!), 'wx', 0o600)
      try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
    }), AbortSignal.timeout(5000))
    expect(result).toBe('complete')
    expect(firstParents[0]).toBe(firstParents[1])
    for (const entry of f.entries) expect(await readFile(join(f.root, entry.path))).toEqual(f.bytes)
    for (const parent of parents) await expect(parent.stat()).rejects.toMatchObject({ code: 'EBADF' })
    expect((await f.tree.stat()).isDirectory()).toBe(true)
  } finally { await f.tree.close() }
})

it('joins an interrupted writer and closes parents whose remaining writes were never offered', async () => {
  const f = await fixture()
  const blocked = deferred()
  const entered = deferred()
  const parents = new Set<FileHandle>()
  const failure = new Error('Source write failed')
  let settled = false
  try {
    const writing = withSourceTreeWriter(f.tree, f.entries.map(entry => entry.path), async write => {
      const results = await Promise.allSettled(f.entries.slice(0, 2).map(entry => write(entry, f.bytes)))
      const rejected = results.find(result => result.status === 'rejected')
      if (rejected?.status === 'rejected') throw rejected.reason
    }, writer(f.tree, async parent => {
      parents.add(parent)
      entered.resolve()
      await blocked.promise
      throw failure
    }), AbortSignal.timeout(5000))
    const observed = writing.then(() => { settled = true }, error => { settled = true; return error })
    await entered.promise
    expect(settled).toBe(false)
    blocked.resolve()
    expect(await observed).toBe(failure)
    for (const parent of parents) await expect(parent.stat()).rejects.toMatchObject({ code: 'EBADF' })
  } finally { blocked.resolve(); await f.tree.close() }
})

it('rejects incomplete writes and canceled captures without publishing success', async () => {
  const f = await fixture()
  try {
    await expect(withSourceTreeWriter(f.tree, f.entries.map(entry => entry.path), async () => 'complete',
      writer(f.tree, async () => {}), AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'SOURCE_TREE_INVALID' })
    await expect(withSourceTreeWriter(f.tree, f.entries.map(entry => entry.path), async write => {
      await write(f.entries[0]!, f.bytes)
    }, writer(f.tree, async () => {}), AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
  } finally { await f.tree.close() }
})
