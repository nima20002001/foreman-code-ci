import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { anchored, openPrivateRoot } from './privateFilesystem.js'
import { withSourceDirectoryParents } from './directoryParents.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('writes through qualified parents after the ancestor cache fills and leaves the root open', async () => {
  const root = await mkdtemp(join(persistentFixtureRoot, 'source-parents-'))
  roots.push(root)
  const tree = await openPrivateRoot(root)
  const paths = ['root.txt', ...Array.from({ length: 140 }, (_, index) => `src/${index}/nested/deeper/file.txt`)]
  try {
    await withSourceDirectoryParents(tree, true, async parentForPath => {
      for (const path of paths) {
        const parent = await parentForPath(path)
        try { await writeFile(anchored(parent, path.split('/').at(-1)!), path) }
        finally { await parent.close() }
      }
    })
    for (const path of paths) expect(await readFile(join(root, path), 'utf8')).toBe(path)
    expect((await tree.stat()).isDirectory()).toBe(true)
  } finally { await tree.close() }
})

it('propagates a failed parent lookup and keeps the caller-owned root usable', async () => {
  const root = await mkdtemp(join(persistentFixtureRoot, 'source-parent-failure-'))
  roots.push(root)
  const tree = await openPrivateRoot(root)
  try {
    await expect(withSourceDirectoryParents(tree, false, parentForPath => parentForPath('missing/nested/file.txt')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect((await tree.stat()).isDirectory()).toBe(true)
  } finally { await tree.close() }
})
