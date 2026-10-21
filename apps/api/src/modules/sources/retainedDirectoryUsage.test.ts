import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { measureRetainedSourceDirectory } from './retainedDirectoryUsage.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp('/tmp/retained-source-')
  roots.push(root)
  const directoryId = randomUUID()
  const directory = join(root, directoryId)
  await mkdir(directory, { mode: 0o700 })
  return { root, directoryId, directory }
}

async function entryBytes(path: string) {
  const stat = await lstat(path)
  return Math.max(4096, stat.size, stat.blocks * 512)
}

async function directoryBytes(path: string) {
  const stat = await lstat(path)
  return Math.max(4096, stat.blocks * 512)
}

it('counts dependency symlinks without following files, directories, dangling links or cycles', async () => {
  const f = await fixture()
  const outside = join(f.root, 'dependencies')
  await mkdir(outside)
  const target = join(outside, 'package.js')
  const content = Buffer.alloc(128 * 1024, 1)
  await writeFile(target, content)
  const paths = ['file', 'directory', 'dangling', 'cycle'].map(name => join(f.directory, name))
  await symlink(target, paths[0]!)
  await symlink(outside, paths[1]!)
  await symlink(join(outside, 'missing'), paths[2]!)
  await symlink('.', paths[3]!)
  const expected = await directoryBytes(f.directory)
    + (await Promise.all(paths.map(entryBytes))).reduce((sum, bytes) => sum + bytes, 0)
  expect(await measureRetainedSourceDirectory(f.root, f.directoryId)).toBe(expected)
  expect(await readFile(target)).toEqual(content)
})

it('counts a hard-linked file once across nested directories', async () => {
  const f = await fixture()
  const nested = join(f.directory, 'nested')
  await mkdir(nested)
  const original = join(f.directory, 'package.js')
  await writeFile(original, Buffer.alloc(32 * 1024, 2))
  await link(original, join(nested, 'package.js'))
  await link(original, join(f.directory, 'alias.js'))
  const expected = await directoryBytes(f.directory) + await directoryBytes(nested) + await entryBytes(original)
  expect(await measureRetainedSourceDirectory(f.root, f.directoryId)).toBe(expected)
})

it('charges a retained file even when another hard link is outside the measured tree', async () => {
  const f = await fixture()
  const outside = join(f.root, 'cached-package.js')
  await writeFile(outside, Buffer.alloc(32 * 1024, 3))
  const retained = join(f.directory, 'package.js')
  await link(outside, retained)
  expect(await measureRetainedSourceDirectory(f.root, f.directoryId))
    .toBe(await directoryBytes(f.directory) + await entryBytes(retained))
})

it('counts every directory and file of a wide nested tree exactly', async () => {
  const f = await fixture()
  let expected = await directoryBytes(f.directory)
  for (let outer = 0; outer < 8; outer++) {
    const directory = join(f.directory, `outer-${outer}`)
    await mkdir(directory)
    expected += await directoryBytes(directory)
    for (let inner = 0; inner < 8; inner++) {
      const nested = join(directory, `inner-${inner}`)
      await mkdir(nested)
      expected += await directoryBytes(nested)
      for (let file = 0; file < 4; file++) {
        const path = join(nested, `file-${file}`)
        await writeFile(path, Buffer.alloc(1024 * (file + 1) * 5, file))
        expected += await entryBytes(path)
      }
    }
  }
  expect(await measureRetainedSourceDirectory(f.root, f.directoryId)).toBe(expected)
})
