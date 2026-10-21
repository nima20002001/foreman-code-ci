import { mkdtemp, mkdir, lstat, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { constants, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { renameDirectory } from '../src/modules/workspaces/renameDirectory.js'

const directories: string[] = []

async function temporaryDirectory(parent = tmpdir()) {
  const directory = await mkdtemp(join(parent, 'workspace-rename-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

it('publishes the same directory inode with its contents and permissions', async () => {
  const parent = await temporaryDirectory()
  const source = join(parent, 'stage')
  const destination = join(parent, 'Project ü')
  await mkdir(source, { mode: 0o700 })
  await writeFile(join(source, 'content.txt'), 'project content')
  const identity = await lstat(source)

  expect(await renameDirectory(source, destination)).toBe(true)
  expect(await lstat(destination)).toMatchObject({ dev: identity.dev, ino: identity.ino, mode: identity.mode })
  expect(await readFile(join(destination, 'content.txt'), 'utf8')).toBe('project content')
  expect(await readdir(parent)).toEqual(['Project ü'])
})

it.each(['empty directory', 'populated directory', 'file', 'symlink'])(
  'preserves both paths when the destination is an existing %s', async kind => {
    const parent = await temporaryDirectory()
    const source = join(parent, 'stage')
    const destination = join(parent, 'existing')
    await mkdir(source)
    if (kind === 'file') await writeFile(destination, 'keep file')
    else if (kind === 'symlink') await symlink(join(parent, 'missing'), destination)
    else {
      await mkdir(destination)
      if (kind === 'populated directory') await writeFile(join(destination, 'keep.txt'), 'keep directory')
    }
    const sourceIdentity = await lstat(source)
    const destinationIdentity = await lstat(destination)

    expect(await renameDirectory(source, destination)).toBe(false)
    expect(await lstat(source)).toMatchObject({ dev: sourceIdentity.dev, ino: sourceIdentity.ino })
    expect(await lstat(destination)).toMatchObject({ dev: destinationIdentity.dev, ino: destinationIdentity.ino })
    if (kind === 'file') expect(await readFile(destination, 'utf8')).toBe('keep file')
    if (kind === 'populated directory') expect(await readFile(join(destination, 'keep.txt'), 'utf8')).toBe('keep directory')
  },
)

it('allows only one concurrent publication to claim a destination', async () => {
  const parent = await temporaryDirectory()
  const sources = [join(parent, 'first'), join(parent, 'second')]
  const destination = join(parent, 'project')
  for (const source of sources) await mkdir(source)
  const identities = await Promise.all(sources.map(source => lstat(source)))

  const results = await Promise.all(sources.map(source => renameDirectory(source, destination)))
  expect(results.toSorted()).toEqual([false, true])
  const winner = results.indexOf(true)
  const loser = results.indexOf(false)
  expect(await lstat(destination)).toMatchObject({ ino: identities[winner]!.ino })
  expect(await lstat(sources[loser]!)).toMatchObject({ ino: identities[loser]!.ino })
})

it('rejects a cross-filesystem move without creating or copying a destination', async () => {
  const parent = await temporaryDirectory()
  const otherFilesystem = await temporaryDirectory('/dev/shm')
  expect((await lstat(parent)).dev).not.toBe((await lstat(otherFilesystem)).dev)
  const source = join(parent, 'stage')
  const destination = join(otherFilesystem, 'project')
  await mkdir(source)
  await writeFile(join(source, 'keep.txt'), 'keep source')

  await expect(renameDirectory(source, destination)).rejects.toMatchObject({ code: constants.errno.EXDEV })
  expect(await readFile(join(source, 'keep.txt'), 'utf8')).toBe('keep source')
  expect(await readdir(otherFilesystem)).toEqual([])
})
