import { mkdtemp, mkdir, rm, symlink, writeFile, lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { readNativeUserFile } from './nativeConfigFiles.js'

const ownership = vi.hoisted(() => ({ foreignPath: '' }))
vi.mock('node:fs/promises', async importOriginal => {
  const filesystem = await importOriginal<typeof import('node:fs/promises')>()
  return { ...filesystem, lstat: async (...args: Parameters<typeof filesystem.lstat>) => {
    const metadata = await filesystem.lstat(...args)
    if (String(args[0]) === ownership.foreignPath) Object.assign(metadata, { uid: Number(metadata.uid) + 1 })
    return metadata
  } }
})

const directories: string[] = []
afterEach(async () => {
  ownership.foreignPath = ''
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'native-config-file-'))
  directories.push(directory)
  return directory
}

it('reads an absent Codex user file as an empty document without creating it', async () => {
  const directory = await fixture()
  const file = join(directory, 'config.toml')
  expect(await readNativeUserFile(file, { whenMissing: '', requireDirectory: true })).toBe('')
  await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(file, 'model = "qualified-model"\n', { mode: 0o600 })
  expect(await readNativeUserFile(file, { whenMissing: '', requireDirectory: true }))
    .toBe('model = "qualified-model"\n')
})

it('preserves an optional missing-file value and required-file failures', async () => {
  const directory = await fixture()
  const file = join(directory, 'missing', 'config.toml')
  expect(await readNativeUserFile(file, { whenMissing: '' })).toBe('')
  await expect(readNativeUserFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readNativeUserFile(file, { whenMissing: '', requireDirectory: true }))
    .rejects.toMatchObject({ code: 'ENOENT' })
})

it('reads same-user linked directories and linked configuration files', async () => {
  const directory = await fixture()
  const actual = join(directory, 'actual')
  await mkdir(actual)
  const linked = join(directory, 'linked')
  await symlink(actual, linked)
  const options = { whenMissing: '', requireDirectory: true }
  expect(await readNativeUserFile(join(linked, 'config.toml'), options)).toBe('')
  const file = join(actual, 'config.toml')
  await writeFile(file, 'model = "qualified-model"\n')
  const linkedFile = join(directory, 'config.toml')
  await symlink(file, linkedFile)
  expect(await readNativeUserFile(linkedFile, options)).toBe('model = "qualified-model"\n')
})

it('rejects links into credential storage', async () => {
  const directory = await fixture()
  const sensitive = join(directory, '.ssh')
  await mkdir(sensitive)
  const target = join(sensitive, 'config')
  await writeFile(target, 'private credential material')
  const linked = join(directory, 'config.toml')
  await symlink(target, linked)
  await expect(readNativeUserFile(linked)).rejects.toMatchObject({ code: 'MCP_CONFIG_FILE_UNSAFE' })
})

it('rejects a linked configuration directory owned by another user', async () => {
  const directory = await fixture()
  const target = join(directory, 'foreign')
  await mkdir(target)
  const linked = join(directory, 'linked')
  await symlink(target, linked)
  ownership.foreignPath = target
  await expect(readNativeUserFile(join(linked, 'config.toml'), { whenMissing: '' }))
    .rejects.toMatchObject({ code: 'MCP_CONFIG_FILE_UNSAFE' })
})
