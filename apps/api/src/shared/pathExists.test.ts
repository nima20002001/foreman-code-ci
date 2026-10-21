import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { privateFixtureDirectory, withPrivateFixtureDirectories } from '../../test/helpers/privateFixtureDirectory.js'
import { pathExists } from './pathExists.js'

it('recognizes files, directories and dangling symlinks without hiding filesystem errors', async () => {
  await withPrivateFixtureDirectories(async () => {
    const root = await privateFixtureDirectory('path-exists-')
    const file = join(root, 'file')
    const directory = join(root, 'directory')
    const link = join(root, 'link')
    await writeFile(file, 'content')
    await mkdir(directory)
    await symlink(join(root, 'missing'), link)

    expect(await pathExists(file)).toBe(true)
    expect(await pathExists(directory)).toBe(true)
    expect(await pathExists(link)).toBe(true)
    expect(await pathExists(join(root, 'missing'))).toBe(false)
    await expect(pathExists(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})
